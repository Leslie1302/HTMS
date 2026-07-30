# HTMS — Hardening Plan

Addresses the five structural weaknesses found during the e-signature build. Ordered
by risk: phase 1 prevents the bug class that has already cost the most time; phase 5
is optional polish. Each phase is independently shippable — stop after any of them
and the system is better than before.

Working rules carried from the existing codebase: smallest working diff, no new
runtime dependencies unless a phase names one, `// ponytail:` comments mark
deliberate ceilings, `npm run lint && npm run typecheck && npm test` green before
each commit.

---

## Phase 1 — Kill the silent-failure class (highest value)

**Problem.** Five of the last six production bugs were RLS/policy bugs that reported
success: a zero-row `UPDATE` returns `{ error: null }`, a blocked Storage download
returns `{ data: null }`, and the UI happily renders as if it worked. The signature
that "reset itself" after MFA, the reviewer's document missing every scan, and the
user-creation failure were all one shape of bug.

### 1.1 Make writes prove they happened

Every client-side mutation on a table with RLS must assert it touched a row.

- Add `src/lib/db.ts` with two thin wrappers:
  - `mustUpdate(query)` — awaits a query that already has `.select(...).single()`
    appended by the caller; throws a readable error when `data` is null or the
    error is a policy denial (Postgres `42501`).
  - `mustDownload(bucket, path)` — throws when Storage returns no blob, naming the
    bucket and path so the failure is diagnosable from a screenshot.
- Replace every bare `supabase.from(...).update(...)` / `.insert(...)` in `src/`
  with the wrapper. Grep target: `\.from\('[a-z_]+'\)\.(update|insert|upsert)`.
  There are roughly a dozen; the signature save in `Settings.tsx` is already done
  and is the reference implementation.
- Same rule for Storage reads that feed a document: the reviewer merge builder
  already counts skipped scans — extend that to the letterhead and signature
  fetches so a missing image is reported, never silently omitted.

**Done when:** revoking a policy in a local database produces a visible error in the
UI for every mutation path, instead of a false success.

### 1.2 Test RLS as each role

This is the real gap. The current suite tests pure functions (`calc`, `signing`,
`lifecycle`) — none of the code where the bugs actually live.

- Add `supabase/tests/rls.test.ts` (vitest, runs against a local Supabase or a
  dedicated test project — needs `SUPABASE_TEST_URL` / `SUPABASE_TEST_SERVICE_KEY`).
- Seed one user per role (admin, officer, deputy_director, director, transporter A,
  transporter B) plus one invoice per transporter, using the service key.
- For each role, assert the full access matrix with a real anon-key client:
  - transporter A can read own invoice/waybills/scans; **cannot** read B's;
  - transporter can update own `signature_path`; **cannot** update own `role` or
    `transporter_id` (the 0022 trigger);
  - deputy_director/director can read all invoices and **download a scan file**
    (the 0020 regression);
  - transporter can upload/replace `signatures/<uid>.png` and `letterheads/<tid>.png`
    but not another user's;
  - non-admin cannot insert into `invoice_signatures` directly (service-role only).
- Wire into CI as a separate job that is allowed to be skipped when the test
  credentials are absent, so forks/PRs don't break.

**Done when:** deliberately reverting migration 0020 or 0022 turns the suite red.

### 1.3 Migration hygiene

- Rename the duplicate `0009_*` pair (`0009_scan_flags.sql`,
  `0009_transporter_checklist.sql`) — one becomes `0009a`/`0009b` or the second is
  renumbered — and record the applied order in a short `supabase/migrations/README.md`.
- Add a CI check that migration filenames are unique-prefixed and monotonic (a ten-line
  node script; no dependency).
- Adopt a convention for policy edits: **always** `drop policy if exists` with the
  *exact current* name — the 0018→0019 constraint bug came from dropping a name that
  never existed. Note it in the README so the next person does not repeat it.

---

## Phase 2 — Make the signature evidentially real

**Problem.** A signature today is a PNG plus a row. The image proves nothing, and
anyone with database access could insert a signature row. For an internal pilot that
is acceptable; for a payment pipeline that will be audited, the claim "X approved
this" needs to be defensible.

### 2.1 Bind the signature to the document, not just the invoice

