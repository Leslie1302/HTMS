-- ============================================================================
-- Migration 0011: scans.uploaded_by defaults to the caller.
-- Root cause: WaybillEntry inserted scans without uploaded_by (NOT NULL, no
-- default) and discarded the error — uploads landed in Storage but never got
-- a scans row, so the checklist/preview/PDF-merge saw no documents.
-- ============================================================================

alter table scans alter column uploaded_by set default auth.uid();
