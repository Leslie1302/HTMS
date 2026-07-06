-- ============================================================
-- HTMS COMPLETE SETUP — run once on a FRESH Supabase project.
-- If you already set up earlier, run only the NEW migration files
-- (0005_scans_destinations.sql, 0006_transporter_contacts.sql).
-- ============================================================


-- ░░░░░░░░░░ migrations/0001_schema.sql ░░░░░░░░░░

-- ============================================================================
-- HTMS — Schema (Ministry of Energy and Green Transition haulage billing)
-- Migration 0001: tables, enums, constraints, indexes.
-- RLS policies are in 0002_rls.sql; storage in 0003_storage.sql.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ── Enums ──────────────────────────────────────────────────────────────────
create type user_role     as enum ('admin', 'officer', 'transporter');
create type cargo_category as enum ('Material', 'Poles', 'Concrete Poles');
create type truck_size     as enum ('20', '40');
create type waybill_status as enum ('draft', 'submitted', 'invoiced', 'void');
create type invoice_status as enum ('draft', 'approved', 'locked', 'void');
create type doc_type       as enum ('invoice', 'letter');
create type fuel_status    as enum ('ok', 'flagged', 'manual');

-- ── Reference: transporters, origins, districts, distance matrix ────────────
create table transporters (
  id          uuid primary key default gen_random_uuid(),
  display_name text not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table origins (
  id   smallint primary key,
  name text not null unique
);

create table districts (
  id      serial primary key,
  name    text not null unique,   -- matches the waybill "To" value
  capital text,
  region  text
);

create table distance_matrix (
  id          bigserial primary key,
  origin_id   smallint not null references origins(id),
  district_id int not null references districts(id),
  km          numeric(10,2) not null check (km >= 0),
  unique (origin_id, district_id)
);
create index idx_distance_lookup on distance_matrix (origin_id, district_id);

-- ── Rate versioning + FIDIC params + base/escalated rates ───────────────────
create table rate_versions (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,
  effective_from date not null,
  is_active      boolean not null default false,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
-- Only one active version at a time.
create unique index uniq_active_rate_version on rate_versions (is_active) where is_active;

create table fidic_params (
  id              uuid primary key default gen_random_uuid(),
  rate_version_id uuid not null references rate_versions(id) on delete cascade,
  a numeric not null, b numeric not null, c numeric not null,
  w_old numeric not null, w_new numeric not null, f_old numeric not null,
  check (abs((a + b + c) - 1.0) < 1e-9)   -- weights must sum to 1
);

create table rates (
  id              uuid primary key default gen_random_uuid(),
  rate_version_id uuid not null references rate_versions(id) on delete cascade,
  item_key        text not null,            -- e.g. 'polePerKm', 'offloadPerPole'
  base_rate       numeric(14,7) not null,
  unique (rate_version_id, item_key)
);

-- ── Weekly fuel series (populated by the GOIL scraper) ──────────────────────
create table weekly_fuel (
  id              bigserial primary key,
  week_start      date not null unique,
  price_per_litre numeric(8,3) not null check (price_per_litre > 0),
  source_url      text,
  scraped_at      timestamptz,
  status          fuel_status not null default 'manual'
);
create index idx_weekly_fuel_week on weekly_fuel (week_start);

-- ── App users (1:1 with auth.users) — carries role + transporter binding ────
create table app_users (
  id             uuid primary key references auth.users(id) on delete cascade,
  role           user_role not null default 'transporter',
  transporter_id uuid references transporters(id),
  full_name      text,
  created_at     timestamptz not null default now(),
  -- a transporter user MUST be bound to a transporter; staff MUST NOT be
  check (
    (role = 'transporter' and transporter_id is not null) or
    (role in ('admin','officer') and transporter_id is null)
  )
);

-- ── Waybills ────────────────────────────────────────────────────────────────
create table waybills (
  id                 uuid primary key default gen_random_uuid(),
  transporter_id     uuid not null references transporters(id),
  category           cargo_category not null,
  waybill_no         text not null,
  vehicle_no         text,
  origin_id          smallint not null references origins(id),
  district_id        int not null references districts(id),
  num_poles          int not null default 0 check (num_poles >= 0),
  num_stay_blocks    int not null default 0 check (num_stay_blocks >= 0),
  num_concrete_poles int not null default 0 check (num_concrete_poles >= 0),
  truck_size         truck_size,
  num_trips          int not null default 1 check (num_trips >= 1),
  waybill_date       date not null,
  processed_date     date,
  status             waybill_status not null default 'draft',
  created_by         uuid not null references app_users(id),
  created_at         timestamptz not null default now()
);
create index idx_waybills_transporter on waybills (transporter_id);
create index idx_waybills_date on waybills (waybill_date);
create index idx_waybills_category on waybills (category);
create index idx_waybills_status on waybills (status);

-- ── Scans (uploaded supporting files; bytes live in Storage) ────────────────
create table scans (
  id           uuid primary key default gen_random_uuid(),
  waybill_id   uuid not null references waybills(id) on delete cascade,
  storage_path text not null,
  mime_type    text not null,
  byte_size    int not null check (byte_size > 0),
  uploaded_by  uuid not null references app_users(id),
  uploaded_at  timestamptz not null default now()
);
create index idx_scans_waybill on scans (waybill_id);

-- ── Invoices + lines (lines store an immutable rate snapshot) ───────────────
create table invoices (
  id              uuid primary key default gen_random_uuid(),
  transporter_id  uuid not null references transporters(id),
  rate_version_id uuid not null references rate_versions(id),
  status          invoice_status not null default 'draft',
  total_cost      numeric(16,2) not null default 0,
  period_start    date,
  period_end      date,
  reference_no    text,
  approved_by     uuid references app_users(id),
  approved_at     timestamptz,
  created_by      uuid not null references app_users(id),
  created_at      timestamptz not null default now()
);
create index idx_invoices_transporter on invoices (transporter_id);
create index idx_invoices_status on invoices (status);

create table invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references invoices(id) on delete cascade,
  waybill_id    uuid not null references waybills(id),
  distance_km   numeric(10,2) not null,
  category      cargo_category not null,
  rate_snapshot jsonb not null,   -- {fuelPrice, factor, rates:{...}} at calc time
  computed_cost numeric(16,2) not null,
  unique (invoice_id, waybill_id)
);
create index idx_invoice_lines_invoice on invoice_lines (invoice_id);

-- ── Generated documents ─────────────────────────────────────────────────────
create table documents (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  type         doc_type not null,
  storage_path text not null,
  reference_no text,
  generated_by uuid not null references app_users(id),
  generated_at timestamptz not null default now()
);

-- ── Append-only audit log ────────────────────────────────────────────────────
create table audit_log (
  id         bigserial primary key,
  actor_id   uuid,
  action     text not null,
  entity     text not null,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_entity on audit_log (entity, entity_id);

-- ── Helper functions to read the caller's role / transporter from JWT ────────
create or replace function auth_role() returns user_role
  language sql stable security definer set search_path = public as $$
  select role from app_users where id = auth.uid();
$$;

create or replace function auth_transporter_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select transporter_id from app_users where id = auth.uid();
$$;

-- ░░░░░░░░░░ migrations/0002_rls.sql ░░░░░░░░░░

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

-- ░░░░░░░░░░ migrations/0003_storage.sql ░░░░░░░░░░

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

-- ░░░░░░░░░░ migrations/0004_auth_trigger.sql ░░░░░░░░░░

-- ============================================================================
-- Auto-provision an app_users row when a new auth user is created.
-- New users default to 'transporter' with NO transporter binding — an Admin
-- must assign their transporter_id (or promote them) before they can file
-- waybills (the check constraint + RLS keep them inert until then).
--
-- NOTE: a brand-new transporter signup would violate the app_users check
-- (transporter requires transporter_id). So we provision as a "pending" row
-- by creating staff-style rows only via Admin, and handle transporter signups
-- through an Admin invite flow. To keep signups non-blocking, we insert the
-- profile with role resolved from the auth metadata if present.
-- ============================================================================

create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  meta_role user_role;
  meta_transporter uuid;
begin
  meta_role := coalesce((new.raw_user_meta_data->>'role')::user_role, 'transporter');
  meta_transporter := nullif(new.raw_user_meta_data->>'transporter_id','')::uuid;

  -- Staff must not carry a transporter_id; transporters must.
  if meta_role = 'transporter' and meta_transporter is null then
    -- Park as officer-with-no-rights? No — instead leave unprovisioned and let
    -- Admin assign. We insert nothing; the user simply has no profile yet and
    -- every RLS policy denies them until Admin creates their app_users row.
    return new;
  end if;

  insert into app_users (id, role, transporter_id, full_name)
  values (new.id, meta_role, meta_transporter, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ░░░░░░░░░░ migrations/0005_scans_destinations.sql ░░░░░░░░░░

-- ============================================================================
-- Migration 0005:
--  (a) Three scan types per waybill: acknowledgement form, waybill, release letter.
--  (b) Multi-destination consolidated trips — when materials/poles share one trip,
--      car, and day, all waybill numbers are stored comma-separated in
--      waybills.waybill_no, and the cost is computed using the FURTHEST destination.
--      waybill_destinations holds every drop; the calc engine takes the max distance.
-- ============================================================================

-- (a) Scan types ------------------------------------------------------------
create type scan_type as enum ('acknowledgement', 'waybill', 'release_letter');

alter table scans add column if not exists scan_type scan_type not null default 'waybill';

-- (b) Multi-destination -----------------------------------------------------
create table if not exists waybill_destinations (
  id          uuid primary key default gen_random_uuid(),
  waybill_id  uuid not null references waybills(id) on delete cascade,
  district_id int  not null references districts(id),
  unique (waybill_id, district_id)
);
create index if not exists idx_waybill_dest_waybill on waybill_destinations (waybill_id);

alter table waybill_destinations enable row level security;

-- Read: follows the parent waybill's visibility.
create policy waybill_dest_read on waybill_destinations
  for select to authenticated
  using (exists (
    select 1 from waybills w where w.id = waybill_destinations.waybill_id
      and (auth_role() in ('admin','officer') or w.transporter_id = auth_transporter_id())
  ));

-- Insert/delete: only while the parent waybill is still a draft.
create policy waybill_dest_write on waybill_destinations
  for insert to authenticated
  with check (exists (
    select 1 from waybills w where w.id = waybill_destinations.waybill_id and w.status = 'draft'
      and (auth_role() in ('admin','officer') or w.transporter_id = auth_transporter_id())
  ));

create policy waybill_dest_delete on waybill_destinations
  for delete to authenticated
  using (exists (
    select 1 from waybills w where w.id = waybill_destinations.waybill_id and w.status = 'draft'
      and (auth_role() in ('admin','officer') or w.transporter_id = auth_transporter_id())
  ));

-- ░░░░░░░░░░ migrations/0006_transporter_contacts.sql ░░░░░░░░░░

-- ============================================================================
-- Migration 0006: optional transporter contact details for the document
-- letterhead (name-based makeshift header). All nullable — documents fall back
-- gracefully to just the name + monogram when these are blank.
-- ============================================================================

alter table transporters add column if not exists address     text;
alter table transporters add column if not exists email       text;
alter table transporters add column if not exists phone       text;
alter table transporters add column if not exists gps_address text;

-- ░░░░░░░░░░ migrations/0007_pri_lifecycle.sql ░░░░░░░░░░

-- ============================================================================
-- HTMS — PR/I lifecycle tracking (Phase 2)
-- Adds: pri_stage enum, invoices.stage, invoices.checklist
-- ============================================================================

do $$ begin
  create type pri_stage as enum (
    'generated',
    'submitted',
    'with_chief_director',
    'minuted_to_pd',
    'pd_processing',
    'pd_processed',
    'cd_directive_audit',
    'audit_validation',
    'returned_to_cd',
    'at_accounts',
    'paid'
  );
exception when duplicate_object then null;
end $$;

alter table invoices add column if not exists stage pri_stage not null default 'generated';
alter table invoices add column if not exists checklist jsonb not null default '{}';

-- ░░░░░░░░░░ migrations/0008_transporter_contracts.sql ░░░░░░░░░░

-- ============================================================================
-- HTMS — Per-transporter contract agreement storage
-- Adds: transporters.contract_path, transporters.contract_validated
-- ============================================================================

alter table transporters add column if not exists contract_path text;
alter table transporters add column if not exists contract_validated boolean not null default false;
alter table transporters add column if not exists manager_name text;
alter table app_users add column if not exists phone text;

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
drop policy if exists device_tokens_own on device_tokens;
create policy device_tokens_own on device_tokens
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ░░░░░░░░░░ migrations/0009_transporter_checklist.sql ░░░░░░░░░░

-- ============================================================================
-- HTMS — Transporter checklist update policy
-- Allows transporters to update checklist on their own invoices when
-- stage is 'generated'. Stage transitions remain gated by the Netlify
-- function (service_role); this only covers the checklist jsonb column.
-- ============================================================================

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

-- ░░░░░░░░░░ seed/seed.sql ░░░░░░░░░░

-- AUTO-GENERATED. Apply after migrations 0001-0009.
begin;

-- origins
insert into origins (id,name) values (1,'Tema') on conflict (id) do nothing;
insert into origins (id,name) values (2,'Takoradi') on conflict (id) do nothing;
insert into origins (id,name) values (3,'Kumasi') on conflict (id) do nothing;
insert into origins (id,name) values (4,'Ntensere') on conflict (id) do nothing;
insert into origins (id,name) values (5,'Nsawam') on conflict (id) do nothing;
insert into origins (id,name) values (6,'Asante-Akim South') on conflict (id) do nothing;

-- districts
insert into districts (name,capital,region) values ('Asunafo North','Goaso','Ahafo') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asunafo South','Kukuom','Ahafo') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asutifi North','Kenyasi','Ahafo') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asutifi South','Hwidiem','Ahafo') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tano North','Duayaw Nkwanta','Ahafo') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tano South Municipal','Bechem','Ahafo') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Adansi Asokwa','Asokwa','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Adansi North','Fomena','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Adansi South','New Edubiase','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Afigya-Kwabre','Kodie','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Afigya-Kwabre North','Boamang','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ahafo-Ano North','Tepa','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ahafo-Ano South East','Mankranso','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ahafo-Ano South West','Mankranso','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Akrofuom','Akrofuom','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Amansie Central','Jacobu','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Amansie South','Edubia','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Amansie West','Manso Nkwanta','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asante-Akim Central Municipal','Konongo','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asante-Akim North','Agogo, Ghana','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asante-Akim South','Juaso','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asokore-Mampong Municipal','Asokore Mampong','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asokwa Municipal','Asokwa','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Atwi ma-Mponua','Nyinahin','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Atwima-Kwanwoma','Foase Kokoben','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Atwima-Nwabiagya','Nkawie','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bekwai Municipal','Bekwai','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bosome-Freho','Asiwa','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bosomtwe','Kuntenase','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ej ura-Sekyedumase','Ejura','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ejisu-Juaben Municipal','Ejisu','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Juaben Municipal','Juaben','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kumasi Metropolitan','Kumasi','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kumawu','Kumawu','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kwabre East','Antoa','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kwadaso Municipal','Kwadaso','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Mampong Municipal','Mampong','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Obuasi East','Tutuka','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Obuasi Municipal','Obuasi','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Offinso Municipal','Offinso','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Offinso North','Akomadan','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Oforikrom Municipal','Oforikrom','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Old Tafo Municipal','Old Tafo','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sekyere Central','Nsuta','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sekyere East','Iffiduase','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sekyere Kumawu','Kumawu','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sekyere South','Agona','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sekyere-Afram Plains','Drobonso','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Suame Municipal','Suame','Ashanti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Banda','Banda Ahenkro','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Berekum East Municipal','Berekum','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Berekum West','Jinijini','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Dormaa Central Municipal','Dormaa Ahenkro','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Dormaa East','Wamfie','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Dormaa West','Ankrankwanta','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Jaman North','Sampa','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Jaman South','Drobo','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sunyani Municipal','Sunyani','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sunyani West','Odumase','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tain','Nsawkaw','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Wenchi','Wenchi','Bono') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Atebubu-Amantin Municipality','Atebubu','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kintampo North Municipality','Kintampo','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kintampo South','Jema','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nkoranza North','Busunya','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nkoranza South','Nkoranza','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Pru East','Yeji','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Pru West','Prang','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sene East','Kajaji','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sene West','Kwame Danso','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Techiman Municipal','Techiman','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Techiman North','Tuobodom','Bono East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Abura - Asebu - Kwamankese','Dunkwa','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Agona East','Nsaba','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Agona West Municipal','Swedru','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ajumako-Enyan-Essiam','Ajumako','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asikuma - Odoben - Brakwa','Breman Asikuma','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Assin Central Municipal','Assin Foso','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Assin North Municipal','Assin Bereku','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Assin South','Nsuaem-Kyekyewere','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Awutu Senya East Municipality','Awutu Breku','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Awutu-Senya','Kasoa','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Cape Coast Metropolitan','Cape Coast','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Effutu Municipality','Winneba','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ekumfi','Essarkyir','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Gomoa Central','Afransi','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Gomoa East','Gomoa Potsin','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Gomoa West','Apam','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Komenda-Edina-Eguafo-Abrem Municipality','Elmina','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Mfantseman Municipality','Saltpond','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Twifo Atti - Mokwa','Twifo Praso','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Twifo Hemang - Lower Denkyira','Heman','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Upper Denkyira East Municipality','Dunkwa-On-Offin','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Upper Denkyira West','Diaso','Central') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Abuakwa North Municipal','Kukurantumi','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Abuakwa South Municipal','Kibi','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Achiase','Achiase','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Akwapim North Municipal','Akropong','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Akuapem South','Aburi','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Akyemansa','Ofoase','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asene Manso-Akroso','Akyem Manso','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Asuogyaman','Atimpoku','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Atiwa East','Kwabeng','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Atiwa West','Kwabeng','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ayensuano','Coaltar','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Birim Central Municipality','Akim Oda','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Birim North','New Abirem','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Birim South','Akim Swedru','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Denkyembour','Akwatia','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('East Akim Municipality','Kibi','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Fanteakwa North','Begoro','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Fanteakwa South','Osino','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kwaebibirem','Kade','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kwahu Afram Plains North','Donkorkrom','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kwahu Afram Plains South','Tease','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kwahu East','Abetifi','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kwahu South','Mpraeso','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kwahu West Municipality','Nkawkaw','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Lower Manya Krobo Municipality','Odumase Krobo','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Lower West Akim Municipal','Asamankese','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('New Juaben Municipal','Koforidua','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('New Juaben North Municipal','Effiduase','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nsawam - Adoagyire Municipality','Nsawam','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Okere','Adukrom','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Suhum Municipal','Suhum','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Upper Manya Krobo','Asesewa','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Upper West Akim','Adeiso','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Yilo Krobo Municipal','Somanya','Eastern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ablekuma Central','Latebiokorshie','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ablekuma North Municipal','Darkuman','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ablekuma West Municipal','Dansoman','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Accra Metropolitan','Accra','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ada East','Ada Foah','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ada West','Sege','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Adenta Municipality','Adenta','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ashaiman Municipality','Ashaiman','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ayawaso Central','Mlci Ct','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ayawaso East Municipal','Dzorwulu','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ayawaso East Municipality','Nima','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ayawaso North Municipal','Abeka','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ayawaso West Municipal','Dworwulu','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ga Central Municipality','Sowutuom','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ga East Municipality','Abokobi','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ga North Municipal','Amomole','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ga South Municipal/ Weija Municipality','Weija','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ga West Municipality','Amasaman','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Korle-Klottey','Osu','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kpone - Katamanso','Kpone','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Krowor Municipal','Nungua','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('La Dade-Kotopon Municipality','La','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('La-Nkwantanang-Madina','Madina','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ledzokuku Municipal','Teshie','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ningo - Prampam','Ningo','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Okaikwai North Municipal','Tesano','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Okaikwai South Municipal?','Abeka','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Shai - Osudoku','Dodowa','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tema Metropolitan','Tema','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tema West','Sakumono','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Weija-Gbawe','Ngleshie','Greater Accra') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bunkpurugu Nakpanduri','Bunkpurugu','North East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Chereponi','Chereponi','North East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('East Mamprusi','Gambaga','North East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Mamprugu Moagduri','Yagaba','North East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('West Mamprusi Municipal','Walewale','North East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Yunyoo-Nasuan','Yunyuo','North East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nalerigu','Nalerigu','North East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Gushiegu','Gushiegu','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Karaga','Karaga','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kpandai','Kpandai','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kumbungu','Kumbungu','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Mion','Sang','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nanton','Savelugu-Nanton','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nanumba North Municipal','Bimbilla','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nanumba South','Wulensi','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Saboba','Saboba','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sagnarigu Municipal','Sagnarigu','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Savelugu Nanton','Savelugu','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tamale Metropolitan','Tamale','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tatale-Sanguli','Tatale','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tolon','Tolon','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Yendi','Yendi','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Zabzugu','Zabzugu','Northern') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Biakoye','Nkonya-Ahenkro','Oti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Jasikan','Jasikan','Oti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kadjebi','Kadjebi','Oti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Krachi East Municipality','Dambai','Oti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Krachi Nchumuru','Chinderi','Oti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Krachi West','Kete Krachi','Oti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nkwanta North','Kpasaa','Oti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nkwanta South Municipal','Nkwanta','Oti') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bole','Bole','Savannah') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Central Gonja','Buipe','Savannah') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('East Gonja Municipal','Salaga','Savannah') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('North East Gonja','Kpalbe','Savannah') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('North Gonja','Daboya','Savannah') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sawla-Tuna-Kalba','Sawla','Savannah') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('West Gonja','Damongo','Savannah') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bawku Municipal','Bawku','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bawku West','Zebilla','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Binduri','Binduri','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bolgatanga East','Zuarungu','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bolgatanga Municipality','Bolgatanga','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bongo','Bongo','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('BuiIsa South','Fumbisi','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Builsa North','Sandema','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Garu','Garu','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kasena Nankana East Municipal','Navrongo','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kasena Nankana West','Paga','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nabdam','Nangodi','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Pusiga','Pusiga','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Talensi','Tongo','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tempane','Tempane','Upper East') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Dafiama Bussief','Issa','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Jirapa Municipal','Jirapa','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Lambussie Karni','Lambussie','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Lawra','Lawra','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nadowli-Kaleo','Nadowli','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nandom','Nandom','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sissala East Municipal','Tumu','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sissala West','Gwollu','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Wa East','Funsi','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Wa Municipality','Wa','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Wa West','Wechiau','Upper West') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Adaklu','Adaklu Waya','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Afadzato South (Afadjato)','Ve Golokuati','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Agotime-Ziope','Kpetoe','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Akatsi North','Ave-Dakpa','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Akatsi South','Akatsi','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Anloga','Anloga','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Central Tongu','Adidome','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ho Municipality','Ho','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ho West','Dzolokpuita','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Hohoe Municipality','Hohoe','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Keta Municipality','Keta','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ketu North','Dzodze','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ketu South Municipality','Denu','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Kpando Municipal','Kpandu','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('North Dayi','Anfoega','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('North Tongu','Battor Dugame','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('South Dayi','Kpeve New Town','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('South Tongu','Sogakope','Volta') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ahanta West','Agona Nkwanta','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Efia-Kwesimintsim','Kwesimintsim','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Ellembelle','Nkroful','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Jomoro','Half Assini','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Mpohor','Mpohor','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Nzema East Municipality','Axim','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Prestea-Huni Valley','Bogoso','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sekondi-Takoradi Metropolitan','Sekondi','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Shama','Shama','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Tarkwa Nsuaem Municipality','Tarkwa','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Wasa-Amenfi Central','Manso Amenfi','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Wasa-Amenfi East','Wassa-Akropong','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Wasa-Amenfi West','Asankragua','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Wassa East','Daboase','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Western Capital','Takoradi','Western') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Aowin','Enchi','Western North') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bia East','Adabokrom','Western North') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bia West','Essam','Western North') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Bodi','Bodi','Western North') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Juaboso','Juaboso','Western North') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sefwi-Akontombra','Sefwi Akontombra','Western North') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sefwi-Anhwiaso-Bekwai-Bibiani','Bibiani','Western North') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Sefwi-Wiawso','Wiawso','Western North') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Suaman','Suaman-Dadieso','Western North') on conflict (name) do nothing;
insert into districts (name,capital,region) values ('Western North Capital','Sefwi Wiaso','Western North') on conflict (name) do nothing;

