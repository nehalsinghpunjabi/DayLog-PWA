// DayLog 2.0 — business-card-process Edge Function.
//
// Secure server-side pipeline. The browser sends an image (or pre-extracted OCR
// text) and receives a structured contact. Both third-party keys live ONLY in
// Supabase secrets and are never exposed to the client:
//
//   OCR_SPACE_API_KEY   — OCR.Space (primary OCR)
//   GROQ_API_KEY        — Groq (groq.com) LLM structuring, only when needed
//   GROQ_MODEL          — optional; overrides the default Groq model
//
// Flow:
//   image -> OCR.Space -> raw text
//         -> deterministic extraction (email / phone / website + heuristics)
//         -> confidence score
//         -> if low confidence AND Groq available: Groq structuring
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
const DEBUG_SCAN = Deno.env.get("DEBUG_SCAN") === "true";
type ScanDebug = Record<string, unknown>;
function debugLog(label: string, value: unknown, debug: ScanDebug) {
  if (!DEBUG_SCAN) return;
  debug[label] = value;
  console.info(`[business-card-process] ${label}:`, JSON.stringify(value));
}

interface RequestBody {
  image_base64?: string;
  mime_type?: string;
  ocr_text?: string;
}

// --- OCR.Space -------------------------------------------------------------
async function ocrSpace(base64: string, mime: string, debug: ScanDebug): Promise<string> {
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
  debugLog("ocr_space", { status: resp.status, raw_json: json }, debug);
  if (json.IsErroredOnProcessing) {
    throw new Error(
      Array.isArray(json.ErrorMessage) ? json.ErrorMessage[0] : "OCR failed.");
  }
  const text = (json.ParsedResults ?? [])
    .map((r: { ParsedText?: string }) => r.ParsedText ?? "")
    .join("\n")
    .trim();
  debugLog("ocr_parsed", { text, confidence: json?.Confidence ?? null }, debug);
  return text;
}

// --- Deterministic extraction ---------------------------------------------
const JOB_WORDS = /manager|director|sales|engineer|consultant|founder|owner|ceo|cto|cfo|coo|officer|executive|head|lead|specialist|architect|designer|developer|president|partner|analyst|advisor|coordinator/i;
const COMPANY_WORDS = /pvt|ltd|llp|inc|corp|solutions|technologies|systems|services|company|enterprises|studio|industries|consultants|group|agency|global|labs|limited|private|holdings|ventures|partners/i;
const NON_PERSON_WORDS = /lighting|dealer|distributor|partner|electrical|electronics|solutions|services|technologies|systems|industries|trades|trading|premium|authorized|certified|logo|showroom|kitchen|spare|parts|crockery/i;
const ADDRESS_WORDS = /road|street|avenue|lane|floor|block|sector|city|pin|zip|nagar|colony|building|suite|drive|blvd|near|opp|opposite/i;

interface NameCandidate {
  value: string;
  source: "ocr" | "groq" | "groq-name-only";
  line: number | null;
  score: number;
  accepted: boolean;
  reasons: string[];
}

function normalizeName(value: string): string {
  return value.replace(/^(?:mr|mrs|ms|dr|er)\.?\s+/i, "").replace(/\s+/g, " ").trim();
}

function nameCandidate(value: string, source: NameCandidate["source"], line: number | null, company: string, companyLine: number | null): NameCandidate {
  const name = normalizeName(value);
  const words = name.split(/\s+/).filter(Boolean);
  const comparable = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const reasons: string[] = [];
  if (!name) reasons.push("empty");
  if (/\d|@|https?:|www\./i.test(name)) reasons.push("contains contact or numeric text");
  if (!/^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*)*$/u.test(name)) reasons.push("contains non-name characters");
  if (words.length < 2) reasons.push("fewer than two name words");
  if (words.length > 4) reasons.push("more than four name words");
  // A middle initial (e.g. "Sajuman K George") is a valid personal-name
  // pattern; a leading/trailing one-letter fragment is not.
  if (words.some((word, index) => word.length < 2 && !(words.length >= 3 && index > 0 && index < words.length - 1))) {
    reasons.push("contains a one-letter fragment");
  }
  if (NON_PERSON_WORDS.test(name)) reasons.push("contains business, product, or partner language");
  if (ADDRESS_WORDS.test(name)) reasons.push("looks like an address");
  if (company && comparable(name) === comparable(company)) reasons.push("identical to company");

  let score = 0;
  if (words.length === 2) score += 42;
  if (words.length === 3) score += 48;
  if (words.length === 4) score += 40;
  if (words.every((word) => word.length >= 2)) score += 8;
  if (line != null && companyLine != null) score += Math.max(0, 14 - Math.abs(line - companyLine) * 3);
  if (source !== "ocr") score += 18;
  if (reasons.length) score = -100;
  return { value: name, source, line, score, accepted: reasons.length === 0, reasons };
}

