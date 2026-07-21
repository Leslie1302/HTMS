# Product Requirements Document (PRD)
## HTMS — Haulage Transaction Management System

**Author:** Leslie Nii Adjei
**Date:** 17 June 2026
**Version:** 1.1 (updated for roles, Ministry branding, scans & GOIL fuel scraper; verified against `Haulage Txn Data.xlsx`)
**Status:** Proposed
**Prepared with:** Agentic Systems Engineer methodology (security-first, production-grade)

---

## 0. Assumptions locked for this draft

You confirmed (v1.1):

- **Build a native system**; the Excel archives are kept separate (no automated import from the old workbook).
- **Three user roles: Admin, Officer, Transporter.** Transporters and officers enter waybill data **and upload relevant scans** (e.g. the signed waybill); the system generates payment request letters and invoices **with the scans attached**.
- **Organisation is the Ministry of Energy and Green Transition** (not ECG). Branding/letterhead follows the Ministry.
- **Weekly fuel prices are scraped from GOIL (`goil.com.gh`)** by a scheduled scraper (you suggested Scrapy) so the FIDIC escalation factor stays current automatically.

Remaining best-fit defaults (flagged so you can override):

| Decision | Default adopted | Why | Override? |
|---|---|---|---|
| Database | **Supabase (Postgres + Auth + Row-Level Security + Storage)** | Free tier, pairs cleanly with Netlify, RLS enforces roles at the data layer, Storage holds scans + generated PDFs | ☐ |
| Documents | **Branded (Ministry), editable, downloadable/printable PDFs with the waybill scan attached** | Payment requests go to Ministry finance — they need letterhead, a review step, and supporting scans | ☐ |
| Currency | **GHS (Ghana Cedi, ₵)** | Per source data | ☐ |
| Scraper runtime | **Scheduled job outside the request path** (GitHub Action / Netlify Scheduled Function), writing into Supabase | A Scrapy spider should never run inside a user-facing serverless request — see §6.6 | ☐ |

---

## 1. Background & Problem Statement

Today, **Ministry of Energy and Green Transition** contractor haulage billing runs entirely inside a single Excel/Google Sheets workbook (`Haulage Txn Data.xlsx`). The workbook chains seven sheets together: raw form responses, a ~266-district distance matrix, a 2018 base-rate card, a FIDIC price-escalation engine (~198.6% multiplier), an escalated rate schedule, a weekly fuel-price series, and a master invoice calculator that computes what each transporter is paid per waybill.

**The problems with the spreadsheet approach:**

- **Fragility.** A single misplaced `INDEX-MATCH`, a broken `IMPORTRANGE`, or an accidental row sort silently corrupts every downstream invoice. `IFERROR(..., "")` hides errors as blanks rather than surfacing them.
- **No audit trail.** There is no record of who changed a rate, edited a waybill, or approved a payment. For financial documents going to ECG, this is a compliance gap.
- **Manual document production.** Payment request letters and invoices are produced by hand outside the workbook, introducing transcription errors and inconsistent formatting.
- **No access control.** Anyone with the share link can edit rates, distances, and computed amounts — including the FIDIC multiplier that cascades into every invoice.
- **Poor reporting.** The dashboard view (totals by category, transporter, date range) has to be rebuilt manually with pivot tables.
- **Concurrency.** Multiple officers editing the same sheet causes overwrites and lock contention.

**The goal:** replace the spreadsheet with a hosted, secure web application that captures waybills natively, computes haulage cost using the exact same vetted formulas, generates branded payment request letters and invoices, and presents a live dashboard of invoice totals — without the user ever touching a spreadsheet again.

---

## 2. Goals & Non-Goals

### 2.1 Goals (in scope for v1)

