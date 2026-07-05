# Prompt for Big Pickle — Memo + Signatory Page generation

Copy everything below the line. Attach the two template photos (the PD memo and the
signed "HAULAGE INVOICES" signatory sheet) so the layout can be matched.

---

You are working in the HTMS repo, in `htms-app/`. Two new client-side PDF documents
must be added, following the EXACT existing pattern in `src/lib/pdf.ts` (jsPDF +
jspdf-autotable, Helvetica, A4 portrait, `M = 48`pt margin, `newDoc()`, `pageWidth()`,
`ref()`, `ghs`-style `num()` formatting, `loadLogo()`). Study `buildInvoice` and
`buildLetter` first and reuse their helpers. Do NOT add dependencies. Do NOT touch
`shared/calc.ts` or any server function.

## 1. `buildMemo(inv: InvoiceDoc, opts, logo?)` in `src/lib/pdf.ts`

Replicates the attached PD memorandum photo:

- Title: **MEMORANDUM** — bold, underlined, left-aligned.
- Block (bold labels, tab-aligned values):
  - `TO:` `CHIEF DIRECTOR`
  - `FROM:` `opts.fromTitle` (e.g. "AG. DIRECTOR, POWER" — caller supplies)
  - `SUBJECT:` `REQUEST FOR PAYMENT IN FAVOUR OF M/S <TRANSPORTER UPPERCASE> FOR THE HAULAGE OF ELECTRICAL MATERIALS` (bold, wraps)
  - `DATE:` today, formatted like `MAY 05, 2026`
- Horizontal rule, then SIX numbered, justified paragraphs (use the invoice data):
  1. `Reference is made to the letter dated <opts.letterDate long form>, from M/S <TRANSPORTER> requesting for payment for haulage of electrical materials (copy attached).`
  2. `We confirm that the transporter has satisfactorily executed the work as evidenced by the attached waybills.`
  3. `Messrs. <TRANSPORTER> submitted <N> waybills with an invoice amount of GHS <total> for processing and payment.` — N = waybill count (reuse the `summary()` helper's waybill count).
  4. `Furthermore, review of the submitted waybills indicated that the amount due the transporter under the invoice is GHS <total>.`
  5. `The Power Directorate hereby submits the request for payment of an amount of GHS<total> (<AMOUNT IN WORDS> Ghana Cedis and <pesewas words> Pesewas) for haulage of the electrical materials to your attention.` — amount-in-words segment bold.
  6. `We have attached copies of the relevant documents for your perusal.`
- Bottom, after ~3 line gap: `opts.signatoryName` bold uppercase (e.g. "ING. SULEMANA ABUBAKARI"). No signature line above it (the sample has none — they sign above the name).

**Amount in words:** write a small `amountInWords(n: number): string` helper in the
same file (Ones/Teens/Tens/Hundred + Thousand/Million scales, plus pesewas from the
2-dp remainder). Example: 13695.86 → "Thirteen Thousand, Six Hundred and Ninety-Five
Ghana Cedis and Eighty-Six Pesewas". Add 3–4 assert cases for it in a small
`shared/__tests__/` test if it's placed somewhere importable, otherwise skip the test
and keep the helper pure.

`opts = { fromTitle: string; signatoryName: string; letterDate: string /* yyyy-mm-dd */ }`

## 2. `buildSignatory(inv: InvoiceDoc, logo?)` in `src/lib/pdf.ts`

Replicates the attached "HAULAGE INVOICES" signatory sheet:

- Header row: title **HAULAGE INVOICES** centered; period box right (`period_start – period_end`
  formatted `Jan 1, 2025 - May 10, 2026`; fall back to the summary() dates).
- Below: `Haulage Cost` total left (big, bold, the invoice total), `Transporter Name: <name>` right.
- autoTable of ONLY this invoice's lines, columns matching the sample:
  `Category | Date | Distance | From | To | Haulage Charge (Pole/Mats) | Haulage Charge/Stay block | Transporter | Truck Size/Trailer | No. of Poles | No. of trips | Waybill No. | Vehicle No. | Haulage Cost`
  - Data source: `invoice_lines` (category, distance_km, computed_cost, rate_snapshot.rates.haulagePerUnitKm, rate_snapshot.rates.stayPerKm) + `waybills` (waybill_date, origins.name, districts.name, truck_size, num_poles, num_trips, waybill_no, vehicle_no).
  - NOTE: the fetch in `Invoices.tsx` `makeDoc()` must add `truck_size,num_poles` to the
    `waybills(...)` select — currently missing.
  - Small font (7pt) so all columns fit; landscape is acceptable if portrait can't fit
    (`new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' })` for this doc only).
- Below the table, three signature blocks stacked vertically with generous spacing,
  each one row: `Prepared by: ____________  Name: ____________  Date: ________`,
  then `Checked by:` and `Approved by:` the same.

## 3. Wire up in `src/pages/Invoices.tsx`

In the detail header button row (next to Invoice/Letter), add:

- **Memo** button → `window.prompt` three times, with defaults remembered in
  `localStorage` (`htms.memo.fromTitle`, `htms.memo.signatoryName`):
  1. "FROM (designation)" default `AG. DIRECTOR, POWER`
  2. "Signatory name" default `ING. SULEMANA ABUBAKARI`
  3. "Date on the transporter's payment request letter (yyyy-mm-dd)" default: the
     invoice's `period_end` or `created_at` date.
  Cancel on any prompt = abort. Then `buildMemo(...).save(\`Memo_${invoiceRef(inv)}.pdf\`)`.
- **Signatory** button → `buildSignatory(inv, logo).save(\`Signatory_${invoiceRef(inv)}.pdf\`)`.
- Both reuse the same fetched `inv` object that `makeDoc` fetches — extend `makeDoc`'s
  `type` union to `'invoice' | 'letter' | 'memo' | 'signatory'` rather than writing a
  new fetch. Memo and signatory do NOT append scans — skip the `appendScansToPdf` path
  for them and save directly.
- Staff only (`!isTransporter`), same styling as the existing buttons, icons:
  `assignment` (memo), `draw` (signatory).

## Verification

- `npx tsc --noEmit -p tsconfig.json` and `-p tsconfig.functions.json` both clean.
- Existing tests still pass (`npx vitest run`).
- Generate both PDFs against a seeded invoice and visually compare with the attached
  photos: memo paragraph order/wording exact; signatory table shows ONLY the invoice's
  trips and the total matches `total_cost`.
