-- ============================================================================
-- Migration 0006: optional transporter contact details for the document
-- letterhead (name-based makeshift header). All nullable — documents fall back
-- gracefully to just the name + monogram when these are blank.
-- ============================================================================

alter table transporters add column if not exists address     text;
alter table transporters add column if not exists email       text;
alter table transporters add column if not exists phone       text;
alter table transporters add column if not exists gps_address text;
