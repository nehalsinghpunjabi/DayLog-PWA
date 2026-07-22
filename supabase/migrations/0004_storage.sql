-- DayLog 2.0 — Storage buckets and object policies
-- Two private buckets. Objects are namespaced by user id as the first path
-- segment (e.g. "<uid>/photos/<file>"), and policies enforce that a user can
-- only touch objects under their own prefix.
--
-- Photos uploaded here are a BACKUP / SYNC copy only. The original photo always
-- remains in the user's Apple Photos library; DayLog never becomes sole owner.
--
-- NOTE: policies are written per-bucket with `bucket_id = '<name>'` (not
-- `bucket_id in ('photos','cards')`). A combined IN(...) policy is valid SQL and
-- enforces RLS correctly, but the Supabase dashboard attributes policies to a
-- bucket by matching `bucket_id = '<name>'`, so an IN(...) form shows up under
-- only one bucket (and reports 0 policies for the other). Explicit per-bucket
-- policies make the dashboard count correct and keep intent obvious.

insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('cards', 'cards', false)
on conflict (id) do nothing;

-- Drop any earlier combined policies so re-running is clean.
drop policy if exists "photos read own"   on storage.objects;
drop policy if exists "photos insert own" on storage.objects;
drop policy if exists "photos update own" on storage.objects;
drop policy if exists "photos delete own" on storage.objects;

-- ===========================================================================
-- photos bucket
-- ===========================================================================
drop policy if exists "photos read own"   on storage.objects;
create policy "photos read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos'
         and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos insert own" on storage.objects;
create policy "photos insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos update own" on storage.objects;
create policy "photos update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos delete own" on storage.objects;
create policy "photos delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- ===========================================================================
-- cards bucket
-- ===========================================================================
drop policy if exists "cards read own"   on storage.objects;
create policy "cards read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'cards'
         and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "cards insert own" on storage.objects;
create policy "cards insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'cards'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "cards update own" on storage.objects;
create policy "cards update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'cards'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'cards'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "cards delete own" on storage.objects;
create policy "cards delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'cards'
         and (storage.foldername(name))[1] = auth.uid()::text);
