-- ============================================================================
-- HTMS — PR/I lifecycle tracking (Phase 2)
-- Adds: pri_stage enum, invoices.stage, invoices.checklist
-- ============================================================================

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

alter table invoices add column stage pri_stage not null default 'generated';
alter table invoices add column checklist jsonb not null default '{}';
