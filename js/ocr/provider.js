// DayLog 2.0 — client-side OCRProvider abstraction.
//
// The rest of the app (scan UI, review form, contact data model) depends ONLY on
// the OcrProvider interface below — never on a specific vendor. Swap providers by
// changing DEFAULT_PROVIDER or registering a new one; no UI/form/model changes.
//
// Contract:
//   interface OcrProvider {
//     name: string
//     available(): Promise<boolean>          // can this provider run right now?
//     recognize(blob: Blob): Promise<{ text: string }>
//   }
//
// Shipped providers:
//   * TesseractProvider  — in-browser OCR via Tesseract.js (loaded lazily).
//   * EdgeProvider       — posts the image to the Supabase `ocr-extract` Edge
//                          Function, which itself abstracts server-side vendors
//                          (OCR.Space, OpenAI Vision, Google Vision, …).
//
// To add a vendor (e.g. Google Vision), implement OcrProvider and register it in
// PROVIDERS, or implement it inside the Edge Function and keep using EdgeProvider.

import { supabase } from "../supabase.js";

const TESSERACT_CDN =
  "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoading) return tesseractLoading;
  tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_CDN;
    s.async = true;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error("Could not load OCR engine."));
    document.head.appendChild(s);
  });
  return tesseractLoading;
}

export const TesseractProvider = {
  name: "tesseract",
  async available() {
    try { await loadTesseract(); return true; } catch { return false; }
  },
  async recognize(blob) {
    const T = await loadTesseract();
    const { data } = await T.recognize(blob, "eng", { logger: () => {} });
    return { text: data?.text || "" };
  },
};

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export const EdgeProvider = {
  name: "edge",
  async available() {
    return Boolean(navigator.onLine);
  },
  async recognize(blob) {
    const base64 = await blobToBase64(blob);
    const { data, error } = await supabase.functions.invoke("ocr-extract", {
      body: { image_base64: base64, mime_type: blob.type || "image/jpeg" },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return { text: data?.text || "" };
  },
};

const PROVIDERS = {
  tesseract: TesseractProvider,
  edge: EdgeProvider,
};

// Preferred provider order. Tesseract works offline and needs no server config,
// so it is the default; Edge is used when explicitly selected.
const DEFAULT_ORDER = ["tesseract", "edge"];

// Recognise using the first available provider in order.
export async function recognizeCard(blob, order = DEFAULT_ORDER) {
  const errors = [];
  for (const key of order) {
    const provider = PROVIDERS[key];
    if (!provider) continue;
    try {
      if (await provider.available()) {
        const { text } = await provider.recognize(blob);
        return { text, provider: provider.name };
      }
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
    }
  }
  throw new Error(
    errors.length ? errors.join("; ") : "No OCR provider is available.");
}

export function registerProvider(provider) {
  PROVIDERS[provider.name] = provider;
}
