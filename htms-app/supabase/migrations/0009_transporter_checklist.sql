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
