-- ============================================================================
-- 0027 — Receipt proofs: private `receipts` bucket + receipt_proofs table.
-- Scans of the minuted/received payment-request documents, tagged with which
-- office acknowledged the receipt (HM = Honourable Minister, CD = Chief Director).
-- Staff may view; only admin/officer may upload or remove.
-- ============================================================================

-- 1. Storage bucket ──────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Read: any staff role (admin/officer/DD/director).
create policy receipts_obj_read on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and is_staff_role(auth_role()));

-- Write: only admin/officer.
create policy receipts_obj_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and auth_role() in ('admin','officer'));

create policy receipts_obj_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and auth_role() in ('admin','officer'));

-- 2. Metadata table ──────────────────────────────────────────────────────────
create table receipt_proofs (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  recipient    text not null constraint receipt_proofs_recipient_check
                 check (recipient in ('HM','CD')),
  storage_path text not null,
  mime_type    text not null,
  byte_size    integer not null check (byte_size >= 0),
  note         text,
  uploaded_by  uuid not null default auth.uid() references app_users(id),
  uploaded_at  timestamptz not null default now()
);

create index idx_receipt_proofs_invoice on receipt_proofs(invoice_id);

-- RLS: staff read; admin/officer insert/delete (transporters denied entirely).
alter table receipt_proofs enable row level security;

create policy receipt_proofs_read on receipt_proofs
  for select to authenticated
  using (is_staff_role(auth_role()));

create policy receipt_proofs_insert on receipt_proofs
  for insert to authenticated
  with check (auth_role() in ('admin','officer'));

create policy receipt_proofs_delete on receipt_proofs
  for delete to authenticated
  using (auth_role() in ('admin','officer'));
