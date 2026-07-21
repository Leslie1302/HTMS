# Supabase Migrations

## Naming convention

Each file is prefixed with a monotonically increasing 4-digit number (`0001`–`9999`).
The prefix determines the **logical** order — Supabase applies them in filename sort order.

| Prefix | Description |
|--------|-------------|
| 0001 | Core schema: tables, enums, indexes |
| 0002 | Row-Level Security (RLS) policies |
| 0003 | Storage buckets + policies |
| 0004 | Auth trigger (auto-provision `app_users`) |
| 0005 | Scan destinations (multi-drop) |
| 0006 | Transporter contacts |
| 0007 | PR/I lifecycle (11 stages) |
| 0008 | Transporter contracts + device tokens |
| 0009a | Scan quality flags |
| 0009b | Transporter checklist update policy |
| 0010 | Checklist review status |
| 0011 | Scan uploaded_by default |
| 0012 | Transporter manager name |
| 0013 | User phone column |
| 0014 | Device tokens table |
| 0015 | Allow locked invoice delete |
| 0016 | Scan resubmit for flagged docs |
| 0017 | Deputy director + director roles |
| 0018 | Electronic attestations (invoice_signatures + storage) |
| 0019 | Drop stale role check constraint |
| 0020 | Reviewer scan read access |
| 0021 | Fix signature storage policies |
| 0022 | Self-update signature policy |
| 0023 | Transporter letterhead storage |
| 0024 | Simplify signature storage with LIKE |
| 0025 | Signature evidence (IP, user-agent, AAL, doc_hash) |
| 0026 | Document archival (archive bucket + document_archives) |

## Duplicate prefix convention

When two migrations share a logical position (e.g. both 0009), suffix with `a`/`b`:
- `0009a_scan_flags.sql`
- `0009b_transporter_checklist.sql`

This keeps the sort order correct while distinguishing the files.

## Policy edit convention

**Always** `DROP POLICY IF EXISTS` with the **exact current name** before creating
the new version. The 0018→0019 constraint bug came from dropping a name that never
existed. Note the exact name in the migration comment.

## Deployment

- `deploy_all_pending.sql` — combined runner for migrations 0009–0023 (with idempotent guards)
- `setup_all.sql` — fresh-install script (0001–0009 + seed data)
- Migration 0024 is **not** included in either runner — apply manually
