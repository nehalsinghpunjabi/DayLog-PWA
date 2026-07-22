-- DayLog 2.0 — core schema
-- Supabase is the source of truth. Every row is owned by exactly one user.
-- Multi-user isolation is enforced by Row Level Security (see 0002_rls_policies.sql).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles: application-facing mirror of auth.users
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  theme        text not null default 'system' check (theme in ('system','light','dark')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- day_entries: one saved day per (user, date)
-- ---------------------------------------------------------------------------
create table if not exists public.day_entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  entry_date   date not null,
  daily_notes  text not null,
  future_plans text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint day_entries_notes_not_blank check (length(btrim(daily_notes)) > 0),
  constraint day_entries_user_date_unique unique (user_id, entry_date)
);

-- ---------------------------------------------------------------------------
-- meetings: detected or manual calendar items attached to a day entry
-- ---------------------------------------------------------------------------
create table if not exists public.meetings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  day_entry_id     uuid references public.day_entries (id) on delete cascade,
  title            text not null,
  notes            text not null default '',
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  duration_minutes integer not null default 60 check (duration_minutes > 0),
  detected         boolean not null default true,
  created_at       timestamptz not null default now(),
  constraint meetings_time_order check (ends_at > starts_at)
);

-- ---------------------------------------------------------------------------
-- photos: metadata + optional Supabase Storage backup.
-- CRITICAL: the original image always stays in Apple Photos.
-- storage_path may be null when the user chose "attach only, do not upload".
-- ---------------------------------------------------------------------------
create table if not exists public.photos (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  day_entry_id  uuid references public.day_entries (id) on delete cascade,
  storage_path  text,
  mime_type     text not null default 'image/jpeg',
  width         integer,
  height        integer,
  byte_size     bigint,
  is_backed_up  boolean not null default false,
  local_ref     text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- my_cards: one virtual business card per user (front/back)
-- ---------------------------------------------------------------------------
create table if not exists public.my_cards (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  front_path   text,
  back_path    text,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- business_card_contacts: OCR-scanned contacts
-- ---------------------------------------------------------------------------
create table if not exists public.business_card_contacts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  name          text not null default '',
  company       text not null default '',
  job_title     text not null default '',
  phones        text[] not null default '{}',
  office_phones text[] not null default '{}',
  emails        text[] not null default '{}',
  website       text not null default '',
  address       text not null default '',
  notes         text not null default '',
  raw_ocr_text  text not null default '',
  image_path    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- reminder_metadata: retained detection records for auditing / re-export
-- ---------------------------------------------------------------------------
create table if not exists public.reminder_metadata (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  meeting_id    uuid references public.meetings (id) on delete cascade,
  source_text   text not null default '',
  detected_date date,
  detected_time text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Ordinary lookup indexes (search-specific GIN indexes live in 0003)
-- ---------------------------------------------------------------------------
create index if not exists day_entries_user_date_idx
  on public.day_entries (user_id, entry_date desc);

create index if not exists meetings_user_starts_idx
  on public.meetings (user_id, starts_at);

create index if not exists meetings_day_entry_idx
  on public.meetings (day_entry_id);

create index if not exists photos_user_created_idx
  on public.photos (user_id, created_at desc);

create index if not exists photos_day_entry_idx
  on public.photos (day_entry_id);

create index if not exists contacts_user_created_idx
  on public.business_card_contacts (user_id, created_at desc);

create index if not exists reminders_user_idx
  on public.reminder_metadata (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_day_entries_touch on public.day_entries;
create trigger trg_day_entries_touch before update on public.day_entries
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_my_cards_touch on public.my_cards;
create trigger trg_my_cards_touch before update on public.my_cards
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_contacts_touch on public.business_card_contacts;
create trigger trg_contacts_touch before update on public.business_card_contacts
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-provision a profile row when a new auth user signs up
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
