// DayLog 2.0 — business-card extraction entry point (client side).
//
// PRIMARY path: send the image to the `business-card-process` Edge Function,
// which runs OCR.Space + deterministic extraction + Grok (server-side, keys
// never exposed) and returns a structured contact.
//
// FALLBACK path: if the Edge Function is unreachable (offline / network error),
// run Tesseract.js locally, then send the extracted text back to the Edge
// Function for structuring if we regain connectivity; otherwise parse locally.
//
// The returned object is normalised to DayLog's contact model (arrays for
// phones/emails) so the review form and DB layer are unchanged.

import { supabase } from "../supabase.js";
import { tesseractText } from "./provider.js";
import { parseCard } from "./parse-card.js";

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Map the Edge Function's single-value schema to DayLog's contact model.
function toContactModel(res, rawText) {
  return {
    name: res.name || "",
    company: res.company || "",
    job_title: res.job_title || "",
    phones: res.phone ? [res.phone] : [],
    office_phones: [],
    emails: res.email ? [res.email] : [],
    website: res.website || "",
    address: res.address || "",
    notes: "",
    raw_ocr_text: res.raw_text || rawText || "",
    confidence: typeof res.confidence === "number" ? res.confidence : null,
    source: res.source || "edge",
  };
}

const FN_NAME = "business-card-process";

// The endpoint the client will actually hit — logged so a project/URL mismatch
// (e.g. functions deployed to a different project than SUPABASE_URL points to)
// is immediately visible.
function functionsUrl() {
  try { return supabase.functions?.url || "(unknown)"; } catch { return "(unknown)"; }
}

// Invoke the Edge Function and, on failure, extract the REAL error detail from
// the underlying HTTP response so the true cause (404 not-deployed, 401 auth,
// 500 runtime) is surfaced instead of a generic message.
async function callEdge(body) {
  console.info(`[DayLog scan] invoke '${FN_NAME}' →`, functionsUrl() + `/${FN_NAME}`);
  const { data, error } = await supabase.functions.invoke(FN_NAME, { body });

  if (error) {
    let status;
    let detail = error.message || "invoke failed";
    // supabase-js FunctionsHttpError carries the Response on error.context.
    try {
      const ctx = error.context;
      if (ctx && typeof ctx.status === "number") status = ctx.status;
      if (ctx && typeof ctx.json === "function") {
        const j = await ctx.clone().json();
        if (j?.error) detail = j.error;
      }
    } catch { /* body not JSON — keep generic detail */ }
    const wrapped = new Error(
      status ? `Edge Function ${FN_NAME} returned ${status}: ${detail}` : detail);
    wrapped.name = error.name || "FunctionsError";
    wrapped.status = status;
    console.error(`[DayLog scan] invoke error (${status ?? "no-status"}):`, detail, error);
    throw wrapped;
  }

  if (data?.error) {
    console.error("[DayLog scan] function returned error payload:", data.error);
    throw new Error(data.error);
  }
  console.info("[DayLog scan] invoke response:", data);
  return data;
}

// Process a business-card image. Returns a normalised contact object.
// Online failures are SURFACED (thrown) so the UI can show them. Only a genuine
// offline condition falls back to local Tesseract OCR.
export async function processBusinessCard(blob) {
  const mime = blob.type || "image/jpeg";
  const base64 = await blobToBase64(blob);
  console.info("[DayLog scan] sending image to Edge Function", { bytes: blob.size, mime });

  try {
    const res = await callEdge({ image_base64: base64, mime_type: mime });
    return toContactModel(res, "");
  } catch (err) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (offline) {
      console.warn("[DayLog scan] offline — using local Tesseract fallback.", err);
      const text = await tesseractText(blob);
      const parsed = parseCard(text);
      return { ...parsed, confidence: null, source: "tesseract-local", offlineFallback: true };
    }
    // Online error — do NOT hide it behind a fallback; surface to the caller.
    throw err;
  }
}