1. Native waybill/trip entry that captures all fields the old form did, with validation at entry time, **plus upload of supporting scans** (signed waybill, delivery note) attached to each waybill.
2. A maintained distance matrix (≈266 districts × 6 origins) queryable by `(From, To)`.
3. A configurable rate engine: editable 2018 base rates, the FIDIC escalation formula with its wage/fuel inputs, and the resulting escalated rate schedule — all versioned.
4. Deterministic invoice cost calculation reproducing the three category branches (Material, Poles, Concrete Poles) exactly.
5. Generation of **payment request letters** and **payment request invoices** as branded (Ministry of Energy and Green Transition), editable, downloadable/printable PDFs, **with the uploaded waybill scan(s) attached/appended** to the document package.
6. A **dashboard** of invoice totals matching the screenshot: total haulage cost, cost split by Poles vs Materials, filters by Waybill No., Category, Transporter, and date range, and a line-item invoice table.
7. Role-based access (Admin / Officer / Transporter) with full audit logging.
9. **Automated weekly fuel-price ingestion** from GOIL (`goil.com.gh`) feeding the escalation engine.
8. Deployable on **Netlify** (frontend + serverless functions) with Supabase as the backend.

### 2.2 Non-Goals (explicitly out of scope for v1)

- Importing or syncing the legacy Excel/Sheets workbook (archives kept separate, per your instruction).
- Payment execution / disbursement (the system *requests* payment; it never moves money).
- KoboToolbox / Google Forms ingestion.
- Mobile native apps (the web app will be responsive, but no iOS/Android build).
- (None deferred on the calculation side — see the verification note below; the fuel-indexed escalation is **v1 core**, not deferred.)

> ⚠️ **Verification finding (changes the design).** I reproduced the dashboard's real invoices against the source doc and found two things:
> 1. The flat **198.6% / ×2.986** multiplier in the doc does **not** match its own FIDIC inputs — those inputs (a=.3, b=.3, c=.4, Wn/Wo=21.77/9.68, Fn/Fo=15.45/3.73) compute to **×2.63**, and *neither* value reproduces the actual dashboard amounts.
> 2. The live system applies the FIDIC factor **per trip, indexed to the diesel price on the waybill's date** (the Weekly-Fuel sheet). Real rows use factors of ~2.11–2.34 (e.g. waybill 12776/12777, 893 km, 120 poles → ₵41,596.77 reproduces only with a per-trip factor of ~2.107, implying diesel ≈ ₵10.55/L at that trip's date). The ×2.986 is just one Oct-2022 snapshot.
>
> **Consequence:** the weekly-fuel-indexed escalation is therefore a **v1 core requirement**, not a v2 add-on — without it the engine cannot match historical invoices. §6.2/§6.3 reflect this.

---

## 3. Users & Personas

| Persona | Role | Needs |
|---|---|---|
| **Leslie (you) / Ministry staff** | Admin | Configure rates, the FIDIC inputs, and the distance matrix; manage transporters and users; approve invoices; generate payment requests; see all reporting; oversee the fuel-price scraper. |
| **Logistics Officer** | Officer | Enter/verify waybills and upload scans on behalf of transporters; see computed costs; assemble invoices for approval; cannot edit rates or the escalation factor. |
| **Transporter** | Transporter | Enter their own waybill data, upload their scans (signed waybill/delivery note), and view/download the payment request letters and invoices generated for **their own** trips only. |

**Critical authorization rules (enforced at the database layer via RLS, not just hidden in the UI):**

- Only **Admin** can edit the rate card, the FIDIC parameters, and the distance matrix — a change there cascades into *every* invoice.
- **Transporters** can only create and read **their own** waybills, scans, and documents — never another transporter's data (this is the primary IDOR surface, see §4).
- Only **Admin** (optionally Officer, configurable) can approve/lock an invoice; once locked, its computed amount and attached scans are immutable.

---

## 4. Threat Model *(ASE — stated first, frames everything below)*

This app holds financial data, computes amounts owed to third parties, and produces documents that trigger real payments. The top attack/abuse surfaces:

1. **Unauthorised rate/formula tampering → financial fraud.** The single highest-impact risk. Anyone able to alter the FIDIC multiplier, a base rate, or a distance silently changes every invoice amount. A 0.1 bump in the multiplier inflates a whole payment cycle. **Mitigation:** Admin-only RLS on rate/formula/distance tables, immutable versioning of rate schedules, full audit log of every change with before/after values, and a "locked" state on approved invoices so their computed amount can never retroactively change when rates are later edited.

