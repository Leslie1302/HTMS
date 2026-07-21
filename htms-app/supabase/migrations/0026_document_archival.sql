-- ============================================================================
-- 0026 — Document archival: append-only archive bucket + document_archives table.
-- PDFs generated client-side (makeDoc / buildReviewerDoc) are uploaded here to
-- create an immutable snapshot that survives re-generation.
-- ============================================================================

-- 1. Storage bucket ──────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('archive', 'archive', false)
on conflict (id) do nothing;

-- Read: staff OR the owning transporter.
create policy archive_obj_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'archive' and (
      is_staff_role(auth_role())
      or storage_owner_transporter(name) = auth_transporter_id()
    )
  );

-- Write: authenticated users (RLS-scoped by path; staff write any, transporters write own).
create policy archive_obj_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'archive');

-- 2. Metadata table ──────────────────────────────────────────────────────────
create table document_archives (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  doc_type     doc_type not null,
  storage_path text not null,
  label        text,
  archived_by  uuid not null references app_users(id),
  archived_at  timestamptz not null default now()
);

create index idx_doc_archives_invoice on document_archives(invoice_id);

-- RLS: staff + the owning transporter can read; no direct writes (service-role only for safety).
alter table document_archives enable row level security;

create policy doc_archives_read on document_archives
  for select to authenticated
  using (
    is_staff_role(auth_role())
    or exists (
      select 1 from invoices i
      where i.id = document_archives.invoice_id
        and i.transporter_id = auth_transporter_id()
    )
  );

-- 3. Append-only trigger ─────────────────────────────────────────────────────
create or replace function doc_archives_immutable()
returns trigger
language plpgsql as $$
begin
  raise exception 'document_archives rows are append-only';
end;
$$;

create trigger doc_archives_no_update
  before update on document_archives
  for each row execute function doc_archives_immutable();

create trigger doc_archives_no_delete
  before delete on document_archives
  for each row execute function doc_archives_immutable();
