-- DayLog 2.0 — Row Level Security
-- Every table is locked to its owner. A user can never read or write another
-- user's rows. auth.uid() is the authenticated user's id from the JWT.

alter table public.profiles              enable row level security;
alter table public.day_entries           enable row level security;
alter table public.meetings              enable row level security;
alter table public.photos                enable row level security;
alter table public.my_cards              enable row level security;
alter table public.business_card_contacts enable row level security;
alter table public.reminder_metadata     enable row level security;

-- ---------------------------------------------------------------------------
-- profiles: a user manages only their own profile row
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Reusable owner policy pattern for the remaining tables
-- ---------------------------------------------------------------------------
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