function selectName(text: string, company: string, proposed: Array<{ value: string; source: NameCandidate["source"] }> = []) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const companyLine = lines.findIndex((line) => line === company);
  const candidates = [
    ...lines.map((line, index) => nameCandidate(line, "ocr", index, company, companyLine >= 0 ? companyLine : null)),
    ...proposed.map((item) => nameCandidate(item.value, item.source, null, company, companyLine >= 0 ? companyLine : null)),
  ];
  const accepted = candidates.filter((candidate) => candidate.accepted).sort((a, b) => b.score - a.score);
  return { chosen: accepted[0] ?? null, candidates };
}

interface Extracted {
  contact: typeof EMPTY_CONTACT;
  confidence: number;
  nameCandidates: NameCandidate[];
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
  // Name selection is intentionally separate from generic OCR-line parsing.
  // A logo fragment must never become a name just because it appears first.
  const selected = selectName(text, company);
  const name = selected.chosen?.value || "";
  const address = lines
    .filter((l) => /road|street|avenue|lane|floor|block|sector|city|pin|zip|nagar|colony|building|suite|drive|blvd|\d{5,6}/i.test(l))
    .join(", ");

  // Confidence is driven by the deterministic contact points. If we confidently
  // have both an email and a phone, deterministic + heuristics are trusted and
  // Groq is skipped to reduce API usage.
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
    nameCandidates: selected.candidates,
  };
}

// --- Groq structuring ------------------------------------------------------
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Validate + coerce an arbitrary Groq response into the strict schema.
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

// Groq (groq.com) — OpenAI-compatible chat completions. Model is configurable
// via GROQ_MODEL and defaults to a currently supported production model.
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

async function groqStructure(text: string, debug: ScanDebug): Promise<typeof EMPTY_CONTACT | null> {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) {
    console.warn("[business-card-process] GROQ_API_KEY not set — skipping AI structuring.");
    return null;
  }
  const model = Deno.env.get("GROQ_MODEL") || DEFAULT_GROQ_MODEL;

  const system =
    "You extract contact details from raw OCR text of a business card. " +
    "Respond with ONLY a compact JSON object, no prose, no code fences. " +
    'Schema exactly: {"name":"","company":"","job_title":"","phone":"",' +
    '"email":"","website":"","address":""}. Use empty strings for unknown fields. ' +
    "The name must be the person's full human name, usually two to four alphabetic words. " +
    "Strip Mr., Mrs., Ms., Dr., and Er. Ignore logos, brands, product names, awards, " +
    "certifications, decorative text, taglines, sponsor logos, companies, and job titles. " +
    "Never put a short logo fragment or dealer, distributor, partner, lighting, electrical, " +
    "electronics, or product text in name. Pick the single best phone and email.";

  const requestBody = {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: text.slice(0, 4000) },
    ],
  };

  debugLog("groq_request", { model, payload: requestBody }, debug);

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const responseText = await resp.text();
    debugLog("groq_response", { status: resp.status, payload: responseText }, debug);
    return null;
  }
  const data = await resp.json();
  debugLog("groq_response", { status: resp.status, payload: data }, debug);
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
  const contact = validateContact(parsed);
  debugLog("groq_parsed_json", contact, debug);
  return contact;
}

