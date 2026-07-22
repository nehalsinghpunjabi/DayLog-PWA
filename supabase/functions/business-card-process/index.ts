// DayLog 2.0 — business-card-process Edge Function.
//
// Secure server-side pipeline. The browser sends an image (or pre-extracted OCR
// text) and receives a structured contact. Both third-party keys live ONLY in
// Supabase secrets and are never exposed to the client:
//
//   OCR_SPACE_API_KEY   — OCR.Space (primary OCR)
//   GROK_API_KEY        — xAI Grok (structuring, only when needed)
//
// Flow:
//   image -> OCR.Space -> raw text
//         -> deterministic extraction (email / phone / website + heuristics)
//         -> confidence score
//         -> if low confidence AND Grok available: Grok structuring
//         -> validated JSON { name, company, job_title, phone, email,
//                             website, address, confidence, source, raw_text }
//
// verify_jwt is enabled (see config.toml), so only authenticated users can call
// this function.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMPTY_CONTACT = {
  name: "",
  company: "",
  job_title: "",
  phone: "",
  email: "",
  website: "",
  address: "",
};

interface RequestBody {
  image_base64?: string;
  mime_type?: string;
  ocr_text?: string;
}

// --- OCR.Space -------------------------------------------------------------
async function ocrSpace(base64: string, mime: string): Promise<string> {
  const key = Deno.env.get("OCR_SPACE_API_KEY");
  if (!key) throw new Error("OCR_SPACE_API_KEY is not configured.");
  const body = new URLSearchParams({
    base64Image: `data:${mime};base64,${base64}`,
    OCREngine: "2",
    scale: "true",
    isTable: "false",
    language: "eng",
  });
  const resp = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await resp.json();
  if (json.IsErroredOnProcessing) {
    throw new Error(
      Array.isArray(json.ErrorMessage) ? json.ErrorMessage[0] : "OCR failed.");
  }
  return (json.ParsedResults ?? [])
    .map((r: { ParsedText?: string }) => r.ParsedText ?? "")
    .join("\n")
    .trim();
}

// --- Deterministic extraction ---------------------------------------------
const JOB_WORDS = /manager|director|sales|engineer|consultant|founder|owner|ceo|cto|cfo|coo|officer|executive|head|lead|specialist|architect|designer|developer|president|partner|analyst|advisor|coordinator/i;
const COMPANY_WORDS = /pvt|ltd|llp|inc|corp|solutions|technologies|systems|services|company|enterprises|studio|industries|consultants|group|agency|global|labs|limited|private|holdings|ventures|partners/i;

interface Extracted {
  contact: typeof EMPTY_CONTACT;
  confidence: number;
}

function deterministicExtract(text: string): Extracted {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const email = (text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/) || [""])[0];
  const phoneMatch = (text.match(/(?:\+?\d[\d\s().-]{6,}\d)/) || [""])[0]
    .replace(/[^\d+]/g, "");
  const phone = phoneMatch.replace(/\D/g, "").length >= 7 ? phoneMatch : "";
  const website = (text.match(
    /(?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|net|org|io|co|dev|app|biz|info)(?:\/\S*)?/i,
  ) || [""])[0].replace(/^https?:\/\//, "");

  const job_title = lines.find((l) => JOB_WORDS.test(l)) || "";
  const company = lines.find((l) => l !== job_title && COMPANY_WORDS.test(l)) || "";
  const name = lines.find(
    (l) => l !== job_title && l !== company &&
      !/\d|@|www|http/i.test(l) && l.split(/\s+/).length <= 5,
  ) || "";
  const address = lines
    .filter((l) => /road|street|avenue|lane|floor|block|sector|city|pin|zip|nagar|colony|building|suite|drive|blvd|\d{5,6}/i.test(l))
    .join(", ");

  // Confidence is driven by the deterministic contact points. If we confidently
  // have both an email and a phone, deterministic + heuristics are trusted and
  // Grok is skipped to reduce API usage.
  let confidence = 0;
  if (email) confidence += 0.45;
  if (phone) confidence += 0.30;
  if (website) confidence += 0.15;
  if (name) confidence += 0.10;
  confidence = Math.min(1, Number(confidence.toFixed(2)));

  return {
    contact: {
      name, company, job_title,
      phone: phone || "", email: email || "", website: website || "", address,
    },
    confidence,
  };
}

// --- Grok structuring ------------------------------------------------------
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Validate + coerce an arbitrary Grok response into the strict schema.
function validateContact(raw: unknown): typeof EMPTY_CONTACT | null {
  if (!isPlainObject(raw)) return null;
  const out = { ...EMPTY_CONTACT };
  for (const key of Object.keys(EMPTY_CONTACT) as (keyof typeof EMPTY_CONTACT)[]) {
    const val = raw[key];
    if (val == null) { out[key] = ""; continue; }
    if (typeof val !== "string" && typeof val !== "number") return null;
    out[key] = String(val).trim();
  }
  return out;
}

async function grokStructure(text: string): Promise<typeof EMPTY_CONTACT | null> {
  const key = Deno.env.get("GROK_API_KEY");
  if (!key) return null;

  const system =
    "You extract contact details from raw OCR text of a business card. " +
    "Respond with ONLY a compact JSON object, no prose, no code fences. " +
    'Schema exactly: {"name":"","company":"","job_title":"","phone":"",' +
    '"email":"","website":"","address":""}. Use empty strings for unknown ' +
    "fields. Pick the single best phone and email.";

  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "grok-2-latest",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: text.slice(0, 4000) },
      ],
    }),
  });

  if (!resp.ok) {
    console.error("Grok error", resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  if (!content) return null;

  // Parse defensively — strip any stray fences and isolate the JSON object.
  let parsed: unknown;
  try {
    const cleaned = content.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : cleaned);
  } catch {
    return null;
  }
  return validateContact(parsed);
}

// --- Handler ---------------------------------------------------------------
serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  try {
    const body = (await request.json()) as RequestBody;

    // 1. Obtain OCR text (from OCR.Space, or client-provided fallback text).
    let text = (body.ocr_text ?? "").trim();
    let ocrSource = "client";
    if (!text) {
      if (!body.image_base64) return json({ error: "image_base64 or ocr_text required" }, 400);
      text = await ocrSpace(body.image_base64, body.mime_type ?? "image/jpeg");
      ocrSource = "ocrspace";
    }
    if (!text) return json({ ...EMPTY_CONTACT, confidence: 0, source: ocrSource, raw_text: "" });

    // 2. Deterministic extraction + confidence.
    const det = deterministicExtract(text);

    // 3. Low confidence -> Grok structuring (if available). Merge, preferring
    //    Grok for descriptive fields but keeping deterministic contact points
    //    when Grok omits them.
    let contact = det.contact;
    let source = `${ocrSource}+deterministic`;
    let confidence = det.confidence;

    const HIGH = 0.75;
    if (det.confidence < HIGH) {
      const grok = await grokStructure(text);
      if (grok) {
        contact = {
          name: grok.name || det.contact.name,
          company: grok.company || det.contact.company,
          job_title: grok.job_title || det.contact.job_title,
          phone: grok.phone || det.contact.phone,
          email: grok.email || det.contact.email,
          website: grok.website || det.contact.website,
          address: grok.address || det.contact.address,
        };
        source = `${ocrSource}+grok`;
        confidence = Math.max(det.confidence, 0.8);
      }
    }

    return json({ ...contact, confidence, source, raw_text: text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "processing failed";
    return json({ error: message }, 400);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
