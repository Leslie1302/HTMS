# HTMS — Session Handoff Note

**Date:** 5 Jul 2026 · **User:** Leslie Nii Adjetey (Power Directorate, Ministry of Energy and Green Transition, Ghana)

## Project

HTMS tracks haulage waybills, calculates transporter payments (FIDIC-escalated rates + weekly GOIL fuel prices), generates payment-request documents, and tracks each invoice through an 11-stage Ministry approval pipeline. Piloted by the Power Directorate; goal is transparency so transporters stop harassing staff for status updates.

**Stack:** React/Vite/TS + Tailwind (`htms-app/src`), Netlify functions (`htms-app/netlify/functions`), Supabase Postgres + RLS + Storage (`htms-app/supabase/migrations`, 0001–0011). Shared calc/validation in `htms-app/shared` (used by BOTH client and server). Docs: `HTMS_PRD.md`, `IMPLEMENTATION_PLAN.md`, `STITCH_DESIGN_BRIEF.md` (+ `design/stitch/` UI references).

**Roles:** admin, officer (staff), transporter (RLS-bound to own `transporter_id`).

## Key domain rules (all server-enforced in `netlify/functions/invoice-stage.ts`)

- 11-stage forward-only pipeline: generated → submitted → with_chief_director → minuted_to_pd → pd_processing → pd_processed → cd_directive_audit → audit_validation → returned_to_cd → at_accounts → paid. Transporters may only do generated→submitted on their own invoice. `audit_log` IS the status history (no history table).
- Submission gate: all 4 checklist items ticked (jsonb on invoices) AND no flagged scans AND officer review_status='approved'.
- `review_status` (pending/approved/disapproved on invoices): disapproved freezes ALL transitions with the logged reason shown to the transporter; re-approval resumes at the same stage. Disapprove is one-way disabled after approval (user's explicit request).
- Reaching 'paid' auto-locks the invoice (`status='locked'`); manual Lock buttons removed. "Approve totals" (admin) = old calc-status approval, distinct from checklist approval.
- Scans: `scan_type` enum (waybill/acknowledgement/release_letter) + `flagged_reason` (0009). Officers flag substandard uploads; transporter sees red "Action Required" card on their status page. Contract = `transporters.contract_path` + `contract_validated`.
- Multi-drop trips bill the FURTHEST destination (`waybill_destinations`); missing distance-matrix rows now fail loudly (422) instead of silently billing a nearer drop. Dashboard shows amber ⚠ + per-drop hover breakdown + billed Km column.
- Dashboard KPI cards sum ONLY approved/locked invoice lines (+ "Owed (approved, unpaid)" card = stage ≠ paid). Table costs are estimates ("Est. Cost").

## This session shipped (all tsc-clean, 13 vitest tests pass)

Migrations 0009 (scan flags + staff scan RLS), 0010 (review_status/review_note), 0011 (scans.uploaded_by default auth.uid() — root fix for silent scan-insert failures from WaybillEntry). Invoices page: doc chips w/ signed URLs + flag toggles, per-checklist-item preview buttons, Approve/Disapprove verdict, row expand/collapse + minimize, search bar. Transporter status page: submit button (was missing entirely!), disapproval + flagged cards, auto-open single invoice. Trip Calculator page (all roles): multi-drop input, finds furthest itself, uses the SAME `shared/calc.ts` + `shared/calcConfig.ts` engine as invoicing (calcConfig moved from functions to shared; `_calcConfig.ts` re-exports). WaybillEntry: category-conditional fields (wooden poles only for Poles, concrete only for Concrete Poles), stale counts zeroed at submit, scan-insert errors surfaced. Admin: read-only Distance Chart tab.

**NOT yet deployed by user:** migrations 0009–0011 need to run on Supabase; app needs redeploy.

## CURRENT TASK (in progress — spec ready)

Build memo + signatory-page PDF generation. **Full spec: `BIG_PICKLE_PROMPT_MEMO.md`** (repo root). User has photos of both paper templates (PD memorandum to the Chief Director; "HAULAGE INVOICES" sheet with Prepared/Checked/Approved signature lines) — ask for them if not attached. Follow the existing client-side jsPDF pattern in `src/lib/pdf.ts` (`buildInvoice`/`buildLetter`); add `buildMemo` + `buildSignatory` + `amountInWords`; wire buttons into `makeDoc` in `src/pages/Invoices.tsx`; the fetch there must add `truck_size,num_poles` to the waybills select. Memo prompts (localStorage-remembered defaults): FROM designation, signatory name, transporter letter date.

## Gotchas

- Ponytail mode active: smallest working diff, no new deps, no speculative abstractions, `// ponytail:` comments mark deliberate ceilings.
- User's node_modules is macOS-built; Linux sandboxes must test in a separate copy (`npm install`, then `npx tsc --noEmit -p tsconfig.json` AND `-p tsconfig.functions.json`, `npx vitest run`).
- tsconfig `include` is only `src` + `shared` — client code must not import from `netlify/functions`.
- `window.prompt/confirm` used for reasons/dialogs by design (pilot-scale).
- Backlog (deliberately skipped): notifications on flag/disapproval, dashboard pagination, per-stage comments, config table for checklist items, editing distance matrix from UI.
