-- ============================================================================
-- Migration 0010: officer verdict on the checklist.
-- 'approved' is required before the invoice can be submitted; 'disapproved'
-- freezes all stage transitions until an officer re-approves. The disapproval
-- note is shown to the transporter as the reason to comply.
-- ============================================================================

alter table invoices add column review_status text not null default 'pending'
  check (review_status in ('pending','approved','disapproved'));
alter table invoices add column review_note text;
