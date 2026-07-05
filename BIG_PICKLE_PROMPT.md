# Prompt for Big Pickle

Copy everything below the line into the agent.

---

You are working in the HTMS repo (Haulage Tracking & Management System for Ghana's Ministry of Energy and Green Transition). The app lives in `htms-app/`: React + Vite + TypeScript + Tailwind frontend, Netlify functions backend, Supabase (Postgres + RLS + Storage). Read `HTMS_PRD.md` for domain context and `htms-app/README.md` before writing anything.

Your job has two parts, in this order:

## Part 1 — Implement `IMPLEMENTATION_PLAN.md` (backend + features)

Follow the plan exactly. Summary of what it specifies:

1. Migration `htms-app/supabase/migrations/0007_pri_lifecycle.sql`: a `pri_stage` enum (11 stages: generated → submitted → with_chief_director → minuted_to_pd → pd_processing → pd_processed → cd_directive_audit → audit_validation → returned_to_cd → at_accounts → paid), plus `invoices.stage` (default 'generated') and `invoices.checklist jsonb default '{}'`.
2. New function `htms-app/netlify/functions/invoice-stage.ts` (~80 lines). Copy the `guard`/`json`/`audit` pattern from `invoices.ts` and `_lib.ts`. Hardcoded forward-only transition map. Role rules: `transporter` may only do `generated → submitted` on their own invoice; `officer`/`admin` do all transitions. Block `generated → submitted` unless all 4 checklist keys are true (`original_waybills`, `original_acknowledgement_forms`, `release_letters`, `contract_agreement_copy` — define as a const array in `shared/validation.ts`). Write every transition to `audit_log` — that is the status history; do NOT create a history table.
3. Do NOT touch `shared/calc.ts`, `shared/rates.ts`, or the FIDIC/rate logic. Do NOT weaken any RLS policy. The existing `invoice_status` enum (draft/approved/locked/void) is the calculation lifecycle — leave it alone; `stage` is a separate column.
4. Memo generation (`doc_type` 'memo' + `renderMemoHtml`) is BLOCKED on a sample document — skip it entirely, leave a `// ponytail: memo template blocked on Ministry sample` comment where the branch would go in `generate-document.ts`.
5. Add one test file in `shared/__tests__/` for the transition map: allowed transitions pass; stage-skips and wrong-role transitions fail.

## Part 2 — Restyle the UI to match the Stitch designs in `design/stitch/`

Each folder has a `screen.png` (visual target) and `code.html` (reference markup). Mapping:

| Stitch folder | App file |
|---|---|
| `htms_login` | `src/pages/Login.tsx` |
| `htms_staff_dashboard` | `src/pages/Dashboard.tsx` |
| `htms_waybill_entry` | `src/pages/WaybillEntry.tsx` |
| `htms_invoice_management` | `src/pages/Invoices.tsx` (add stage timeline + checklist card here) |
| `htms_transporter_invoice_status` | NEW page `src/pages/InvoiceStatus.tsx`, route for transporter role, mobile-friendly |
| `htms_admin_user_management`, `htms_admin_audit_logs` | tabs in `src/pages/Admin.tsx` |
| `htms_admin_fleet_registry` | SKIP — no fleet table exists; do not invent one. The transporters CRUD in Admin covers it. |
| `ministry_of_energy_haulage_tracking_management_system` | SKIP — marketing/landing page, not needed for an internal pilot. |

Rules for the port:

- The designs are a visual reference, not code to paste. Rebuild with the repo's existing Tailwind setup. Do NOT add the Tailwind CDN script, and do NOT copy Stitch's full Material-token soup — extract only the handful of colors actually used into `tailwind.config.js` alongside the existing `ministry` palette (`#2e7d32` stays primary).
- Keep the top navbar layout and the red/gold/green Ghana-flag accent strip. No sidebar.
- Inter font and Material Symbols icons are fine to add (one `<link>` each in `index.html`).
- Keep all existing data wiring (`src/lib/api.ts`, AuthProvider, role-gated routes) — this is a reskin plus the new lifecycle UI, not a rewrite.
- The invoice detail's stage timeline is the centerpiece: completed steps green with actor + timestamp (rendered from `audit_log` rows), current step highlighted, one "Advance" button gated by role.

## Working style

- Smallest diff that matches the design and the plan. No new dependencies unless one screen is impossible without it.
- After each phase: `npm run build` and the test suite must pass. Run existing tests in `shared/__tests__/` before and after.
- Commit per phase: (1) migration + function + test, (2) each screen restyle separately.
- If the Stitch design conflicts with existing functionality (missing filters, missing columns), functionality wins — keep the feature, adapt the styling.

Start with Part 1. Do not start Part 2 until Part 1 builds and its test passes.
