-- ============================================================================
-- HTMS — Migration 0023: transporter letterhead scans.
-- A transporter may upload a scan of their own printed letterhead; the letter
-- and invoice are then rendered on it instead of the generated plain header.
-- Path convention: letterheads/<transporter_id>.png in the `documents` bucket.
-- `letterhead_insets` calibrates the printable area (pt from the page edges) so
-- content clears the scan's header/footer bands — every scan differs.
-- ============================================================================

alter table transporters add column if not exists letterhead_path text;
alter table transporters add column if not exists letterhead_insets jsonb;

-- ── Storage policies: letterheads in the `documents` bucket ──────────────────
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

-- ── Transporters table: let a transporter save their own letterhead columns ──
-- RLS cannot restrict columns, so a trigger blocks non-staff from editing
-- anything else on their row (rates, contract validation, etc.).

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