2. **Unauthenticated or over-privileged data access (IDOR / mutation via exposed endpoints).** Serverless API routes that trust client-asserted identity would let one user read or mutate another's waybills, or let an Officer self-approve invoices. **Mitigation:** every Netlify function verifies the Supabase JWT server-side; RLS policies are default-deny and grant by role; no service-role key ever reaches the client.

3. **Denial-of-Wallet / abuse of metered functions and PDF generation.** PDF rendering and report aggregation are CPU/invocation-heavy; unbounded calls run up Netlify/Supabase usage and can DoS the app. **Mitigation:** rate limiting (per-user + per-IP sliding window) on all functions, especially document generation; pagination and caps on report queries; caching of dashboard aggregates.

4. **Malicious file uploads (scans) and tenant data leakage.** Transporters upload scan files that get attached to financial documents. Risks: malware/oversized files, polyglot files, path traversal, and — most importantly — one transporter reading another's scans. **Mitigation:** validate MIME type and size, store in Supabase Storage under per-transporter, RLS-scoped paths with signed-URL-only access, strip/he-render uploads (e.g. re-encode images, sanitise PDFs), and never serve a scan by guessable public URL.

5. **Compromised/abused fuel scraper (supply-chain + data integrity).** The GOIL scraper runs unattended and writes a number that directly scales every invoice. If GOIL changes its page, blocks the bot, or returns a bad value, the escalation factor silently breaks. A scraper that follows arbitrary redirects is also an SSRF risk. **Mitigation:** the scraper runs as an isolated scheduled job (never in the request path), validates the scraped price against a sane range and the previous week (reject >X% jumps for human review), falls back to last-known-good price on failure, alerts on staleness, and writes via a least-privilege service account. See §6.6.

Secondary surfaces: injection via free-text fields → parameterised queries + schema validation; stored XSS in generated documents → output encoding; secrets leakage via client bundles → no secrets in frontend, source maps stripped in production.

---

## 5. Architecture

### 5.1 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | **React + Vite + TypeScript**, Tailwind CSS | Fast static build, deploys natively on Netlify; TS gives end-to-end typing with the API contracts. |
| Hosting / edge | **Netlify** (static hosting + Netlify Functions / Edge Functions) | Your stated requirement. Edge Functions handle auth/rate-limit before business logic. |
| API | Netlify Functions (Node/TypeScript) | Co-located with the frontend; one deploy pipeline. |
| Database & Auth | **Supabase** (Postgres, GoTrue auth, RLS, Storage) | RLS enforces the auth model at the data layer; Storage holds generated PDFs; free tier sufficient for this volume. |
| Validation | **Zod** (shared schemas, client + server) | Single source of truth for input contracts; reject-and-log invalid payloads. |
| PDF generation | **React-pdf** or **Puppeteer-on-function** (HTML→PDF) | Branded, templated, editable-before-export documents. |
| Observability | **Sentry** (errors) + Supabase logs / Logflare | Every unhandled exception logged with request context. |

### 5.2 Data-flow / request map

```
[Officer / Admin browser (React SPA)]
        │  HTTPS, Supabase JWT in Authorization header
        ▼
[Netlify Edge: CSP + CORS allow-list]
        ▼
[Rate Limiter — sliding window, per-user + per-IP]
        ▼
[Auth Middleware — verify Supabase JWT server-side, resolve role]
        ▼
[Netlify Function: route handler + Zod validation]
        │
        ├──► [Cache layer: dashboard aggregates, rate schedule]  ──(hit)──► response
        │
        ▼ (cache miss / writes)
[Supabase Postgres — RLS enforced, default-deny]
   tables: transporters, districts, distance_matrix, rate_versions,
           rates, fidic_params, waybills, invoices, invoice_lines,
           documents, audit_log
        │
        ▼ (on document generation)
[PDF renderer] ──► [Supabase Storage: signed-URL PDFs]
```

The **auth barrier and rate limiter sit in front of all business logic** — no route is unauthenticated by accident.

