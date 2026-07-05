-- ============================================================================
-- Migration 0012: manager / authorised signatory name for a transporter.
-- Printed under the signature line on generated letters and invoices; nullable
-- so documents fall back to the company name when it is blank.
-- ============================================================================

alter table transporters add column if not exists manager_name text;
