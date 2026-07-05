# HTMS — UI Design Brief (for Google Stitch)

Paste sections of this into Stitch per screen. Keep prompts short; Stitch works best one screen at a time.

## Product in one line

HTMS is an internal web app for Ghana's Ministry of Energy and Green Transition that tracks haulage waybills, calculates transporter payments, generates payment-request invoices/letters/memos, and shows every invoice's real-time status through the Ministry approval pipeline.

## Users

- **Officer / Admin (Power Directorate staff):** enter waybills, generate invoices and documents, advance invoice stages, manage rates.
- **Transporter:** uploads waybill scans, marks their invoice as "submitted at Ministry," then watches its status — read-only. The status timeline is the anti-harassment feature; make it prominent and legible to non-technical users.

## Brand & style

- Primary green: `#2e7d32` (dark `#1b5e20`, light tint `#e8f5e9`). Header: near-black (`gray-900`) with white text.
- Signature detail: a thin Ghana-flag accent strip (red / gold / green) under the header — keep it.
- Ministry crest logo top-left, app name "HTMS", subtitle "Ministry of Energy and Green Transition".
- Tone: official government, clean, trustworthy. Desktop-first (office use), but transporter status screen must work well on mobile.
- Currency shown as GHS / ₵ with 2 decimals. Dates as 5-Jul-2026.

## Screens (design each)

### 1. Login
Centered card, crest, email + password, green primary button. Nothing else.

### 2. Dashboard (staff)
- 3 KPI stat cards: Total value, Poles value, Materials value.
- New: a row of stage-count chips (e.g. "4 In Processing", "2 At Audit", "1 At Accounts") showing the invoice pipeline queue.
- Filter bar: search by waybill no., category dropdown, transporter dropdown.
- Dense data table: date, waybill no., transporter, category, origin → destination, trips, truck size, computed cost.

### 3. Waybill Entry
Form: transporter, category (Material / Poles / Concrete Poles), waybill no., vehicle no., origin, destination district, quantities (poles / stay blocks / concrete poles), truck size (20/40 ft), trips, date. Plus a drag-and-drop scan upload zone with thumbnail list of uploaded files.

### 4. Invoices (staff)
- List of invoices: reference no., transporter, period, total, calc status (draft/approved/locked), **pipeline stage badge**.
- Detail view for one invoice:
  - **Stage timeline** (the centerpiece): 11 steps — Generated → Submitted at Ministry → With Chief Director → Minuted to Power Directorate → Processing → Processed → CD Directive to Audit → Audit Validation → Returned to CD → At Accounts → Paid. Completed steps green with actor + timestamp, current step highlighted, future steps gray. One clear "Advance to next stage" button.
  - **Rejection-prevention checklist** card: 4 checkboxes — original waybills, original acknowledgement forms, release letters, contract agreement copy. Submission is blocked until all 4 are checked; show that state clearly.
  - Line items table (waybill, distance km, rate, cost) and document actions: Generate Invoice / Letter / Memo (download).

### 5. Invoice Status (transporter, mobile-friendly)
Read-only version of the detail view: big current-stage banner ("Your invoice is at: Audit Validation"), vertical timeline with dates, checklist state, total amount. No edit controls except one button visible only at the start: "Mark as submitted at Ministry".

### 6. Admin
Tabs: Transporters (CRUD table), Rate versions (list + activate), Fuel prices (weekly table with flagged/manual status), Users (role assignment).

## Don'ts

- No sidebars — keep the current top navbar layout.
- No dashboards full of charts; this is an operational tool, tables over graphs.
- Don't hide the timeline behind a tab — it's the product's main promise.
