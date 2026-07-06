-- ============================================================================
-- Migration 0016: let a transporter replace a FLAGGED scan on their own waybill.
-- Scans are otherwise immutable to transporters once a waybill leaves 'draft'
-- (they were invoiced). This narrow policy lets the owner re-upload a corrected
-- copy for a document staff flagged: it only applies while flagged_reason is
-- set, and only to the transporter's own waybills. Clearing the flag ends the
-- window (the row can't be updated again through this policy).
-- ============================================================================

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