-- distance_matrix
insert into distance_matrix (origin_id,district_id,km) select 1,id,438 from districts where name='Asunafo North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,315 from districts where name='Asunafo North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,137 from districts where name='Asunafo North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,162.7 from districts where name='Asunafo North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,369.3 from districts where name='Asunafo North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,215 from districts where name='Asunafo North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,459 from districts where name='Asunafo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,299 from districts where name='Asunafo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,158 from districts where name='Asunafo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,183.7 from districts where name='Asunafo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,352.6 from districts where name='Asunafo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,205 from districts where name='Asunafo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,385 from districts where name='Asutifi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,347 from districts where name='Asutifi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,111 from districts where name='Asutifi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,136.7 from districts where name='Asutifi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,346.2 from districts where name='Asutifi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,201 from districts where name='Asutifi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,420 from districts where name='Asutifi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,339 from districts where name='Asutifi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,119 from districts where name='Asutifi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,144.7 from districts where name='Asutifi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,395.4 from districts where name='Asutifi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,195 from districts where name='Asutifi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,394 from districts where name='Tano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,378 from districts where name='Tano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,93 from districts where name='Tano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,118.7 from districts where name='Tano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,316.8 from districts where name='Tano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,169 from districts where name='Tano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,397 from districts where name='Tano South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,364 from districts where name='Tano South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,80 from districts where name='Tano South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,105.7 from districts where name='Tano South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,287.5 from districts where name='Tano South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,158 from districts where name='Tano South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,265 from districts where name='Adansi Asokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,232 from districts where name='Adansi Asokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,82 from districts where name='Adansi Asokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,107.7 from districts where name='Adansi Asokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,170.7 from districts where name='Adansi Asokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,83.9 from districts where name='Adansi Asokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,388 from districts where name='Adansi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,236 from districts where name='Adansi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,87 from districts where name='Adansi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,112.7 from districts where name='Adansi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,239 from districts where name='Adansi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,108 from districts where name='Adansi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,414 from districts where name='Adansi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,199 from districts where name='Adansi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,113 from districts where name='Adansi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,138.7 from districts where name='Adansi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,243.8 from districts where name='Adansi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,132 from districts where name='Adansi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,294 from districts where name='Afigya-Kwabre' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,307 from districts where name='Afigya-Kwabre' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,16 from districts where name='Afigya-Kwabre' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,41.7 from districts where name='Afigya-Kwabre' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,226.7 from districts where name='Afigya-Kwabre' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,94.8 from districts where name='Afigya-Kwabre' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,298 from districts where name='Afigya-Kwabre North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,341 from districts where name='Afigya-Kwabre North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,34 from districts where name='Afigya-Kwabre North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,59.7 from districts where name='Afigya-Kwabre North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,245.9 from districts where name='Afigya-Kwabre North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,220 from districts where name='Afigya-Kwabre North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,393 from districts where name='Ahafo-Ano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,379 from districts where name='Ahafo-Ano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,92 from districts where name='Ahafo-Ano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,117.7 from districts where name='Ahafo-Ano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,300.7 from districts where name='Ahafo-Ano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,171 from districts where name='Ahafo-Ano North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,336 from districts where name='Ahafo-Ano South East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,325 from districts where name='Ahafo-Ano South East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,35 from districts where name='Ahafo-Ano South East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,60.7 from districts where name='Ahafo-Ano South East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,263.5 from districts where name='Ahafo-Ano South East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,118 from districts where name='Ahafo-Ano South East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,336 from districts where name='Ahafo-Ano South West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,325 from districts where name='Ahafo-Ano South West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,35 from districts where name='Ahafo-Ano South West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,60.7 from districts where name='Ahafo-Ano South West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,263.5 from districts where name='Ahafo-Ano South West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,118 from districts where name='Ahafo-Ano South West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,290 from districts where name='Akrofuom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,257 from districts where name='Akrofuom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,91 from districts where name='Akrofuom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,116.7 from districts where name='Akrofuom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,182.5 from districts where name='Akrofuom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,115 from districts where name='Akrofuom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,333 from districts where name='Amansie Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,265 from districts where name='Amansie Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,32 from districts where name='Amansie Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,57.7 from districts where name='Amansie Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,309.4 from districts where name='Amansie Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,116 from districts where name='Amansie Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,132 from districts where name='Amansie South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,199 from districts where name='Amansie South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,94 from districts where name='Amansie South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,119.7 from districts where name='Amansie South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,68 from districts where name='Amansie South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,142 from districts where name='Amansie South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,74 from districts where name='Amansie West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,311 from districts where name='Amansie West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,74 from districts where name='Amansie West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,99.7 from districts where name='Amansie West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,10 from districts where name='Amansie West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,142 from districts where name='Amansie West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,246 from districts where name='Asante-Akim Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,423 from districts where name='Asante-Akim Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,55 from districts where name='Asante-Akim Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,80.7 from districts where name='Asante-Akim Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,161.8 from districts where name='Asante-Akim Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,29 from districts where name='Asante-Akim Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,385 from districts where name='Asante-Akim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,326 from districts where name='Asante-Akim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,84 from districts where name='Asante-Akim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,109.7 from districts where name='Asante-Akim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,183.8 from districts where name='Asante-Akim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,47.8 from districts where name='Asante-Akim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,235 from districts where name='Asante-Akim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,307 from districts where name='Asante-Akim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,66 from districts where name='Asante-Akim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,91.7 from districts where name='Asante-Akim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,171 from districts where name='Asante-Akim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,17.2 from districts where name='Asante-Akim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,268 from districts where name='Asokore-Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,310 from districts where name='Asokore-Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,11 from districts where name='Asokore-Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,36.7 from districts where name='Asokore-Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,152.7 from districts where name='Asokore-Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,76.2 from districts where name='Asokore-Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,369 from districts where name='Asokwa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,232 from districts where name='Asokwa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,68 from districts where name='Asokwa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,93.7 from districts where name='Asokwa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,170.7 from districts where name='Asokwa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,93.9 from districts where name='Asokwa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,360 from districts where name='Atwi ma-Mponua' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,295 from districts where name='Atwi ma-Mponua' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,59 from districts where name='Atwi ma-Mponua' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,84.7 from districts where name='Atwi ma-Mponua' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,274.7 from districts where name='Atwi ma-Mponua' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,142 from districts where name='Atwi ma-Mponua' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,296 from districts where name='Atwima-Kwanwoma' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,268 from districts where name='Atwima-Kwanwoma' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,27 from districts where name='Atwima-Kwanwoma' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,52.7 from districts where name='Atwima-Kwanwoma' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,239 from districts where name='Atwima-Kwanwoma' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,106 from districts where name='Atwima-Kwanwoma' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,330 from districts where name='Atwima-Nwabiagya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,318 from districts where name='Atwima-Nwabiagya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,29 from districts where name='Atwima-Nwabiagya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,54.7 from districts where name='Atwima-Nwabiagya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,254.8 from districts where name='Atwima-Nwabiagya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,107 from districts where name='Atwima-Nwabiagya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,340 from districts where name='Bekwai Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,248 from districts where name='Bekwai Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,39 from districts where name='Bekwai Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,64.7 from districts where name='Bekwai Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,223 from districts where name='Bekwai Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,97.2 from districts where name='Bekwai Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,258 from districts where name='Bosome-Freho' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,264 from districts where name='Bosome-Freho' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,70 from districts where name='Bosome-Freho' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,95.7 from districts where name='Bosome-Freho' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,197.4 from districts where name='Bosome-Freho' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,68.4 from districts where name='Bosome-Freho' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,270 from districts where name='Bosomtwe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,276 from districts where name='Bosomtwe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,26 from districts where name='Bosomtwe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,51.7 from districts where name='Bosomtwe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,221.5 from districts where name='Bosomtwe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,97.1 from districts where name='Bosomtwe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,398 from districts where name='Ej ura-Sekyedumase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,386 from districts where name='Ej ura-Sekyedumase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,97 from districts where name='Ej ura-Sekyedumase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,122.7 from districts where name='Ej ura-Sekyedumase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,286.1 from districts where name='Ej ura-Sekyedumase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,147 from districts where name='Ej ura-Sekyedumase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,280 from districts where name='Ejisu-Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,304 from districts where name='Ejisu-Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,21 from districts where name='Ejisu-Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,46.7 from districts where name='Ejisu-Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,206.1 from districts where name='Ejisu-Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,73.3 from districts where name='Ejisu-Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,330 from districts where name='Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,306 from districts where name='Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,29 from districts where name='Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,54.7 from districts where name='Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,214.7 from districts where name='Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,69.3 from districts where name='Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,301 from districts where name='Kumasi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,306 from districts where name='Kumasi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,25.7 from districts where name='Kumasi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,228.6 from districts where name='Kumasi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,82.3 from districts where name='Kumasi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,243 from districts where name='Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,332 from districts where name='Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,58 from districts where name='Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,83.7 from districts where name='Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,212.3 from districts where name='Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,76.3 from districts where name='Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,296 from districts where name='Kwabre East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,266 from districts where name='Kwabre East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,26 from districts where name='Kwabre East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,51.7 from districts where name='Kwabre East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,205.2 from districts where name='Kwabre East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,72.5 from districts where name='Kwabre East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,281 from districts where name='Kwadaso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,293 from districts where name='Kwadaso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,6 from districts where name='Kwadaso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,31.7 from districts where name='Kwadaso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,219.5 from districts where name='Kwadaso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,87.2 from districts where name='Kwadaso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,359 from districts where name='Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,346 from districts where name='Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,58 from districts where name='Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,83.7 from districts where name='Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,245.6 from districts where name='Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,105 from districts where name='Mampong Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,281 from districts where name='Obuasi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,243 from districts where name='Obuasi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,79 from districts where name='Obuasi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,104.7 from districts where name='Obuasi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,189.2 from districts where name='Obuasi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,197 from districts where name='Obuasi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,367 from districts where name='Obuasi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,204 from districts where name='Obuasi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,66 from districts where name='Obuasi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,91.7 from districts where name='Obuasi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,275.1 from districts where name='Obuasi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,131 from districts where name='Obuasi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,333 from districts where name='Offinso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,319 from districts where name='Offinso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,32 from districts where name='Offinso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,57.7 from districts where name='Offinso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,270.1 from districts where name='Offinso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,134 from districts where name='Offinso Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,407 from districts where name='Offinso North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,412 from districts where name='Offinso North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,106 from districts where name='Offinso North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,131.7 from districts where name='Offinso North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,343 from districts where name='Offinso North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,186 from districts where name='Offinso North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,357 from districts where name='Oforikrom Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,188 from districts where name='Oforikrom Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,130 from districts where name='Oforikrom Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,155.7 from districts where name='Oforikrom Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,293 from districts where name='Oforikrom Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,77.3 from districts where name='Oforikrom Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,120 from districts where name='Old Tafo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,295 from districts where name='Old Tafo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,166 from districts where name='Old Tafo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,191.7 from districts where name='Old Tafo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,59.4 from districts where name='Old Tafo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,84.6 from districts where name='Old Tafo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,375 from districts where name='Sekyere Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,336 from districts where name='Sekyere Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,58 from districts where name='Sekyere Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,83.7 from districts where name='Sekyere Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,232.4 from districts where name='Sekyere Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,99.5 from districts where name='Sekyere Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,300 from districts where name='Sekyere East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,317 from districts where name='Sekyere East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,40 from districts where name='Sekyere East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,65.7 from districts where name='Sekyere East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,213.1 from districts where name='Sekyere East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,80.2 from districts where name='Sekyere East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,243 from districts where name='Sekyere Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,333 from districts where name='Sekyere Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,58 from districts where name='Sekyere Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,83.7 from districts where name='Sekyere Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,209.1 from districts where name='Sekyere Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,76.3 from districts where name='Sekyere Kumawu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,348 from districts where name='Sekyere South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,182 from districts where name='Sekyere South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,47 from districts where name='Sekyere South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,72.7 from districts where name='Sekyere South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,226.2 from districts where name='Sekyere South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,93.4 from districts where name='Sekyere South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,296 from districts where name='Sekyere-Afram Plains' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,364 from districts where name='Sekyere-Afram Plains' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,248 from districts where name='Sekyere-Afram Plains' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,273.7 from districts where name='Sekyere-Afram Plains' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,236.1 from districts where name='Sekyere-Afram Plains' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,129 from districts where name='Sekyere-Afram Plains' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,301 from districts where name='Suame Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,298 from districts where name='Suame Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,9 from districts where name='Suame Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,34.7 from districts where name='Suame Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,236.7 from districts where name='Suame Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,87.5 from districts where name='Suame Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,526 from districts where name='Banda' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,540 from districts where name='Banda' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,261 from districts where name='Banda' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,286.7 from districts where name='Banda' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,445.2 from districts where name='Banda' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,324 from districts where name='Banda' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,465 from districts where name='Berekum East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,414 from districts where name='Berekum East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,164 from districts where name='Berekum East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,189.7 from districts where name='Berekum East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,370 from districts where name='Berekum East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,238 from districts where name='Berekum East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,473 from districts where name='Berekum West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,413 from districts where name='Berekum West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,172 from districts where name='Berekum West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,197.7 from districts where name='Berekum West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,378 from districts where name='Berekum West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,246 from districts where name='Berekum West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,510 from districts where name='Dormaa Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,395 from districts where name='Dormaa Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,209 from districts where name='Dormaa Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,234.7 from districts where name='Dormaa Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,428 from districts where name='Dormaa Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,284 from districts where name='Dormaa Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,494 from districts where name='Dormaa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,390 from districts where name='Dormaa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,193 from districts where name='Dormaa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,218.7 from districts where name='Dormaa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,430 from districts where name='Dormaa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,261 from districts where name='Dormaa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,562 from districts where name='Dormaa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,391 from districts where name='Dormaa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,202 from districts where name='Dormaa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,227.7 from districts where name='Dormaa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,454.4 from districts where name='Dormaa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,323 from districts where name='Dormaa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,547 from districts where name='Jaman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,486 from districts where name='Jaman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,246 from districts where name='Jaman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,271.7 from districts where name='Jaman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,463.7 from districts where name='Jaman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,319 from districts where name='Jaman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,542 from districts where name='Jaman South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,435 from districts where name='Jaman South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,188 from districts where name='Jaman South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,213.7 from districts where name='Jaman South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,400.4 from districts where name='Jaman South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,268 from districts where name='Jaman South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,431 from districts where name='Sunyani Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,417 from districts where name='Sunyani Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,130 from districts where name='Sunyani Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,155.7 from districts where name='Sunyani Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,351 from districts where name='Sunyani Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,203 from districts where name='Sunyani Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,402 from districts where name='Sunyani West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,417 from districts where name='Sunyani West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,128 from districts where name='Sunyani West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,153.7 from districts where name='Sunyani West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,26.2 from districts where name='Sunyani West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,211 from districts where name='Sunyani West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,481 from districts where name='Tain' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,360 from districts where name='Tain' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,180 from districts where name='Tain' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,205.7 from districts where name='Tain' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,408.4 from districts where name='Tain' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,261 from districts where name='Tain' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,455 from districts where name='Wenchi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,445 from districts where name='Wenchi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,154 from districts where name='Wenchi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,179.7 from districts where name='Wenchi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,132.2 from districts where name='Wenchi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,234 from districts where name='Wenchi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,462 from districts where name='Atebubu-Amantin Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,447 from districts where name='Atebubu-Amantin Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,161 from districts where name='Atebubu-Amantin Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,186.7 from districts where name='Atebubu-Amantin Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,9.3 from districts where name='Atebubu-Amantin Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,207 from districts where name='Atebubu-Amantin Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,510 from districts where name='Kintampo North Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,496 from districts where name='Kintampo North Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,209 from districts where name='Kintampo North Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,234.7 from districts where name='Kintampo North Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,405.6 from districts where name='Kintampo North Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,257 from districts where name='Kintampo North Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,433 from districts where name='Kintampo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,455 from districts where name='Kintampo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,191.8 from districts where name='Kintampo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,217.5 from districts where name='Kintampo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,360 from districts where name='Kintampo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,245 from districts where name='Kintampo South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,413 from districts where name='Nkoranza North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,456 from districts where name='Nkoranza North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,170.2 from districts where name='Nkoranza North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,195.9 from districts where name='Nkoranza North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,340.2 from districts where name='Nkoranza North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,217 from districts where name='Nkoranza North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,463 from districts where name='Nkoranza South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,434 from districts where name='Nkoranza South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,154 from districts where name='Nkoranza South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,179.7 from districts where name='Nkoranza South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,319.8 from districts where name='Nkoranza South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,198 from districts where name='Nkoranza South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,528 from districts where name='Pru East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,533 from districts where name='Pru East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,227 from districts where name='Pru East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,252.7 from districts where name='Pru East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,464 from districts where name='Pru East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,277 from districts where name='Pru East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,489 from districts where name='Pru West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,477 from districts where name='Pru West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,188 from districts where name='Pru West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,213.7 from districts where name='Pru West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,378 from districts where name='Pru West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,238 from districts where name='Pru West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,558 from districts where name='Sene East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,534 from districts where name='Sene East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,257 from districts where name='Sene East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,282.7 from districts where name='Sene East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,434 from districts where name='Sene East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,295 from districts where name='Sene East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,491 from districts where name='Sene West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,482 from districts where name='Sene West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,192 from districts where name='Sene West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,217.7 from districts where name='Sene West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,382 from districts where name='Sene West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,242 from districts where name='Sene West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,426 from districts where name='Techiman Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,431 from districts where name='Techiman Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,126 from districts where name='Techiman Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,151.7 from districts where name='Techiman Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,362 from districts where name='Techiman Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,211 from districts where name='Techiman Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,405 from districts where name='Techiman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,423 from districts where name='Techiman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,132 from districts where name='Techiman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,157.7 from districts where name='Techiman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,354 from districts where name='Techiman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,233 from districts where name='Techiman North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,468 from districts where name='Abura - Asebu - Kwamankese' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,211 from districts where name='Abura - Asebu - Kwamankese' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,97 from districts where name='Abura - Asebu - Kwamankese' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,122.7 from districts where name='Abura - Asebu - Kwamankese' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,227 from districts where name='Abura - Asebu - Kwamankese' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,282 from districts where name='Abura - Asebu - Kwamankese' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,133 from districts where name='Agona East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,174 from districts where name='Agona East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,195 from districts where name='Agona East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,220.7 from districts where name='Agona East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,59.6 from districts where name='Agona East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,143 from districts where name='Agona East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,107 from districts where name='Agona West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,182 from districts where name='Agona West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,224 from districts where name='Agona West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,249.7 from districts where name='Agona West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,59.2 from districts where name='Agona West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,160 from districts where name='Agona West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,151 from districts where name='Ajumako-Enyan-Essiam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,146 from districts where name='Ajumako-Enyan-Essiam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,191 from districts where name='Ajumako-Enyan-Essiam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,216.7 from districts where name='Ajumako-Enyan-Essiam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,93.7 from districts where name='Ajumako-Enyan-Essiam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,160 from districts where name='Ajumako-Enyan-Essiam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,174 from districts where name='Asikuma - Odoben - Brakwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,169 from districts where name='Asikuma - Odoben - Brakwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,181 from districts where name='Asikuma - Odoben - Brakwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,206.7 from districts where name='Asikuma - Odoben - Brakwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,116 from districts where name='Asikuma - Odoben - Brakwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,127 from districts where name='Asikuma - Odoben - Brakwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,241 from districts where name='Assin Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,160 from districts where name='Assin Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,134 from districts where name='Assin Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,159.7 from districts where name='Assin Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,140 from districts where name='Assin Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,156 from districts where name='Assin Central Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,267 from districts where name='Assin North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,181 from districts where name='Assin North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,113 from districts where name='Assin North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,138.7 from districts where name='Assin North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,165 from districts where name='Assin North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,136 from districts where name='Assin North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,372 from districts where name='Assin South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,171 from districts where name='Assin South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,195 from districts where name='Assin South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,220.7 from districts where name='Assin South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,106 from districts where name='Assin South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,163 from districts where name='Assin South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,64 from districts where name='Awutu Senya East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,213 from districts where name='Awutu Senya East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,253 from districts where name='Awutu Senya East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,278.7 from districts where name='Awutu Senya East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,42.9 from districts where name='Awutu Senya East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,124 from districts where name='Awutu Senya East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,64 from districts where name='Awutu-Senya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,195 from districts where name='Awutu-Senya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,256 from districts where name='Awutu-Senya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,281.7 from districts where name='Awutu-Senya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,52.1 from districts where name='Awutu-Senya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,167 from districts where name='Awutu-Senya' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,174 from districts where name='Cape Coast Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,84 from districts where name='Cape Coast Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,215 from districts where name='Cape Coast Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,240.7 from districts where name='Cape Coast Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,166 from districts where name='Cape Coast Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,219 from districts where name='Cape Coast Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,95 from districts where name='Effutu Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,167 from districts where name='Effutu Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,319 from districts where name='Effutu Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,344.7 from districts where name='Effutu Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,81.1 from districts where name='Effutu Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,169 from districts where name='Effutu Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,122 from districts where name='Ekumfi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,144 from districts where name='Ekumfi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,213 from districts where name='Ekumfi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,238.7 from districts where name='Ekumfi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,109 from districts where name='Ekumfi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,175 from districts where name='Ekumfi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,124 from districts where name='Gomoa Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,165 from districts where name='Gomoa Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,219 from districts where name='Gomoa Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,244.7 from districts where name='Gomoa Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,66.2 from districts where name='Gomoa Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,162 from districts where name='Gomoa Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,82 from districts where name='Gomoa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,183 from districts where name='Gomoa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,269 from districts where name='Gomoa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,294.7 from districts where name='Gomoa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,62.9 from districts where name='Gomoa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,177 from districts where name='Gomoa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,114 from districts where name='Gomoa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,119 from districts where name='Gomoa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,304 from districts where name='Gomoa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,329.7 from districts where name='Gomoa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,99.5 from districts where name='Gomoa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,199 from districts where name='Gomoa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,183 from districts where name='Komenda-Edina-Eguafo-Abrem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,74 from districts where name='Komenda-Edina-Eguafo-Abrem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,224 from districts where name='Komenda-Edina-Eguafo-Abrem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,249.7 from districts where name='Komenda-Edina-Eguafo-Abrem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,169 from districts where name='Komenda-Edina-Eguafo-Abrem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,246 from districts where name='Komenda-Edina-Eguafo-Abrem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,146 from districts where name='Mfantseman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,111 from districts where name='Mfantseman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,232 from districts where name='Mfantseman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,257.7 from districts where name='Mfantseman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,145 from districts where name='Mfantseman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,201 from districts where name='Mfantseman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,244 from districts where name='Twifo Atti - Mokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,118 from districts where name='Twifo Atti - Mokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,173 from districts where name='Twifo Atti - Mokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,198.7 from districts where name='Twifo Atti - Mokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,179 from districts where name='Twifo Atti - Mokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,195 from districts where name='Twifo Atti - Mokwa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,345 from districts where name='Twifo Hemang - Lower Denkyira' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,142 from districts where name='Twifo Hemang - Lower Denkyira' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,188 from districts where name='Twifo Hemang - Lower Denkyira' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,213.7 from districts where name='Twifo Hemang - Lower Denkyira' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,322 from districts where name='Twifo Hemang - Lower Denkyira' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,279 from districts where name='Twifo Hemang - Lower Denkyira' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,325 from districts where name='Upper Denkyira East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,198 from districts where name='Upper Denkyira East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,93 from districts where name='Upper Denkyira East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,118.7 from districts where name='Upper Denkyira East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,227 from districts where name='Upper Denkyira East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,163 from districts where name='Upper Denkyira East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,444 from districts where name='Upper Denkyira West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,224 from districts where name='Upper Denkyira West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,143 from districts where name='Upper Denkyira West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,168.7 from districts where name='Upper Denkyira West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,281 from districts where name='Upper Denkyira West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,212 from districts where name='Upper Denkyira West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,135 from districts where name='Abuakwa North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,460 from districts where name='Abuakwa North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,403 from districts where name='Abuakwa North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,428.7 from districts where name='Abuakwa North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,273 from districts where name='Abuakwa North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,162 from districts where name='Abuakwa North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,106 from districts where name='Abuakwa South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,291 from districts where name='Abuakwa South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,172 from districts where name='Abuakwa South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,197.7 from districts where name='Abuakwa South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,55.4 from districts where name='Abuakwa South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,117 from districts where name='Abuakwa South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,187 from districts where name='Achiase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,323 from districts where name='Achiase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,35 from districts where name='Achiase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,60.7 from districts where name='Achiase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,264 from districts where name='Achiase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,128 from districts where name='Achiase' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,84 from districts where name='Akwapim North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,273 from districts where name='Akwapim North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,230 from districts where name='Akwapim North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,255.7 from districts where name='Akwapim North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,43.5 from districts where name='Akwapim North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,194 from districts where name='Akwapim North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,66 from districts where name='Akuapem South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,255 from districts where name='Akuapem South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,244 from districts where name='Akuapem South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,269.7 from districts where name='Akuapem South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,25.1 from districts where name='Akuapem South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,186 from districts where name='Akuapem South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,200 from districts where name='Akyemansa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,266 from districts where name='Akyemansa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,112 from districts where name='Akyemansa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,137.7 from districts where name='Akyemansa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,117 from districts where name='Akyemansa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,59.4 from districts where name='Akyemansa' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,158 from districts where name='Asene Manso-Akroso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,290 from districts where name='Asene Manso-Akroso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,176 from districts where name='Asene Manso-Akroso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,201.7 from districts where name='Asene Manso-Akroso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,80.4 from districts where name='Asene Manso-Akroso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,112 from districts where name='Asene Manso-Akroso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,64 from districts where name='Asuogyaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,307 from districts where name='Asuogyaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,250 from districts where name='Asuogyaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,275.7 from districts where name='Asuogyaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,83.7 from districts where name='Asuogyaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,222 from districts where name='Asuogyaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,201 from districts where name='Atiwa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,297 from districts where name='Atiwa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,150 from districts where name='Atiwa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,175.7 from districts where name='Atiwa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,84.6 from districts where name='Atiwa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,99.2 from districts where name='Atiwa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,201 from districts where name='Atiwa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,297 from districts where name='Atiwa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,150 from districts where name='Atiwa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,175.7 from districts where name='Atiwa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,84.6 from districts where name='Atiwa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,99.2 from districts where name='Atiwa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,84 from districts where name='Ayensuano' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,243 from districts where name='Ayensuano' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,204 from districts where name='Ayensuano' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,229.7 from districts where name='Ayensuano' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,21.6 from districts where name='Ayensuano' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,145 from districts where name='Ayensuano' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,174 from districts where name='Birim Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,216 from districts where name='Birim Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,343 from districts where name='Birim Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,368.7 from districts where name='Birim Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,90 from districts where name='Birim Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,99.8 from districts where name='Birim Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,206 from districts where name='Birim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,299 from districts where name='Birim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,100 from districts where name='Birim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,125.7 from districts where name='Birim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,118 from districts where name='Birim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,24.6 from districts where name='Birim North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,156 from districts where name='Birim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,196 from districts where name='Birim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,171 from districts where name='Birim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,196.7 from districts where name='Birim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,96.5 from districts where name='Birim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,102 from districts where name='Birim South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,132 from districts where name='Denkyembour' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,235 from districts where name='Denkyembour' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,201 from districts where name='Denkyembour' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,226.7 from districts where name='Denkyembour' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,70.8 from districts where name='Denkyembour' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,95.2 from districts where name='Denkyembour' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,106 from districts where name='East Akim Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,267 from districts where name='East Akim Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,195 from districts where name='East Akim Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,220.7 from districts where name='East Akim Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,42 from districts where name='East Akim Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,117 from districts where name='East Akim Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,147 from districts where name='Fanteakwa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,334 from districts where name='Fanteakwa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,176 from districts where name='Fanteakwa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,201.7 from districts where name='Fanteakwa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,92.4 from districts where name='Fanteakwa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,138 from districts where name='Fanteakwa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,128 from districts where name='Fanteakwa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,304 from districts where name='Fanteakwa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,148 from districts where name='Fanteakwa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,173.7 from districts where name='Fanteakwa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,68 from districts where name='Fanteakwa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,102 from districts where name='Fanteakwa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,142 from districts where name='Kwaebibirem' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,256 from districts where name='Kwaebibirem' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,173 from districts where name='Kwaebibirem' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,198.7 from districts where name='Kwaebibirem' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,77.3 from districts where name='Kwaebibirem' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,87 from districts where name='Kwaebibirem' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,317 from districts where name='Kwahu Afram Plains North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,495 from districts where name='Kwahu Afram Plains North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,190 from districts where name='Kwahu Afram Plains North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,215.7 from districts where name='Kwahu Afram Plains North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,350 from districts where name='Kwahu Afram Plains North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,217 from districts where name='Kwahu Afram Plains North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,385 from districts where name='Kwahu Afram Plains South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,470 from districts where name='Kwahu Afram Plains South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,224 from districts where name='Kwahu Afram Plains South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,249.7 from districts where name='Kwahu Afram Plains South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,325 from districts where name='Kwahu Afram Plains South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,192 from districts where name='Kwahu Afram Plains South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,212 from districts where name='Kwahu East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,368 from districts where name='Kwahu East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,89 from districts where name='Kwahu East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,114.7 from districts where name='Kwahu East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,127 from districts where name='Kwahu East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,79.7 from districts where name='Kwahu East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,195 from districts where name='Kwahu South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,363 from districts where name='Kwahu South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,118 from districts where name='Kwahu South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,143.7 from districts where name='Kwahu South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,120 from districts where name='Kwahu South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,72.7 from districts where name='Kwahu South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,192 from districts where name='Kwahu West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,391 from districts where name='Kwahu West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,109 from districts where name='Kwahu West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,134.7 from districts where name='Kwahu West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,107 from districts where name='Kwahu West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,61.7 from districts where name='Kwahu West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,56 from districts where name='Lower Manya Krobo Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,278 from districts where name='Lower Manya Krobo Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,238 from districts where name='Lower Manya Krobo Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,263.7 from districts where name='Lower Manya Krobo Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,77.1 from districts where name='Lower Manya Krobo Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,215 from districts where name='Lower Manya Krobo Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,108 from districts where name='Lower West Akim Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,205 from districts where name='Lower West Akim Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,220 from districts where name='Lower West Akim Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,245.7 from districts where name='Lower West Akim Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,42 from districts where name='Lower West Akim Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,183 from districts where name='Lower West Akim Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,114 from districts where name='New Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,299 from districts where name='New Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,200 from districts where name='New Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,225.7 from districts where name='New Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,57.3 from districts where name='New Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,162 from districts where name='New Juaben Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,264 from districts where name='New Juaben North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,317 from districts where name='New Juaben North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,40 from districts where name='New Juaben North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,65.7 from districts where name='New Juaben North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,213 from districts where name='New Juaben North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,80.3 from districts where name='New Juaben North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,64 from districts where name='Nsawam - Adoagyire Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,241 from districts where name='Nsawam - Adoagyire Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,237 from districts where name='Nsawam - Adoagyire Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,262.7 from districts where name='Nsawam - Adoagyire Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,0 from districts where name='Nsawam - Adoagyire Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,162 from districts where name='Nsawam - Adoagyire Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,95 from districts where name='Okere' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,278 from districts where name='Okere' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,222 from districts where name='Okere' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,247.7 from districts where name='Okere' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,48.2 from districts where name='Okere' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,188 from districts where name='Okere' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,103 from districts where name='Suhum Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,242 from districts where name='Suhum Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,198 from districts where name='Suhum Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,223.7 from districts where name='Suhum Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,29.9 from districts where name='Suhum Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,135 from districts where name='Suhum Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,151 from districts where name='Upper Manya Krobo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,350 from districts where name='Upper Manya Krobo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,213 from districts where name='Upper Manya Krobo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,238.7 from districts where name='Upper Manya Krobo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,102 from districts where name='Upper Manya Krobo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,162 from districts where name='Upper Manya Krobo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,79 from districts where name='Upper West Akim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,278 from districts where name='Upper West Akim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,227 from districts where name='Upper West Akim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,252.7 from districts where name='Upper West Akim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,16.9 from districts where name='Upper West Akim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,173 from districts where name='Upper West Akim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,64 from districts where name='Yilo Krobo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,300 from districts where name='Yilo Krobo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,236 from districts where name='Yilo Krobo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,261.7 from districts where name='Yilo Krobo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,63.7 from districts where name='Yilo Krobo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,212 from districts where name='Yilo Krobo Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,40 from districts where name='Ablekuma Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,219 from districts where name='Ablekuma Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,252 from districts where name='Ablekuma Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,277.7 from districts where name='Ablekuma Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,39.6 from districts where name='Ablekuma Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,197 from districts where name='Ablekuma Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,38 from districts where name='Ablekuma North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,217 from districts where name='Ablekuma North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,248 from districts where name='Ablekuma North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,273.7 from districts where name='Ablekuma North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,36.6 from districts where name='Ablekuma North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,194 from districts where name='Ablekuma North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,44 from districts where name='Ablekuma West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,218 from districts where name='Ablekuma West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,256 from districts where name='Ablekuma West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,281.7 from districts where name='Ablekuma West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,41.4 from districts where name='Ablekuma West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,202 from districts where name='Ablekuma West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,29 from districts where name='Accra Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,228 from districts where name='Accra Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,272 from districts where name='Accra Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,297.7 from districts where name='Accra Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,36.2 from districts where name='Accra Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,198 from districts where name='Accra Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,92 from districts where name='Ada East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,334 from districts where name='Ada East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,356 from districts where name='Ada East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,381.7 from districts where name='Ada East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,140 from districts where name='Ada East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,316 from districts where name='Ada East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,80 from districts where name='Ada West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,340 from districts where name='Ada West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,317 from districts where name='Ada West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,342.7 from districts where name='Ada West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,102 from districts where name='Ada West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,278 from districts where name='Ada West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,39 from districts where name='Adenta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,240 from districts where name='Adenta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,262 from districts where name='Adenta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,287.7 from districts where name='Adenta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,43.8 from districts where name='Adenta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,202 from districts where name='Adenta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,29 from districts where name='Ashaiman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,246 from districts where name='Ashaiman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,268 from districts where name='Ashaiman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,293.7 from districts where name='Ashaiman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,54.4 from districts where name='Ashaiman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,214 from districts where name='Ashaiman Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,38 from districts where name='Ayawaso Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,225 from districts where name='Ayawaso Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,247 from districts where name='Ayawaso Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,272.7 from districts where name='Ayawaso Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,33.8 from districts where name='Ayawaso Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,194 from districts where name='Ayawaso Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,30 from districts where name='Ayawaso East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,225 from districts where name='Ayawaso East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,248 from districts where name='Ayawaso East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,273.7 from districts where name='Ayawaso East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,32.5 from districts where name='Ayawaso East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,193 from districts where name='Ayawaso East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,34 from districts where name='Ayawaso East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,224 from districts where name='Ayawaso East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,250 from districts where name='Ayawaso East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,275.7 from districts where name='Ayawaso East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,34.7 from districts where name='Ayawaso East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,195 from districts where name='Ayawaso East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,37 from districts where name='Ayawaso North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,219 from districts where name='Ayawaso North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,248 from districts where name='Ayawaso North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,273.7 from districts where name='Ayawaso North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,32.6 from districts where name='Ayawaso North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,193 from districts where name='Ayawaso North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,30 from districts where name='Ayawaso West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,225 from districts where name='Ayawaso West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,248 from districts where name='Ayawaso West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,273.7 from districts where name='Ayawaso West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,32.5 from districts where name='Ayawaso West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,193 from districts where name='Ayawaso West Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,41 from districts where name='Ga Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,220 from districts where name='Ga Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,241 from districts where name='Ga Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,266.7 from districts where name='Ga Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,28 from districts where name='Ga Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,188 from districts where name='Ga Central Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,50 from districts where name='Ga East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,227 from districts where name='Ga East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,251 from districts where name='Ga East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,276.7 from districts where name='Ga East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,30.8 from districts where name='Ga East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,55.6 from districts where name='Ga East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,47 from districts where name='Ga North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,226 from districts where name='Ga North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,232 from districts where name='Ga North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,257.7 from districts where name='Ga North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,24.3 from districts where name='Ga North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,185 from districts where name='Ga North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,48 from districts where name='Ga South Municipal/ Weija Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,213 from districts where name='Ga South Municipal/ Weija Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,256 from districts where name='Ga South Municipal/ Weija Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,281.7 from districts where name='Ga South Municipal/ Weija Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,42 from districts where name='Ga South Municipal/ Weija Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,202 from districts where name='Ga South Municipal/ Weija Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,55 from districts where name='Ga West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,226 from districts where name='Ga West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,229 from districts where name='Ga West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,254.7 from districts where name='Ga West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,14.5 from districts where name='Ga West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,175 from districts where name='Ga West Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,47 from districts where name='Korle-Klottey' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,227 from districts where name='Korle-Klottey' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,254 from districts where name='Korle-Klottey' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,279.7 from districts where name='Korle-Klottey' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,39.6 from districts where name='Korle-Klottey' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,200 from districts where name='Korle-Klottey' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,33 from districts where name='Kpone - Katamanso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,245 from districts where name='Kpone - Katamanso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,267 from districts where name='Kpone - Katamanso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,292.7 from districts where name='Kpone - Katamanso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,62.9 from districts where name='Kpone - Katamanso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,225 from districts where name='Kpone - Katamanso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,24 from districts where name='Krowor Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,245 from districts where name='Krowor Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,267 from districts where name='Krowor Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,292.7 from districts where name='Krowor Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,53.3 from districts where name='Krowor Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,214 from districts where name='Krowor Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,36 from districts where name='La Dade-Kotopon Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,228 from districts where name='La Dade-Kotopon Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,256 from districts where name='La Dade-Kotopon Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,281.7 from districts where name='La Dade-Kotopon Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,39.9 from districts where name='La Dade-Kotopon Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,200 from districts where name='La Dade-Kotopon Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,34 from districts where name='La-Nkwantanang-Madina' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,234 from districts where name='La-Nkwantanang-Madina' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,256 from districts where name='La-Nkwantanang-Madina' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,281.7 from districts where name='La-Nkwantanang-Madina' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,47 from districts where name='La-Nkwantanang-Madina' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,208 from districts where name='La-Nkwantanang-Madina' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,27 from districts where name='Ledzokuku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,246 from districts where name='Ledzokuku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,268 from districts where name='Ledzokuku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,293.7 from districts where name='Ledzokuku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,47.8 from districts where name='Ledzokuku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,205 from districts where name='Ledzokuku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,55 from districts where name='Ningo - Prampam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,278 from districts where name='Ningo - Prampam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,246 from districts where name='Ningo - Prampam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,271.7 from districts where name='Ningo - Prampam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,75.4 from districts where name='Ningo - Prampam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,246 from districts where name='Ningo - Prampam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,35 from districts where name='Okaikwai North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,220 from districts where name='Okaikwai North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,245 from districts where name='Okaikwai North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,270.7 from districts where name='Okaikwai North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,30 from districts where name='Okaikwai North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,190 from districts where name='Okaikwai North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,37 from districts where name='Okaikwai South Municipal?' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,219 from districts where name='Okaikwai South Municipal?' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,248 from districts where name='Okaikwai South Municipal?' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,273.7 from districts where name='Okaikwai South Municipal?' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,32.6 from districts where name='Okaikwai South Municipal?' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,193 from districts where name='Okaikwai South Municipal?' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,32 from districts where name='Shai - Osudoku' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,317 from districts where name='Shai - Osudoku' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,241 from districts where name='Shai - Osudoku' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,266.7 from districts where name='Shai - Osudoku' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,58.3 from districts where name='Shai - Osudoku' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,205 from districts where name='Shai - Osudoku' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,257 from districts where name='Tema Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,301 from districts where name='Tema Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,326.7 from districts where name='Tema Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,60.8 from districts where name='Tema Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,221 from districts where name='Tema Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,21 from districts where name='Tema West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,246 from districts where name='Tema West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,268 from districts where name='Tema West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,293.7 from districts where name='Tema West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,53.5 from districts where name='Tema West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,214 from districts where name='Tema West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,57 from districts where name='Weija-Gbawe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,198 from districts where name='Weija-Gbawe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,260 from districts where name='Weija-Gbawe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,285.7 from districts where name='Weija-Gbawe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,52.8 from districts where name='Weija-Gbawe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,213 from districts where name='Weija-Gbawe' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,661 from districts where name='Bunkpurugu Nakpanduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,898 from districts where name='Bunkpurugu Nakpanduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,608 from districts where name='Bunkpurugu Nakpanduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,633.7 from districts where name='Bunkpurugu Nakpanduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,690 from districts where name='Bunkpurugu Nakpanduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,684 from districts where name='Bunkpurugu Nakpanduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,861 from districts where name='Chereponi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,858 from districts where name='Chereponi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,560 from districts where name='Chereponi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,585.7 from districts where name='Chereponi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,797 from districts where name='Chereponi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,733 from districts where name='Chereponi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,842 from districts where name='East Mamprusi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,846 from districts where name='East Mamprusi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,541 from districts where name='East Mamprusi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,566.7 from districts where name='East Mamprusi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,667 from districts where name='East Mamprusi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,612 from districts where name='East Mamprusi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,751 from districts where name='Mamprugu Moagduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,774 from districts where name='Mamprugu Moagduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,484 from districts where name='Mamprugu Moagduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,509.7 from districts where name='Mamprugu Moagduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,679 from districts where name='Mamprugu Moagduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,571 from districts where name='Mamprugu Moagduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,790 from districts where name='West Mamprusi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,793 from districts where name='West Mamprusi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,489 from districts where name='West Mamprusi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,514.7 from districts where name='West Mamprusi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,685 from districts where name='West Mamprusi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,577 from districts where name='West Mamprusi Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,641 from districts where name='Yunyoo-Nasuan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,932 from districts where name='Yunyoo-Nasuan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,621 from districts where name='Yunyoo-Nasuan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,646.7 from districts where name='Yunyoo-Nasuan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,649 from districts where name='Yunyoo-Nasuan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,660 from districts where name='Yunyoo-Nasuan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,635.2 from districts where name='Nalerigu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,779 from districts where name='Gushiegu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,784 from districts where name='Gushiegu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,478 from districts where name='Gushiegu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,503.7 from districts where name='Gushiegu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,586 from districts where name='Gushiegu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,573 from districts where name='Gushiegu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,779 from districts where name='Karaga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,763 from districts where name='Karaga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,478 from districts where name='Karaga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,503.7 from districts where name='Karaga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,657 from districts where name='Karaga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,549 from districts where name='Karaga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,901 from districts where name='Kpandai' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,633 from districts where name='Kpandai' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,600 from districts where name='Kpandai' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,625.7 from districts where name='Kpandai' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,410 from districts where name='Kpandai' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,530 from districts where name='Kpandai' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,668 from districts where name='Kumbungu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,691 from districts where name='Kumbungu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,401 from districts where name='Kumbungu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,426.7 from districts where name='Kumbungu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,596 from districts where name='Kumbungu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,488 from districts where name='Kumbungu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,723 from districts where name='Mion' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,736 from districts where name='Mion' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,445 from districts where name='Mion' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,470.7 from districts where name='Mion' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,557 from districts where name='Mion' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,533 from districts where name='Mion' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,706 from districts where name='Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,717 from districts where name='Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,405 from districts where name='Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,430.7 from districts where name='Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,620 from districts where name='Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,514 from districts where name='Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,846 from districts where name='Nanumba North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,832 from districts where name='Nanumba North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,545 from districts where name='Nanumba North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,570.7 from districts where name='Nanumba North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,455 from districts where name='Nanumba North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,623 from districts where name='Nanumba North Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,827 from districts where name='Nanumba South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,654 from districts where name='Nanumba South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,526 from districts where name='Nanumba South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,551.7 from districts where name='Nanumba South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,431 from districts where name='Nanumba South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,551 from districts where name='Nanumba South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,853 from districts where name='Saboba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,854 from districts where name='Saboba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,288 from districts where name='Saboba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,313.7 from districts where name='Saboba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,587 from districts where name='Saboba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,614 from districts where name='Saboba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,653 from districts where name='Sagnarigu Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,696 from districts where name='Sagnarigu Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,385 from districts where name='Sagnarigu Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,410.7 from districts where name='Sagnarigu Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,580 from districts where name='Sagnarigu Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,475 from districts where name='Sagnarigu Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,706 from districts where name='Savelugu Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,695 from districts where name='Savelugu Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,405 from districts where name='Savelugu Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,430.7 from districts where name='Savelugu Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,620 from districts where name='Savelugu Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,491 from districts where name='Savelugu Nanton' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,682 from districts where name='Tamale Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,668 from districts where name='Tamale Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,381 from districts where name='Tamale Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,406.7 from districts where name='Tamale Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,575 from districts where name='Tamale Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,467 from districts where name='Tamale Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,846 from districts where name='Tatale-Sanguli' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,770 from districts where name='Tatale-Sanguli' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,534 from districts where name='Tatale-Sanguli' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,559.7 from districts where name='Tatale-Sanguli' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,548 from districts where name='Tatale-Sanguli' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,619 from districts where name='Tatale-Sanguli' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,709 from districts where name='Tolon' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,765 from districts where name='Tolon' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,478 from districts where name='Tolon' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,503.7 from districts where name='Tolon' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,582 from districts where name='Tolon' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,474 from districts where name='Tolon' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,779 from districts where name='Yendi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,765 from districts where name='Yendi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,478 from districts where name='Yendi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,503.7 from districts where name='Yendi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,715 from districts where name='Yendi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,565 from districts where name='Yendi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,827 from districts where name='Zabzugu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,752 from districts where name='Zabzugu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,526 from districts where name='Zabzugu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,551.7 from districts where name='Zabzugu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,529 from districts where name='Zabzugu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,615 from districts where name='Zabzugu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,355 from districts where name='Biakoye' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,177 from districts where name='Biakoye' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,115 from districts where name='Biakoye' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,140.7 from districts where name='Biakoye' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,209 from districts where name='Biakoye' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,353 from districts where name='Biakoye' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,235 from districts where name='Jasikan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,492 from districts where name='Jasikan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,428 from districts where name='Jasikan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,453.7 from districts where name='Jasikan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,246 from districts where name='Jasikan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,391 from districts where name='Jasikan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,243 from districts where name='Kadjebi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,502 from districts where name='Kadjebi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,445 from districts where name='Kadjebi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,470.7 from districts where name='Kadjebi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,262 from districts where name='Kadjebi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,407 from districts where name='Kadjebi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,325 from districts where name='Krachi East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,561 from districts where name='Krachi East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,504 from districts where name='Krachi East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,529.7 from districts where name='Krachi East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,342 from districts where name='Krachi East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,486 from districts where name='Krachi East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,554 from districts where name='Krachi Nchumuru' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,611 from districts where name='Krachi Nchumuru' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,634 from districts where name='Krachi Nchumuru' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,659.7 from districts where name='Krachi Nchumuru' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,392 from districts where name='Krachi Nchumuru' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,511 from districts where name='Krachi Nchumuru' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,462 from districts where name='Krachi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,645 from districts where name='Krachi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,681 from districts where name='Krachi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,706.7 from districts where name='Krachi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,422 from districts where name='Krachi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,542 from districts where name='Krachi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,430 from districts where name='Nkwanta North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,607 from districts where name='Nkwanta North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,604 from districts where name='Nkwanta North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,629.7 from districts where name='Nkwanta North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,384 from districts where name='Nkwanta North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,503 from districts where name='Nkwanta North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,373 from districts where name='Nkwanta South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,571 from districts where name='Nkwanta South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,514 from districts where name='Nkwanta South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,539.7 from districts where name='Nkwanta South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,348 from districts where name='Nkwanta South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,467 from districts where name='Nkwanta South Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,578 from districts where name='Bole' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,624 from districts where name='Bole' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,320 from districts where name='Bole' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,345.7 from districts where name='Bole' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,530 from districts where name='Bole' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,430 from districts where name='Bole' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,629 from districts where name='Central Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,566 from districts where name='Central Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,328 from districts where name='Central Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,353.7 from districts where name='Central Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,471 from districts where name='Central Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,356 from districts where name='Central Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,795 from districts where name='East Gonja Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,571 from districts where name='East Gonja Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,494 from districts where name='East Gonja Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,519.7 from districts where name='East Gonja Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,463 from districts where name='East Gonja Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,581 from districts where name='East Gonja Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,530 from districts where name='North East Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,740 from districts where name='North East Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,429 from districts where name='North East Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,454.7 from districts where name='North East Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,555 from districts where name='North East Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,580 from districts where name='North East Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,747 from districts where name='North Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,688 from districts where name='North Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,446 from districts where name='North Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,471.7 from districts where name='North Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,593 from districts where name='North Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,485 from districts where name='North Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,657 from districts where name='Sawla-Tuna-Kalba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,653 from districts where name='Sawla-Tuna-Kalba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,349 from districts where name='Sawla-Tuna-Kalba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,374.7 from districts where name='Sawla-Tuna-Kalba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,560 from districts where name='Sawla-Tuna-Kalba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,666 from districts where name='Sawla-Tuna-Kalba' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,673 from districts where name='West Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,676 from districts where name='West Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,386 from districts where name='West Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,411.7 from districts where name='West Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,582 from districts where name='West Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,474 from districts where name='West Gonja' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,927 from districts where name='Bawku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,913 from districts where name='Bawku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,626 from districts where name='Bawku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,651.7 from districts where name='Bawku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,815 from districts where name='Bawku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,718 from districts where name='Bawku Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,827 from districts where name='Bawku West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,832 from districts where name='Bawku West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,526 from districts where name='Bawku West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,551.7 from districts where name='Bawku West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,782 from districts where name='Bawku West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,674 from districts where name='Bawku West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,705 from districts where name='Binduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,922 from districts where name='Binduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,611 from districts where name='Binduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,636.7 from districts where name='Binduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,737 from districts where name='Binduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,709 from districts where name='Binduri' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,863 from districts where name='Bolgatanga East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,860 from districts where name='Bolgatanga East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,552 from districts where name='Bolgatanga East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,577.7 from districts where name='Bolgatanga East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,741 from districts where name='Bolgatanga East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,650 from districts where name='Bolgatanga East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,829 from districts where name='Bolgatanga Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,833 from districts where name='Bolgatanga Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,543 from districts where name='Bolgatanga Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,568.7 from districts where name='Bolgatanga Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,737 from districts where name='Bolgatanga Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,678 from districts where name='Bolgatanga Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,853 from districts where name='Bongo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,848 from districts where name='Bongo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,552 from districts where name='Bongo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,577.7 from districts where name='Bongo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,752 from districts where name='Bongo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,699 from districts where name='Bongo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,942 from districts where name='BuiIsa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,826 from districts where name='BuiIsa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,641 from districts where name='BuiIsa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,666.7 from districts where name='BuiIsa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,802 from districts where name='BuiIsa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,600 from districts where name='BuiIsa South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,827 from districts where name='Builsa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,860 from districts where name='Builsa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,549 from districts where name='Builsa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,574.7 from districts where name='Builsa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,742 from districts where name='Builsa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,620 from districts where name='Builsa North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,954 from districts where name='Garu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,949 from districts where name='Garu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,653 from districts where name='Garu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,678.7 from districts where name='Garu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,715 from districts where name='Garu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,706 from districts where name='Garu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,874 from districts where name='Kasena Nankana East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,1073 from districts where name='Kasena Nankana East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,573 from districts where name='Kasena Nankana East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,598.7 from districts where name='Kasena Nankana East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,767 from districts where name='Kasena Nankana East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,673 from districts where name='Kasena Nankana East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,729 from districts where name='Kasena Nankana West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,895 from districts where name='Kasena Nankana West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,428 from districts where name='Kasena Nankana West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,453.7 from districts where name='Kasena Nankana West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,778 from districts where name='Kasena Nankana West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,664 from districts where name='Kasena Nankana West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,850 from districts where name='Nabdam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,854 from districts where name='Nabdam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,563 from districts where name='Nabdam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,588.7 from districts where name='Nabdam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,760 from districts where name='Nabdam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,650 from districts where name='Nabdam' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,941 from districts where name='Pusiga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,944 from districts where name='Pusiga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,640 from districts where name='Pusiga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,665.7 from districts where name='Pusiga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,747 from districts where name='Pusiga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,692 from districts where name='Pusiga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,828 from districts where name='Talensi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,831 from districts where name='Talensi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,541 from districts where name='Talensi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,566.7 from districts where name='Talensi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,736 from districts where name='Talensi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,671 from districts where name='Talensi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,687 from districts where name='Tempane' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,921 from districts where name='Tempane' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,610 from districts where name='Tempane' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,635.7 from districts where name='Tempane' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,741 from districts where name='Tempane' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,704 from districts where name='Tempane' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,772 from districts where name='Dafiama Bussief' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,804 from districts where name='Dafiama Bussief' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,499 from districts where name='Dafiama Bussief' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,524.7 from districts where name='Dafiama Bussief' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,710 from districts where name='Dafiama Bussief' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,664 from districts where name='Dafiama Bussief' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,824 from districts where name='Jirapa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,809 from districts where name='Jirapa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,523 from districts where name='Jirapa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,548.7 from districts where name='Jirapa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,717 from districts where name='Jirapa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,687 from districts where name='Jirapa Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,866 from districts where name='Lambussie Karni' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,865 from districts where name='Lambussie Karni' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,563 from districts where name='Lambussie Karni' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,588.7 from districts where name='Lambussie Karni' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,756 from districts where name='Lambussie Karni' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,687 from districts where name='Lambussie Karni' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,827 from districts where name='Lawra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,833 from districts where name='Lawra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,526 from districts where name='Lawra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,551.7 from districts where name='Lawra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,739 from districts where name='Lawra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,693 from districts where name='Lawra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,758 from districts where name='Nadowli-Kaleo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,790 from districts where name='Nadowli-Kaleo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,485 from districts where name='Nadowli-Kaleo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,510.7 from districts where name='Nadowli-Kaleo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,696 from districts where name='Nadowli-Kaleo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,644 from districts where name='Nadowli-Kaleo' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,858 from districts where name='Nandom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,861 from districts where name='Nandom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,713 from districts where name='Nandom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,738.7 from districts where name='Nandom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,768 from districts where name='Nandom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,721 from districts where name='Nandom' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,880 from districts where name='Sissala East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,866 from districts where name='Sissala East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,527 from districts where name='Sissala East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,552.7 from districts where name='Sissala East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,791 from districts where name='Sissala East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,746 from districts where name='Sissala East Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,842 from districts where name='Sissala West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,871 from districts where name='Sissala West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,569 from districts where name='Sissala West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,594.7 from districts where name='Sissala West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,779 from districts where name='Sissala West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,731 from districts where name='Sissala West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,854 from districts where name='Wa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,834 from districts where name='Wa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,553 from districts where name='Wa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,578.7 from districts where name='Wa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,781 from districts where name='Wa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,932 from districts where name='Wa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,745 from districts where name='Wa Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,751 from districts where name='Wa Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,447 from districts where name='Wa Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,472.7 from districts where name='Wa Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,653 from districts where name='Wa Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,612 from districts where name='Wa Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,704 from districts where name='Wa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,736 from districts where name='Wa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,431 from districts where name='Wa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,456.7 from districts where name='Wa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,645 from districts where name='Wa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,599 from districts where name='Wa West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,153 from districts where name='Adaklu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,400 from districts where name='Adaklu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,352 from districts where name='Adaklu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,377.7 from districts where name='Adaklu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,186 from districts where name='Adaklu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,367 from districts where name='Adaklu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,220 from districts where name='Afadzato South (Afadjato)' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,418 from districts where name='Afadzato South (Afadjato)' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,361 from districts where name='Afadzato South (Afadjato)' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,386.7 from districts where name='Afadzato South (Afadjato)' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,195 from districts where name='Afadzato South (Afadjato)' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,372 from districts where name='Afadzato South (Afadjato)' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,164 from districts where name='Agotime-Ziope' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,404 from districts where name='Agotime-Ziope' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,351 from districts where name='Agotime-Ziope' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,376.7 from districts where name='Agotime-Ziope' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,142 from districts where name='Agotime-Ziope' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,386 from districts where name='Agotime-Ziope' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,145 from districts where name='Akatsi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,398 from districts where name='Akatsi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,421 from districts where name='Akatsi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,446.7 from districts where name='Akatsi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,208 from districts where name='Akatsi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,363 from districts where name='Akatsi North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,126 from districts where name='Akatsi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,363 from districts where name='Akatsi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,385 from districts where name='Akatsi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,410.7 from districts where name='Akatsi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,172 from districts where name='Akatsi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,404 from districts where name='Akatsi South' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,130 from districts where name='Anloga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,383 from districts where name='Anloga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,405 from districts where name='Anloga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,430.7 from districts where name='Anloga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,191 from districts where name='Anloga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,424 from districts where name='Anloga' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,140 from districts where name='Central Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,354 from districts where name='Central Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,376 from districts where name='Central Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,401.7 from districts where name='Central Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,151 from districts where name='Central Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,329 from districts where name='Central Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,137 from districts where name='Ho Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,401 from districts where name='Ho Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,336 from districts where name='Ho Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,361.7 from districts where name='Ho Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,159 from districts where name='Ho Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,337 from districts where name='Ho Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,189 from districts where name='Ho West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,442 from districts where name='Ho West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,350 from districts where name='Ho West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,375.7 from districts where name='Ho West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,175 from districts where name='Ho West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,322 from districts where name='Ho West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,201 from districts where name='Hohoe Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,443 from districts where name='Hohoe Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,393 from districts where name='Hohoe Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,418.7 from districts where name='Hohoe Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,217 from districts where name='Hohoe Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,419 from districts where name='Hohoe Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,193 from districts where name='Keta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,491 from districts where name='Keta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,486 from districts where name='Keta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,511.7 from districts where name='Keta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,208 from districts where name='Keta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,440 from districts where name='Keta Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,368 from districts where name='Ketu North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,389 from districts where name='Ketu North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,411 from districts where name='Ketu North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,436.7 from districts where name='Ketu North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,196 from districts where name='Ketu North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,430 from districts where name='Ketu North' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,167 from districts where name='Ketu South Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,424 from districts where name='Ketu South Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,427 from districts where name='Ketu South Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,452.7 from districts where name='Ketu South Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,212 from districts where name='Ketu South Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,445 from districts where name='Ketu South Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,188 from districts where name='Kpando Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,444 from districts where name='Kpando Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,385 from districts where name='Kpando Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,410.7 from districts where name='Kpando Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,193 from districts where name='Kpando Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,395 from districts where name='Kpando Municipal' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,175 from districts where name='North Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,403 from districts where name='North Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,347 from districts where name='North Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,372.7 from districts where name='North Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,180 from districts where name='North Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,357 from districts where name='North Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,66 from districts where name='North Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,319 from districts where name='North Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,341 from districts where name='North Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,366.7 from districts where name='North Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,126 from districts where name='North Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,291 from districts where name='North Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,128 from districts where name='South Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,378 from districts where name='South Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,319 from districts where name='South Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,344.7 from districts where name='South Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,150 from districts where name='South Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,330 from districts where name='South Dayi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,93 from districts where name='South Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,333 from districts where name='South Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,355 from districts where name='South Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,380.7 from districts where name='South Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,140 from districts where name='South Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,373 from districts where name='South Tongu' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,251 from districts where name='Ahanta West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,4 from districts where name='Ahanta West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,292 from districts where name='Ahanta West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,317.7 from districts where name='Ahanta West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,259 from districts where name='Ahanta West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,70.4 from districts where name='Ahanta West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,251 from districts where name='Efia-Kwesimintsim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,3 from districts where name='Efia-Kwesimintsim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,292 from districts where name='Efia-Kwesimintsim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,317.7 from districts where name='Efia-Kwesimintsim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,237 from districts where name='Efia-Kwesimintsim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,337 from districts where name='Efia-Kwesimintsim' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,341 from districts where name='Ellembelle' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,84 from districts where name='Ellembelle' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,269 from districts where name='Ellembelle' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,294.7 from districts where name='Ellembelle' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,311 from districts where name='Ellembelle' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,348 from districts where name='Ellembelle' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,431 from districts where name='Jomoro' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,174 from districts where name='Jomoro' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,449 from districts where name='Jomoro' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,474.7 from districts where name='Jomoro' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,378 from districts where name='Jomoro' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,424 from districts where name='Jomoro' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,286 from districts where name='Mpohor' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,29 from districts where name='Mpohor' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,309 from districts where name='Mpohor' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,334.7 from districts where name='Mpohor' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,254 from districts where name='Mpohor' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,351 from districts where name='Mpohor' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,320 from districts where name='Nzema East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,63 from districts where name='Nzema East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,298 from districts where name='Nzema East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,323.7 from districts where name='Nzema East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,295 from districts where name='Nzema East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,376 from districts where name='Nzema East Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,383 from districts where name='Prestea-Huni Valley' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,126 from districts where name='Prestea-Huni Valley' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,172 from districts where name='Prestea-Huni Valley' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,197.7 from districts where name='Prestea-Huni Valley' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,304 from districts where name='Prestea-Huni Valley' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,250 from districts where name='Prestea-Huni Valley' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,257 from districts where name='Sekondi-Takoradi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,10 from districts where name='Sekondi-Takoradi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,296 from districts where name='Sekondi-Takoradi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,321.7 from districts where name='Sekondi-Takoradi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,230 from districts where name='Sekondi-Takoradi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,339 from districts where name='Sekondi-Takoradi Metropolitan' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,241 from districts where name='Shama' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,26 from districts where name='Shama' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,276 from districts where name='Shama' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,301.7 from districts where name='Shama' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,222 from districts where name='Shama' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,321 from districts where name='Shama' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,346 from districts where name='Tarkwa Nsuaem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,89 from districts where name='Tarkwa Nsuaem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,225 from districts where name='Tarkwa Nsuaem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,250.7 from districts where name='Tarkwa Nsuaem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,263 from districts where name='Tarkwa Nsuaem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,286 from districts where name='Tarkwa Nsuaem Municipality' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,439 from districts where name='Wasa-Amenfi Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,155 from districts where name='Wasa-Amenfi Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,179 from districts where name='Wasa-Amenfi Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,204.7 from districts where name='Wasa-Amenfi Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,373 from districts where name='Wasa-Amenfi Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,257 from districts where name='Wasa-Amenfi Central' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,377 from districts where name='Wasa-Amenfi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,154 from districts where name='Wasa-Amenfi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,138 from districts where name='Wasa-Amenfi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,163.7 from districts where name='Wasa-Amenfi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,275 from districts where name='Wasa-Amenfi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,216 from districts where name='Wasa-Amenfi East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,451 from districts where name='Wasa-Amenfi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,193 from districts where name='Wasa-Amenfi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,222 from districts where name='Wasa-Amenfi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,247.7 from districts where name='Wasa-Amenfi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,331 from districts where name='Wasa-Amenfi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,282 from districts where name='Wasa-Amenfi West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,233 from districts where name='Wassa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,24 from districts where name='Wassa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,269 from districts where name='Wassa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,294.7 from districts where name='Wassa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,214 from districts where name='Wassa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,313 from districts where name='Wassa East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,257 from districts where name='Western Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,306 from districts where name='Western Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,331.7 from districts where name='Western Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,239 from districts where name='Western Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,335 from districts where name='Western Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,504 from districts where name='Aowin' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,246 from districts where name='Aowin' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,276 from districts where name='Aowin' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,301.7 from districts where name='Aowin' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,385 from districts where name='Aowin' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,334 from districts where name='Aowin' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,666 from districts where name='Bia East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,420 from districts where name='Bia East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,365 from districts where name='Bia East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,390.7 from districts where name='Bia East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,602 from districts where name='Bia East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,356 from districts where name='Bia East' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,228 from districts where name='Bia West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,374 from districts where name='Bia West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,228 from districts where name='Bia West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,253.7 from districts where name='Bia West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,100.6 from districts where name='Bia West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,327 from districts where name='Bia West' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,620 from districts where name='Bodi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,362 from districts where name='Bodi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,198 from districts where name='Bodi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,223.7 from districts where name='Bodi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,417.2 from districts where name='Bodi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,306 from districts where name='Bodi' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,471 from districts where name='Juaboso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,337 from districts where name='Juaboso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,197 from districts where name='Juaboso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,222.7 from districts where name='Juaboso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,409.2 from districts where name='Juaboso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,290 from districts where name='Juaboso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,498 from districts where name='Sefwi-Akontombra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,290 from districts where name='Sefwi-Akontombra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,224 from districts where name='Sefwi-Akontombra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,249.7 from districts where name='Sefwi-Akontombra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,393.7 from districts where name='Sefwi-Akontombra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,312 from districts where name='Sefwi-Akontombra' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,394 from districts where name='Sefwi-Anhwiaso-Bekwai-Bibiani' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,277 from districts where name='Sefwi-Anhwiaso-Bekwai-Bibiani' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,93 from districts where name='Sefwi-Anhwiaso-Bekwai-Bibiani' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,118.7 from districts where name='Sefwi-Anhwiaso-Bekwai-Bibiani' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,330 from districts where name='Sefwi-Anhwiaso-Bekwai-Bibiani' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,182 from districts where name='Sefwi-Anhwiaso-Bekwai-Bibiani' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,428 from districts where name='Sefwi-Wiawso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,273 from districts where name='Sefwi-Wiawso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,154 from districts where name='Sefwi-Wiawso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,179.7 from districts where name='Sefwi-Wiawso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,328.5 from districts where name='Sefwi-Wiawso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,246 from districts where name='Sefwi-Wiawso' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,251 from districts where name='Suaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,217 from districts where name='Suaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,246 from districts where name='Suaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,271.7 from districts where name='Suaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,448.3 from districts where name='Suaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,329 from districts where name='Suaman' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 1,id,512 from districts where name='Western North Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 2,id,375 from districts where name='Western North Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 3,id,151 from districts where name='Western North Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 4,id,176.7 from districts where name='Western North Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 5,id,328.5 from districts where name='Western North Capital' on conflict (origin_id,district_id) do update set km=excluded.km;
insert into distance_matrix (origin_id,district_id,km) select 6,id,246 from districts where name='Western North Capital' on conflict (origin_id,district_id) do update set km=excluded.km;