### 5.3 The calculation pipeline (mirrors the 7-sheet workbook)

```
Waybill (From, To, category, counts, truck size, trips)
   │
   ├─ Distance lookup:  distance_matrix[(From, To)]  →  km        (was DistanceChart)
   │
   ├─ Rate resolution:  base rate × per-trip FIDIC factor         (was Key + Adjustment Table)
   │     escalated_rate(trip) = base_rate × factor(waybill_date)
   │     factor = a + b·(Wn/Wo) + c·(Fn(date)/Fo)                 (was FORMULA 198.6%)
   │     where Fn(date) = diesel price for the trip's week         (was Weekly-Fuel sheet)
   │
   ▼
Invoice cost = category-branch formula (see §6.3)                 (was cleaned column R)
   │
   ▼
invoice_lines persisted with a SNAPSHOT of the rates used (immutable once locked)
```

**Key architectural improvement over the spreadsheet:** each invoice line stores a *snapshot* of the distance, rates, and FIDIC multiplier used at calculation time. Editing rates later never silently rewrites historical invoices — it only affects new ones, unless an Admin explicitly recalculates an unlocked invoice.

---

## 6. Functional Requirements

### 6.1 Waybill entry (native form)

Captures, with validation:

- Transporter (select from managed list; no free-text mismatches — this replaces the `SUBSTITUTE` name-normalizer entirely).
- Cargo category: `Poles` | `Material` | `Concrete Poles`.
- Date on waybill + date of processing.
- Start location (origin warehouse): Tema, Kumasi, Takoradi, Ntensere, Nsawam, Asante-Akim South.
- Destination district (select from ~266 managed districts).
- Counts: number of poles, stay blocks, concrete poles (as relevant to category).
- Truck size: 20ft | 40ft.
- Number of trips.
- Vehicle registration number.
- Waybill number(s) — supports multi-waybill entries (e.g. `12776/12777` as seen in the data).
- **Scan upload** — one or more supporting files (signed waybill, delivery note) attached to the waybill; image or PDF, size/type validated. These are surfaced on the dashboard and appended to the generated payment request documents.

Transporters submit and see only their own waybills; Officers can submit/verify on any transporter's behalf.

Validation rules: counts ≥ 0; trips ≥ 1; a `(From, To)` pair must resolve to a known distance or the form blocks submission with a clear message (no silent blank like the old `IFERROR`). Category-appropriate fields are required (e.g. Material requires truck size; Poles requires pole count).

### 6.2 Rate & formula management (Admin only)

- **Base rate card** (editable, the 2018 contract rates):

  | Item | Base rate (GHS) |
  |---|---|
  | Haulage per ton per km (materials) | 0.34 |
  | Haulage per pole per km | 0.182163 |
  | Off-loading per pole | 1.8783375 |
  | Haulage per stay block per km | 0.018525 |
  | Off-loading per stay block | 0.234 |
  | Off-loading flat charge (40ft truck) | 225.42 |
  | Off-loading flat charge (20ft truck) | 112.69 |
  | Port-to-warehouse (40ft truck) | 1,080.625 |
  | Port-to-warehouse (20ft truck) | 540.3125 |
  | Haulage per concrete pole per km | 0.5464875 |
  | Off-loading per concrete pole | 5.6350125 |

