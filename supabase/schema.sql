-- DayLog 2.0 — consolidated schema
-- Convenience file: applies all migrations in order for a fresh project.
-- Prefer running the numbered files in supabase/migrations/ with the Supabase
-- CLI. This mirrors them for one-shot setup in the SQL editor.

\i migrations/0001_init_schema.sql
\i migrations/0002_rls_policies.sql
\i migrations/0003_search.sql
\i migrations/0004_storage.sql
