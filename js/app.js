// DayLog 2.0 — application controller.
// iPhone-first PWA. Supabase is the source of truth; IndexedDB is cache only.
// All writes flow App -> Supabase -> local cache.

import { supabase, isConfigured } from "./supabase.js";
import { auth } from "./auth.js";
import { cache } from "./api/cache.js";
import { storageApi } from "./api/storage.js";
import { entries, meetings, photos, myCard, contacts, globalSearch } from "./api/db.js";
import { detectMeeting, formatTime } from "./meetings.js";
import { buildICS, buildVCard, downloadFile, safeName } from "./exporters.js";
import { processBusinessCard } from "./ocr/extract.js";
import { isDuplicate } from "./ocr/parse-card.js";

const $ = (s) => document.querySelector(s);
const app = $("#app");

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const state = {
  ready: false,
  session: null,
  tab: "log",
  authMode: "signin",       // signin | signup | reset
  entries: [],
  contacts: [],
  card: null,
  cardDraft: { front: null, back: null, frontPath: null, backPath: null },
  draft: { date: todayISO(), daily_notes: "", future_plans: "", meetings: [], photos: [] },
  query: "",
  searchResults: null,
  modal: null,
  viewer: null,
  toast: "",
  busy: false,
  flip: false,
  theme: localStorage.getItem("daylog-theme") || "system",
  deferredInstall: null,
  scanMode: false,
  cardSide: "front",
  cardSourceMode: false,
  photoTarget: null,
  contact: null,
  scan: { blob: null, status: "idle", message: "" },
  scanToken: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(s = "") {
  return String(s).replace(/[&<>'"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}
function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Welcome back";
}
function toast(message) {
  state.toast = message;
  render();
  setTimeout(() => { if (state.toast === message) { state.toast = ""; render(); } }, 3300);
}
function btn(label, action, kind = "", disabled = false, extra = "") {
  return `<button class="button ${kind}" ${disabled ? "disabled" : ""} data-action="${action}" ${extra}>${label}</button>`;
}
function toArray(value) {
  return String(value || "").split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function authScreen() {
  const mode = state.authMode;
  const heading = mode === "signup" ? "Create your account"
    : mode === "reset" ? "Reset password" : "Welcome to DayLog";
  const configWarning = isConfigured ? "" :
    `<p class="auth-warning">Supabase is not configured. Copy <code>js/config.example.js</code> to <code>js/config.js</code> and add your project URL and anon key.</p>`;
  return `
  <main class="auth">
    <div class="auth-card">
      <div class="brand"><span class="brand-mark">◧</span><h1>DayLog</h1></div>
      <h2>${heading}</h2>
      ${configWarning}
      <form id="auth-form" class="stack">
        <div class="field"><label>Email</label>
          <input class="input" id="auth-email" type="email" autocomplete="email" inputmode="email" required placeholder="you@example.com"></div>
        ${mode !== "reset" ? `<div class="field"><label>Password</label>
          <input class="input" id="auth-password" type="password" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" required minlength="6" placeholder="••••••••"></div>` : ""}
        <button class="button" type="submit" ${state.busy ? "disabled" : ""}>
          ${state.busy ? '<i class="spinner"></i> ' : ""}${mode === "signup" ? "Create account" : mode === "reset" ? "Send reset link" : "Sign in"}
        </button>
      </form>
      <div class="auth-links">
        ${mode !== "signin" ? btn("Have an account? Sign in", "auth-signin", "link") : ""}
        ${mode === "signin" ? btn("Create account", "auth-signup", "link") : ""}
        ${mode === "signin" ? btn("Forgot password?", "auth-reset", "link") : ""}
      </div>
    </div>
  </main>`;
}

function meetingCard(m, scope) {
  const payload = esc(JSON.stringify({
    id: m.id, title: m.title, notes: m.notes,
    starts_at: m.starts_at, ends_at: m.ends_at,
  }));
  const timeLabel = formatTime(new Date(m.starts_at).toTimeString().slice(0, 5));
  const dateLabel = new Date(m.starts_at).toISOString().slice(0, 10);
  return `<article class="card meeting">
    <h3>${esc(m.title)}</h3>
    <small>${esc(dateLabel)} · ${esc(timeLabel)} · ${m.duration_minutes || 60} min</small>
    ${m.notes && m.notes !== "Detected locally" ? `<p>${esc(m.notes)}</p>` : ""}
    <div class="split">
      ${btn("＋ Add to Calendar", "calendar", "secondary", false, `data-meeting="${payload}"`)}
      ${scope === "entry" && m.id ? btn("Delete", "delete-meeting", "ghost", false, `data-meeting-id="${m.id}"`) : ""}
    </div>
  </article>`;
}

function photoStrip(list, scope) {
  if (!list?.length) return "";
  return `<div class="photo-strip">${list.map((p, i) => {
    const key = p.local_ref || p.storage_path || p.id;
    return `<div class="thumb"><img data-photo-id="${p.id}" data-media-key="${esc(key)}" data-storage="${esc(p.storage_path || "")}" alt="Photo ${i + 1}">
      <button data-action="remove-photo" data-scope="${scope}" data-photo="${p.id}" data-storage="${esc(p.storage_path || "")}" aria-label="Remove photo">×</button></div>`;
  }).join("")}</div>`;
}

function logScreen() {
  const d = state.draft;
  return `<main class="stack">
    <p class="greeting">${greeting()}</p>
    <div class="field"><label>Date</label>
      <input class="input" id="date" type="date" value="${d.date}"></div>
    <div class="field"><label>What you did today <span class="req">*</span></label>
      <textarea id="daily_notes" placeholder="Capture what mattered today…">${esc(d.daily_notes)}</textarea></div>
    <div class="field"><label>Meetings / future plans</label>
      <textarea id="future_plans" placeholder="e.g. Team sync tomorrow at 9:30 am">${esc(d.future_plans)}</textarea></div>
    <div class="split-actions">
      ${btn("📷 Attach Photo", "attach")}
      ${btn("▣ Scan Business Card", "scan", "secondary")}
    </div>
    ${photoStrip(d.photos, "draft")}
    <div class="split">
      ${btn(state.busy ? '<i class="spinner"></i> Detect' : "⌕ Detect meeting", "detect", "", !d.future_plans.trim() || state.busy)}
      <span class="status">Offline detection · calendar export</span>
    </div>
    ${d.meetings.map((m) => meetingCard(m, "draft")).join("")}
    ${btn("▣ Save Day", "save", "", state.busy)}
  </main>`;
}

function historyScreen() {
  const results = state.searchResults;
  const body = results !== null ? searchResultsHtml(results) : entriesHtml();
  return `<main>
    <div class="search">
      <input id="search" class="input" placeholder="Search everything…" value="${esc(state.query)}" autocomplete="off">
      ${state.searching ? '<i class="spinner search-spin"></i>' : ""}
    </div>
    <section id="entry-list">${body}</section>
  </main>`;
}

function entriesHtml() {
  if (!state.entries.length) {
    return `<div class="empty"><div class="empty-icon">◌</div><b>No entries yet.</b><p>Saved daily logs will appear here — forever, until you delete them.</p></div>`;
  }
  return state.entries.map((e) => `<article class="card entry" data-entry="${e.id}">
    <div class="entry-head"><h3>${esc(e.entry_date)}</h3>
      <button class="icon-btn" data-action="delete-entry" data-entry="${e.id}" aria-label="Delete entry">⌫</button></div>
    <p>${esc(e.daily_notes)}</p>
    ${e.future_plans ? `<p class="small">${esc(e.future_plans)}</p>` : ""}
    ${(e.meetings || []).map((m) => meetingCard(m, "entry")).join("")}
    ${btn("📷 Attach Photo", "attach-entry", "secondary", false, `data-entry="${e.id}"`)}
    ${photoStrip(e.photos, "entry:" + e.id)}
  </article>`).join("");
}

function searchResultsHtml(results) {
  if (!results.length) {
    return `<div class="empty"><div class="empty-icon">⌕</div><b>No matches.</b><p>Try a different word or a partial term.</p></div>`;
  }
  const icons = { day_entry: "◴", meeting: "＋", contact: "▣" };
  const labels = { day_entry: "Log", meeting: "Meeting", contact: "Contact" };
  return `<div class="results">${results.map((r) => `
    <button class="result" data-action="open-result" data-kind="${r.kind}" data-ref="${r.ref_id}" data-entry="${r.entry_id || ""}">
      <span class="result-kind">${icons[r.kind] || "•"} ${labels[r.kind] || r.kind}</span>
      <span class="result-title">${esc(r.title || "")}</span>
      <span class="result-snippet">${esc(r.snippet || "")}</span>
    </button>`).join("")}</div>`;
}

function cardPick(title, mediaKey, side) {
  return `<section class="stack">
    <b>${title}</b>
    <button class="business-card" data-action="pick-card" data-side="${side}">
      <div class="card-face">${mediaKey
        ? `<img data-media-key="${esc(mediaKey)}" alt="${title}">`
        : `<div class="card-placeholder">▧<br>Upload ${title}</div>`}</div>
    </button>
    ${btn(mediaKey ? "Replace Image" : "Choose Image", "pick-card", "secondary", false, `data-side="${side}"`)}
  </section>`;
}

function myCardScreen() {
  const c = state.card;
  const d = state.cardDraft;
  const hasDraft = d.front || d.back;

  if (!c && !hasDraft) {
    return `<main><div class="empty">
      <div class="card card-placeholder" style="aspect-ratio:1.75">
        <div><div class="empty-icon">▭</div><h2>My Virtual Card</h2>
        <p>Store your business card digitally and access it anytime.</p></div>
      </div><br>${btn("＋ Create Card", "create-card")}
    </div></main>`;
  }

  if (!c) {
    return `<main class="stack"><h2>My Virtual Card</h2>
      ${cardPick("Front Side", d.front, "front")}
      ${cardPick("Back Side", d.back, "back")}
      ${btn("▣ Save Card", "save-card", "", !d.front || !d.back || state.busy)}
    </main>`;
  }

  return `<main class="stack"><h2>My Virtual Card</h2>
    <div class="card-stage">
      <button class="business-card ${state.flip ? "flipped" : ""}" data-action="flip" aria-label="Flip virtual card">
        <div class="business-card-inner">
          <div class="card-face"><img data-media-key="${esc(c.front_path)}" data-storage="${esc(c.front_path)}" data-bucket="cards" alt="Front of card"></div>
          <div class="card-face back"><img data-media-key="${esc(c.back_path)}" data-storage="${esc(c.back_path)}" data-bucket="cards" alt="Back of card"></div>
        </div>
      </button>
    </div>
    <p class="status">Tap to flip. Use the controls to edit.</p>
    <div class="card-controls">
      ${btn("⛶ Fullscreen", "view-card", "secondary")}
      ${btn("⋮ Edit Card", "edit-card", "secondary")}
    </div>
  </main>`;
}

function contactFields(c) {
  const fields = [
    ["name", "Name"], ["job_title", "Job Title"], ["company", "Company"],
    ["phones", "Mobile Number(s)"], ["office_phones", "Office Number(s)"],
    ["emails", "Email Address(es)"], ["website", "Website"], ["address", "Address"],
  ];
  const val = (k) => Array.isArray(c[k]) ? c[k].join(", ") : (c[k] || "");
  return `<div class="stack">${fields.map(([k, l]) =>
    `<div class="field"><label>${l}</label>
     <input class="input contact-field" data-field="${k}" value="${esc(val(k))}"></div>`).join("")}
    <div class="field"><label>Notes</label>
     <textarea class="contact-field" data-field="notes">${esc(c.notes || "")}</textarea></div>
  </div>`;
}

function modal() {
  const m = state.modal;
  if (!m) return "";
  let body = "";
  if (m === "photo") {
    body = `<h2>Attach Photo</h2>
      <p class="status">Your original stays in Apple Photos — DayLog keeps a copy.</p>
      <div class="stack">${btn("📷 Take Photo", "camera")}${btn("▧ Choose From Library", "library", "secondary")}</div>`;
  }
  if (m === "card-source") {
    body = `<h2>Upload ${state.cardSide === "front" ? "Front" : "Back"} Side</h2>
      <div class="stack">${btn("📷 Camera", "camera-card")}${btn("▧ Photo Library", "library-card", "secondary")}</div>`;
  }
  if (m === "scanning") {
    body = `<h2>Scanning card</h2>
      <div class="scan-status"><i class="spinner big"></i>
        <p class="status">${esc(state.scan.message || "Processing…")}</p></div>
      <div class="actions">${btn("Cancel", "cancel-scan", "ghost")}</div>`;
  }
  if (m === "scan-error") {
    body = `<h2>Couldn't read the card</h2>
      <p class="status">${esc(state.scan.message || "Something went wrong.")}</p>
      <div class="actions">${btn("Cancel", "cancel-scan", "ghost")}${btn("Retry", "retry-scan")}</div>`;
  }
  if (m === "edit-card") {
    body = `<h2>Edit Card</h2><div class="stack">
      ${btn("Replace Front Image", "replace-front", "secondary")}
      ${btn("Replace Back Image", "replace-back", "secondary")}
      ${btn("Delete Card", "delete-card", "danger")}</div>`;
  }
  if (m === "delete-card") {
    body = `<h2>Delete Virtual Card?</h2><p>This removes both sides of your saved card.</p>
      <div class="actions">${btn("Cancel", "close", "ghost")}${btn("Delete", "confirm-delete-card", "danger")}</div>`;
  }
  if (m === "review-contact") {
    body = `<h2>Review Contact</h2>${contactFields(state.contact)}
      <div class="actions">${btn("Cancel", "close", "ghost")}${btn("Save Contact", "save-contact")}</div>`;
  }
  if (m === "duplicate") {
    body = `<h2>Possible Duplicate</h2><p>A contact in DayLog has the same phone or email.</p>
      <div class="actions">${btn("Cancel", "close", "ghost")}${btn("Save Anyway", "save-contact")}</div>`;
  }
  if (m === "theme") {
    body = `<h2>Appearance</h2><div class="stack">
      ${btn("System", "theme-system", state.theme === "system" ? "" : "secondary")}
      ${btn("Light", "theme-light", state.theme === "light" ? "" : "secondary")}
      ${btn("Dark", "theme-dark", state.theme === "dark" ? "" : "secondary")}</div>
      <div class="actions">${btn("Sign out", "signout", "danger")}${btn("Close", "close", "ghost")}</div>`;
  }
  return `<div class="modal-backdrop" data-action="close"><section class="modal" role="dialog" aria-modal="true">${body}</section></div>`;
}

function viewer() {
  if (!state.viewer) return "";
  const v = state.viewer;
  return `<section class="viewer">
    <div class="viewer-image" id="viewer-area">
      <img id="viewer-img" data-media-key="${esc(v.key)}" data-storage="${esc(v.storage || "")}" data-bucket="${esc(v.bucket || "photos")}" alt="Fullscreen image"></div>
    <div class="viewer-footer"><span>${esc(v.label || "")}</span>
      <div class="split">${v.back ? btn("Show Other Side", "viewer-back", "ghost") : ""}${btn("Close", "close-viewer", "ghost")}</div></div>
  </section>`;
}

function contactsPanel() {
  if (!state.contacts.length) return "";
  return `<section class="contacts-panel"><h3>Saved contacts</h3>${state.contacts.map((c) => `
    <article class="card contact-row">
      <div><b>${esc(c.name || "Unnamed")}</b>${c.company ? `<small> · ${esc(c.company)}</small>` : ""}
        ${c.emails?.length ? `<div class="small">${esc(c.emails.join(", "))}</div>` : ""}</div>
      <div class="split">
        ${btn("Save .vcf", "export-contact", "secondary", false, `data-contact="${c.id}"`)}
        ${btn("Delete", "delete-contact", "ghost", false, `data-contact="${c.id}"`)}
      </div>
    </article>`).join("")}</section>`;
}

function render() {
  document.body.dataset.theme = state.theme === "system" ? "" : state.theme;

  if (!state.ready) { app.innerHTML = `<div class="boot"><i class="spinner big"></i></div>`; return; }
  if (!state.session) { app.innerHTML = authScreen(); return; }

  const screen = state.tab === "log" ? logScreen()
    : state.tab === "history" ? historyScreen()
    : state.tab === "contacts" ? `<main>${state.contacts.length ? contactsPanel() : `<div class="empty"><div class="empty-icon">▣</div><b>No contacts yet.</b><p>Scan a business card from the Log screen.</p></div>`}</main>`
    : myCardScreen();

  app.innerHTML = `
    <header class="topbar"><h1>DayLog</h1>
      <button class="icon-btn" data-action="theme" aria-label="Settings">◐</button></header>
    ${state.deferredInstall ? `<div class="install">Install DayLog for a full-screen experience.${btn("Install", "install", "secondary")}</div>` : ""}
    ${screen}
    <nav class="bottom-nav">
      <button class="nav-btn ${state.tab === "log" ? "active" : ""}" data-tab="log"><b>＋</b>Log</button>
      <button class="nav-btn ${state.tab === "history" ? "active" : ""}" data-tab="history"><b>◴</b>History</button>
      <button class="nav-btn ${state.tab === "contacts" ? "active" : ""}" data-tab="contacts"><b>▣</b>Contacts</button>
      <button class="nav-btn ${state.tab === "card" ? "active" : ""}" data-tab="card"><b>▭</b>My Card</button>
    </nav>
    ${modal()}${viewer()}
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""}`;

  loadImages();
}

// Resolve every <img data-media-key> to a viewable URL via the storage helper.
async function loadImages() {
  const imgs = document.querySelectorAll("img[data-media-key]");
  for (const el of imgs) {
    const key = el.dataset.mediaKey;
    const storage = el.dataset.storage || null;
    const bucket = el.dataset.bucket || "photos";
    if (!key) continue;
    const prev = el.dataset.url;
    if (prev) URL.revokeObjectURL(prev);
    const url = await storageApi.resolveURL({ local_ref: key, storage_path: storage }, bucket);
    if (url) { el.src = url; el.dataset.url = url; }
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadAll() {
  try {
    const [list, contactList, card] = await Promise.all([
      entries.list(), contacts.list(), myCard.get(),
    ]);
    state.entries = list;
    state.contacts = (contactList || []).map(normalizeContact);
    state.card = card;
  } catch (err) {
    console.error(err);
    toast("Could not load data. Showing cached copy.");
    state.entries = await cache.all("day_entries");
  }
}
function normalizeContact(c) {
  return {
    ...c,
    phones: c.phones || [], office_phones: c.office_phones || [], emails: c.emails || [],
  };
}

// ---------------------------------------------------------------------------
// Search (as-you-type, debounced)
// ---------------------------------------------------------------------------
let searchTimer = null;
function onSearchInput(value) {
  state.query = value;
  const term = value.trim();
  if (!term) { state.searchResults = null; state.searching = false; render(); return; }
  state.searching = true;
  $("#entry-list") && ($("#entry-list").innerHTML = state.searchResults ? searchResultsHtml(state.searchResults) : entriesHtml());
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try {
      const results = await globalSearch(term, 60);
      if (state.query.trim() === term) { state.searchResults = results; state.searching = false; render(); }
    } catch (err) {
      console.error(err); state.searching = false;
      toast("Search failed. Check your connection.");
    }
  }, 200);
}

// ---------------------------------------------------------------------------
// Business-card scan flow
// ---------------------------------------------------------------------------
// Business-card scan pipeline with explicit UX states:
// photo -> upload backup -> Edge Function (OCR.Space + Groq) -> review.
// Shows a scanning modal with Cancel, and a scan-error modal with Retry/Cancel.
async function startScan(file) {
  console.info("[DayLog scan] start", { name: file?.name, size: file?.size, type: file?.type });
  const token = Symbol("scan");
  state.scanToken = token;
  state.scan = { blob: file, status: "processing", message: "Reading business card…" };
  state.modal = "scanning";
  render();
  try {
    // Keep a backup copy (original stays in Apple Photos); non-fatal on failure.
    let imagePath = null;
    try {
      const meta = await storageApi.attachPhoto(file, { backup: true });
      imagePath = meta.storage_path;
    } catch (e) { console.warn("[DayLog scan] backup upload skipped:", e?.message); }

    const result = await processBusinessCard(file);
    if (state.scanToken !== token) { console.info("[DayLog scan] cancelled; ignoring result"); return; }

    console.info("[DayLog scan] extracted contact", { source: result.source, confidence: result.confidence });
    state.contact = normalizeContact({ ...result, image_path: imagePath });
    state.scan = { blob: null, status: "idle", message: "" };
    state.modal = "review-contact";
    render();
    if (result.offlineFallback) {
      toast("Offline — scanned on-device. Review the fields.");
    } else if (result.confidence !== null && result.confidence < 0.5) {
      toast("Low-confidence scan — please review the fields.");
    }
  } catch (err) {
    if (state.scanToken !== token) return; // superseded/cancelled
    console.error("[DayLog scan] failed:", err);
    state.scan = { blob: file, status: "error", message: err?.message || "Scan failed." };
    state.modal = "scan-error";
    render();
  }
}

function cancelScan() {
  console.info("[DayLog scan] cancelled by user");
  state.scanToken = null; // any in-flight result will be ignored
  state.scan = { blob: null, status: "idle", message: "" };
  state.modal = null;
  render();
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------
app.addEventListener("submit", async (e) => {
  if (e.target.id !== "auth-form") return;
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password")?.value || "";
  state.busy = true; render();
  try {
    if (state.authMode === "reset") {
      await auth.resetPassword(email);
      toast("Password reset email sent.");
      state.authMode = "signin";
    } else if (state.authMode === "signup") {
      await auth.signUp(email, password);
      toast("Account created. Check your email if confirmation is required.");
    } else {
      await auth.signIn(email, password);
    }
  } catch (err) {
    toast(err.message || "Authentication failed.");
  } finally {
    state.busy = false; render();
  }
});

app.addEventListener("click", async (e) => {
  const tabEl = e.target.closest("[data-tab]");
  if (tabEl) { state.tab = tabEl.dataset.tab; state.flip = false; render(); return; }
  const a = e.target.closest("[data-action]");
  if (!a) return;
  const action = a.dataset.action;
  await handleAction(action, a);
});

async function handleAction(action, a) {
  switch (action) {
    case "auth-signin": state.authMode = "signin"; render(); break;
    case "auth-signup": state.authMode = "signup"; render(); break;
    case "auth-reset": state.authMode = "reset"; render(); break;
    case "signout":
      await auth.signOut();
      state.modal = null;
      break;
    case "close": state.modal = null; render(); break;
    case "theme": state.modal = "theme"; render(); break;
    case "theme-system": case "theme-light": case "theme-dark": {
      state.theme = action.replace("theme-", "");
      localStorage.setItem("daylog-theme", state.theme);
      state.modal = null; render(); break;
    }
    case "install":
      if (state.deferredInstall) {
        state.deferredInstall.prompt();
        await state.deferredInstall.userChoice;
        state.deferredInstall = null; render();
      }
      break;

    // --- photos ---
    case "attach":
      state.photoTarget = "draft"; state.scanMode = false; state.cardSourceMode = false;
      state.modal = "photo"; render(); break;
    case "attach-entry":
      state.photoTarget = "entry:" + a.dataset.entry; state.scanMode = false;
      state.cardSourceMode = false; state.modal = "photo"; render(); break;
    case "camera": case "library":
      state.modal = null; render();
      $("#" + (action === "camera" ? "camera-input" : "photo-input")).click();
      break;
    case "remove-photo": await removePhoto(a); break;

    // --- meetings ---
    case "detect": await detect(); break;
    case "calendar": {
      const m = JSON.parse(a.dataset.meeting);
      downloadFile(buildICS(m), `${safeName(m.title, "daylog-event")}.ics`, "text/calendar;charset=utf-8");
      toast("Calendar event downloaded. Open it to add to Apple Calendar.");
      break;
    }
    case "delete-meeting":
      await meetings.remove(a.dataset.meetingId);
      await refreshEntries(); toast("Meeting removed"); break;

    // --- entries ---
    case "save": await saveDay(); break;
    case "delete-entry": await deleteEntry(a.dataset.entry); break;
    case "open-result": openResult(a); break;

    // --- card ---
    case "create-card":
      state.cardDraft = { front: null, back: null }; state.cardSide = "front";
      state.modal = "card-source"; render(); break;
    case "pick-card":
      state.cardSide = a.dataset.side || "front"; state.modal = "card-source"; render(); break;
    case "replace-front": state.cardSide = "front"; state.modal = "card-source"; render(); break;
    case "replace-back": state.cardSide = "back"; state.modal = "card-source"; render(); break;
    case "camera-card": case "library-card":
      state.cardSourceMode = true; state.modal = null; render();
      $("#" + (action === "camera-card" ? "camera-input" : "photo-input")).click(); break;
    case "save-card": await saveCard(); break;
    case "flip": state.flip = !state.flip; render(); break;
    case "view-card":
      state.viewer = {
        key: state.flip ? state.card.back_path : state.card.front_path,
        storage: state.flip ? state.card.back_path : state.card.front_path,
        bucket: "cards", back: true,
      }; render(); break;
    case "edit-card": state.modal = "edit-card"; render(); break;
    case "delete-card": state.modal = "delete-card"; render(); break;
    case "confirm-delete-card": await deleteCard(); break;

    // --- viewer ---
    case "close-viewer": state.viewer = null; render(); break;
    case "viewer-back":
      state.viewer.key = state.viewer.key === state.card.front_path ? state.card.back_path : state.card.front_path;
      state.viewer.storage = state.viewer.key; render(); break;

    // --- scan / contacts ---
    case "scan":
      state.scanMode = true; state.cardSourceMode = false; state.photoTarget = null;
      state.modal = "photo"; render(); break;
    case "retry-scan":
      if (state.scan.blob) await startScan(state.scan.blob); break;
    case "cancel-scan": cancelScan(); break;
    case "save-contact": await saveContact(); break;
    case "export-contact": {
      const c = state.contacts.find((x) => x.id === a.dataset.contact);
      if (c) { downloadFile(buildVCard(c), `${safeName(c.name, "daylog-contact")}.vcf`, "text/vcard;charset=utf-8"); toast("Contact downloaded."); }
      break;
    }
    case "delete-contact":
      await contacts.remove(a.dataset.contact);
      state.contacts = state.contacts.filter((x) => x.id !== a.dataset.contact);
      toast("Contact deleted"); render(); break;
  }
}

// Runs on the Detect button press. No modal dependency: an ambiguous hour
// (e.g. "at 7") is added with a best-guess time and the toast notes it so the
// user can edit — no blocking confirmation dialog.
async function detect() {
  const r = detectMeeting(state.draft.future_plans, state.draft.date);
  if (!r.meeting) { toast(r.status); return; }
  state.draft.meetings = [r.meeting];
  toast(r.confirm ? `${r.status} — edit the time if needed` : r.status);
  render();
}

async function saveDay() {
  if (!state.draft.date || !state.draft.daily_notes.trim()) {
    toast("Date and daily notes are required."); return;
  }
  state.busy = true; render();
  try {
    const saved = await entries.save({
      entry_date: state.draft.date,
      daily_notes: state.draft.daily_notes.trim(),
      future_plans: state.draft.future_plans.trim(),
    });
    // Attach detected meetings to the saved entry.
    for (const m of state.draft.meetings) {
      await meetings.add({ ...m, day_entry_id: saved.id });
    }
    // Re-parent draft photos to the entry.
    for (const p of state.draft.photos) {
      await supabase.from("photos").update({ day_entry_id: saved.id }).eq("id", p.id);
    }
    state.draft = { date: todayISO(), daily_notes: "", future_plans: "", meetings: [], photos: [] };
    await refreshEntries();
    toast("Day saved to your account.");
  } catch (err) {
    toast(err.message || "Could not save.");
  } finally {
    state.busy = false; render();
  }
}

async function deleteEntry(id) {
  const entry = state.entries.find((e) => e.id === id);
  try {
    for (const p of entry?.photos || []) {
      if (p.storage_path) await storageApi.removeBackup("photos", p.storage_path);
    }
    await entries.remove(id);
    state.entries = state.entries.filter((e) => e.id !== id);
    toast("Entry deleted"); render();
  } catch (err) { toast(err.message); }
}

async function removePhoto(a) {
  const photoId = a.dataset.photo;
  const storage = a.dataset.storage || null;
  const scope = a.dataset.scope;
  try {
    if (storage) await storageApi.removeBackup("photos", storage);
    await photos.remove(photoId);
    if (scope === "draft") {
      state.draft.photos = state.draft.photos.filter((p) => p.id !== photoId);
    } else {
      await refreshEntries();
    }
    render();
  } catch (err) { toast(err.message); }
}

async function saveCard() {
  state.busy = true; render();
  try {
    const saved = await myCard.save({
      front_path: state.cardDraft.frontPath,
      back_path: state.cardDraft.backPath,
    });
    state.card = saved;
    state.cardDraft = { front: null, back: null, frontPath: null, backPath: null };
    toast("Virtual card saved");
  } catch (err) { toast(err.message); }
  finally { state.busy = false; render(); }
}

async function deleteCard() {
  try {
    if (state.card?.front_path) await storageApi.removeBackup("cards", state.card.front_path);
    if (state.card?.back_path) await storageApi.removeBackup("cards", state.card.back_path);
    await myCard.remove();
    state.card = null; state.modal = null; toast("Virtual card deleted"); render();
  } catch (err) { toast(err.message); }
}

async function saveContact() {
  const c = state.contact;
  const payload = {
    ...c,
    phones: Array.isArray(c.phones) ? c.phones : toArray(c.phones),
    office_phones: Array.isArray(c.office_phones) ? c.office_phones : toArray(c.office_phones),
    emails: Array.isArray(c.emails) ? c.emails : toArray(c.emails),
  };
  const existing = state.contacts.find((x) => isDuplicate(x, payload));
  if (existing && state.modal !== "duplicate") { state.modal = "duplicate"; render(); return; }
  try {
    const saved = await contacts.save(payload);
    state.contacts = [normalizeContact(saved), ...state.contacts.filter((x) => x.id !== saved.id)];
    downloadFile(buildVCard(saved), `${safeName(saved.name, "daylog-contact")}.vcf`, "text/vcard;charset=utf-8");
    state.modal = null;
    toast("Contact saved & downloaded.");
    render();
  } catch (err) { toast(err.message); }
}

function openResult(a) {
  const kind = a.dataset.kind;
  if (kind === "contact") { state.tab = "contacts"; state.query = ""; state.searchResults = null; render(); return; }
  state.tab = "history"; state.query = ""; state.searchResults = null; render();
  const entryId = a.dataset.entry || a.dataset.ref;
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-entry="${entryId}"]`);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); }
  });
}

