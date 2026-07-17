-- ============================================================================
-- HTMS — Migration 0021: fix signature storage policies from 0018.
-- Path is signatures/<uid>.png (or .jpg), but the policies compared
-- split_part(name,'/',2) (= "<uid>.png") to auth.uid()::text (= "<uid>")
-- — never equal. Compare the path stem (without extension) instead so both
-- .png and .jpg uploads are covered.
-- ============================================================================

drop policy if exists sig_obj_insert on storage.objects;
create policy sig_obj_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'signatures'
    and split_part(name, '.', 1) = 'signatures/' || auth.uid()::text
  );

drop policy if exists sig_obj_update on storage.objects;
create policy sig_obj_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'signatures'
    and split_part(name, '.', 1) = 'signatures/' || auth.uid()::text
  )
  with check (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'signatures'
    and split_part(name, '.', 1) = 'signatures/' || auth.uid()::text
  );

drop policy if exists sig_obj_read on storage.objects;
create policy sig_obj_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'signatures'
    and (
      is_staff_role(auth_role())
      or split_part(name, '.', 1) = 'signatures/' || auth.uid()::text
    )
  );
