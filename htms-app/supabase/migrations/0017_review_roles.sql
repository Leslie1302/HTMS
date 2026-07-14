-- ============================================================================
-- HTMS — Migration 0017: Add Deputy Director and Director review roles.
-- New enum values cannot be used in the same transaction they are added.
-- ============================================================================

alter type user_role add value if not exists 'deputy_director';
alter type user_role add value if not exists 'director';