async function refreshEntries() {
  state.entries = await entries.list();
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------
// Live-toggle the Detect button without a full re-render (a render() here would
// rebuild innerHTML and drop the textarea's focus/cursor mid-typing).
function syncDetectButton() {
  const el = document.querySelector('[data-action="detect"]');
  if (el) el.disabled = !state.draft.future_plans.trim() || state.busy;
}

app.addEventListener("input", (e) => {
  if (e.target.id === "date") state.draft.date = e.target.value;
  if (e.target.id === "daily_notes") state.draft.daily_notes = e.target.value;
  if (e.target.id === "future_plans") {
    state.draft.future_plans = e.target.value;
    syncDetectButton();
  }
  if (e.target.id === "search") onSearchInput(e.target.value);
  if (e.target.classList.contains("contact-field")) {
    const field = e.target.dataset.field;
    if (["phones", "office_phones", "emails"].includes(field)) {
      state.contact[field] = toArray(e.target.value);
    } else {
      state.contact[field] = e.target.value;
    }
  }
});

// File inputs (photo library / camera)
function wireFileInputs() {
  for (const input of [$("#photo-input"), $("#camera-input")]) {
    input.addEventListener("change", async (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      if (!files.length) return;

      if (state.scanMode) { state.scanMode = false; await startScan(files[0]); return; }

      if (state.cardSourceMode) {
        state.cardSourceMode = false;
        state.busy = true; render();
        try {
          const { path, localRef } = await storageApi.attachCardSide(files[0]);
          state.cardDraft[state.cardSide] = localRef;
          state.cardDraft[state.cardSide + "Path"] = path;
        } catch (err) { toast(err.message); }
        finally { state.busy = false; render(); }
        return;
      }

      // Day-entry / draft photos.
      state.busy = true; render();
      try {
        for (const file of files.slice(0, 10)) {
          const meta = await storageApi.attachPhoto(file, { backup: true });
          const entryId = state.photoTarget?.startsWith("entry:") ? state.photoTarget.split(":")[1] : null;
          const row = await photos.add({ ...meta, day_entry_id: entryId });
          if (state.photoTarget === "draft") state.draft.photos.push(row);
        }
        if (state.photoTarget?.startsWith("entry:")) await refreshEntries();
        toast(files.length === 1 ? "Photo attached" : "Photos attached");
      } catch (err) { toast(err.message); }
      finally { state.busy = false; state.photoTarget = null; render(); }
    });
  }
}

// Pointer pan in fullscreen viewer.
function wireViewerGestures() {
  let gesture = {};
  document.addEventListener("pointerdown", (e) => {
    if (!state.viewer || !e.target.closest("#viewer-area")) return;
    gesture = { x: e.clientX, y: e.clientY };
    e.target.setPointerCapture?.(e.pointerId);
  });
  document.addEventListener("pointermove", (e) => {
    if (!gesture.x || !state.viewer) return;
    const tx = e.clientX - gesture.x, ty = e.clientY - gesture.y;
    const img = $("#viewer-img");
    if (img) img.style.transform = `translate(${tx}px, ${ty}px)`;
  });
  document.addEventListener("pointerup", () => { gesture = {}; });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  wireFileInputs();
  wireViewerGestures();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); state.deferredInstall = e; render();
  });
  window.addEventListener("online", () => { if (state.session) refreshEntries().then(render); });

  auth.onChange(async (session) => {
    const wasSignedIn = Boolean(state.session);
    state.session = session;
    if (session && !wasSignedIn) { await loadAll(); }
    if (!session) { state.entries = []; state.contacts = []; state.card = null; }
    state.ready = true;
    render();
  });

  state.session = await auth.currentSession();
  if (state.session) await loadAll();
  state.ready = true;
  render();
}

init();
