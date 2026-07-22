// DayLog 2.0 — Tesseract fallback OCR.
//
// OCR.Space (server-side, in the business-card-process Edge Function) is the
// PRIMARY recognizer. Tesseract.js runs entirely in the browser and is used
// ONLY as a fallback when the Edge Function is unreachable (e.g. offline). No
// API keys are involved on the client.

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
    s.onerror = () => reject(new Error("Could not load the offline OCR engine."));
    document.head.appendChild(s);
  });
  return tesseractLoading;
}

// Recognize card text locally. Throws if Tesseract cannot be loaded/run.
export async function tesseractText(blob) {
  const T = await loadTesseract();
  const { data } = await T.recognize(blob, "eng", { logger: () => {} });
  return data?.text || "";
}
