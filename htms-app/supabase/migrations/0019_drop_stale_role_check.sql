-- ============================================================================
-- HTMS — Migration 0019: drop the stale role check from 0001.
-- 0001 defined the check inline (auto-named "app_users_check"); 0018 tried to
-- replace it but dropped the wrong name ("app_users_role_check" didn't exist
-- yet), leaving BOTH constraints in place. The old one rejects the new
-- deputy_director/director roles. 0018's replacement is correct — just remove
-- the leftover.
-- ============================================================================

alter table app_users drop constraint if exists app_users_check;
