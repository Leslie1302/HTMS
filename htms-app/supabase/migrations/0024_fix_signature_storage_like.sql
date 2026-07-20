-- ============================================================================
-- HTMS — Migration 0024: replace split_part signature policies with LIKE.
-- The split_part approach in 0021 was fragile; LIKE '..uid..%' is simpler and
-- covers both .png and .jpg uploads reliably.
-- ============================================================================

drop policy if exists sig_obj_insert on storage.objects;
create policy sig_obj_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name like 'signatures/' || auth.uid()::text || '.%'
  );

drop policy if exists sig_obj_update on storage.objects;
create policy sig_obj_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and name like 'signatures/' || auth.uid()::text || '.%'
  )
  with check (
    bucket_id = 'documents'
    and name like 'signatures/' || auth.uid()::text || '.%'
  );

drop policy if exists sig_obj_read on storage.objects;
create policy sig_obj_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (
      is_staff_role(auth_role())
      or name like 'signatures/' || auth.uid()::text || '.%'
    )
  );
