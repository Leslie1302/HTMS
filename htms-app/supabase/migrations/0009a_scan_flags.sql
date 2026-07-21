-- ============================================================================
-- Migration 0009: scan quality flags.
-- An officer flags a substandard upload with a reason (null = OK). The flag
-- blocks invoice submission server-side and surfaces as an "action required"
-- prompt on the transporter's status page. audit is the officer's flag itself.
-- ============================================================================

alter table scans add column flagged_reason text;

-- Officers/admin may update scans (flag / unflag).
create policy scans_update_staff on scans
  for update to authenticated
  using (auth_role() in ('admin','officer'))
  with check (auth_role() in ('admin','officer'));

-- Staff may attach corrected scans or remove bad ones after invoicing.
-- Transporters stay draft-only: corrected originals arrive physically at the
-- Ministry and staff upload the replacement copy.
create policy scans_insert_staff on scans
  for insert to authenticated
  with check (auth_role() in ('admin','officer'));

create policy scans_delete_staff on scans
  for delete to authenticated
  using (auth_role() in ('admin','officer'));
