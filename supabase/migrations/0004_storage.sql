-- DayLog 2.0 — Storage buckets and object policies
-- Two private buckets. Objects are namespaced by user id as the first path
-- segment (e.g. "<uid>/photos/<file>"), and policies enforce that a user can
-- only touch objects under their own prefix.
--
-- Photos uploaded here are a BACKUP / SYNC copy only. The original photo always
-- remains in the user's Apple Photos library; DayLog never becomes sole owner.

insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('cards', 'cards', false)
on conflict (id) do nothing;

-- helper: first path segment must equal the caller's uid
-- storage.foldername(name) returns text[] of the path segments.

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
