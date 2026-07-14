-- ============================================================================
-- HTMS — Migration 0018: E-signatures (one-time upload + per-invoice signing).
-- ============================================================================

-- ── users: signature storage path ────────────────────────────────────────────
alter table app_users add column if not exists signature_path text;

-- Update the check constraint to include the new staff roles.
alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check check (
  (role = 'transporter' and transporter_id is not null) or
  (role in ('admin','officer','deputy_director','director') and transporter_id is null)
);

-- ── invoice_signatures: one row per (invoice, slot) ──────────────────────────
create table if not exists invoice_signatures (
  invoice_id uuid not null references invoices(id) on delete cascade,
  slot       text not null check (slot in ('transporter','prepared','checked','approved')),
  user_id    uuid not null references app_users(id),
  signed_at  timestamptz not null default now(),
  primary key (invoice_id, slot)
);

-- ── is_staff_role helper (avoids repeating the in-list everywhere) ──────────
create or replace function is_staff_role(r user_role) returns boolean
  language sql immutable as $$
  select r in ('admin','officer','deputy_director','director');
$$;

-- ── RLS for invoice_signatures ───────────────────────────────────────────────
alter table invoice_signatures enable row level security;

-- SELECT: staff + the invoice's own transporter can read.
create policy invoice_signatures_read on invoice_signatures
  for select to authenticated
  using (
    is_staff_role(auth_role())
    or exists (
      select 1 from invoices i
      where i.id = invoice_signatures.invoice_id
        and i.transporter_id = auth_transporter_id()
    )
  );

-- INSERT: only via service role (Netlify function does the writing).
-- No insert policy for authed users — all attempts are denied by default-deny.

-- ── RLS updates: grant deputy_director and director SELECT where staff can ───

-- Reference data (loop over the 8 tables): already readable by all authenticated.
-- No change needed — the existing `for select to authenticated using (true)` covers them.

-- app_users: staff read (already `id = auth.uid() or auth_role() = 'admin'`).
-- Extend so new roles can read all users (they may need to see who signed what).
drop policy if exists app_users_self_read on app_users;
create policy app_users_self_read on app_users
  for select to authenticated
  using (id = auth.uid() or is_staff_role(auth_role()));

-- waybills: staff see all.
drop policy if exists waybills_read on waybills;
create policy waybills_read on waybills
  for select to authenticated
  using (is_staff_role(auth_role()) or transporter_id = auth_transporter_id());

-- scans: follow parent waybill.
drop policy if exists scans_read on scans;
create policy scans_read on scans
  for select to authenticated
  using (exists (
    select 1 from waybills w where w.id = scans.waybill_id
      and (is_staff_role(auth_role()) or w.transporter_id = auth_transporter_id())
  ));

-- invoices: staff see all.
drop policy if exists invoices_read on invoices;
create policy invoices_read on invoices
  for select to authenticated
  using (is_staff_role(auth_role()) or transporter_id = auth_transporter_id());

-- invoice_lines: follow parent invoice.
drop policy if exists invoice_lines_read on invoice_lines;
create policy invoice_lines_read on invoice_lines
  for select to authenticated
  using (exists (
    select 1 from invoices i where i.id = invoice_lines.invoice_id
      and (is_staff_role(auth_role()) or i.transporter_id = auth_transporter_id())
  ));

-- documents: follow parent invoice.
drop policy if exists documents_read on documents;
create policy documents_read on documents
  for select to authenticated
  using (exists (
    select 1 from invoices i where i.id = documents.invoice_id
      and (is_staff_role(auth_role()) or i.transporter_id = auth_transporter_id())
  ));

-- audit_log: admin + new staff roles can read.
drop policy if exists audit_admin_read on audit_log;
create policy audit_admin_read on audit_log
  for select to authenticated using (is_staff_role(auth_role()));

-- ── Storage policies: signatures in the `documents` bucket ───────────────────
-- Path convention: signatures/<user_id>.png
-- Owner can insert/update their own; all staff + owner can read.

create policy sig_obj_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'signatures'
    and split_part(name, '/', 2) = auth.uid()::text
  );

create policy sig_obj_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'signatures'
    and split_part(name, '/', 2) = auth.uid()::text
  );

create policy sig_obj_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'signatures'
    and (
      is_staff_role(auth_role())
      or split_part(name, '/', 2) = auth.uid()::text
    )
  );