- **FIDIC escalation parameters** (editable, drives the multiplier): `Pn = Po × (a + b·Wn/Wo + c·Fn/Fo)`
  - a = 0.30 (fixed, non-adjustable component)
  - b = 0.30 (labour weight)
  - c = 0.40 (fuel weight)
  - Wo = 9.68 (2018 min wage), Wn = 21.77 (2022 min wage)
  - Fo = 3.73 (2018 diesel ₵/L), Fn = 15.45 (2022 diesel ₵/L)
  - With `Fo` and a *fixed* `Fn`, multiplier ≈ 2.63 from these inputs (the doc's stated ×2.986/198.6% appears to be a separate snapshot — see verification finding in §2.2).

- **Per-trip fuel indexing (v1 core — now verified against the workbook).** Inspecting the actual `cleaned` sheet confirms the live per-trip rate formula is:

  ```
  escalated_rate(trip) = ( a + b·(Wn/Wo) + c · Fn(week) / Fo ) × base_rate
  ```
  where `Fn(week) = INDEX(FuelPrice, MATCH(trip_week_id, weekendID, 1))` — i.e. the diesel price for the trip's week, looked up from the Weekly-Fuel series with an approximate (≤) match. `a`, `b`, `c`, `Wo`, `Wn`, `Fo` remain configurable baseline parameters. The fixed ×2.986 / ×2.63 figures are just snapshots of this formula at one diesel price.
- **Versioning:** any change to base rates or the baseline FIDIC parameters creates a new `rate_version` rather than overwriting. Each invoice references the version it used. This is the single most important integrity feature.
- **Weekly fuel series** is an append-only table populated automatically by the GOIL scraper (§6.6), with manual Admin override.

### 6.3 Invoice calculation (must reproduce the workbook exactly)

For each waybill, distance `I` is looked up from the matrix — note the workbook applies a **`30 + chart_distance`** adjustment (a fixed 30 km added to every surveyed distance), which the engine must reproduce. The escalated rate is `base_rate × factor(waybill_date)` using the diesel price for the trip's week (see §6.2):

**Material:**
```
Haulage Cost = (Distance × HaulageRate_perTonKm × TruckSize_tonnes + OffloadingFlatCharge) × NumberOfTrips
```

**Poles** (and **Concrete Poles**, with concrete-pole rates):
```
Haulage Cost = (HaulageRate × Distance + OffloadingPerPole) × NumberOfPoles
             + (StayBlockRate × Distance + StayBlockOffloadCharge) × NumberOfStayBlocks
```

Excel reference being reproduced:
```
=IF(category="Material", (I*J*O+K)*P,
  IF(category="Poles", (J*I+K)*N+(L*I+M)*Q,
    IF(category="Concrete Poles", (J*I+K)*N+(L*I+M)*Q, "")))
```

**Difference from the spreadsheet:** instead of `IFERROR(..., "")` hiding failures as blanks, the engine returns a typed error and the UI shows *why* (e.g. "no distance for Tema → Jirapa Municipal"). Computation is done server-side and unit-tested against known waybills from the existing data — e.g. waybill 12776/12777 (Tema → Bolgatanga East, 893 km, 120 poles) → **₵41,596.77**, which reproduces only with the per-trip fuel-indexed factor (≈2.107 at that trip's diesel price), confirming the date-indexed model.

### 6.4 Payment request documents

- **Payment Request Invoice** — itemised, per transporter or per waybill batch, showing distance, rates applied, category, counts, and computed cost per line, with totals.
- **Payment Request Letter** — formal cover letter on **Ministry of Energy and Green Transition** letterhead, referencing the invoice(s), with reference number, date, addressee (Ministry finance), and signature block.
- Both are **editable before export** (recipient, reference no., date, notes), **branded** with the Ministry letterhead/logo, and exported as **downloadable, printable PDF**.
- **The uploaded waybill scan(s) are appended** to the generated PDF package (or merged as supporting pages), so the payment request goes out together with its evidence.
- Generated PDFs and scans are stored in Supabase Storage and retrievable only via short-lived signed URLs scoped to the requesting user's role/ownership.

### 6.5 Dashboard (matches the screenshot)

- Headline cards: **Total Haulage Cost**, **Haulage Cost (Poles)**, **Haulage Cost (Materials)**.
- Filters: **Waybill No.**, **Category**, **Transporter Name**, **Date range** (defaulting to a week, as in the screenshot).
- Line-item table: Category, Date, Distance, From, To, Haulage Charge (Pole/Mats), Haulage Charge/stay block, Transporter, Truck Size, No. of Poles, No. of Trips, Waybill No., Vehicle No., Haulage Cost.
- Sortable columns; cost values formatted as ₵ with thousands separators.
- Aggregates are cached and recomputed on data change for fast loads.

> Optional: this dashboard can also be delivered as a live, re-openable view that refreshes from the database each time you open it — useful for a daily glance without logging into the full app.

### 6.6 Automated fuel-price ingestion (GOIL scraper)

The escalation factor depends on the current diesel price. To keep it accurate without manual data entry, a **scheduled scraper pulls the diesel price from GOIL (`goil.com.gh`)** and writes it into the `weekly_fuel` table, which the calc engine reads per trip (§6.2).

**Runtime & placement.** The Scrapy spider you suggested is a good fit for the *scraping logic*, but it must **not** run inside a user-facing Netlify function (cold-start weight, long runtime, and a request-path scraper is a DoS/SSRF liability). Instead:

- Run it as an **isolated scheduled job** — a **GitHub Action on a weekly cron** (simplest; Scrapy runs comfortably there) or a containerised scheduled task. A Netlify Scheduled Function can trigger/health-check it, but the heavy scrape lives outside the request path.
- The job authenticates to Supabase with a **least-privilege service key** that can only insert into `weekly_fuel`, and upserts `(week_start, price_per_litre, source_url, scraped_at)`.

**Reliability & integrity guards (because this number scales every invoice):**

- **Sanity validation:** reject a scraped price that is non-numeric, ≤ 0, or deviates more than a configurable threshold (e.g. ±25%) from last week — flag it for Admin review instead of writing it.
- **Fallback:** on scrape failure or site-structure change, keep the last-known-good price and **alert** rather than writing a bad/blank value.
- **Staleness alert:** if no successful scrape in N days, notify Admin (a stale fuel price quietly under/over-bills everyone).
- **Provenance:** every fuel row records its `source_url` and `scraped_at` for audit; Admin can manually override any week.
- **Idempotent & polite:** one fetch per week, respect `robots.txt`, set a clear User-Agent, no aggressive crawling.

**Caveat to confirm:** scraping a third-party site is brittle (markup changes break it) and should respect GOIL's terms of service. If GOIL (or the NPA) publishes prices via a stable page/API or a downloadable list, that is preferable to HTML scraping. The Admin manual-override path exists precisely so billing never blocks on the scraper.

### 6.7 Electronic attestation (MFA-authenticated)

Each generated payment request document can carry an **electronic attestation** — an MFA-authenticated confirmation that a specific user reviewed and approved the document. This is **not** a cryptographic digital signature; it is an audit-trail attestation bound to the signer's identity, MFA session, IP address, and user agent at the time of signing.

**How it works:**

- **One-time setup:** each user uploads a signature image (PNG/JPEG) and enrolls a TOTP authenticator factor (Supabase built-in).
- **Signing action:** when a user clicks "Sign," the system verifies their JWT carries `aal === 'aal2'` (MFA-authenticated session), then writes an `invoice_signatures` row recording the slot, user, timestamp, IP, user agent, and AAL level.
- **Slots:** four attestation slots per invoice — `transporter` (own invoice only), `prepared` (officer/admin), `checked` (Deputy Director), `approved` (Director). Ordering: `prepared` → `checked` → `approved`; `transporter` is independent.
- **Document rendering:** when a PDF is generated, attestation images and signer names are drawn into the appropriate signature blocks on the letter, invoice, signatory sheet, and memo.
- **Tamper evidence:** the `invoice_signatures` table has `REVOKE INSERT, UPDATE, DELETE` for authenticated users and an append-only trigger — rows can only be written by the service-role function and never modified or deleted.
- **Evidence fields (migration 0025):** `doc_hash` (SHA-256 of the rendered PDF, infrastructure ready), `signed_ip`, `user_agent`, `aal` are captured at signing time for audit purposes.

`// ponytail: this is an attestation, not a legal digital signature — no PKI, no certificate chain, no third-party timestamp authority.`

---

## 7. Non-Functional Requirements

- **Security:** see threat model (§4) and security blueprint (§9). Default-deny RLS; server-side JWT verification; rate limiting on every function.
- **Accuracy:** invoice math must match the legacy workbook to the cent on a regression suite of real historical waybills before launch.
- **Performance:** dashboard loads < 2 s for a typical month of data; PDF generation < 5 s.
- **Auditability:** every create/update/delete on waybills, rates, FIDIC params, and invoices is written to an append-only `audit_log` with actor, timestamp, and before/after.
- **Availability:** Netlify + Supabase managed infra; no single self-hosted server to babysit.
- **Data retention:** invoices and documents retained indefinitely; soft-delete only (nothing financial is hard-deleted).

---

## 8. Data Model (Supabase / Postgres)

```
app_users         (id→auth.users, role[admin|officer|transporter], transporter_id, full_name)
transporters      (id, display_name, active, created_at)
districts         (id, name, region, active)
origins           (id, name)                         -- the 6 warehouses
distance_matrix   (id, origin_id, district_id, km, UNIQUE(origin_id, district_id))
rate_versions     (id, label, effective_from, fidic_multiplier, created_by, created_at, is_active)
rates             (id, rate_version_id, item_key, base_rate, escalated_rate)
fidic_params      (id, rate_version_id, a, b, c, Wo, Wn, Fo, Fn, computed_multiplier)
weekly_fuel       (id, week_start, price_per_litre, source_url, scraped_at,
                   status[ok|flagged|manual])          -- populated by GOIL scraper §6.6
waybills          (id, transporter_id, category, waybill_no, vehicle_no, origin_id,
                   district_id, num_poles, num_stay_blocks, num_concrete_poles,
                   truck_size, num_trips, waybill_date, processed_date,
                   created_by, status, created_at)
scans             (id, waybill_id, storage_path, mime_type, byte_size,
                   uploaded_by, uploaded_at)            -- per-transporter RLS-scoped paths
invoices          (id, transporter_id, status[draft|approved|locked], total_cost,
                   rate_version_id, period_start, period_end, approved_by, created_at)
invoice_lines     (id, invoice_id, waybill_id, distance_km, category,
                   rate_snapshot jsonb, computed_cost)   -- immutable snapshot
documents         (id, invoice_id, type[invoice|letter], storage_path,
                   reference_no, generated_by, generated_at)
invoice_signatures  (invoice_id, slot[transporter|prepared|checked|approved],
                    user_id, signed_at, doc_hash, signed_ip, user_agent, aal)
audit_log         (id, actor_id, action, entity, entity_id, before jsonb,
                   after jsonb, created_at)
```

Indexes on every FK and on the columns the dashboard filters/sorts by (`waybills.waybill_date`, `category`, `transporter_id`, `invoices.status`). `distance_matrix` has a composite unique index on `(origin_id, district_id)` — this replaces the `INDEX-MATCH` lookup with a single keyed read.

---

## 9. Security Blueprint *(ASE Mode 2)*

**Source control & config.** `.gitignore` excludes `.env`; a `.env.example` documents every variable (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (functions only), `SENTRY_DSN`). Pre-commit secrets scanning (`truffleHog`/`git-secrets`). The service-role key lives only in Netlify function env vars — never in the client bundle.

**Frontend.** Production build minified; source maps stripped or uploaded only to Sentry (not public). Content-Security-Policy header set at the edge; CORS allow-lists the Netlify origin only (no wildcard). No secrets or rate logic in client code — all computation is server-side.

**Input validation.** Shared Zod schemas validate every payload at the function boundary before any DB call. Invalid payloads are rejected and logged, never coerced. Free-text fields (vehicle no., notes) are length-bounded and output-encoded when rendered into PDFs.

**Database & auth.** RLS enabled on every table, default-deny:
- **Transporter:** `SELECT/INSERT/UPDATE` only rows where `waybills.transporter_id = my transporter_id` (resolved from `app_users`), and only while status = draft; can read only their own scans, invoices, and documents. No read of other transporters' data — the primary IDOR defence.
- **Officer:** create/verify waybills and upload scans for any transporter; assemble invoices; no write to `rates`, `fidic_params`, `distance_matrix`.
- **Admin:** full access to rates/formula/distance, user management, invoice approval/lock, scraper oversight.
- Approved/locked invoices and their `invoice_lines` and attached scans are immutable to everyone (DB-level rule).
- **Storage:** scans and PDFs live under per-transporter path prefixes with Storage RLS; access only via short-lived signed URLs, never public URLs.
JWTs verified server-side on every request; role and `transporter_id` resolved from `app_users` via the token's claims, never from the request body.

**API & rate limiting.** Sliding-window limiter (per-user + per-IP) on all functions; tighter caps on `generate-document` and report endpoints. Breaches logged and alerted. Report queries are paginated and capped.

**Dependencies.** `npm audit` runs in CI; versions pinned; CVE/unmaintained packages flagged and block the build.

**Caching & scaling.** Dashboard aggregates and the active rate schedule cached (edge / in-memory) with invalidation on write. Distance matrix is effectively static — cached aggressively.

**Observability.** Sentry error boundaries on the SPA and in functions; structured logs with request context; `/health` endpoint; alert on error-rate threshold.

---

## 10. CI/CD Pipeline (Netlify)

Gates run in order; a failing gate blocks deploy:

```
dependency audit (npm audit) → lint (ESLint) → type-check (tsc) →
unit tests (calc engine regression) → integration tests (API + RLS) →
build + minify (strip source maps) → env-var injection → deploy (Netlify)
```

The **calculation-engine regression suite is non-negotiable**: it asserts the three category formulas against known historical waybills before any deploy ships.

---

## 11. Milestones (suggested)

| Phase | Deliverable |
|---|---|
| **M0 — Foundations** | Repo, `.env.example`, Supabase project, schema + RLS, CI pipeline skeleton, auth. |
| **M1 — Core data** | Transporters, districts, distance matrix (+30 km rule), rate versions + FIDIC engine, GOIL fuel scraper with sanity guards (Admin UI). |
| **M2 — Waybills + calc engine** | Native entry form, scan upload, server-side cost calculator, regression test suite passing against legacy figures. |
| **M2.5 — Electronic attestation** | MFA-authenticated attestation with four signing slots, tamper-evident audit trail, signature image rendering in PDFs. |
| **M3 — Invoices + documents** | Invoice assembly, approve/lock workflow, branded Ministry PDF letter + invoice generation with scans appended. |
| **M4 — Dashboard** | Filterable, cached dashboard matching the screenshot. |
| **M5 — Hardening + launch** | Rate-limit tuning, Sentry, audit-log review UI, pen-test of RLS, production deploy. |

---

## 12. Open Questions — resolution log

1. **Branding** — ✅ Resolved. Ministry of Energy and Green Transition crest supplied; used in the header, login, and PDF letterhead. Invoice/letter formats matched to the approved samples (Tahoma/Helvetica, justified body).
2. **GOIL price selector** — ✅ Resolved. The scraper reads the **Diesel XP** price from the permanent page `https://goil.com.gh/new-fuel-prices/`, plus the effective date; updated whenever GOIL revises pump prices. Admin can override any week.
3. **Wage component** — ✅ Confirmed by reproduction. `Wn` is held fixed per escalation period and only diesel varies per week; the engine reproduces real invoices to the cent on this basis.
4. **Truck tonnage** — ✅ Resolved by verification. The Material formula uses the truck **footer value (20 or 40) directly** as the `O` multiplier (validated against the ₵14,763.71 material invoice).
5. **Distance +30 km** — ✅ Confirmed. The engine applies `30 + chart_distance`, matching the workbook.
6. **Multi-waybill rows** — ✅ Resolved. Consolidated same-trip waybills are entered with comma-separated numbers and multiple destinations; the cost uses the **furthest** destination.
7. **Scan handling** — ✅ Resolved. Three scan types (acknowledgement, waybill, release letter), ≤10 MB, image or PDF; **appended as pages** to the generated PDF package.

No open blockers remain on the calculation or document logic. Remaining work is operational hardening/UX (custom domain, optional further PDF polish).

---

*Prepared with a security-first methodology: the threat model (§4) drives the architecture (§5), schema (§8), and security blueprint (§9). No operational layer — auth, validation, rate limiting, RLS, audit, observability — is deferred to "later."*
