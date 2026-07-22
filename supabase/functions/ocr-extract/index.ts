// DayLog 2.0 — OCR Edge Function (provider abstraction)
//
// This function is the server-side half of the OCRProvider architecture.
// The client posts an image (base64) and receives structured card text.
//
// It deliberately ships with a single, dependency-free provider ("passthrough")
// that returns any text the client already extracted, plus a stub contract for
// real vendors. Add a provider by implementing OcrProvider and registering it in
// PROVIDERS — the client UI, forms, and data models never change.
//
// Configure the active provider with the OCR_PROVIDER env var (defaults to
// "passthrough"). Vendor keys (when a real provider is added) come from env too;
// no secrets are committed.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

interface OcrRequest {
  image_base64?: string;
  mime_type?: string;
  // Optional client-side text (e.g. from in-browser Tesseract) to normalise.
  client_text?: string;
}

interface OcrResult {
  text: string;
  provider: string;
}

interface OcrProvider {
  name: string;
  extract(req: OcrRequest): Promise<OcrResult>;
}

// --- Passthrough provider ---------------------------------------------------
// Normalises text the client already produced. Always available, no network.
const passthrough: OcrProvider = {
  name: "passthrough",
  async extract(req) {
    return { text: (req.client_text ?? "").trim(), provider: "passthrough" };
  },
};

// --- OCR.Space provider (activated only when OCR_SPACE_API_KEY is set) -------
const ocrSpace: OcrProvider = {
  name: "ocrspace",
  async extract(req) {
    const key = Deno.env.get("OCR_SPACE_API_KEY");
    if (!key) throw new Error("OCR_SPACE_API_KEY not configured");
    if (!req.image_base64) throw new Error("image_base64 required");
    const body = new URLSearchParams({
      base64Image: `data:${req.mime_type ?? "image/jpeg"};base64,${req.image_base64}`,
      OCREngine: "2",
      scale: "true",
      isTable: "false",
    });
    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await resp.json();
    if (json.IsErroredOnProcessing) {
      throw new Error(json.ErrorMessage?.[0] ?? "OCR.Space error");
    }
    const text = (json.ParsedResults ?? [])
      .map((r: { ParsedText?: string }) => r.ParsedText ?? "")
      .join("\n")
      .trim();
    return { text, provider: "ocrspace" };
  },
};

const PROVIDERS: Record<string, OcrProvider> = {
  passthrough,
  ocrspace: ocrSpace,
};

function activeProvider(): OcrProvider {
  const name = Deno.env.get("OCR_PROVIDER") ?? "passthrough";
  return PROVIDERS[name] ?? passthrough;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const req = (await request.json()) as OcrRequest;
    const provider = activeProvider();
    const result = await provider.extract(req);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "OCR failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
