-- ============================================================================
-- HTMS — PILOT RESET
-- Flushes all test/operational data so the system can go live fresh.
--
--   WIPES:   waybills, scans, invoices, invoice_lines, documents, audit_log,
--            device_tokens, ALL transporters, and ALL non-admin user accounts.
--   KEEPS:   configuration & reference data (origins, districts, distance chart,
--            rate versions, FIDIC params, rates, weekly fuel prices) and every
--            admin login.
--
-- ⚠️  DESTRUCTIVE and IRREVERSIBLE. Take a database backup first
--     (Supabase → Database → Backups) before running.
--
-- HOW TO RUN: paste into Supabase → SQL Editor → Run. Storage files are NOT
-- removed by SQL — see the storage note at the bottom.
-- ============================================================================

begin;

-- Safety guard: never run if there is no admin to keep (would delete everyone).
do $$
begin
  if not exists (select 1 from app_users where role = 'admin') then
    raise exception 'Aborting pilot reset: no admin account found — refusing to delete all users.';
  end if;
end $$;

-- 1. Operational data (children first to respect foreign keys).
delete from documents;
delete from invoice_lines;
delete from invoices;
delete from scans;
delete from waybills;
delete from device_tokens;
delete from audit_log;

-- 2. Remove every non-admin account (officers, transporters, parked signups).
--    Deleting from auth.users cascades to app_users (and their device tokens).
delete from auth.users
where id not in (select id from app_users where role = 'admin');

-- 3. Remove all transporter companies (now unreferenced) and their contacts.
delete from transporters;

-- 4. Tidy the generated-document counters (optional, cosmetic).
-- (audit_log ids continue from where they were; harmless.)

commit;

-- ── After committing, verify the flush ──────────────────────────────────────
-- select
--   (select count(*) from transporters)  as transporters,
--   (select count(*) from waybills)       as waybills,
--   (select count(*) from invoices)       as invoices,
--   (select count(*) from app_users)      as users_left;   -- should be admins only

-- ── Storage cleanup (files are NOT deleted by the SQL above) ────────────────
-- Empty the two private buckets so scans, generated PDFs and old contracts go
-- too. Easiest: Supabase → Storage → open each bucket → select all → delete.
-- Buckets to empty:  scans   and   documents
--
-- Or, to drop the object records via SQL (physical files are reclaimed by
-- Storage afterwards):
--   delete from storage.objects where bucket_id in ('scans', 'documents');
