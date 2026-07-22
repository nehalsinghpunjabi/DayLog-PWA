// DayLog 2.0 — calendar (.ics) and contact (.vcf) exporters.
// iPhone-friendly: opening the downloaded file hands off to Apple Calendar /
// Contacts. This intentionally replaces Android AlarmManager / ContactsContract.

function pad(n) { return String(n).padStart(2, "0"); }

// Format a Date as a UTC iCalendar timestamp: YYYYMMDDTHHMMSSZ
function icsStamp(date) {
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) + "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) + "Z"
  );
}

function icsEscape(s) {
  return String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}

// meeting: { id?, title, notes, starts_at, ends_at }
export function buildICS(meeting) {
  const uid = meeting.id || crypto.randomUUID?.() || `${Date.now()}@daylog`;
  const start = new Date(meeting.starts_at);
  const end = new Date(meeting.ends_at);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DayLog//DayLog 2.0//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@daylog.app`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(meeting.title)}`,
    `DESCRIPTION:${icsEscape(meeting.notes || "")}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(meeting.title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function vcardValues(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value || "").split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}
function vcardEscape(s) {
  return String(s || "").replace(/([,;\\\n])/g, "\\$1");
}

// contact: { name, company, job_title, phones[], office_phones[], emails[],
//            website, address, notes }
export function buildVCard(contact) {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${vcardEscape(contact.name || "Unnamed contact")}`,
    `N:${vcardEscape(contact.name || "")};;;;`,
  ];
  if (contact.company) lines.push(`ORG:${vcardEscape(contact.company)}`);
  if (contact.job_title) lines.push(`TITLE:${vcardEscape(contact.job_title)}`);
  for (const p of vcardValues(contact.phones)) lines.push(`TEL;TYPE=CELL:${vcardEscape(p)}`);
  for (const p of vcardValues(contact.office_phones)) lines.push(`TEL;TYPE=WORK:${vcardEscape(p)}`);
  for (const e of vcardValues(contact.emails)) lines.push(`EMAIL;TYPE=WORK:${vcardEscape(e)}`);
  if (contact.website) lines.push(`URL:${vcardEscape(contact.website)}`);
  if (contact.address) lines.push(`ADR;TYPE=WORK:;;${vcardEscape(contact.address)};;;;`);
  if (contact.notes) lines.push(`NOTE:${vcardEscape(contact.notes)}`);
  lines.push("END:VCARD", "");
  return lines.join("\r\n");
}

// Trigger a browser download. On iOS Safari this opens the system import sheet.
export function downloadFile(data, filename, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
}

export function safeName(name, fallback) {
  return (name || fallback).replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}