-- rate version + fidic + base rates
insert into rate_versions (id,label,effective_from,is_active) values ('00000000-0000-0000-0000-000000000001','2022 FIDIC baseline','2022-10-01',true) on conflict (id) do nothing;
insert into fidic_params (rate_version_id,a,b,c,w_old,w_new,f_old) values ('00000000-0000-0000-0000-000000000001',0.4,0.3,0.3,9.68,21.77,3.73) on conflict do nothing;
insert into rates (rate_version_id,item_key,base_rate) values ('00000000-0000-0000-0000-000000000001','materialPerTonKm',0.34) on conflict (rate_version_id,item_key) do update set base_rate=excluded.base_rate;
insert into rates (rate_version_id,item_key,base_rate) values ('00000000-0000-0000-0000-000000000001','offloadTruck40',225.42) on conflict (rate_version_id,item_key) do update set base_rate=excluded.base_rate;
insert into rates (rate_version_id,item_key,base_rate) values ('00000000-0000-0000-0000-000000000001','offloadTruck20',112.69375) on conflict (rate_version_id,item_key) do update set base_rate=excluded.base_rate;
insert into rates (rate_version_id,item_key,base_rate) values ('00000000-0000-0000-0000-000000000001','polePerKm',0.182163) on conflict (rate_version_id,item_key) do update set base_rate=excluded.base_rate;
insert into rates (rate_version_id,item_key,base_rate) values ('00000000-0000-0000-0000-000000000001','offloadPerPole',1.8783375) on conflict (rate_version_id,item_key) do update set base_rate=excluded.base_rate;
insert into rates (rate_version_id,item_key,base_rate) values ('00000000-0000-0000-0000-000000000001','stayPerKm',0.018525) on conflict (rate_version_id,item_key) do update set base_rate=excluded.base_rate;
insert into rates (rate_version_id,item_key,base_rate) values ('00000000-0000-0000-0000-000000000001','offloadPerStay',0.234) on conflict (rate_version_id,item_key) do update set base_rate=excluded.base_rate;
insert into rates (rate_version_id,item_key,base_rate) values ('00000000-0000-0000-0000-000000000001','concretePerKm',0.5464875) on conflict (rate_version_id,item_key) do update set base_rate=excluded.base_rate;
insert into rates (rate_version_id,item_key,base_rate) values ('00000000-0000-0000-0000-000000000001','offloadPerConcrete',5.6350125) on conflict (rate_version_id,item_key) do update set base_rate=excluded.base_rate;

