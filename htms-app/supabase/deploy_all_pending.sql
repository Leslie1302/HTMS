-- ============================================================================
-- HTMS — Combined deployment script for all pending migrations (0009–0023)
-- Run in the Supabase SQL Editor or via `supabase db push`.
-- Safe to re-run: all statements use IF NOT EXISTS / IF EXISTS guards.
-- ============================================================================

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0009 (a): scan quality flags                                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

alter table scans add column if not exists flagged_reason text;

-- Officers/admin may update scans (flag / unflag).
do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'scans_update_staff') then
    create policy scans_update_staff on scans
      for update to authenticated
      using (auth_role() in ('admin','officer'))
      with check (auth_role() in ('admin','officer'));
  end if;
end $$;

-- Staff may attach corrected scans or remove bad ones after invoicing.
do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'scans_insert_staff') then
    create policy scans_insert_staff on scans
      for insert to authenticated
      with check (auth_role() in ('admin','officer'));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'scans_delete_staff') then
    create policy scans_delete_staff on scans
      for delete to authenticated
      using (auth_role() in ('admin','officer'));
  end if;
end $$;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0009 (b): transporter checklist update policy                 ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'invoices_checklist_self') then
    create policy invoices_checklist_self on invoices
      for update to authenticated
      using (
        auth_role() = 'transporter'
        and transporter_id = auth_transporter_id()
        and stage = 'generated'
      )
      with check (
        auth_role() = 'transporter'
        and transporter_id = auth_transporter_id()
        and stage = 'generated'
      );
  end if;
end $$;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0010: officer verdict on the checklist                        ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

alter table invoices add column if not exists review_status text not null default 'pending'
  check (review_status in ('pending','approved','disapproved'));
alter table invoices add column if not exists review_note text;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0011: scans.uploaded_by defaults to the caller                ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

alter table scans alter column uploaded_by set default auth.uid();

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0012: manager / authorised signatory name for a transporter   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

alter table transporters add column if not exists manager_name text;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0013: phone number on app_users                               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

alter table app_users add column if not exists phone text;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0014: FCM device registration tokens                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

create table if not exists device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_users(id) on delete cascade,
  token        text not null unique,
  platform     text not null default 'web',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists idx_device_tokens_user on device_tokens (user_id);

alter table device_tokens enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'device_tokens_own') then
    create policy device_tokens_own on device_tokens
      for all to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end $$;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0015: allow deletion of locked invoices                       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

create or replace function forbid_locked_invoice_change() returns trigger
  language plpgsql as $$
begin
  if (tg_op = 'UPDATE' and old.status = 'locked') then
    raise exception 'Invoice % is locked and cannot be modified', old.id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0016: transporter scan resubmit for flagged documents          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'scans_resubmit_update') then
    create policy scans_resubmit_update on scans
      for update to authenticated
      using (
        auth_role() = 'transporter'
        and flagged_reason is not null
        and exists (
          select 1 from waybills w
          where w.id = scans.waybill_id and w.transporter_id = auth_transporter_id()
        )
      )
      with check (
        exists (
          select 1 from waybills w
          where w.id = scans.waybill_id and w.transporter_id = auth_transporter_id()
        )
      );
  end if;
end $$;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0017: add Deputy Director and Director review roles            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

alter type user_role add value if not exists 'deputy_director';
alter type user_role add value if not exists 'director';

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0018: E-signatures (one-time upload + per-invoice signing)    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- users: signature storage path
alter table app_users add column if not exists signature_path text;

-- Update the check constraint to include the new staff roles.
alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check check (
  (role = 'transporter' and transporter_id is not null) or
  (role in ('admin','officer','deputy_director','director') and transporter_id is null)
);

-- invoice_signatures: one row per (invoice, slot)
create table if not exists invoice_signatures (
  invoice_id uuid not null references invoices(id) on delete cascade,
  slot       text not null check (slot in ('transporter','prepared','checked','approved')),
  user_id    uuid not null references app_users(id),
  signed_at  timestamptz not null default now(),
  primary key (invoice_id, slot)
);

-- is_staff_role helper
create or replace function is_staff_role(r user_role) returns boolean
  language sql immutable as $$
  select r in ('admin','officer','deputy_director','director');
$$;

-- RLS for invoice_signatures
alter table invoice_signatures enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'invoice_signatures_read') then
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
  end if;
end $$;

-- Extend SELECT policies to cover deputy_director / director.

-- app_users: staff read all
drop policy if exists app_users_self_read on app_users;
create policy app_users_self_read on app_users
  for select to authenticated
  using (id = auth.uid() or is_staff_role(auth_role()));

-- waybills: staff see all
drop policy if exists waybills_read on waybills;
create policy waybills_read on waybills
  for select to authenticated
  using (is_staff_role(auth_role()) or transporter_id = auth_transporter_id());

