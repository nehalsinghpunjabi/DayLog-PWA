# DayLog 2.0 — Business-Card OCR & Contact Extraction

Business-card processing runs **server-side** so no third-party API keys ever
reach the browser. The frontend only ever talks to Supabase.

```
iPhone PWA
   │  (image bytes, base64)
   ▼
Supabase Edge Function  business-card-process   ← OCR_SPACE_API_KEY, GROQ_API_KEY
   │  1. OCR.Space        → raw text
   │  2. deterministic    → email / phone / website + heuristics + confidence
   │  3. if low confidence → Groq structuring (validated JSON)
   ▼
Structured contact JSON
   │
   ▼
Editable preview → Save → VCF export (iOS Contacts)
```

## Secrets (server-side only)

Set on the Supabase project — never committed, never sent to the client:

```bash
supabase secrets set OCR_SPACE_API_KEY=your_ocrspace_key
supabase secrets set GROQ_API_KEY=your_groq_key         # optional but recommended
supabase secrets set GROQ_MODEL=llama-3.3-70b-versatile # optional model override
supabase functions deploy business-card-process
```

- `OCR_SPACE_API_KEY` — required for image OCR.
- `GROQ_API_KEY` — optional. If absent, the function still returns the
  deterministic result; only the AI structuring step is skipped.
- `GROQ_MODEL` — optional; defaults to `llama-3.3-70b-versatile`. Any currently
  supported Groq model works (see https://console.groq.com/docs/models).

Groq is called via its OpenAI-compatible endpoint
`https://api.groq.com/openai/v1/chat/completions` using JSON mode
(`response_format: { type: "json_object" }`). The selected model, request
payload, and response payload are logged to the Edge Function logs.

The Edge Function is `verify_jwt = true`, so only authenticated DayLog users can
invoke it.

## Response schema

```json
{
  "name": "",
  "company": "",
  "job_title": "",
  "phone": "",
  "email": "",
  "website": "",
  "address": "",
  "confidence": 0,
  "source": "ocrspace+deterministic | ocrspace+groq | tesseract-local",
  "raw_text": ""
}
```

The client maps `phone`/`email` into DayLog's array-based contact model
(`phones[]`, `emails[]`) before showing the editable review form.

## Confidence & cost control

Deterministic extraction runs first (regex for email/phone/website + heuristics
for name/company/title). A confidence score is computed from which contact
points were found:

- email +0.45, phone +0.30, website +0.15, name +0.10.

If confidence ≥ **0.75**, Groq is **not** called — the deterministic result is
returned, minimising API usage. Below the threshold, Groq structures the raw
text and its fields are merged (deterministic contact points win when Groq
leaves them blank). Malformed Groq output is rejected by `validateContact()` and
the function falls back to the deterministic contact.

## Fallback (offline)

If the Edge Function is unreachable, the client ([js/ocr/extract.js](../js/ocr/extract.js)):

1. Runs **Tesseract.js** locally to get text.
2. Retries the Edge Function with that text (`ocr_text`) so Groq can still
   structure it if connectivity returns.
3. If still offline, parses locally with heuristics
   ([js/ocr/parse-card.js](../js/ocr/parse-card.js)) and marks
   `source: "tesseract-local"`.

Tesseract is **fallback only**; OCR.Space is the primary recognizer.

## Scan UX states

The scan flow ([js/app.js](../js/app.js) `startScan`) surfaces explicit states:

- **Scanning** modal with a spinner + **Cancel** (aborts the in-flight request
  via `AbortController`).
- **Error** modal with **Retry** (re-runs on the same image) and **Cancel**.
- A low-confidence result toasts a "please review" hint.
- Every scan ends in the editable review form before anything is saved — OCR is
  never trusted to write contact data silently.

## Extending / swapping providers

- **Different OCR vendor:** change `ocrSpace()` in the Edge Function (or add a
  branch). The client contract is unchanged.
- **Different LLM:** change `groqStructure()`. The strict `validateContact()`
  gate means any model that returns the JSON schema drops in without touching the
  UI, forms, or data model.