- Extend `invoice_signatures` with:
  - `doc_hash text` — SHA-256 of the exact PDF bytes the signer was shown,
  - `signed_ip inet`, `user_agent text` — captured server-side in `invoice-sign.ts`,
  - `aal text` — record that the assurance level was `aal2` at signing time.
- The client builds the document, hashes it (`crypto.subtle.digest`, no dependency),
  and sends the hash with the sign request. The function stores it.
- On any later download, recompute and show a small "verified — matches what was
  signed" indicator, or a warning if the underlying data has changed since.

**Payoff:** you can prove *what* was approved, not merely that someone clicked
Approve. This is the single highest-value change for audit defensibility.

### 2.2 Close the insert path

- `invoice_signatures` already has no INSERT policy (service-role only) — good.
  Add a `REVOKE INSERT, UPDATE, DELETE ON invoice_signatures FROM authenticated`
  to make the intent explicit rather than relying on default-deny, and add a test
  asserting a direct insert from an authed client fails.
- Add a database-level guard: signatures are append-only. A `BEFORE UPDATE OR DELETE`
  trigger that raises unless the current role is the service role.

### 2.3 Say what it is

- Update the PRD and any Ministry-facing description: this is an **MFA-authenticated
  electronic attestation with a tamper-evident audit trail**, not a cryptographic
  digital signature (no PKI, no certificate authority). If someone upstream needs
  legal-grade signatures, that is a different project (qualified certificates), and
  they should learn that now rather than at audit.

---

## Phase 3 — Archive what was actually submitted

**Problem.** PDFs are generated client-side at download time from live data. Two
consequences: the same invoice can render differently in different browsers or after
a code change, and there is no record of the exact document the Ministry received.

- On `generated → submitted`, the client uploads the generated PDF package to a new
  private `archive` bucket at `archive/<invoice_id>/<stage>-<timestamp>.pdf`, and the
  `invoice-stage` function records the path plus its SHA-256 on the invoice row
  (or a small `invoice_documents` table if more than one archived doc per invoice).
- Same at `approved` (Director) so the memo and signatory sheet as-approved are kept.
- Archive objects are read-only to everyone except service role; no update or delete
  policy at all. `// ponytail: archive is append-only; retention policy when Records
  Management asks for one`.
- The invoice detail page gains a small "Archived documents" list so staff can open
  exactly what was submitted rather than a fresh render.

**Payoff:** removes the "we cannot reproduce what they signed six months ago" problem
entirely, and makes 2.1's hash meaningful long-term.

---

## Phase 4 — Close the workflow gaps that push people back to phone calls

The system's stated purpose is that transporters stop chasing staff for status. Two
gaps undercut that.

- **Notifications on the events that matter.** FCM is already wired
  (`netlify/functions/_fcm.ts`, `device_tokens`). Add sends on: scan flagged,
  checklist disapproved, each stage advance, and payment. Nothing more — over-notifying
  trains people to ignore the app.
- **Replace `window.prompt`/`confirm` on decision paths** (disapproval reason, flag
  reason, MFA code, memo fields) with the existing `MfaStepUpModal` pattern. Prompts
  cannot be styled, are blocked by some browsers, and offer no validation — a
  disapproval reason typed into a native prompt is a compliance record captured
  through the flimsiest input in the app.

---

## Phase 5 — Optional polish (only if the above ships)

- **Dashboard pagination** — the KPI queries are unbounded; fine at pilot scale, not
  at Ministry scale. Cheap to add before it hurts.
- **Per-stage comments** — the audit trail records *that* a stage moved, not *why*.
- **Checklist items in a config table** rather than a const array, once the Ministry
  starts asking to change them.
- **A bundle diet** — the main chunk is ~1.5 MB (jsPDF + pdfjs + firebase). Manual
  chunks or lazier imports would help transporters on slow connections, which is most
  of them.

---

## Sequencing and effort

| Phase | Why now | Rough size |
|---|---|---|
| 1 | Prevents the bug class that has already cost the most debugging time | Largest — 1.2 is most of it |
| 2 | Needed before anyone audits a payment made through this system | Medium |
| 3 | Cheap insurance; depends on 2.1 for full value | Small–medium |
| 4 | Delivers the stated business goal | Small each |
| 5 | Scale problems you do not have yet | Small each |

Do **1.1 and 1.3 first** — they are small, mechanical, and immediately stop the class
of bug that has burned the most time. 1.2 is the real investment and the one that
keeps paying.