// A deliberately narrow retry used only after every first-pass name candidate
// fails validation. It cannot modify company/contact fields.
async function groqNameOnly(text: string, debug: ScanDebug): Promise<string> {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) return "";
  const model = Deno.env.get("GROQ_MODEL") || DEFAULT_GROQ_MODEL;
  const requestBody = {
    model, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "From this business-card OCR text, return ONLY JSON {\"name\":\"\"}. Return the person's full human name only. Ignore logos, brands, companies, job titles, product text, taglines, addresses, emails, and phones. Strip honorifics. If no reliable two-to-four-word personal name exists, return an empty string." },
      { role: "user", content: text.slice(0, 4000) },
    ],
  };
  debugLog("groq_name_only_request", { model, payload: requestBody }, debug);
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(requestBody),
  });
  const data = await resp.json().catch(() => null);
  debugLog("groq_name_only_response", { status: resp.status, payload: data }, debug);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return "";
  try {
    const cleaned = content.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : cleaned);
    return typeof parsed?.name === "string" ? normalizeName(parsed.name) : "";
  } catch { return ""; }
}

// --- Handler ---------------------------------------------------------------
serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  try {
    const body = (await request.json()) as RequestBody;
    const debug: ScanDebug = {};
    debugLog("edge_request", {
      payload_bytes: Number(request.headers.get("content-length")) || null,
      url: request.url,
      authenticated: Boolean(request.headers.get("authorization")),
      image_mime: body.mime_type ?? null,
      image_base64_length: body.image_base64?.length ?? 0,
    }, debug);

    // 1. Obtain OCR text (from OCR.Space, or client-provided fallback text).
    let text = (body.ocr_text ?? "").trim();
    let ocrSource = "client";
    if (!text) {
      if (!body.image_base64) return json({ error: "image_base64 or ocr_text required" }, 400);
      text = await ocrSpace(body.image_base64, body.mime_type ?? "image/jpeg", debug);
      ocrSource = "ocrspace";
    }
    if (!text) {
      const final = { ...EMPTY_CONTACT, confidence: 0, source: ocrSource, raw_text: "" };
      debugLog("final_contact", final, debug);
      return json(DEBUG_SCAN ? { ...final, debug } : final);
    }
    debugLog("raw_ocr_text", text, debug);

    // 2. Deterministic extraction + confidence.
    const det = deterministicExtract(text);
    debugLog("deterministic", {
      email: det.contact.email, phone: det.contact.phone, website: det.contact.website,
      confidence: det.confidence, contact: det.contact,
    }, debug);
    debugLog("name_candidates_initial", det.nameCandidates, debug);

    // 3. Low confidence -> Groq structuring (if available). Merge, preferring
    //    Groq for descriptive fields but keeping deterministic contact points
    //    when Groq omits them.
    let contact = det.contact;
    let source = `${ocrSource}+deterministic`;
    let confidence = det.confidence;
    let groqProposedName = "";

    const HIGH = 0.75;
    // Contact-point confidence must not hide an untrusted person name. A valid
    // name is a separate requirement from email/phone/website confidence.
    if (det.confidence < HIGH || !det.contact.name) {
      const groq = await groqStructure(text, debug);
      if (groq) {
        groqProposedName = groq.name;
        contact = {
          name: groq.name || det.contact.name,
          company: groq.company || det.contact.company,
          job_title: groq.job_title || det.contact.job_title,
          phone: groq.phone || det.contact.phone,
          email: groq.email || det.contact.email,
          website: groq.website || det.contact.website,
          address: groq.address || det.contact.address,
        };
        source = `${ocrSource}+groq`;
        confidence = Math.max(det.confidence, 0.8);
      }
    }

    // Rank raw OCR lines and any Groq proposal using the same rules. A model
    // response is a candidate, not an authority over logos/brand fragments.
    let reviewed = selectName(text, contact.company, groqProposedName
      ? [{ value: groqProposedName, source: "groq" }]
      : []);
    debugLog("name_candidates_ranked", reviewed.candidates, debug);
    debugLog("name_candidates_rejected", reviewed.candidates.filter((c) => !c.accepted), debug);
    debugLog("name_candidate_chosen", reviewed.chosen, debug);

    if (!reviewed.chosen) {
      const retryName = await groqNameOnly(text, debug);
      reviewed = selectName(text, contact.company, retryName
        ? [{ value: retryName, source: "groq-name-only" }]
        : []);
      debugLog("name_candidates_second_pass", reviewed.candidates, debug);
      debugLog("name_candidate_second_pass_chosen", reviewed.chosen, debug);
    }
    contact.name = reviewed.chosen?.value || "";

    const final = { ...contact, confidence, source, raw_text: text };
    debugLog("final_contact", final, debug);
    console.log(JSON.stringify(final, null, 2));
    return json(DEBUG_SCAN ? { ...final, debug } : final);
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
