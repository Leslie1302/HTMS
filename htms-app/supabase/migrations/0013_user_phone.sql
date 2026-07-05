-- ============================================================================
-- Migration 0013: phone number on app_users (staff) for SMS notifications.
-- The Director/officers receive invoice-stage SMS alerts on this number.
-- Nullable — a user with no phone is simply skipped when notifying.
-- ============================================================================

alter table app_users add column if not exists phone text;
