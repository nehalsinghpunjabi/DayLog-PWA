-- DayLog 2.0 — Full Text Search
-- Global search indexes day entries, meetings, and OCR contacts.
-- Requirements: partial matches, case-insensitive, search-as-you-type, fast on
-- very large datasets. We combine:
--   * generated tsvector columns + GIN indexes  -> ranked full-word FTS
--   * pg_trgm GIN indexes                        -> partial / prefix substrings
-- A single SQL function unions the sources so the client makes one round trip.

create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- ---------------------------------------------------------------------------
-- Generated search vectors
-- ---------------------------------------------------------------------------
alter table public.day_entries
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(daily_notes, '') || ' ' || coalesce(future_plans, ''))
  ) stored;

alter table public.meetings
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(title, '') || ' ' || coalesce(notes, ''))
  ) stored;

alter table public.business_card_contacts
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('english',
      coalesce(name, '') || ' ' ||
      coalesce(company, '') || ' ' ||
      coalesce(job_title, '') || ' ' ||
      array_to_string(emails, ' ') || ' ' ||
      array_to_string(phones, ' ') || ' ' ||
      array_to_string(office_phones, ' ') || ' ' ||
      coalesce(website, '') || ' ' ||
      coalesce(address, ''))
  ) stored;

-- ---------------------------------------------------------------------------
-- FTS (GIN) indexes
-- ---------------------------------------------------------------------------
create index if not exists day_entries_tsv_idx
  on public.day_entries using gin (search_tsv);
create index if not exists meetings_tsv_idx
  on public.meetings using gin (search_tsv);
create index if not exists contacts_tsv_idx
  on public.business_card_contacts using gin (search_tsv);

-- ---------------------------------------------------------------------------
-- Trigram (GIN) indexes for partial / substring / typo-tolerant matching
-- ---------------------------------------------------------------------------
create index if not exists day_entries_notes_trgm
  on public.day_entries using gin (daily_notes gin_trgm_ops);
create index if not exists day_entries_plans_trgm
  on public.day_entries using gin (future_plans gin_trgm_ops);
create index if not exists meetings_title_trgm
  on public.meetings using gin (title gin_trgm_ops);
create index if not exists contacts_name_trgm
  on public.business_card_contacts using gin (name gin_trgm_ops);
create index if not exists contacts_company_trgm
  on public.business_card_contacts using gin (company gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Unified global search RPC.
-- Runs as invoker so RLS still restricts rows to the calling user.
-- Turns a raw query into a prefix tsquery (search-as-you-type) and also
-- ILIKE-matches for partial substrings the tsquery would miss.
-- ---------------------------------------------------------------------------
create or replace function public.global_search(
  q          text,
  max_rows   integer default 50
)
returns table (
  kind        text,
  ref_id      uuid,
  entry_id    uuid,
  title       text,
  snippet     text,
  occurred_on date,
  rank        real
)
language sql
stable
security invoker
set search_path = public
as $$
  with cleaned as (
    select nullif(btrim(q), '') as term
  ),
  ts as (
    -- build a prefix tsquery: "team syn" -> 'team:* & syn:*'
    select case
      when (select term from cleaned) is null then null
      else to_tsquery('english',
        regexp_replace(
          plainto_tsquery('english', (select term from cleaned))::text,
          '''([^'']+)''', '''\1'':*', 'g'))
    end as tsq,
    '%' || (select term from cleaned) || '%' as pat
  ),
  entries as (
    select
      'day_entry'::text as kind,
      d.id              as ref_id,
      d.id              as entry_id,
      to_char(d.entry_date, 'YYYY-MM-DD') as title,
      left(coalesce(nullif(d.daily_notes, ''), d.future_plans), 160) as snippet,
      d.entry_date      as occurred_on,
      ts_rank(d.search_tsv, (select tsq from ts)) as rank
    from public.day_entries d, ts
    where (ts.tsq is not null and d.search_tsv @@ ts.tsq)
       or d.daily_notes  ilike ts.pat
       or d.future_plans ilike ts.pat
  ),
  mtgs as (
    select
      'meeting'::text as kind,
      m.id            as ref_id,
      m.day_entry_id  as entry_id,
      m.title         as title,
      left(coalesce(nullif(m.notes, ''), m.title), 160) as snippet,
      (m.starts_at at time zone 'UTC')::date as occurred_on,
      ts_rank(m.search_tsv, (select tsq from ts)) as rank
    from public.meetings m, ts
    where (ts.tsq is not null and m.search_tsv @@ ts.tsq)
       or m.title ilike ts.pat
       or m.notes ilike ts.pat
  ),
  contacts as (
    select
      'contact'::text as kind,
      c.id            as ref_id,
      null::uuid      as entry_id,
      coalesce(nullif(c.name, ''), 'Contact') as title,
      left(concat_ws(' · ',
        nullif(c.company, ''),
        nullif(c.job_title, ''),
        nullif(array_to_string(c.emails, ', '), '')), 160) as snippet,
      c.created_at::date as occurred_on,
      ts_rank(c.search_tsv, (select tsq from ts)) as rank
    from public.business_card_contacts c, ts
    where (ts.tsq is not null and c.search_tsv @@ ts.tsq)
       or c.name    ilike ts.pat
       or c.company ilike ts.pat
       or c.job_title ilike ts.pat
       or array_to_string(c.emails, ' ') ilike ts.pat
       or array_to_string(c.phones, ' ') ilike ts.pat
       or array_to_string(c.office_phones, ' ') ilike ts.pat
  )
  select * from (
    select * from entries
    union all select * from mtgs
    union all select * from contacts
  ) results
  order by rank desc nulls last, occurred_on desc nulls last
  limit greatest(1, least(max_rows, 200));
$$;

grant execute on function public.global_search(text, integer) to authenticated;