-- weekly_fuel
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-10-19',4.86,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-10-26',4.83,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-11-02',4.83,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-11-09',4.83,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-11-16',4.81,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-11-23',4.81,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-11-30',4.81,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-12-07',4.81,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-12-14',4.81,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-12-21',4.81,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2020-12-28',5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-01-04',5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-01-11',5.08,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-01-18',5.08,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-01-25',5.18,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-02-01',5.18,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-02-08',5.3,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-02-15',5.3,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-02-22',5.39,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-03-01',5.39,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-03-08',5.39,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-03-15',5.39,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-03-22',5.39,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-03-29',5.39,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-04-05',5.39,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-04-12',5.65,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-04-19',5.65,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-04-26',5.65,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-05-03',5.62,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-05-17',6.1,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-05-31',6.28,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-06-07',6.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-06-14',6.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-06-21',6.31,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-06-28',6.31,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-07-05',6.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-07-12',6.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-07-19',6.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-07-26',6.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-08-02',6.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-08-09',6.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-08-16',6.48,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-08-23',6.48,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-08-30',6.48,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-09-06',6.48,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-09-13',6.48,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-09-20',6.44,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-09-27',6.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-10-04',6.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-10-11',6.62,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-10-18',6.62,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-10-25',6.62,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-11-01',6.62,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-11-08',6.62,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-11-15',7.03,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-11-22',7.15,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-11-29',7.15,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-12-06',7.06,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-12-13',7.06,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-12-20',7.06,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2021-12-27',7.06,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-01-03',6.9,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-01-10',6.94,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-01-17',6.94,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-01-24',6.94,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-01-31',6.94,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-02-07',6.94,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-02-14',6.94,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-02-21',6.94,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-02-28',8.11,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-03-07',8.68,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-03-14',8.68,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-03-21',8.68,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-03-28',8.68,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-04-04',11.57,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-04-11',11.38,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-04-18',11.38,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-04-25',11.13,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-05-02',11.13,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-05-09',11.13,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-05-16',11.13,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-05-23',11.13,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-05-30',12.34,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-06-06',12.34,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-06-13',12.34,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-06-20',12.34,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-06-27',13.7,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-07-04',13.7,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-07-11',13.7,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-07-18',13.7,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-07-25',14.33,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-08-01',14.33,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-08-08',14.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-08-15',14.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-08-22',14.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-08-29',14.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-09-05',14.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-09-12',14.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-09-19',14.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-09-26',14.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-10-03',14.26,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-10-11',14.48,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-10-17',14.48,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-10-24',15.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-10-31',15.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-11-01',23.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-11-07',23.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-11-14',23.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-11-15',20.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-11-28',20.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-11-30',19.77,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-12-01',18.86,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-12-07',18.86,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-12-14',18.86,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-12-16',16.1,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-12-20',16.1,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2022-12-22',15.85,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-01-02',14.6,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-01-07',14.6,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-01-11',14.6,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-01-16',15.52,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-01-25',15.52,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-01-31',15.52,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-02-01',15.52,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-02-03',15.25,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-02-13',15.25,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-02-16',14.9,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-02-20',14.9,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-02-24',14.9,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-02-27',14.9,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-03-01',13.8,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-03-07',13.8,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-03-16',13.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-03-21',13.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-03-31',13.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-04-03',12.84,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-04-14',12.84,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-04-17',12.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-04-27',12.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-05-01',12.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-05-02',12.64,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-05-12',12.64,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-05-16',12.3,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-05-25',12.3,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-06-01',12.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-06-06',12.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-06-12',12.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-06-29',12.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-07-03',12.3,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-07-12',12.3,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-07-19',12.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-07-29',12.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-08-01',12.95,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-08-08',12.95,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-08-16',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-08-21',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-09-01',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-09-07',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-09-12',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-09-26',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-10-03',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-10-10',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-10-17',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-10-23',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-10-30',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-11-10',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-11-13',13.5,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-11-20',13.3,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-12-06',13.3,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2023-12-19',12.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-01-19',12.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-01-22',12.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-01-29',12.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-02-02',13.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-02-09',13.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-02-19',13.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-03-01',14.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-03-07',14.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-03-21',14.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-03-27',14.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-04-04',14.74,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-04-18',14.7,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-04-30',14.7,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-05-04',14.65,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-05-17',14.7,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-06-04',14.75,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-06-11',14.75,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-06-18',14.75,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-07-02',14.92,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-07-17',15.25,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-08-05',14.99,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-08-16',14.9,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-09-02',14.7,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-09-16',14.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-09-23',14.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-10-01',14.49,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-10-09',14.29,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-10-17',14.9,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-11-02',15.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-11-19',15.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2024-12-05',15.45,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-01-02',15.6,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-01-17',15.77,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-02-18',15.79,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-05-05',14.41,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-05-16',13.91,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-06-02',12.98,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-06-09',12.88,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-07-16',14.38,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-08-01',14.38,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-08-08',14.38,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-08-19',14.3,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-09-02',13.9,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-11-04',12.76,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-11-11',12.76,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-11-18',12.76,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-11-19',13.2,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-11-24',13.2,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2025-12-14',12.94,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2026-01-06',11.96,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2026-01-16',11.21,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2026-02-02',12.55,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2026-02-16',12.83,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2026-04-08',17.1,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;
insert into weekly_fuel (week_start,price_per_litre,status) values ('2026-05-02',15.77,'manual') on conflict (week_start) do update set price_per_litre=excluded.price_per_litre;

commit;

-- Migration 0015: allow deletion of locked invoices (immutability = no updates).
create or replace function forbid_locked_invoice_change() returns trigger
  language plpgsql as $$
begin
  if (tg_op = 'UPDATE' and old.status = 'locked') then
    raise exception 'Invoice % is locked and cannot be modified', old.id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
