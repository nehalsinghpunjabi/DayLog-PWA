// DayLog 2.0 — image normalization for OCR.
//
// Business-card photos arrive in wildly different formats/orientations/sizes
// depending on the device and browser (iPhone HEIC vs JPEG, EXIF-rotated camera
// shots, 12MP originals, etc.). To make OCR input IDENTICAL across iPhone Safari,
// the installed PWA, Chrome, and desktop, every image is normalized before OCR:
//
//   1. decode with EXIF orientation applied  (createImageBitmap from-image)
//   2. downscale so the longest side <= 2000px
//   3. re-encode as JPEG at ~85% quality
//
// The ORIGINAL blob is never modified here — the caller uploads the original to
// storage and passes only the return value of prepareForOcr() to the OCR step.

const MAX_EDGE = 2000;
const QUALITY = 0.85;

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => resolve(b), type, quality);
    } else {
      // Very old Safari fallback via data URL.
      try {
        const dataUrl = canvas.toDataURL(type, quality);
        const [meta, b64] = dataUrl.split(",");
        const mime = (meta.match(/:(.*?);/) || [])[1] || type;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type: mime }));
      } catch {
        resolve(null);
      }
    }
  });
}

// EXIF-aware decode. Prefers createImageBitmap (well-defined, consistent across
// browsers); falls back to an <img> element (modern browsers apply EXIF
// orientation to the decoded image by default).
async function decode(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch { /* fall through to <img> */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
    img.src = url;
  });
}

function sizeOf(source) {
  return {
    width: source.width || source.naturalWidth || 0,
    height: source.height || source.naturalHeight || 0,
  };
}

// Normalize an image for OCR. Returns a JPEG Blob (EXIF-applied, <=maxEdge,
// quality). On any failure it returns the ORIGINAL blob so a scan is never
// blocked by preprocessing.
export async function prepareForOcr(blob, { maxEdge = MAX_EDGE, quality = QUALITY } = {}) {
  try {
    const source = await decode(blob);
    const { width, height } = sizeOf(source);
    if (!width || !height) { source.close?.(); return blob; }

    const longest = Math.max(width, height);
    const scale = longest > maxEdge ? maxEdge / longest : 1; // downscale only
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    source.close?.();

    const out = await canvasToBlob(canvas, "image/jpeg", quality);
    return out || blob;
  } catch (err) {
    console.warn("[DayLog scan] image normalization failed; using original.", err);
    return blob;
  }
}
