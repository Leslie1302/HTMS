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
