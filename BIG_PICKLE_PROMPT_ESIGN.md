# Prompt for Big Pickle — Electronic Attestations, Review Roles, Director View

Copy everything below the line into the agent.

---

You are working in the HTMS repo, in `htms-app/`. Read `HANDOFF.md` and `HTMS_PRD.md`
first. Stack: React/Vite/TS + Tailwind, Netlify functions, Supabase (Postgres + RLS +
Storage). PDFs are generated CLIENT-SIDE in `src/lib/pdf.ts` (jsPDF) and merged with
scans via `src/lib/mergeScans.ts` (pdf-lib). Latest migration is `0016`. Do NOT add
new dependencies. Do NOT touch `shared/calc.ts` or rate logic. Smallest working diff;
mark deliberate ceilings with `// ponytail:` comments.

Feature set: MFA-authenticated electronic attestations applied to the generated documents, two new
review roles (Deputy Director, Director), and a simplified reviewer reading view.

## 1. Migrations

**`0017_review_roles.sql`** — ONLY this (new enum values cannot be used in the same
transaction they're added):

```sql
alter type user_role add value if not exists 'deputy_director';
alter type user_role add value if not exists 'director';
```

**`0018_signatures.sql`**:

- `alter table users add column signature_path text;` (storage path of the one-time
  uploaded signature image).
- New table:
  ```sql
  create table invoice_signatures (
    invoice_id uuid not null references invoices(id) on delete cascade,
    slot text not null check (slot in ('transporter','prepared','checked','approved')),
    user_id uuid not null references users(id),
    signed_at timestamptz not null default now(),
    primary key (invoice_id, slot)
  );
  ```
  RLS: staff + the invoice's own transporter can SELECT; INSERT only via service role
  (the Netlify function does the writing) — so no insert policy for authed users.
- Storage: signature images live in the existing private `documents` bucket under
  `signatures/<user_id>.png`. Policies: owner can insert/update their own; all staff
  roles + the owner can read. (Needed because whoever generates a PDF must fetch the
  signature images of everyone who signed it.)
- Grep the migrations for `auth_role() in ('admin','officer')` (RLS) and the Netlify
  functions for the same role checks (`guard` in `_lib.ts` and per-function checks).
  `deputy_director` and `director` are STAFF, read-only: give them SELECT wherever
  admin/officer can SELECT (invoices, invoice_lines, waybills, scans, transporters,
  audit_log, distance matrix). They get NO insert/update/delete on those tables. Add a
  `is_staff_role()` sql helper or extend the in-list — whichever is the smaller diff.
- `admin-users.ts` + the Admin Users tab must allow creating/assigning the two new
  roles.

## 2. Signature capture (one-time) + MFA enrollment

- New "My signature" card on a settings surface every authed role can reach (reuse an
  existing page section if one fits; otherwise a minimal `/settings` route). Contents:
  1. Signature upload: PNG/JPEG file input → store at `signatures/<uid>.png` in
     `documents`, save path on `users.signature_path`. Show current signature image
     (signed URL) with a Replace button.
  2. MFA enrollment: Supabase built-in TOTP — `supabase.auth.mfa.enroll({ factorType:
     'totp' })`, render the returned QR (`totp.qr_code` is an SVG data URI — just an
     `<img>`), verify the 6-digit code with `challenge` + `verify`, list/unenroll
     existing factors. No custom MFA code, no SMS provider.
- Uploading a signature does NOT sign anything. Signing is always an explicit action
  below.

## 3. The signing action — one server function, MFA-gated

**New `netlify/functions/invoice-sign.ts`** (copy the `guard`/`json`/`audit` pattern
from `invoice-stage.ts`):

- Input: `{ invoice_id }`. The slot is DERIVED from the caller's role — never sent by
  the client: `transporter → 'transporter'` (own invoice only), `officer/admin →
  'prepared'`, `deputy_director → 'checked'`, `director → 'approved'`.
- **MFA gate:** verify the caller's JWT has `aal === 'aal2'` (decode the access token
  payload; it's a claim). Reject with 403 `mfa_required` otherwise. This is the server
  enforcement of "MFA authenticates the user when their signature is about to be
  applied".
- Preconditions (422 with a clear message): caller has `users.signature_path` set;
  slot not already signed; ordering — `'checked'` requires `'prepared'` to exist,
  `'approved'` requires `'checked'`; `'transporter'` requires the invoice to be
  submission-ready (same checklist/review gate `invoice-stage.ts` uses for
  generated→submitted). Signing is otherwise stage-agnostic.
  `// ponytail: signatures decoupled from pipeline stages; bind slots to specific stages if the Ministry asks`
- Effect: insert the `invoice_signatures` row (service client), write an `audit_log`
  entry (`invoice.signed`, meta: slot).
- **Transporter auto-sign:** in `invoice-stage.ts`, make `generated → submitted`
  additionally require the `'transporter'` signature row to exist (409 telling them to
  sign first). Client-side, the transporter's Submit flow on `InvoiceStatus.tsx`
  becomes: step-up to aal2 if needed (`supabase.auth.mfa.getAuthenticatorAssuranceLevel()`,
  then `challenge` + `verify` with a code prompt — reuse `window.prompt`, pilot-scale)
  → call `invoice-sign` → call `invoice-stage` submit. One button, "Sign & Submit".
  If the user has no signature or no MFA factor, show a link to the settings card
  instead of the button.

## 4. Staff "Approve" buttons (apply signature)

On the invoice detail (Invoices page), one signature status strip showing the three
slots (Prepared / Checked / Approved) with signer name + date when filled. Next to it,
ONE button whose label depends on role and slot state:

- officer/admin, `prepared` empty → **"Sign (Prepared by)"**
- deputy_director, `checked` empty (and `prepared` filled) → **"Approve"**
- director, `approved` empty (and `checked` filled) → **"Approve"**

All three run the same client flow as §3 (aal2 step-up → `invoice-sign`) then refresh.
Disabled with a tooltip when the ordering precondition isn't met.

## 5. Render signatures into the PDFs (`src/lib/pdf.ts`)

Extend `InvoiceDoc` with `signatures?: { slot: string; signed_at: string; name: string;
sigDataUrl?: string | null }[]` — the fetch in `Invoices.tsx` `makeDoc()` (and the
transporter status page's doc download, if it has one) joins `invoice_signatures` +
signer `users.full_name`/`signature_path`, creates signed URLs, and fetches each image
to a data URL (same technique as `loadLogo()`).

- `buildLetter` + `buildInvoice`: if the `transporter` slot is signed, draw the
  signature image (~110×40pt) above the transporter name block, with the signed date
  under it. Unsigned = render exactly as today.
- `buildSignatory`: for each filled slot, replace the blank underscores: draw the
  signature image over the "Prepared/Checked/Approved by:" line, the signer's name on
  the Name line, `short(signed_at)` on the Date line. Unfilled slots keep the blanks.
- `buildMemo`: if `approved` is signed, draw the Director's signature image above the
  signatory name, and default `opts.signatoryName` to the approved signer's name.

## 6. Reviewer view (Director + Deputy Director)

Same Invoices page, but for `role in ('deputy_director','director')` render a
simplified detail:

- HIDE the per-scan chip buttons, flag toggles, checklist preview buttons,
  approve/disapprove verdict, stage-advance controls, and the Memo/Signatory/Invoice/
  Letter buttons.
- SHOW: header summary (transporter, ref, period, total), the signature status strip +
  their Approve button (§4), and ONE button: **"Payment request documentation"**.
- That button builds a single merged PDF, chronological order:
  1. Payment request letter (`buildLetter`) then invoice (`buildInvoice`) — both with
     signatures per §5,
  2. acknowledgement scans,
  3. waybill scans,
  4. release-letter scans.
  Reuse `appendScansToPdf` exactly as the existing scan-package path in `Invoices.tsx`
  does — the only change is ordering the scans `acknowledgement → waybill →
  release_letter` (then by created_at) instead of whatever order they come back in.
  Open in a new tab (blob URL) rather than auto-download, so they can read in-browser.
- Routing: reviewers land on the Invoices page; hide nav items for pages they can't
  use (Waybill entry, Admin). No new page component unless the conditional rendering
  in `Invoices.tsx` gets unmanageable — prefer an `isReviewer` flag.

## Verification

- `npx tsc --noEmit -p tsconfig.json` and `-p tsconfig.functions.json` clean;
  `npx vitest run` passes. (Linux sandbox: fresh `npm install` in a copy — the user's
  `node_modules` is macOS-built.)
- Add ONE test file: slot-ordering + role→slot derivation logic (pure function in
  `shared/`, e.g. `shared/signing.ts`, imported by the Netlify function) — allowed and
  rejected cases.
- Manual: transporter without MFA/signature is blocked with a helpful message;
  transporter with both can Sign & Submit; signed letter shows the image; DD before
  officer-prepare is blocked; Director's merged doc pages come out in the specified
  order; memo carries the Director's signature after approval.

## Assumptions baked in (flag to the user if wrong)

- MFA = Supabase built-in TOTP (authenticator app). No SMS/email OTP.
- Signatures are decoupled from the 11-stage pipeline (only transporter-sign gates
  submission); DD/Director signing does not advance stages.
- Reviewers are read-only everywhere except signing.
