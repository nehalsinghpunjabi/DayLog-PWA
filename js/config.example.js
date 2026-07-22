// DayLog 2.0 — runtime configuration TEMPLATE.
//
// Copy this file to `js/config.js` and fill in your Supabase project values.
// `js/config.js` is git-ignored so no keys are committed.
//
// The anon key is safe to ship to browsers: Row Level Security enforces that
// each user can only ever reach their own rows. Never put the service_role key
// here — it bypasses RLS and must stay server-side only.

window.DAYLOG_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-ref.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
};
