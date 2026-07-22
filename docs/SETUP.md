# DayLog 2.0 — Setup & Deployment

Complete walkthrough for a fresh deployment.

## 1. Supabase project

1. Sign in at [supabase.com](https://supabase.com) and create a new project.
2. Wait for provisioning, then open **Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY`

## 2. Database schema

Run the migrations in order. Two options:

### Option A — SQL Editor (no tooling)
Open **SQL Editor** in the dashboard and paste + run each file, in order:

1. `supabase/migrations/0001_init_schema.sql`
2. `supabase/migrations/0002_rls_policies.sql`
3. `supabase/migrations/0003_search.sql`
4. `supabase/migrations/0004_storage.sql`

### Option B — Supabase CLI

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

After applying, verify in **Table Editor** that these tables exist with RLS
enabled: `profiles`, `day_entries`, `meetings`, `photos`, `my_cards`,
`business_card_contacts`, `reminder_metadata`.

Under **Storage** you should see private buckets `photos` and `cards`.

## 3. Authentication

1. **Authentication → Providers → Email**: keep enabled.
2. For quick testing, **Authentication → Providers → Email → Confirm email**
   can be turned off so sign-ups log in immediately. Leave it on for production.
3. **Authentication → URL Configuration**: add your site URL (e.g.
   `https://YOURNAME.github.io/daylog-pwa-rebuild/`) to **Site URL** and
   **Redirect URLs** so password-reset and future OAuth redirects work.

### Enabling Apple / Google later
The client already calls `signInWithOAuth` (see `js/auth.js`). To turn them on:
1. Configure the provider under **Authentication → Providers**.
2. Add sign-in buttons that call `auth.signInWithApple()` / `auth.signInWithGoogle()`.
No schema changes are needed — new users get a `profiles` row automatically.

## 4. Business-card Edge Function

Card scanning runs server-side so no API keys reach the browser. Deploy the
function and set its secrets:

```bash
supabase functions deploy business-card-process
supabase secrets set OCR_SPACE_API_KEY=your_ocrspace_key
supabase secrets set GROK_API_KEY=your_grok_key   # optional (AI structuring)
```

- `OCR_SPACE_API_KEY` — required for image OCR.
- `GROK_API_KEY` — optional; without it the deterministic extraction is returned.

If the function is not deployed, scanning falls back to in-browser Tesseract.
See [OCR.md](OCR.md) for the full pipeline.

## 5. App configuration

```bash
cp js/config.example.js js/config.js
```

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `js/config.js`.

## 6. Run locally

```bash
python -m http.server 8080
# then open http://localhost:8080
```

Service workers require HTTP(S); `file://` will not work.

## 7. Deploy to GitHub Pages

### Automatic (recommended)
1. Push the repo to GitHub with a `main` branch.
2. **Settings → Secrets and variables → Actions → Variables** — add:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
3. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. The included `.github/workflows/deploy.yml` generates `js/config.js` from the
   variables and publishes the site. No keys are committed.

### Manual
1. Create `js/config.js` locally (it is git-ignored — you must add it on the host
   another way) **or** commit a `config.js` with your public anon key if you
   accept it being public (RLS still protects data).
2. **Settings → Pages → Deploy from a branch → `main` / root**.

After deploy, open the HTTPS URL in Safari and Add to Home Screen.

## 8. Post-deploy checklist

- [ ] Sign up creates a user and a `profiles` row.
- [ ] Saving a day writes to `day_entries` (visible in Table Editor).
- [ ] A second account cannot see the first account's rows (RLS check).
- [ ] Search returns results as you type.
- [ ] Photo attach uploads to the `photos` bucket under your user id.
- [ ] `.ics` and `.vcf` downloads open the iOS import sheets.
- [ ] Offline: reload with airplane mode on — the shell and cached data load.
