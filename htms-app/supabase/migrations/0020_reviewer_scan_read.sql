-- ============================================================================
-- HTMS — Migration 0020: reviewers (deputy_director/director) can READ scan
-- files. 0018 widened the scans TABLE policy to is_staff_role but left the
-- scans STORAGE policy at admin/officer, so reviewer downloads failed and the
-- merged "Payment request documentation" PDF silently omitted the scans.
-- Write/delete policies unchanged — reviewers stay read-only.
-- ============================================================================

drop policy if exists scans_obj_read on storage.objects;
create policy scans_obj_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'scans' and (
      is_staff_role(auth_role())
      or storage_owner_transporter(name) = auth_transporter_id()
    )
  );
