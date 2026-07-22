-- DayLog 2.0 — all Row Level Security & Storage policies in one file.
-- Standalone convenience copy of the policy statements from
-- migrations/0002_rls_policies.sql and migrations/0004_storage.sql.
-- Run AFTER the tables and buckets exist.

-- === Table RLS =============================================================
alter table public.profiles              enable row level security;
alter table public.day_entries           enable row level security;
alter table public.meetings              enable row level security;
alter table public.photos                enable row level security;
alter table public.my_cards              enable row level security;
alter table public.business_card_contacts enable row level security;
alter table public.reminder_metadata     enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid());
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (id = auth.uid());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete using (id = auth.uid());

drop policy if exists day_entries_all on public.day_entries;
create policy day_entries_all on public.day_entries
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists meetings_all on public.meetings;
create policy meetings_all on public.meetings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists photos_all on public.photos;
create policy photos_all on public.photos
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists my_cards_all on public.my_cards;
create policy my_cards_all on public.my_cards
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists contacts_all on public.business_card_contacts;
create policy contacts_all on public.business_card_contacts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists reminders_all on public.reminder_metadata;
create policy reminders_all on public.reminder_metadata
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- === Storage object policies ===============================================
drop policy if exists "photos read own" on storage.objects;
create policy "photos read own" on storage.objects
  for select to authenticated
  using (bucket_id in ('photos','cards')
         and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos insert own" on storage.objects;
create policy "photos insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('photos','cards')
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos update own" on storage.objects;
create policy "photos update own" on storage.objects
  for update to authenticated
  using (bucket_id in ('photos','cards')
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id in ('photos','cards')
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos delete own" on storage.objects;
create policy "photos delete own" on storage.objects
  for delete to authenticated
  using (bucket_id in ('photos','cards')
         and (storage.foldername(name))[1] = auth.uid()::text);
