# DayLog 2.0 — OCR Provider Architecture

DayLog treats OCR as a **replaceable** capability. The scan UI, review form, and
contact data model depend only on an interface — never on a specific vendor — so
you can swap or add providers without touching the rest of the app.

## The interface

```js
interface OcrProvider {
  name: string
  available(): Promise<boolean>        // can it run right now?
  recognize(blob: Blob): Promise<{ text: string }>
}
```

Text extraction (recognition) is deliberately separate from field parsing.
`js/ocr/parse-card.js` turns raw text into `{ name, company, job_title,
phones[], emails[], website, address, notes }` and is unaffected by which
provider produced the text.

## Shipped providers (`js/ocr/provider.js`)

| Provider | Where it runs | Needs config | Offline |
|---|---|---|---|
| `TesseractProvider` | In-browser (Tesseract.js, lazy-loaded) | none | yes (after first load) |
| `EdgeProvider` | Supabase `ocr-extract` Edge Function | function deploy | no |

`recognizeCard(blob)` tries providers in order (`tesseract`, then `edge`) and
uses the first that reports `available()`.

## Server-side providers (`supabase/functions/ocr-extract/index.ts`)

The Edge Function is itself a provider registry so you can add vendors without
shipping their SDKs to the browser:

| Provider key | Activation |
|---|---|
| `passthrough` (default) | Always; normalises client-supplied text |
| `ocrspace` | Set `OCR_PROVIDER=ocrspace` + `OCR_SPACE_API_KEY` |

Select the active server provider with the `OCR_PROVIDER` env var.

## Adding a provider

### Option A — client-side (e.g. a WASM engine)
```js
import { registerProvider } from "./ocr/provider.js";

registerProvider({
  name: "myengine",
  async available() { return true; },
  async recognize(blob) {
    const text = await myEngine(blob);
    return { text };
  },
});
```
Then include `"myengine"` in the order passed to `recognizeCard`.

### Option B — server-side (e.g. Google Vision, OpenAI Vision)
Implement `OcrProvider` inside the Edge Function and register it in `PROVIDERS`:

```ts
const googleVision: OcrProvider = {
  name: "gvision",
  async extract(req) {
    const key = Deno.env.get("GOOGLE_VISION_API_KEY");
    // …call the API with req.image_base64…
    return { text, provider: "gvision" };
  },
};
```
Deploy, then `supabase secrets set OCR_PROVIDER=gvision GOOGLE_VISION_API_KEY=…`.
The browser keeps using `EdgeProvider` unchanged.

## Why this shape

- **Vendor independence** — no lock-in; providers are hot-swappable.
- **Privacy control** — keep OCR on-device (Tesseract) or move it server-side.
- **Review-first** — every scan lands in an editable form before saving, so
  imperfect recognition never silently corrupts contact data.
