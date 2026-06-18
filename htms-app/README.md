# HTMS — Haulage Transaction Management System

Replaces the `Haulage Txn Data.xlsx` workbook with a hosted, secure web app for
**Ministry of Energy and Green Transition** contractor haulage billing. Captures
waybills + scans natively, computes haulage cost with the exact FIDIC
fuel-indexed formula, generates branded payment-request letters and invoices, and
shows a live dashboard of invoice totals.

Built security-first: every operational layer (auth, validation, rate limiting,
RLS, audit, observability) is part of the foundation, not an afterthought. See
`../HTMS_PRD.md` for the full product/architecture spec and threat model.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind (deploys to Netlify static hosting) |
| API | Netlify Functions (TypeScript) with server-side JWT verify + rate limiting |
| Data/Auth | Supabase (Postgres, GoTrue auth, Row-Level Security, Storage) |
| Validation | Zod (shared client + server) |
| Fuel data | Scrapy spider (GOIL) on a weekly GitHub Action cron |

## The calculation engine (verified)

`shared/calc.ts` reproduces the workbook to the cent. The per-trip escalated rate is:

```
factor   = a + b·(Wn/Wo) + c·(Fuel_week / Fo)          # a=0.4 b=0.3 c=0.3 (LIVE weights)
rate     = factor × base_rate                          # haulage AND offload
distance = 30 + chart_distance
```

`Fuel_week` is the diesel price for the latest week ≤ the trip date (Excel
approximate MATCH). Regression fixtures (real dashboard rows) all pass exactly:

| Waybill | Route | Result |
|---|---|---|
| 12776/12777 | Tema→Bolgatanga East, 893 km, 120 poles | ₵41,596.77 |
| — | Tema→Tamale Metropolitan, 712 km, 120 poles | ₵36,995.44 |
| — | tema→Sunyani Municipal, 461 km, 40ft material | ₵14,763.71 |

> The prose context doc stated weights 0.3/0.3/0.4 and a ×2.986 multiplier. Both
> are wrong: the live workbook named-ranges use **0.4/0.3/0.3**, and the factor is
> fuel-indexed per trip (≈2.1–2.34 across 2024–2026), not a fixed multiplier.

## Local setup

```bash
cd htms-app
npm install
cp .env.example .env        # fill in Supabase keys
npm run dev                 # Vite dev server
```

## Database

Apply migrations in order, then seed:

```bash
# Using the Supabase CLI or psql against your project:
psql "$DATABASE_URL" -f supabase/migrations/0001_schema.sql
psql "$DATABASE_URL" -f supabase/migrations/0002_rls.sql
psql "$DATABASE_URL" -f supabase/migrations/0003_storage.sql
psql "$DATABASE_URL" -f supabase/migrations/0004_auth_trigger.sql
psql "$DATABASE_URL" -f supabase/seed/seed.sql      # 266 districts, rates, 225 fuel weeks
```

`seed.sql` is pre-generated. To regenerate from the JSON sources: `npm run seed:gen`.

### Roles

Three roles enforced by RLS (`app_users.role`):

- **admin** — edits rates/FIDIC/distance, manages users, approves/locks invoices.
- **officer** — files waybills + scans for any transporter, assembles invoices.
- **transporter** — files and views **only their own** waybills, scans, documents.

New auth signups get no profile until an Admin assigns their role/transporter
(every RLS policy denies an unprovisioned user). Create the first Admin manually:

```sql
insert into app_users (id, role, full_name)
values ('<auth-user-uuid>', 'admin', 'Leslie Nii Adjei');
```

## Tests

```bash
npm test          # vitest: calc regression vs real invoices + RLS-shape checks
npm run typecheck # tsc on app + functions
npm run lint
```

The calc regression suite (`shared/__tests__/calc.test.ts`) is the non-negotiable
CI gate — it asserts the three category formulas against real historical invoices.

## Deploy (Netlify)

1. Connect the repo; set **base directory** to `htms-app`.
2. Build command `npm run build`, publish `dist`, functions `netlify/functions`.
3. Set env vars (see `.env.example`) — **service-role key and JWT secret are
   server-only**, never prefixed `VITE_`.
4. CSP/CORS/HSTS headers ship via `netlify.toml`.

## Fuel scraper

`scraper/goil_fuel_spider.py` scrapes the GOIL diesel price weekly via the
GitHub Action in `.github/workflows/scrape-fuel.yml`. It validates the price
(range + ≤25% weekly deviation), writes `status='flagged'` on suspicious jumps,
and keeps the last-known-good value on failure. Set repo secrets
`FUEL_SCRAPER_SUPABASE_URL` and `FUEL_SCRAPER_SUPABASE_KEY` (a key scoped to
`weekly_fuel` only). Confirm the exact GOIL price selector before relying on it
(see open questions in the PRD) — Admin can always override a week manually.

## Security posture (summary)

- Default-deny RLS on every table; transporters fully isolated (primary IDOR defence).
- All Netlify functions verify the Supabase JWT server-side and resolve role from
  `app_users` — never from the request body.
- Sliding-window rate limiting per-IP and per-user; tighter budget on document generation.
- Zod validation at the API boundary; invalid payloads rejected and logged.
- Scans/documents in private Storage buckets, per-transporter paths, signed-URL access only.
- Locked invoices immutable at the DB layer (trigger); every mutation audited.
- Production build minified, source maps stripped; CSP/HSTS/no-sniff headers.

## Note on repo layout

The app lives in `htms-app/`. The Python/Django files at the repo root are from an
earlier abandoned scaffold and are unrelated to this stack — safe to remove once
you've confirmed nothing depends on them.
