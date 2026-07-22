# DayLog 2.0 — Architecture

## Principles

1. **Supabase is the source of truth.** Every mutation is written to Supabase
   first; only then is the IndexedDB cache updated.
2. **IndexedDB is a cache only.** It exists for fast reads and offline viewing.
   It is never consulted for conflict resolution and is safe to clear.
3. **Multi-user by default.** Row Level Security isolates every user's data at
   the database and storage layers — not in application code.
4. **iPhone-first.** Layout, gestures, safe areas, and install flow target
   Safari on iOS 17+ / iPhone 13–16.

## Write path

```
User action
   │
   ▼
js/app.js  (UI controller)
   │
   ▼
js/api/db.js  ──►  Supabase (Postgres, RLS enforced)   ◄── source of truth
   │
   ▼
js/api/cache.js  ──►  IndexedDB (cache mirror)
```

Reads try Supabase when online and fall back to the cache when offline. On
reconnect (`window 'online'` event) the entry list is refreshed from Supabase.

## Data model

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | Per-user profile mirror of `auth.users` | `id` = auth uid, `theme` |
| `day_entries` | One row per (user, date) | `entry_date`, `daily_notes`, `future_plans`, `search_tsv` |
| `meetings` | Detected/manual calendar items | `day_entry_id`, `starts_at`, `ends_at`, `search_tsv` |
| `photos` | Photo metadata + optional backup | `storage_path` (nullable), `local_ref`, `is_backed_up` |
| `my_cards` | One virtual card per user | `front_path`, `back_path` |
| `business_card_contacts` | OCR contacts | `phones[]`, `emails[]`, `search_tsv` |
| `reminder_metadata` | Retained detection audit | `meeting_id`, `source_text` |

A `handle_new_user` trigger inserts a `profiles` row on sign-up. `touch_updated_at`
maintains `updated_at` timestamps.

## Row Level Security

Every table has RLS enabled. The pattern is:

```sql
using (user_id = auth.uid()) with check (user_id = auth.uid())
```

`profiles` keys on `id = auth.uid()`. `my_cards` keys on `user_id` (its PK).
Storage objects live under `<uid>/…` and policies compare the first path segment
to `auth.uid()`. A user therefore can never read or write another user's rows or
files — the guarantee lives in the database, so a client bug cannot leak data.

## Global search

Search must be fast on very large datasets and support partial, case-insensitive,
search-as-you-type queries. We combine two index types per searchable table:

- **`tsvector` generated column + GIN index** — ranked full-word matching via
  `to_tsvector('english', …)`.
- **`pg_trgm` GIN index** — substring / partial / typo-tolerant matching via
  `ILIKE '%term%'`.

The `global_search(q, max_rows)` RPC unions day entries, meetings, and contacts,
building a **prefix tsquery** (`team:* & syn:*`) so partial last words match
while typing, and falling back to `ILIKE` for substrings the tsquery misses.
It runs `security invoker`, so RLS still restricts results to the caller. The
client debounces input (200 ms) and calls the RPC once per settle.

## Infinite history

There is no expiration, archive, or retention logic anywhere. Entries persist in
Postgres until the user explicitly deletes them. The `(user_id, entry_date desc)`
index keeps listing fast, and search relies on GIN indexes rather than full
scans, so history scales to tens of thousands of entries over many years.

## Photos & Apple Photos

The picker (`input[type=file]`) copies bytes out of Apple Photos without moving
or deleting the source, so the original always remains in the user's library.
DayLog caches the blob locally (instant + offline) and uploads an **optional**
backup copy to Supabase Storage. If the upload fails or the user is offline, the
local copy still exists and DayLog is never the sole owner of the image.

## Business-card OCR & extraction (server-side)

Card scanning runs in the `business-card-process` Edge Function so no API keys
reach the browser: image → OCR.Space → deterministic extraction + confidence →
Groq structuring only when confidence is low → validated JSON. The client
([js/ocr/extract.js](../js/ocr/extract.js)) calls the function and falls back to
in-browser Tesseract only when offline. Keys (`OCR_SPACE_API_KEY`,
`GROQ_API_KEY`) live in Supabase secrets. See [OCR.md](OCR.md).

## Offline & PWA

- `service-worker.js` caches the app shell (cache-first), Supabase API is always
  network-first (freshness), and cross-origin ESM/OCR assets are
  stale-while-revalidate so the app boots offline after first load.
- IndexedDB serves cached entries and media when offline.
- Manifest + Apple meta tags provide standalone display, icons, and theming.

## Calendar & contacts

Instead of Android AlarmManager / ContactsContract, DayLog generates standard
files: `.ics` (VEVENT with a 15-minute VALARM) for Apple Calendar and vCard 3.0
`.vcf` for iOS Contacts. Opening the downloaded file hands off to the native iOS
import sheet.

## Tech choices

- **Vanilla JS ES modules** — zero build step; deployable as static files.
- **supabase-js from an ESM CDN** — cached by the service worker after first load.
- **No framework** — keeps the bundle tiny and the APK-like feel snappy on iOS.
