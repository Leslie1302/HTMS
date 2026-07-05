# HTMS Phase 2 — Implementation Plan

Three features: PR/I lifecycle tracking, rejection-prevention checklist, Ministry memos.
All build on existing tables and patterns — no new services, no new dependencies.

## What already exists (reuse, don't rebuild)

| Need | Existing asset |
|---|---|
| Status history / "who updated when" | `audit_log` (append-only, before/after jsonb) |
| Document generation | `documents` table + `doc_type` enum + `shared/documents.ts` templates + `generate-document.ts` |
| Role-scoped writes | `guard({ roles })` in netlify functions + RLS policies |
| Transporter identity | `app_users.transporter_id` binding + RLS scoping |

## Phase 1 — PR/I lifecycle (core value, build first) ~3–5 days

**Migration `0007_pri_lifecycle.sql`:**

```sql
create type pri_stage as enum (
  'generated',            -- system creates PR/I (start of lifecycle)
  'submitted',            -- delivered in person at Ministry (transporter updates)
  'with_chief_director',  -- at CD's office
  'minuted_to_pd',        -- minuted to Power Directorate
  'pd_processing',        -- unit working on it
  'pd_processed',         -- unit done, back to CD
  'cd_directive_audit',   -- CD directs to audit
  'audit_validation',     -- audit unit validating
  'returned_to_cd',       -- audit done, back to CD
  'at_accounts',          -- with accounts for payment
  'paid'
);
alter table invoices add column stage pri_stage not null default 'generated';
alter table invoices add column checklist jsonb not null default '{}';
```

**One new function `invoice-stage.ts`** (~80 lines, copy the `invoices.ts` pattern):

- `POST { invoiceId, stage }`
- Hardcoded transition map (each stage → its single next stage; plus a `rejected → pd_processing` style back-step if needed later — skip until it happens).
- Role map: `transporter` may only do `generated → submitted`, and only on their own invoice (RLS already scopes this). `officer`/`admin` do everything else.
- `generated → submitted` blocked unless all 4 checklist items are true.
- Every transition writes `audit_log` — that IS the status history; no new history table.

**UI (Invoices.tsx + a transporter-visible status view):**

- Stage badge + "advance to next stage" button (label changes per stage).
- Timeline rendered from `audit_log` rows for that invoice (who, when, what stage).
- Transporters get read-only stage + timeline for their own invoices — this is the anti-harassment feature; they check the app instead of calling you.

## Phase 2 — Checklist ~1 day

Fixed 4 items, stored in the `checklist` jsonb column (no new table):

```json
{
  "original_waybills": false,
  "original_acknowledgement_forms": false,
  "release_letters": false,
  "contract_agreement_copy": false
}
```

- Checkbox card on the invoice detail page, editable by transporter + officers.
- Server enforces "all true" before `generated → submitted` (in `invoice-stage.ts`, not just the UI).
- Items are hardcoded in `shared/validation.ts` as a const array — a config table for 4 fixed items is over-engineering. Make it a table only when a second unit onboards with different items.

## Phase 3 — Ministry memo ~1–2 days (blocked on sample)

- `alter type doc_type add value 'memo';`
- `renderMemoHtml()` in `shared/documents.ts`, same pattern as invoice/letter.
- One more branch in `generate-document.ts`.
- **Blocker: need one real memo sample** (format, addressee block, reference style, signature block). Do not start without it.

## Phase 4 — Pilot hardening ~1 day

- Dashboard: count of invoices per stage (one grouped query), so the unit sees its queue.
- RLS check: transporters can `select` their own invoice `stage`/`checklist` and `update` nothing except via the stage function.
- One test: transition-map unit test in `shared/__tests__` (allowed transitions pass, skips and wrong-role fail).

## Decisions locked in (change these only if wrong)

1. Checklist **blocks** submission (not warn-only).
2. CD/audit/accounts stages are recorded **by Power Directorate on their behalf** during pilot — those units are not users yet.
3. No notifications/emails in pilot. Add when someone asks twice.
4. No per-stage comments field. `audit_log` captures actor + timestamp; add a note column when a real case needs one.

## Total: ~6–9 working days, one migration, one new function, template + UI edits.
