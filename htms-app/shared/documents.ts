/**
 * Branded HTML document templates: Payment Request Invoice + Letter.
 * Styled to match the Ministry/transporter samples — Tahoma 12pt, justified
 * body, a makeshift letterhead built from the transporter's name (+ optional
 * contact details). Print-to-PDF ready (A4). All values HTML-escaped (XSS).
 */

const MINISTRY = 'Ministry of Energy and Green Transition';
// Default recipient block (editable addressee via options).
const RECIPIENT_TITLE = 'The Chief Director';
const RECIPIENT_ADDRESS = ['P.O. Box SD 40', 'Accra'];

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NUM = (n: number) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const GHS = (n: number) => 'GHS ' + NUM(n);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function parseDate(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
const fmtLong = (s?: string | null) => {
  const d = parseDate(s) ?? new Date();
  return `${LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
const fmtShort = (s?: string | null) => {
  const d = parseDate(s);
  if (!d) return esc(s);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
};

/** Makeshift monogram from the transporter name (e.g. "HONEYWEALTH …" → "HW"). */
function monogram(name: string): string {
  const stop = new Set(['ENTERPRISES', 'ENTERPRISE', 'LIMITED', 'LTD', 'COMPANY', 'CO', 'GHANA', 'AND', '&', 'THE']);
  const words = name.toUpperCase().split(/[\s-]+/).filter((w) => w && !stop.has(w));
  if (words.length >= 2) return (words[0][0] + words[1][0]).slice(0, 2);
  if (words.length === 1) return words[0].slice(0, 2);
  return name.slice(0, 2).toUpperCase();
}

interface Transporter {
  display_name?: string;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  gps_address?: string | null;
}
interface DocLine {
  category: string;
  computed_cost: number;
  waybills?: {
    waybill_no?: string;
    vehicle_no?: string;
    waybill_date?: string;
    num_trips?: number;
    districts?: { name?: string };
    origins?: { name?: string };
  };
}
interface DocInvoice {
  id: string;
  reference_no?: string | null;
  total_cost: number;
  period_start?: string | null;
  period_end?: string | null;
  created_at?: string;
  transporters?: Transporter;
  invoice_lines?: DocLine[];
}
interface DocOpts {
  referenceNo?: string;
  addressee?: string;
  notes?: string;
}

function invoiceNo(inv: DocInvoice, opts: DocOpts) {
  return esc(opts.referenceNo ?? inv.reference_no ?? 'INV-' + inv.id.slice(0, 8).toUpperCase());
}

/** Build the headline route + period summary from the lines. */
function summary(inv: DocInvoice) {
  const lines = inv.invoice_lines ?? [];
  const origins = lines.map((l) => l.waybills?.origins?.name).filter(Boolean) as string[];
  const origin = origins[0] ?? '—';
  // Headline destination = the highest-amount (furthest-cost) drop.
  const furthest = [...lines].sort((a, b) => b.computed_cost - a.computed_cost)[0];
  const dest = furthest?.waybills?.districts?.name ?? '—';
  const dates = lines.map((l) => parseDate(l.waybills?.waybill_date)).filter(Boolean) as Date[];
  dates.sort((a, b) => a.getTime() - b.getTime());
  const periodStart = inv.period_start ?? (dates[0] ? dates[0].toISOString().slice(0, 10) : null);
  const periodEnd = inv.period_end ?? (dates[dates.length - 1] ? dates[dates.length - 1].toISOString().slice(0, 10) : null);
  const trips = lines.reduce((n, l) => n + (l.waybills?.num_trips ?? 0), 0);
  const waybillCount = lines.reduce(
    (n, l) => n + (l.waybills?.waybill_no ? l.waybills.waybill_no.split(/[,/]/).filter((x) => x.trim()).length : 0),
    0,
  );
  return { origin, dest, periodStart, periodEnd, trips, waybillCount };
}

function letterhead(t: Transporter | undefined, withMonogram: boolean): string {
  const name = t?.display_name ?? 'Transporter';
  const contactBits = [
    t?.email ? `Email: ${esc(t.email)}` : '',
    t?.phone ? `Phone: ${esc(t.phone)}` : '',
    t?.gps_address ? `GPS ${esc(t.gps_address)}` : '',
  ].filter(Boolean).join(' &nbsp;|&nbsp; ');
  return `
  <div class="letterhead">
    ${withMonogram ? `<div class="mono">${esc(monogram(name))}</div>` : ''}
    <div class="lh-text">
      <div class="org">${esc(name)}</div>
      ${t?.address ? `<div class="addr">${esc(t.address)}</div>` : ''}
      ${contactBits ? `<div class="addr">${contactBits}</div>` : ''}
    </div>
  </div>`;
}

function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 22mm; }
  body { font-family: Tahoma, Geneva, Verdana, sans-serif; font-size: 12pt; color: #111; line-height: 1.5; }
  p, .body, td, th, li { font-size: 12pt; }
  .body, .just { text-align: justify; }
  .letterhead { display:flex; align-items:center; gap:14px; border-bottom:2px solid #1b5e20; padding-bottom:10px; margin-bottom:14px; }
  .letterhead.center { flex-direction:column; text-align:center; gap:2px; }
  .mono { width:54px; height:54px; flex:none; border-radius:8px; background:#1b5e20; color:#fff;
          display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:20pt; font-family: Tahoma, sans-serif; }
  .org { font-size:15pt; font-weight:bold; letter-spacing:0.3px; }
  .addr { font-size:10.5pt; color:#333; }
  .right { text-align:right; }
  .center { text-align:center; }
  .muted { color:#444; }
  h2 { font-size:13pt; margin:14px 0 6px; }
  table { width:100%; border-collapse:collapse; margin:14px 0; }
  th,td { border:1px solid #999; padding:7px 9px; text-align:left; vertical-align:top; }
  th { background:#e8f5e9; font-weight:bold; }
  td.amt, th.amt { text-align:right; white-space:nowrap; }
  .total { text-align:right; font-weight:bold; font-size:13pt; margin-top:6px; }
  .sign-line { margin-top:42px; }
  .kv { margin:2px 0; }
  .kv b { display:inline-block; min-width:190px; }
</style></head><body>
${inner}
</body></html>`;
}

// ── Invoice ───────────────────────────────────────────────────────────────
export function renderInvoiceHtml(inv: DocInvoice, opts: DocOpts = {}): string {
  const s = summary(inv);
  const ref = invoiceNo(inv, opts);
  const rows = (inv.invoice_lines ?? [])
    .map((l) => {
      const w = l.waybills ?? {};
      return `<tr>
        <td>${fmtShort(w.waybill_date)}</td>
        <td>${esc(w.waybill_no)}</td>
        <td>${esc(w.vehicle_no ?? '')}</td>
        <td>${esc(w.origins?.name ?? '')}</td>
        <td>${esc(w.districts?.name ?? '')}</td>
        <td class="amt">${NUM(l.computed_cost)}</td>
      </tr>`;
    })
    .join('');

  const inner = `
  ${letterhead(inv.transporters, false).replace('class="letterhead"', 'class="letterhead center"')}
  <div class="right"><b>Invoice No:</b> ${ref}</div>
  <div>Date: ${fmtLong(inv.created_at)}</div>

  <h2>Bill To:</h2>
  <div>${esc(opts.addressee ?? RECIPIENT_TITLE)}<br>${esc(MINISTRY)}<br>${RECIPIENT_ADDRESS.map(esc).join('<br>')}</div>

  <p class="body"><b>Haulage of Electrical Poles &amp; Materials – ${esc(s.origin)} to ${esc(s.dest)}</b></p>

  <table>
    <thead><tr>
      <th>Date</th><th>Waybill(s)</th><th>Vehicle Reg.</th><th>From</th><th>To</th><th class="amt">Amount (GHS)</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="total">Total Amount Due: ${GHS(inv.total_cost)}</div>
  ${opts.notes ? `<p class="body muted">${esc(opts.notes)}</p>` : ''}
  <p class="center muted">Thank you for your business. Payment is due within 30 days.</p>`;
  return shell(`Invoice ${ref}`, inner);
}

// ── Letter ──────────────────────────────────────────────────────────────────
export function renderLetterHtml(inv: DocInvoice, opts: DocOpts = {}): string {
  const s = summary(inv);
  const ref = invoiceNo(inv, opts);
  const name = inv.transporters?.display_name ?? 'Transporter';
  const route = `${s.origin} to ${s.dest}`;
  const period = `${fmtLong(s.periodStart)} – ${fmtLong(s.periodEnd)}`;

  const inner = `
  ${letterhead(inv.transporters, true)}
  <div>${fmtLong(inv.created_at)}</div>
  <div style="margin-top:10px">${esc(opts.addressee ?? RECIPIENT_TITLE)}<br>${esc(MINISTRY)}<br>${RECIPIENT_ADDRESS.map(esc).join('<br>')}</div>

  <p style="margin-top:14px"><b>REQUEST FOR PAYMENT – HAULAGE OF ELECTRICAL POLES AND MATERIALS FROM ${esc(s.origin.toUpperCase())} TO ${esc(s.dest.toUpperCase())}</b></p>
  <p>Dear Sir,</p>

  <p class="body">I write to formally request payment for haulage services rendered during the period of ${period}. The services involved the transportation of electrical poles and materials from ${esc(route)}.</p>
  <p class="body">The details of the services rendered are as follows:</p>
  <div class="just">
    <div class="kv"><b>Service Description:</b> Haulage of Electrical Poles &amp; Materials – ${esc(route)}</div>
    <div class="kv"><b>Service Period:</b> ${period}</div>
    <div class="kv"><b>Invoice Number:</b> ${ref}</div>
    <div class="kv"><b>Invoice Date:</b> ${fmtLong(inv.created_at)}</div>
    <div class="kv"><b>Total Number of Trips:</b> ${s.trips} trip(s)</div>
    <div class="kv"><b>Total Waybills:</b> ${s.waybillCount} waybill(s)</div>
    <div class="kv"><b>Total Amount Due:</b> ${GHS(inv.total_cost)}</div>
  </div>
  <p class="body">The haulage services were completed satisfactorily and in accordance with the agreed terms. All electrical poles and materials were delivered safely and on schedule.</p>
  <p class="body">Attached please find Invoice ${ref} with detailed trip information for your review and processing. I kindly request that payment be processed at your earliest convenience.</p>
  ${opts.notes ? `<p class="body">${esc(opts.notes)}</p>` : ''}
  <p class="body">Should you require any additional information, supporting documentation, or clarification regarding this invoice, please do not hesitate to contact me.</p>
  <p class="body">Thank you for your attention to this matter. I look forward to your prompt response.</p>
  <p>Yours faithfully,</p>
  <div class="sign-line">______________________________<br>${esc(name)}</div>`;
  return shell(`Payment Request – ${ref}`, inner);
}
