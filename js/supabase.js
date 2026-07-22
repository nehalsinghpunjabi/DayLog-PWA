// DayLog 2.0 — Supabase client singleton.
// Loads supabase-js from an ESM CDN (cached by the service worker after first
// load) and reads credentials from window.DAYLOG_CONFIG (js/config.js).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const cfg = window.DAYLOG_CONFIG || {};

if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY ||
    cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
  console.error(
    "DayLog: missing Supabase config. Copy js/config.example.js to js/config.js " +
    "and set SUPABASE_URL and SUPABASE_ANON_KEY.");
}

export const supabase = createClient(
  cfg.SUPABASE_URL || "https://placeholder.supabase.co",
  cfg.SUPABASE_ANON_KEY || "placeholder",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

export const isConfigured = Boolean(
  cfg.SUPABASE_URL &&
  cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes("YOUR-PROJECT"),
);
