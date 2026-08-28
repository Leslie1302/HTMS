# Supabase Migrations

Applied in filename sort order against the Supabase project (SQL editor or CLI).
The rules below were each learned from a production bug.

## Naming

- `NNNN_short_description.sql`, zero-padded, **prefix unique across the folder**.
  `scripts/check-migrations.mjs` enforces this in CI.
- Never edit a migration that has been applied anywhere. Write a new one.

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
| 0009 | Scan quality flags |
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
| 0027 | Receipt proofs (receipts bucket + receipt_proofs) |
| 0028 | Invoice comments (audience-directed rectification notes) |

## Duplicate prefix convention

`0009` and `0009b` are a historical exception: two migrations were authored with the
same number. `0009_scan_flags.sql` applied first, then `0009b_transporter_checklist.sql`.
Do not renumber them — they are already applied in production. Suffix `a`/`b` if it
ever recurs.

## Editing policies — the rule that has bitten us most

**Always `drop policy if exists` using the policy's EXACT current name, then recreate.**

`drop policy if exists <wrong_name>` silently succeeds and does nothing. That is what
happened in 0018: it dropped `app_users_role_check` (which did not exist) and added a
new constraint, leaving the original `app_users_check` from 0001 still enforcing the
old role list — so creating a Deputy Director failed with a constraint violation that
pointed at a constraint nobody had touched. Fixed in 0019.

Before writing a policy migration, list what is actually there:

```sql
select policyname, cmd, qual, with_check from pg_policies where tablename = '<table>';
select conname from pg_constraint where conrelid = '<table>'::regclass;
```

## Storage policies are separate from table policies

Widening a table's RLS does **not** widen access to files in a Storage bucket. 0018
gave reviewers read access to the `scans` table but not the `scans` bucket, so their
merged PDF silently omitted every scan (fixed in 0020). When a role gains access to
records that have files, update both.

## RLS cannot restrict columns

A row-level policy allows or denies the whole row. To let a user update *some* columns
of their own row, pair a self-update policy with a `BEFORE UPDATE` trigger that raises
on the columns they must not touch — see 0022 (`app_users`: signature only) and 0023
(`transporters`: letterhead only). Exempt the service role by checking
`auth.uid() is not null`, or the Netlify admin functions break.

## Test the policy, not just the SQL

`supabase/tests/rls.test.ts` asserts the access matrix per role. Any migration that
adds or changes a policy should add a case there. A policy with no test is a policy
that will fail silently in front of a user.

## Path matching in Storage policies

Compare the **full object path**, not a `split_part` fragment:
`name = 'signatures/' || auth.uid()::text || '.png'`. 0018 compared
`split_part(name, '/', 2)` (`"<uid>.png"`) against `auth.uid()::text` (`"<uid>"`),
which never matches — silently blocking every non-admin upload (fixed in 0021/0024).

## Deployment scripts

- `deploy_all_pending.sql` — combined runner for the mid-series migrations (idempotent guards).
- `setup_all.sql` — fresh-install script (early migrations + seed data).
- Later migrations may need manual application — check the file header.
