-- ============================================================================
-- HTMS — Per-transporter contract agreement storage
-- Adds: transporters.contract_path, transporters.contract_validated
-- ============================================================================

alter table transporters add column contract_path text;
alter table transporters add column contract_validated boolean not null default false;
