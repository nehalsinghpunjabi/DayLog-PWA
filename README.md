# DayLog 2.0

An iPhone-first Progressive Web App that recreates the original DayLog Android
app while adding cloud sync, multi-user accounts, infinite history, and global
full-text search. Built with vanilla HTML/CSS/JavaScript on a Supabase backend.

- **Frontend:** static HTML + CSS + ES-module JavaScript (no build step)
- **Backend:** Supabase — Auth, Postgres, Storage, Edge Functions
- **Source of truth:** Supabase. IndexedDB is a cache only.
- **Data flow:** every write goes App → Supabase → local cache.

---

## Features

| Area | What it does |
|---|---|
| **Auth** | Email/password via Supabase Auth. Apple & Google sign-in are pre-wired for later. |
| **Multi-user** | Complete data isolation enforced by Row Level Security on every table and storage object. |
| **Log** | Date, daily notes (required), future plans, photo attachments, meeting detection, business-card scan. |
| **History** | Chronological, **infinite** — no expiration, archive, or retention limits. Delete only on request. |
| **Global search** | Supabase Full Text Search + trigram partial matching. Case-insensitive, search-as-you-type, fast on large datasets. Indexes notes, plans, meetings, and OCR contact fields. |
| **My Card** | Front/back virtual business card with 3D flip, fullscreen viewer, pan, replace, delete. |
| **Photos** | Originals stay in Apple Photos; Supabase Storage holds an optional backup copy. DayLog is never the sole owner. |
| **Meetings** | Offline detection of explicit/relative dates, weekdays, and times → calendar events. |
| **Calendar** | Generates `.ics` files for Apple Calendar (replaces Android AlarmManager). |
| **Business cards** | Pluggable OCR (`OCRProvider`) → editable review → duplicate check → `.vcf` export for iOS Contacts. |
| **PWA** | Manifest, service worker, offline app shell, standalone mode, safe-area/notch support, light/dark themes, install prompt. |

---

## Project structure

```
daylog-pwa-rebuild/
├── index.html                 App shell + iOS/PWA metadata
├── styles.css                 iPhone-first design system (light/dark)
├── manifest.json              PWA manifest
├── service-worker.js          Offline app-shell + runtime caching
├── js/
│   ├── config.example.js      Config template (copy to config.js)
│   ├── supabase.js            Supabase client singleton
│   ├── auth.js                Auth flows (email now; Apple/Google ready)
│   ├── app.js                 UI controller (screens, events, render)
│   ├── meetings.js            Offline meeting detection
│   ├── exporters.js           .ics + .vcf builders
│   ├── api/
│   │   ├── cache.js           IndexedDB cache layer (cache only)
│   │   ├── db.js              Supabase data access (source of truth)
│   │   └── storage.js         Photo cache + backup upload
│   └── ocr/
│       ├── provider.js        OCRProvider abstraction (Tesseract / Edge)
│       └── parse-card.js      Card field extraction + duplicate check
├── icons/                     App icons (SVG + generated PNGs)
├── supabase/
│   ├── migrations/            0001 schema · 0002 RLS · 0003 search · 0004 storage
│   ├── functions/ocr-extract/ OCR Edge Function (server-side provider abstraction)
│   ├── schema.sql             Consolidated schema (psql \i)
│   ├── policies.sql           All RLS + storage policies (standalone)
│   └── config.toml            Supabase CLI config
├── docs/
│   ├── SETUP.md               Full Supabase + deployment setup
│   ├── ARCHITECTURE.md        Data model, flow, and design decisions
│   └── OCR.md                 Adding OCR providers
└── .github/workflows/deploy.yml   GitHub Pages deploy (injects config)
```

---

## Quick start

### 1. Create a Supabase project
At [supabase.com](https://supabase.com) create a project and note the
**Project URL** and **anon public key** (Settings → API).

### 2. Apply the database
In the Supabase **SQL Editor**, run the migration files in order:

```
supabase/migrations/0001_init_schema.sql
supabase/migrations/0002_rls_policies.sql
supabase/migrations/0003_search.sql
supabase/migrations/0004_storage.sql
```

or with the Supabase CLI:

```bash
supabase link --project-ref YOUR_REF
supabase db push
```

### 3. Configure the app

```bash
cp js/config.example.js js/config.js
```

Edit `js/config.js` and set `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
`js/config.js` is git-ignored, so no keys are committed.

### 4. Run locally
A service worker needs an HTTP origin — do not open with `file://`.

```bash
python -m http.server 8080
```

Open `http://localhost:8080`.

### 5. Deploy
Push to GitHub and enable Pages, or use the included Actions workflow. See
[docs/SETUP.md](docs/SETUP.md) for the full walkthrough.

---

## Add to iPhone Home Screen

1. Host over HTTPS (GitHub Pages works).
2. Open the URL in **Safari** on iPhone.
3. **Share → Add to Home Screen → Add**.
4. Launch DayLog from the Home Screen for standalone mode.

Safari does not fire the Chromium `beforeinstallprompt` event; Add to Home
Screen is the expected iOS install path.

---

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL` | `js/config.js` (or CI variable) | Project URL |
| `SUPABASE_ANON_KEY` | `js/config.js` (or CI variable) | Public anon key (safe in the browser; RLS protects data) |

No other keys are required for v1. The `service_role` key must **never** be
placed in client config — it bypasses RLS. Optional server-side OCR vendor keys
(e.g. `OCR_SPACE_API_KEY`) are set only on the Edge Function.

---

## Security model

- Every table has RLS restricting rows to `user_id = auth.uid()`.
- Storage objects are namespaced by user id; policies block cross-user access.
- The `global_search` RPC runs as invoker, so search respects RLS.
- No secrets are committed; the anon key is a public client credential by design.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.