-- scans: follow parent waybill
drop policy if exists scans_read on scans;
create policy scans_read on scans
  for select to authenticated
  using (exists (
    select 1 from waybills w where w.id = scans.waybill_id
      and (is_staff_role(auth_role()) or w.transporter_id = auth_transporter_id())
  ));

-- invoices: staff see all
drop policy if exists invoices_read on invoices;
create policy invoices_read on invoices
  for select to authenticated
  using (is_staff_role(auth_role()) or transporter_id = auth_transporter_id());

-- invoice_lines: follow parent invoice
drop policy if exists invoice_lines_read on invoice_lines;
create policy invoice_lines_read on invoice_lines
  for select to authenticated
  using (exists (
    select 1 from invoices i where i.id = invoice_lines.invoice_id
      and (is_staff_role(auth_role()) or i.transporter_id = auth_transporter_id())
  ));

-- documents: follow parent invoice
drop policy if exists documents_read on documents;
create policy documents_read on documents
  for select to authenticated
  using (exists (
    select 1 from invoices i where i.id = documents.invoice_id
      and (is_staff_role(auth_role()) or i.transporter_id = auth_transporter_id())
  ));

-- audit_log: staff can read
drop policy if exists audit_admin_read on audit_log;
create policy audit_admin_read on audit_log
  for select to authenticated using (is_staff_role(auth_role()));

-- Storage policies: signatures in the `documents` bucket
do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'sig_obj_insert') then
    create policy sig_obj_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'documents'
        and split_part(name, '/', 1) = 'signatures'
        and split_part(name, '/', 2) = auth.uid()::text
      );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'sig_obj_update') then
    create policy sig_obj_update on storage.objects
      for update to authenticated
      using (
        bucket_id = 'documents'
        and split_part(name, '/', 1) = 'signatures'
        and split_part(name, '/', 2) = auth.uid()::text
      );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'sig_obj_read') then
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
  end if;
end $$;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0019: drop the stale role check from 0001                     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

alter table app_users drop constraint if exists app_users_check;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0020: reviewers can READ scan files                           ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

drop policy if exists scans_obj_read on storage.objects;
create policy scans_obj_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'scans' and (
      is_staff_role(auth_role())
      or storage_owner_transporter(name) = auth_transporter_id()
    )
  );

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0021: fix signature storage policies (.png AND .jpg)           ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

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

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0022: let users save their OWN signature_path                 ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'app_users_self_update') then
    create policy app_users_self_update on app_users
      for update to authenticated
      using (id = auth.uid())
      with check (id = auth.uid());
  end if;
end $$;

create or replace function app_users_guard_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and auth_role() is distinct from 'admin'
     and (new.role is distinct from old.role
          or new.transporter_id is distinct from old.transporter_id) then
    raise exception 'Only an admin may change roles or company bindings';
  end if;
  return new;
end $$;

drop trigger if exists app_users_self_update_guard on app_users;
create trigger app_users_self_update_guard
  before update on app_users
  for each row execute function app_users_guard_self_update();

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Migration 0023: transporter letterhead scans                             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

alter table transporters add column if not exists letterhead_path text;
alter table transporters add column if not exists letterhead_insets jsonb;

-- Storage policies: letterheads in the `documents` bucket.
-- Owner (the transporter's users) can write their own; staff + owner can read.

drop policy if exists lh_obj_write on storage.objects;
create policy lh_obj_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name = 'letterheads/' || auth_transporter_id()::text || '.png'
  );

drop policy if exists lh_obj_update on storage.objects;
create policy lh_obj_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and name = 'letterheads/' || auth_transporter_id()::text || '.png'
  )
  with check (
    bucket_id = 'documents'
    and name = 'letterheads/' || auth_transporter_id()::text || '.png'
  );

drop policy if exists lh_obj_read on storage.objects;
create policy lh_obj_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'letterheads'
    and (
      is_staff_role(auth_role())
      or name = 'letterheads/' || auth_transporter_id()::text || '.png'
    )
  );

-- Transporters table: let a transporter save their own letterhead columns.
-- RLS cannot restrict columns, so a trigger blocks non-staff from editing
-- anything else on their row.

drop policy if exists transporters_self_update on transporters;
create policy transporters_self_update on transporters
  for update to authenticated
  using (id = auth_transporter_id())
  with check (id = auth_transporter_id());

create or replace function transporters_guard_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_staff_role(auth_role()) then
    if to_jsonb(new) - 'letterhead_path' - 'letterhead_insets'
       is distinct from to_jsonb(old) - 'letterhead_path' - 'letterhead_insets' then
      raise exception 'You may only update your letterhead';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists transporters_self_update_guard on transporters;
create trigger transporters_self_update_guard
  before update on transporters
  for each row execute function transporters_guard_self_update();

-- ============================================================================
-- Done. All pending migrations (0009–0023) applied.
-- ============================================================================
