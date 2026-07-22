// DayLog 2.0 — offline meeting detection.
// Ports the APK's local parser: explicit dates (ISO / slash / month-name),
// relative dates (today / tomorrow / day after tomorrow), weekdays (incl.
// "next <weekday>"), and times (am/pm, 24h clock, "at <hour>", noon).
// Produces a meeting object with UTC-safe start/end timestamps.

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m || 0).padStart(2, "0")} ${ap}`;
}

export function dateFromText(text, base) {
  const low = text.toLowerCase();
  const d = new Date(`${base}T12:00:00`);
  if (low.includes("day after tomorrow")) { d.setDate(d.getDate() + 2); return iso(d); }
  if (low.includes("tomorrow")) { d.setDate(d.getDate() + 1); return iso(d); }
  if (low.includes("today")) return iso(d);

  const isoM = low.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoM) return iso(new Date(+isoM[1], +isoM[2] - 1, +isoM[3]));

  const slash = low.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (slash) {
    const year = slash[3]
      ? (slash[3].length === 2 ? +("20" + slash[3]) : +slash[3])
      : d.getFullYear();
    const cand = new Date(year, +slash[2] - 1, +slash[1]);
    if (!slash[3] && cand < new Date(`${base}T00:00:00`)) cand.setFullYear(cand.getFullYear() + 1);
    return iso(cand);
  }

  const named = low.match(/\b(?:(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?)\b/);
  if (named) {
    const day = +(named[1] || named[4]);
    const mon = MONTHS[named[2] || named[3]];
    const cand = new Date(d.getFullYear(), mon, day);
    if (cand < new Date(`${base}T00:00:00`)) cand.setFullYear(cand.getFullYear() + 1);
    return iso(cand);
  }

  const wd = WEEK.find((x) => new RegExp(`\\b(?:next\\s+)?${x}\\b`).test(low));
  if (wd) {
    const add = (WEEK.indexOf(wd) - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + add);
    return iso(d);
  }
  return null;
}

export function timeFromText(text) {
  const l = text.toLowerCase();
  if (l.includes("noon")) return { time: "12:00", low: false };

  let m = l.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let h = +m[1];
    const n = +(m[2] || 0);
    if (n > 59 || h > 12) return null;
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return { time: `${String(h).padStart(2, "0")}:${String(n).padStart(2, "0")}`, low: false };
  }
  m = l.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m && +m[1] < 24 && +m[2] < 60) {
    return { time: `${m[1].padStart(2, "0")}:${m[2]}`, low: false };
  }
  m = l.match(/\b(?:at|@)\s+(\d{1,2})\b/);
  if (m && +m[1] <= 12) {
    return { time: `${String(+m[1] === 12 ? 12 : +m[1]).padStart(2, "0")}:00`, low: true };
  }
  return null;
}

function toTimestamps(dateStr, timeStr, durationMinutes) {
  const start = new Date(`${dateStr}T${timeStr}:00`);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return { starts_at: start.toISOString(), ends_at: end.toISOString() };
}

// Returns { meeting?, status, confirm? }.
export function detectMeeting(text, date, durationMinutes = 60) {
  const dt0 = dateFromText(text, date);
  const tm = timeFromText(text);
  if (!dt0 && !tm) return { status: "Saved as a normal note. No date/time detected." };
  if (dt0 && !tm) return { status: `Add a time for ${dt0}, then tap Detect.` };

  let dt = dt0;
  if (!dt) {
    dt = date;
    const now = new Date();
    const x = new Date(`${dt}T${tm.time}:00`);
    if (x <= now) { x.setDate(x.getDate() + 1); dt = iso(x); }
  }

  const clean = text
    .replace(/\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|today|tomorrow|day after tomorrow|next\s+\w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|(?:at|@)\s+\d{1,2}|noon)\b/gi, " ")
    .replace(/\b(on|at|for|by)\b/gi, " ")
    .replace(/\s+/g, " ").trim()
    .replace(/^[,.:\- ]+|[,.:\- ]+$/g, "") || "Reminder";

  const startDate = new Date(`${dt}T${tm.time}:00`);
  if (startDate < new Date()) {
    return { status: "That reminder is in the past. Add a future date or time." };
  }

  const { starts_at, ends_at } = toTimestamps(dt, tm.time, durationMinutes);
  const meeting = {
    title: clean,
    notes: "Detected locally",
    starts_at,
    ends_at,
    duration_minutes: durationMinutes,
    detected: true,
    source_text: text,
    detected_date: dt,
    detected_time: tm.time,
  };
  return {
    meeting,
    status: `Reminder set for ${dt} at ${formatTime(tm.time)}`,
    confirm: tm.low,
  };
}
