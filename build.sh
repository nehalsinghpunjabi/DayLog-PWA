#!/usr/bin/env bash
# DayLog 2.0 — Vercel build step.
# Generates js/config.js from environment variables so no keys are committed.
# Vercel runs this via the buildCommand in vercel.json. Node/bash are both
# available in the Vercel build image; this uses only POSIX shell + printf.
#
# Required environment variables (set in the Vercel dashboard):
#   SUPABASE_URL
#   SUPABASE_ANON_KEY

set -euo pipefail

: "${SUPABASE_URL:?SUPABASE_URL is not set. Add it in Vercel > Settings > Environment Variables.}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is not set. Add it in Vercel > Settings > Environment Variables.}"

mkdir -p js

# The anon key is a public JWT and the URL is a plain https origin — neither can
# contain a double quote or backslash, so direct interpolation is safe here.
cat > js/config.js <<EOF
// DayLog 2.0 — generated at build time from Vercel environment variables.
// Do not edit or commit; regenerated on every deploy.
window.DAYLOG_CONFIG = {
  SUPABASE_URL: "${SUPABASE_URL}",
  SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY}"
};
EOF

echo "Generated js/config.js for ${SUPABASE_URL}"
