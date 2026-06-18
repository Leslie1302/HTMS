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
