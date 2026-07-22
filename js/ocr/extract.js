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

async function callEdge(body, signal) {
  const { data, error } = await supabase.functions.invoke(
    "business-card-process", { body, ...(signal ? { signal } : {}) });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

// Process a business-card image. Returns a normalised contact object.
// `signal` (optional AbortSignal) lets the caller cancel an in-flight scan.
export async function processBusinessCard(blob, { signal } = {}) {
  const mime = blob.type || "image/jpeg";

  // PRIMARY: image -> Edge Function (OCR.Space + Grok).
  try {
    const base64 = await blobToBase64(blob);
    const res = await callEdge({ image_base64: base64, mime_type: mime }, signal);
    return toContactModel(res, "");
  } catch (primaryErr) {
    if (signal?.aborted) throw new DOMException("Scan cancelled", "AbortError");
    console.warn("DayLog: primary card processing failed, trying fallback.", primaryErr);

    // FALLBACK: local Tesseract OCR.
    const text = await tesseractText(blob);
    if (signal?.aborted) throw new DOMException("Scan cancelled", "AbortError");

    // If we can reach the Edge Function, let Grok structure the local text.
    try {
      const res = await callEdge({ ocr_text: text }, signal);
      return toContactModel(res, text);
    } catch {
      // Fully offline: parse locally with heuristics.
      const parsed = parseCard(text);
      return {
        ...parsed,
        confidence: null,
        source: "tesseract-local",
      };
    }
  }
}
