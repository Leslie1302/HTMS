-- ============================================================================
-- Migration 0015: allow deletion of locked invoices.
-- The immutability trigger blocked BOTH updates and deletes of a locked
-- (paid) invoice, which stopped admin cleanup / the pilot flush from removing
-- them. Locked invoices must still be immutable (no value changes), but an
-- admin delete should go through. RLS still restricts normal deletes to
-- admins on draft invoices, so only the service-role admin tools can delete
-- a locked one.
-- ============================================================================

create or replace function forbid_locked_invoice_change() returns trigger
  language plpgsql as $$
begin
  if (tg_op = 'UPDATE' and old.status = 'locked') then
    raise exception 'Invoice % is locked and cannot be modified', old.id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
