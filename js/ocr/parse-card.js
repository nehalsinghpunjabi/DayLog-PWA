// DayLog 2.0 — business-card field extraction.
// Heuristic parse of raw OCR text into the contact data model. Kept separate
// from the OCR providers so recognition and parsing evolve independently.

const JOB_WORDS = /manager|director|sales|engineer|consultant|founder|owner|ceo|cto|cfo|coo|officer|executive|head|lead|specialist|architect|designer|developer|president|partner|analyst|advisor|coordinator/i;
const COMPANY_WORDS = /pvt|ltd|llp|inc|corp|solutions|technologies|systems|services|company|enterprises|studio|industries|consultants|group|agency|global|labs|limited|private|holdings|ventures|partners/i;

export function parseCard(raw) {
  const text = raw || "";
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const emails = [...text.matchAll(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]);
  const phones = [...text.matchAll(/(?:\+?\d[\d\s().-]{6,}\d)/g)]
    .map((m) => m[0].replace(/[^\d+]/g, ""))
    .filter((p) => p.replace(/\D/g, "").length >= 7);
  const websites = [...text.matchAll(/(?:https?:\/\/)?(?:www\.)?[\w.-]+\.[A-Za-z]{2,}(?:\/\S*)?/g)]
    .map((m) => m[0]).filter((w) => !w.includes("@"));

  const jobTitle = lines.find((l) => JOB_WORDS.test(l)) || "";
  const company = lines.find((l) => l !== jobTitle && COMPANY_WORDS.test(l)) || "";
  const name = lines.find(
    (l) => l !== jobTitle && l !== company &&
      !/\d|@|www|http/i.test(l) && l.split(/\s+/).length <= 5,
  ) || "";

  const address = lines
    .filter((l) => /road|street|avenue|lane|floor|block|sector|city|pin|zip|nagar|colony|building|suite|drive|blvd|\d{5,6}/i.test(l))
    .join(", ");

  return {
    name,
    job_title: jobTitle,
    company,
    phones: [...new Set(phones)],
    office_phones: [],
    emails: [...new Set(emails)],
    website: websites[0] || "",
    address,
    notes: "",
    raw_ocr_text: text,
  };
}

// Duplicate detection: same email, or same last-7 phone digits.
export function isDuplicate(a, b) {
  const emails = (x) => (x || []).map((e) => e.toLowerCase().trim());
  const digits = (x) => (x || []).map((p) => p.replace(/\D/g, "").slice(-7)).filter(Boolean);
  const aE = emails(a.emails), bE = emails(b.emails);
  if (aE.some((e) => bE.includes(e))) return true;
  const aP = [...digits(a.phones), ...digits(a.office_phones)];
  const bP = [...digits(b.phones), ...digits(b.office_phones)];
  return aP.some((p) => bP.includes(p));
}
