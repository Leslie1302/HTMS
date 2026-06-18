-- ============================================================================
-- HTMS — Storage buckets + policies. Scans and generated documents are PRIVATE;
-- access only via short-lived signed URLs. Path convention enforces tenancy:
--   scans/<transporter_id>/<waybill_id>/<filename>
--   documents/<transporter_id>/<invoice_id>/<filename>
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('scans', 'scans', false), ('documents', 'documents', false)
on conflict (id) do nothing;

-- Helper: first path segment = transporter_id.
create or replace function storage_owner_transporter(name text) returns uuid
  language sql immutable as $$
  select nullif(split_part(name, '/', 1), '')::uuid;
$$;

-- ── scans bucket ────────────────────────────────────────────────────────────
create policy scans_obj_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'scans' and (
      auth_role() in ('admin','officer')
      or storage_owner_transporter(name) = auth_transporter_id()
    )
  );

create policy scans_obj_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'scans' and (
      auth_role() in ('admin','officer')
      or storage_owner_transporter(name) = auth_transporter_id()
    )
  );

create policy scans_obj_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'scans' and (
      auth_role() = 'admin'
      or storage_owner_transporter(name) = auth_transporter_id()
    )
  );

-- ── documents bucket: staff write, owner-or-staff read ──────────────────────
create policy docs_obj_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents' and (
      auth_role() in ('admin','officer')
      or storage_owner_transporter(name) = auth_transporter_id()
    )
  );

create policy docs_obj_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and auth_role() in ('admin','officer'));
