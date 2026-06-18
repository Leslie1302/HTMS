-- ============================================================================
-- HTMS — Row-Level Security. DEFAULT DENY everywhere; grant by explicit rule.
-- Roles: admin (full), officer (operate, no rate edits), transporter (own data).
-- ============================================================================

-- Enable RLS on every table (deny-all until a policy grants).
alter table transporters    enable row level security;
alter table origins         enable row level security;
alter table districts       enable row level security;
alter table distance_matrix enable row level security;
alter table rate_versions   enable row level security;
alter table fidic_params    enable row level security;
alter table rates           enable row level security;
alter table weekly_fuel     enable row level security;
alter table app_users       enable row level security;
alter table waybills        enable row level security;
alter table scans           enable row level security;
alter table invoices        enable row level security;
alter table invoice_lines   enable row level security;
alter table documents       enable row level security;
alter table audit_log       enable row level security;

-- ── Reference data: all authenticated users may READ; only admin may WRITE ──
do $$
declare t text;
begin
  foreach t in array array['transporters','origins','districts','distance_matrix',
                           'rate_versions','fidic_params','rates','weekly_fuel']
  loop
    execute format('create policy %I_read on %I for select to authenticated using (true);', t, t);
    execute format($f$create policy %1$I_admin_write on %1$I for all to authenticated
                      using (auth_role() = 'admin') with check (auth_role() = 'admin');$f$, t);
  end loop;
end $$;

-- ── app_users: a user can read their own row; admin manages all ─────────────
create policy app_users_self_read on app_users
  for select to authenticated using (id = auth.uid() or auth_role() = 'admin');
create policy app_users_admin_write on app_users
  for all to authenticated
  using (auth_role() = 'admin') with check (auth_role() = 'admin');

-- ── Waybills ────────────────────────────────────────────────────────────────
-- Read: staff see all; transporters see only their own.
create policy waybills_read on waybills
  for select to authenticated
  using (auth_role() in ('admin','officer') or transporter_id = auth_transporter_id());

-- Insert: officers/admin for anyone; transporters only for themselves.
create policy waybills_insert on waybills
  for insert to authenticated
  with check (
    auth_role() in ('admin','officer')
    or (auth_role() = 'transporter' and transporter_id = auth_transporter_id())
  );

-- Update: only while draft; transporters only their own. Locked/invoiced are immutable.
create policy waybills_update on waybills
  for update to authenticated
  using (
    status = 'draft' and (
      auth_role() in ('admin','officer')
      or (auth_role() = 'transporter' and transporter_id = auth_transporter_id())
    )
  )
  with check (
    auth_role() in ('admin','officer')
    or (auth_role() = 'transporter' and transporter_id = auth_transporter_id())
  );

-- Delete: admin only (and never a non-draft).
create policy waybills_delete on waybills
  for delete to authenticated
  using (auth_role() = 'admin' and status = 'draft');

-- ── Scans: follow the parent waybill's visibility ───────────────────────────
create policy scans_read on scans
  for select to authenticated
  using (exists (
    select 1 from waybills w where w.id = scans.waybill_id
      and (auth_role() in ('admin','officer') or w.transporter_id = auth_transporter_id())
  ));
create policy scans_insert on scans
  for insert to authenticated
  with check (exists (
    select 1 from waybills w where w.id = scans.waybill_id and w.status = 'draft'
      and (auth_role() in ('admin','officer') or w.transporter_id = auth_transporter_id())
  ));
create policy scans_delete on scans
  for delete to authenticated
  using (exists (
    select 1 from waybills w where w.id = scans.waybill_id and w.status = 'draft'
      and (auth_role() in ('admin','officer') or w.transporter_id = auth_transporter_id())
  ));

-- ── Invoices: staff manage; transporters read their own. ────────────────────
create policy invoices_read on invoices
  for select to authenticated
  using (auth_role() in ('admin','officer') or transporter_id = auth_transporter_id());

-- Officers/admin create & edit invoices only while draft.
create policy invoices_write on invoices
  for all to authenticated
  using (
    auth_role() in ('admin','officer')
    and (status = 'draft' or auth_role() = 'admin')
  )
  with check (auth_role() in ('admin','officer'));

-- Approving/locking is an UPDATE; only admin may set approved/locked.
-- (Application enforces the transition; this guards the data layer.)

-- ── Invoice lines: visible with the invoice; immutable once invoice locked ──
create policy invoice_lines_read on invoice_lines
  for select to authenticated
  using (exists (
    select 1 from invoices i where i.id = invoice_lines.invoice_id
      and (auth_role() in ('admin','officer') or i.transporter_id = auth_transporter_id())
  ));
create policy invoice_lines_write on invoice_lines
  for all to authenticated
  using (exists (
    select 1 from invoices i where i.id = invoice_lines.invoice_id
      and i.status = 'draft' and auth_role() in ('admin','officer')
  ))
  with check (exists (
    select 1 from invoices i where i.id = invoice_lines.invoice_id
      and i.status = 'draft' and auth_role() in ('admin','officer')
  ));

-- ── Documents: visible with the invoice; created by staff ───────────────────
create policy documents_read on documents
  for select to authenticated
  using (exists (
    select 1 from invoices i where i.id = documents.invoice_id
      and (auth_role() in ('admin','officer') or i.transporter_id = auth_transporter_id())
  ));
create policy documents_write on documents
  for all to authenticated
  using (auth_role() in ('admin','officer'))
  with check (auth_role() in ('admin','officer'));

-- ── Audit log: admin read-only via API; inserts happen via service role ─────
create policy audit_admin_read on audit_log
  for select to authenticated using (auth_role() = 'admin');

-- ── Immutability trigger: a locked invoice and its lines cannot change ──────
create or replace function forbid_locked_invoice_change() returns trigger
  language plpgsql as $$
begin
  if (tg_op = 'UPDATE' and old.status = 'locked')
     or (tg_op = 'DELETE' and old.status = 'locked') then
    raise exception 'Invoice % is locked and cannot be modified', old.id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger trg_invoice_lock
  before update or delete on invoices
  for each row execute function forbid_locked_invoice_change();
