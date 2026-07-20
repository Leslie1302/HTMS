/**
 * Client-side PDF generation for the Payment Request Invoice and Letter.
 * Produces real, vector (selectable) PDFs the user can print and submit —
 * no server/Puppeteer dependency. Layout mirrors the approved samples.
 *
 * Font: Helvetica (a PDF base-14 font). Tahoma is a proprietary Microsoft font
 * and can't be embedded without the licensed .ttf; Helvetica is the standard
 * sans-serif equivalent for generated PDFs.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const NAVY: [number, number, number] = [26, 35, 108];
const BLUE: [number, number, number] = [43, 92, 197];
const BLUE_LIGHT: [number, number, number] = [225, 231, 247];
const MINISTRY = 'Ministry of Energy and Green Transition';
const RECIPIENT = ['The Chief Director', MINISTRY, 'P.O. Box SD 40', 'Accra'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const num = (n: number) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function pd(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
const long = (s?: string | null) => {
  const d = pd(s) ?? new Date();
  return `${LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
const short = (s?: string | null) => {
  const d = pd(s);
  return d ? `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}` : (s ?? '');
};

interface Line {
  computed_cost: number;
  category?: string;
  distance_km?: number;
  rate_snapshot?: { rates?: { haulagePerUnitKm?: number; stayPerKm?: number } };
  waybills?: {
    waybill_no?: string;
    vehicle_no?: string;
    waybill_date?: string;
    num_trips?: number;
    num_poles?: number;
    truck_size?: string | number;
    districts?: { name?: string };
    origins?: { name?: string };
  };
}
export interface InvoiceDoc {
  id: string;
  reference_no?: string | null;
  total_cost: number;
  created_at?: string;
  period_start?: string | null;
  period_end?: string | null;
  transporters?: {
    display_name?: string;
    address?: string | null;
    email?: string | null;
    phone?: string | null;
    gps_address?: string | null;
    manager_name?: string | null;
  };
  /** Scanned company letterhead as a data URL — drawn full-page behind the content. */
  letterheadDataUrl?: string | null;
  /** Printable insets (pt) inside the scanned letterhead: content starts below the header band and ends above the footer band. */
  letterheadInsets?: { top: number; bottom: number; left?: number; right?: number } | null;
  invoice_lines?: Line[];
  signatures?: { slot: string; signed_at: string; name: string; sigDataUrl?: string | null }[];
}

function ref(inv: InvoiceDoc) {
  return inv.reference_no ?? 'INV-' + inv.id.slice(0, 8).toUpperCase();
}

/** Exposed for filenames + the scan-merge flow. */
export function invoiceRef(inv: InvoiceDoc): string {
  return ref(inv);
}

function summary(inv: InvoiceDoc) {
  const lines = inv.invoice_lines ?? [];
  const origin = lines[0]?.waybills?.origins?.name ?? '—';
  const furthest = [...lines].sort((a, b) => b.computed_cost - a.computed_cost)[0];
  const dest = furthest?.waybills?.districts?.name ?? '—';
  const dates = (lines.map((l) => pd(l.waybills?.waybill_date)).filter(Boolean) as Date[]).sort(
    (a, b) => a.getTime() - b.getTime(),
  );
  const ps = inv.period_start ?? (dates[0]?.toISOString().slice(0, 10) ?? null);
  const pe = inv.period_end ?? (dates[dates.length - 1]?.toISOString().slice(0, 10) ?? null);
  const trips = lines.reduce((n, l) => n + (l.waybills?.num_trips ?? 0), 0);
  const waybills = lines.reduce(
    (n, l) => n + (l.waybills?.waybill_no ? l.waybills.waybill_no.split(/[,/]/).filter((x) => x.trim()).length : 0),
    0,
  );
  return { origin, dest, ps, pe, trips, waybills };
}

const M = 48; // page margin (pt)

/** Load /ministry-logo.png as a data URL for embedding (null if absent). */
export async function loadLogo(): Promise<string | null> {
  try {
    const res = await fetch('/ministry-logo.png');
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function newDoc() {
  return new jsPDF({ unit: 'pt', format: 'a4' });
}
function pageWidth(doc: jsPDF) {
  return doc.internal.pageSize.getWidth();
}

/**
 * Plain letterhead from the transporter's registration details (name, address,
 * email, phone, GPS) — no logo or monogram badge: these documents are issued on
 * behalf of many different companies and must not share a visual identity.
 * Company name left, contact stack right, accent rule beneath. Returns the y below it.
 */
/** Default printable insets when a scanned letterhead is used but not calibrated. */
const LH_INSET = { top: 110, bottom: 90 };

/**
 * Draw the transporter's scanned letterhead as a full-page background on the
 * CURRENT page and return the y where content may start. Returns null when the
 * transporter has no letterhead on file (caller falls back to `letterhead()`).
 */
/**
 * Pages already painted, per document. The scan is OPAQUE, so painting it twice
 * on a page erases everything drawn in between — which is exactly what happened
 * when the autoTable page hook repainted page 1 over the header and the table.
 */
const lhPainted = new WeakMap<jsPDF, Set<number>>();

function letterheadScan(doc: jsPDF, inv: InvoiceDoc): number | null {
  if (!inv.letterheadDataUrl) return null;
  const top = inv.letterheadInsets?.top ?? LH_INSET.top;
  const page = doc.getCurrentPageInfo().pageNumber;
  let seen = lhPainted.get(doc);
  if (!seen) { seen = new Set(); lhPainted.set(doc, seen); }
  if (seen.has(page)) return top; // already painted this page — never paint over content
  const W = pageWidth(doc);
  const H = doc.internal.pageSize.getHeight();
  try {
    doc.addImage(inv.letterheadDataUrl, 'PNG', 0, 0, W, H);
  } catch {
    return null; // unreadable image — fall back to the generated letterhead
  }
  seen.add(page);
  return top;
}

/** Bottom limit for content: above the scanned letterhead's footer band, else the normal margin. */
function contentBottom(doc: jsPDF, inv: InvoiceDoc): number {
  const H = doc.internal.pageSize.getHeight();
  if (!inv.letterheadDataUrl) return H - M;
  return H - (inv.letterheadInsets?.bottom ?? LH_INSET.bottom);
}

/** Left margin: scanned letterhead inset, or default M when no letterhead. */
function lhL(inv: InvoiceDoc): number {
  if (!inv.letterheadDataUrl) return M;
  return inv.letterheadInsets?.left ?? M;
}

/** Right margin: scanned letterhead inset, or default M when no letterhead. */
function lhR(inv: InvoiceDoc): number {
  if (!inv.letterheadDataUrl) return M;
  return inv.letterheadInsets?.right ?? M;
}

function letterhead(doc: jsPDF, inv: InvoiceDoc, y: number): number {
  const W = pageWidth(doc);
  const t = inv.transporters ?? {};
  const name = t.display_name ?? 'Transporter';

  // Left: company name.
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(...NAVY);
  doc.text(name.toUpperCase(), M, y + 14);

  // Right: contact stack, right-aligned.
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(110);
  let ry = y + 8;
  for (const l of [t.address, t.email, t.phone, t.gps_address ? `GPS ${t.gps_address}` : ''].filter(Boolean)) {
    doc.text(l as string, W - M, ry, { align: 'right' });
    ry += 11;
  }

  const bottom = Math.max(y + 30, ry + 2);
  doc.setDrawColor(...BLUE).setLineWidth(1.8).line(M, bottom, W - M, bottom);
  return bottom + 24;
}

/** Decorative two-tone wave along the page bottom, matching the letterhead template. */
function waveFooter(doc: jsPDF): void {
  const W = pageWidth(doc);
  const H = doc.internal.pageSize.getHeight();
  const seg = 48;
  const wave = (baseY: number, amp: number, phase: number, color: [number, number, number]) => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= seg; i++) {
      pts.push([(W * i) / seg, baseY + Math.sin((i / seg) * Math.PI * 3 + phase) * amp]);
    }
    const rel: number[][] = [];
    for (let i = 1; i < pts.length; i++) rel.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    rel.push([0, H - pts[pts.length - 1][1]]); // down to bottom-right
    rel.push([-W, 0]); // along the bottom edge
    doc.setFillColor(...color).lines(rel, pts[0][0], pts[0][1], [1, 1], 'F', true);
  };
  wave(H - 34, 9, 0, BLUE);
  wave(H - 22, 7, Math.PI, NAVY);
}

/** Signature line + manager's name (falls back to the company name) + company. */
function signatureBlock(doc: jsPDF, inv: InvoiceDoc, x: number, y: number, forPrefix = false): void {
  const t = inv.transporters ?? {};
  const name = t.display_name ?? 'Transporter';
  const manager = t.manager_name?.trim() || name;
  doc.setDrawColor(120).setLineWidth(0.6).line(x, y, x + 190, y);
  // "For: <manager>" when someone signs on the manager's behalf.
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(17).text(`${forPrefix ? 'For: ' : ''}${manager}`, x, y + 15);
  if (manager !== name) {
    doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(90).text(name, x, y + 28);
  }
}

/** True when the signed-in signer's name differs from the registered manager — the printed name then gets a "For:" prefix. */
function signedForAnother(inv: InvoiceDoc, sig?: { name: string }): boolean {
  const t = inv.transporters ?? {};
  const manager = (t.manager_name?.trim() || t.display_name || '').toLowerCase();
  return !!sig && !!sig.name.trim() && sig.name.trim().toLowerCase() !== manager;
}

// ── Invoice PDF ──────────────────────────────────────────────────────────────
export function buildInvoice(inv: InvoiceDoc): jsPDF {
  const doc = newDoc();
  const W = pageWidth(doc);
  const s = summary(inv);
  const L = lhL(inv);
  const R = lhR(inv);
  // Scanned company letterhead wins; otherwise the generated one.
  let y = letterheadScan(doc, inv) ?? letterhead(doc, inv, M);

  // Invoice no (right) + date.
  doc.setTextColor(17);
  doc.setFont('helvetica', 'bold').setFontSize(11);
  doc.text(`Invoice No: ${ref(inv)}`, W - R, y, { align: 'right' });
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.text(`Date: ${long(inv.created_at)}`, L, y);
  y += 22;

  // Bill To.
  doc.setFont('helvetica', 'bold').text('Bill To:', L, y);
  y += 15;
  doc.setFont('helvetica', 'normal');
  for (const lineTxt of RECIPIENT) {
    doc.text(lineTxt, L, y);
    y += 13;
  }
  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.text(`Haulage of Electrical Poles & Materials - ${s.origin} to ${s.dest}`, L, y);
  y += 10;

  // Table.
  autoTable(doc, {
    startY: y,
    // Keep rows inside the scanned letterhead's printable area on every page.
    margin: { left: L, right: R, top: inv.letterheadDataUrl ? (inv.letterheadInsets?.top ?? LH_INSET.top) : M, bottom: inv.letterheadDataUrl ? (inv.letterheadInsets?.bottom ?? LH_INSET.bottom) : M },
    // Paint the background BEFORE each page's rows (and never twice — see letterheadScan).
    willDrawPage: () => { letterheadScan(doc, inv); },
    head: [['Date', 'Waybill(s)', 'Vehicle Reg.', 'From', 'To', 'Amount (GHS)']],
    body: (inv.invoice_lines ?? []).map((l) => {
      const w = l.waybills ?? {};
      return [
        short(w.waybill_date),
        w.waybill_no ?? '',
        w.vehicle_no ?? '',
        w.origins?.name ?? '',
        w.districts?.name ?? '',
        num(l.computed_cost),
      ];
    }),
    styles: { font: 'helvetica', fontSize: 10, cellPadding: 5, lineColor: [150, 150, 150], lineWidth: 0.5 },
    headStyles: { fillColor: BLUE_LIGHT, textColor: 17, fontStyle: 'bold' },
    columnStyles: { 5: { halign: 'right' } },
  });

  // Total + footer.
  const afterTable = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;
  doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(...NAVY);
  doc.text(`Total Amount Due: GHS ${num(inv.total_cost)}`, W - R, afterTable, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(90);
  doc.text('Thank you for your business. Payment is due within 30 days.', W / 2, afterTable + 28, { align: 'center' });

  // Signature block (left). If transporter signed, the image sits ON the signature line.
  const transSig = inv.signatures?.find((s) => s.slot === 'transporter');
  doc.setFontSize(10).setTextColor(17).setFont('helvetica', 'bold').text('For and on behalf of the company:', L, afterTable + 60);
  const lineY = afterTable + (transSig?.sigDataUrl ? 112 : 92); // extra headroom for the image
  if (transSig?.sigDataUrl) {
    try { doc.addImage(transSig.sigDataUrl, 'PNG', L + 20, lineY - 36, 94, 34); } catch { /* skip unreadable */ }
    doc.setFontSize(9).setTextColor(90).setFont('helvetica', 'normal');
    doc.text(`Signed: ${short(transSig.signed_at)}`, L + 190, lineY - 4, { align: 'right' });
  }
  signatureBlock(doc, inv, L, lineY, signedForAnother(inv, transSig));

  if (!inv.letterheadDataUrl) waveFooter(doc); // scanned letterhead brings its own footer
  return doc;
}

// ── Letter PDF ───────────────────────────────────────────────────────────────
export function buildLetter(inv: InvoiceDoc): jsPDF {
  const doc = newDoc();
  const W = pageWidth(doc);
  const L = lhL(inv);
  const R = lhR(inv);
  const contentW = W - L - R;
  const s = summary(inv);
  const route = `${s.origin} to ${s.dest}`;
  const period = `${long(s.ps)} - ${long(s.pe)}`;

  // Scanned company letterhead wins; otherwise the generated one.
  let y = letterheadScan(doc, inv) ?? letterhead(doc, inv, M);

  const para = (text: string, opts: { bold?: boolean; gap?: number; align?: 'left' | 'justify' } = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal').setFontSize(12).setTextColor(17);
    const allLines = doc.splitTextToSize(text, contentW) as string[];
    let offset = 0;
    while (offset < allLines.length) {
      const available = contentBottom(doc, inv) - y;
      const fit = Math.max(1, Math.floor(available / 15));
      const chunk = allLines.slice(offset, offset + fit);
      offset += chunk.length;
      if (y + chunk.length * 15 > contentBottom(doc, inv) || (offset < allLines.length && chunk.length < fit)) {
        doc.addPage();
        y = letterheadScan(doc, inv) ?? M;
      }
      doc.text(chunk, L, y, { align: opts.align ?? 'left', maxWidth: contentW });
      y += chunk.length * 15;
      if (offset < allLines.length) {
        doc.addPage();
        y = letterheadScan(doc, inv) ?? M;
      }
    }
    y += (opts.gap ?? 8);
  };

  doc.setFont('helvetica', 'normal').setFontSize(12);
  doc.text(long(inv.created_at), L, y);
  y += 20;
  for (const lineTxt of RECIPIENT) {
    doc.text(lineTxt, L, y);
    y += 14;
  }
  y += 10;

  para(`REQUEST FOR PAYMENT - HAULAGE OF ELECTRICAL POLES AND MATERIALS FROM ${s.origin.toUpperCase()} TO ${s.dest.toUpperCase()}`, { bold: true, gap: 12 });
  para('Dear Sir,', { gap: 12 });
  para(
    `I write to formally request payment for haulage services rendered during the period of ${period}. The services involved the transportation of electrical poles and materials from ${route}.`,
    { align: 'justify' },
  );
  para('The details of the services rendered are as follows:', { align: 'justify' });

  // Detail key/value block.
  const kv: [string, string][] = [
    ['Service Description:', `Haulage of Electrical Poles & Materials - ${route}`],
    ['Service Period:', period],
    ['Invoice Number:', ref(inv)],
    ['Invoice Date:', long(inv.created_at)],
    ['Total Number of Trips:', `${s.trips} trip(s)`],
    ['Total Waybills:', `${s.waybills} waybill(s)`],
    ['Total Amount Due:', `GHS ${num(inv.total_cost)}`],
  ];
  doc.setFontSize(12);
  for (const [k, v] of kv) {
    if (y + 16 > contentBottom(doc, inv)) {
      doc.addPage();
      y = letterheadScan(doc, inv) ?? M;
    }
    doc.setFont('helvetica', 'bold').text(k, L, y);
    doc.setFont('helvetica', 'normal').text(v, L + 150, y);
    y += 16;
  }
  y += 8;

  para('The haulage services were completed satisfactorily and in accordance with the agreed terms. All electrical poles and materials were delivered safely and on schedule.', { align: 'justify' });
  para(`Attached please find Invoice ${ref(inv)} with detailed trip information for your review and processing. I kindly request that payment be processed at your earliest convenience.`, { align: 'justify' });
  para('Should you require any additional information, supporting documentation, or clarification regarding this invoice, please do not hesitate to contact me.', { align: 'justify' });
  para('Thank you for your attention to this matter. I look forward to your prompt response.', { align: 'justify' });
  para('Yours faithfully,', { gap: 36 });
  // Transporter signature on letter if signed — image sits ON the signature line.
  const transSig = inv.signatures?.find((s) => s.slot === 'transporter');
  if (transSig?.sigDataUrl) {
    try { doc.addImage(transSig.sigDataUrl, 'PNG', L + 20, y - 34, 94, 32); } catch { /* skip */ }
    doc.setFontSize(9).setTextColor(90).setFont('helvetica', 'normal');
    doc.text(`Signed: ${short(transSig.signed_at)}`, L + 190, y - 4, { align: 'right' });
  }
  signatureBlock(doc, inv, L, y, signedForAnother(inv, transSig));

  if (!inv.letterheadDataUrl) waveFooter(doc); // scanned letterhead brings its own footer
  return doc;
}

// ── Amount in words ──────────────────────────────────────────────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = ['', 'Thousand', 'Million', 'Billion'];

function under1000(x: number): string {
  let out = '';
  if (x >= 100) {
    out += ONES[Math.floor(x / 100)] + ' Hundred';
    x %= 100;
    if (x) out += ' and ';
  }
  if (x >= 20) {
    out += TENS[Math.floor(x / 10)];
    if (x % 10) out += '-' + ONES[x % 10];
  } else if (x > 0) out += ONES[x];
  return out;
}

/** 13695.86 → "Thirteen Thousand, Six Hundred and Ninety-Five Ghana Cedis and Eighty-Six Pesewas". */
export function amountInWords(n: number): string {
  const cedis = Math.floor(n);
  const pesewas = Math.round((n - cedis) * 100);
  let whole = cedis;
  const parts: string[] = [];
  let scale = 0;
  while (whole > 0) {
    const chunk = whole % 1000;
    if (chunk) parts.unshift(under1000(chunk) + (SCALES[scale] ? ' ' + SCALES[scale] : ''));
    whole = Math.floor(whole / 1000);
    scale++;
  }
  const cedisW = (parts.length ? parts.join(', ') : 'Zero') + ' Ghana Cedis';
  return pesewas > 0 ? `${cedisW} and ${under1000(pesewas)} Pesewas` : cedisW;
}

/** Goods descriptor from the invoice's line categories (fixed order, comma-joined for a mix). */
function categoryLabel(inv: InvoiceDoc): string {
  const map: Record<string, string> = { 'Concrete Poles': 'Concrete Poles', Material: 'Electrical Materials', Poles: 'Wooden Poles' };
  const present = new Set((inv.invoice_lines ?? []).map((l) => l.category));
  const labels = (['Concrete Poles', 'Material', 'Poles'] as const).filter((c) => present.has(c)).map((c) => map[c]);
  return labels.length ? labels.join(', ') : 'Electrical Materials';
}

// ── Memorandum PDF ───────────────────────────────────────────────────────────
export interface MemoOpts {
  fromTitle: string;
  signatoryName: string;
  letterDate: string; // yyyy-mm-dd
}

export function buildMemo(inv: InvoiceDoc, opts: MemoOpts, logo?: string | null): jsPDF {
  const doc = newDoc();
  const W = pageWidth(doc);
  const H = doc.internal.pageSize.getHeight();
  const name = (inv.transporters?.display_name ?? 'Transporter').toUpperCase();
  const s = summary(inv);
  const goods = categoryLabel(inv);
  const total = num(inv.total_cost);
  const dateStr = `${MONTHS[(pd(inv.created_at) ?? new Date()).getUTCMonth()].toUpperCase()} ${String((pd(inv.created_at) ?? new Date()).getUTCDate()).padStart(2, '0')}, ${(pd(inv.created_at) ?? new Date()).getUTCFullYear()}`;
  let y = M;

  if (logo) {
    const sz = 44;
    doc.addImage(logo, 'PNG', (W - sz) / 2, y, sz, sz);
    y += sz + 10;
  }

  // Title.
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(17);
  doc.text('MEMORANDUM', M, y);
  doc.setLineWidth(1).line(M, y + 3, M + doc.getTextWidth('MEMORANDUM'), y + 3);
  y += 26;

  // Header block.
  const labelX = M;
  const valueX = M + 74;
  const row = (label: string, value: string, bold = false) => {
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(17).text(label, labelX, y);
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    const lines = doc.splitTextToSize(value, W - M - valueX) as string[];
    doc.text(lines, valueX, y);
    y += lines.length * 15 + 4;
  };
  row('TO:', 'CHIEF DIRECTOR');
  row('FROM:', opts.fromTitle);
  row('SUBJECT:', `REQUEST FOR PAYMENT IN FAVOUR OF M/S ${name} FOR THE HAULAGE OF ${goods.toUpperCase()}`, true);
  row('DATE:', dateStr);
  y += 4;
  doc.setDrawColor(120).setLineWidth(0.8).line(M, y, W - M, y);
  y += 20;

  // Numbered, justified paragraphs.
  let n = 0;
  const numX = M;
  const bodyX = M + 22;
  const bodyW = W - M - bodyX;
  // Justified word-flow renderer: wraps to bodyW, honours per-word bold (jsPDF has no rich text),
  // and distributes slack across gaps on every line except each paragraph's last.
  const para = (segments: { text: string; bold?: boolean }[]) => {
    n++;
    doc.setFontSize(12).setTextColor(17);
    const measured = segments.flatMap((sg) =>
      sg.text.trim().split(/\s+/).filter(Boolean).map((w) => {
        doc.setFont('helvetica', sg.bold ? 'bold' : 'normal');
        return { w, b: !!sg.bold, width: doc.getTextWidth(w) };
      }),
    );
    doc.setFont('helvetica', 'normal');
    const sw = doc.getTextWidth(' ');
    // Greedy line break.
    const lines: { w: string; b: boolean; width: number }[][] = [];
    let cur: typeof measured = [];
    let curW = 0;
    for (const m of measured) {
      const add = (cur.length ? sw : 0) + m.width;
      if (cur.length && curW + add > bodyW) {
        lines.push(cur);
        cur = [];
        curW = 0;
      }
      curW += (cur.length ? sw : 0) + m.width;
      cur.push(m);
    }
    if (cur.length) lines.push(cur);

    if (y + lines.length * 15 > H - M - 40) {
      doc.addPage();
      y = M;
    }
    doc.setFont('helvetica', 'bold').setFontSize(12).text(`${n}.`, numX, y);
    lines.forEach((ln, li) => {
      const wordsW = ln.reduce((s, m) => s + m.width, 0);
      const gaps = ln.length - 1;
      const gap = li < lines.length - 1 && gaps > 0 ? (bodyW - wordsW) / gaps : sw;
      let x = bodyX;
      for (const m of ln) {
        doc.setFont('helvetica', m.b ? 'bold' : 'normal').text(m.w, x, y);
        x += m.width + gap;
      }
      y += 15;
    });
    y += 8;
  };

  para([{ text: `Reference is made to the letter dated ${long(opts.letterDate)}, from M/S ${name} requesting for payment for haulage of ${goods.toLowerCase()} (copy attached).` }]);
  para([{ text: 'We confirm that the transporter has satisfactorily executed the work as evidenced by the attached waybills.' }]);
  para([{ text: `Messrs. ${name} submitted ${s.waybills} waybill${s.waybills === 1 ? '' : 's'} with an invoice amount of GHS ${total} for processing and payment.` }]);
  para([{ text: `Furthermore, review of the submitted waybills indicated that the amount due the transporter under the invoice is GHS ${total}.` }]);
  para([
    { text: `The Power Directorate hereby submits the request for payment of an amount of GHS${total} ` },
    { text: `(${amountInWords(inv.total_cost)})`, bold: true },
    { text: ` for haulage of the ${goods.toLowerCase()} to your attention.` },
  ]);
  para([{ text: 'We have attached copies of the relevant documents for your perusal.' }]);

  // Signatory (no signature line — signed above the name).
  y += 45;
  if (y > H - M) {
    doc.addPage();
    y = M + 45;
  }
  // If Director approved, draw their signature and default name.
  const dirSig = inv.signatures?.find((s) => s.slot === 'approved');
  if (dirSig?.sigDataUrl) {
    try { doc.addImage(dirSig.sigDataUrl, 'PNG', M, y - 54, 100, 36); } catch { /* skip */ }
    doc.setFontSize(9).setTextColor(90).setFont('helvetica', 'normal');
    doc.text(short(dirSig.signed_at), M, y - 14);
  }
  const signatoryName = dirSig?.name || opts.signatoryName;
  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(17);
  doc.text(signatoryName.toUpperCase(), M, y);

  return doc;
}

// ── Signatory sheet PDF ──────────────────────────────────────────────────────
export function buildSignatory(inv: InvoiceDoc, logo?: string | null): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
  const W = pageWidth(doc);
  const name = inv.transporters?.display_name ?? 'Transporter';
  const s = summary(inv);
  const period = `${long(s.ps)} - ${long(s.pe)}`;
  let y = M;

  if (logo) doc.addImage(logo, 'PNG', M, y - 4, 34, 34);

  // Title centered + period box right.
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(17);
  doc.text('HAULAGE INVOICES', W / 2, y + 18, { align: 'center' });
  doc.setDrawColor(120).setLineWidth(0.8).rect(W - M - 190, y, 190, 26);
  doc.setFont('helvetica', 'normal').setFontSize(10);
  doc.text(period, W - M - 95, y + 17, { align: 'center' });
  y += 44;

  // Haulage cost (left, big) + transporter (right).
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90).text('Haulage Cost', M, y);
  doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(17).text(num(inv.total_cost), M, y + 20);
  doc.setFont('helvetica', 'bold').setFontSize(11).text(`Transporter Name: ${name}`, W - M, y + 14, { align: 'right' });
  y += 40;

  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [['Category', 'Date', 'Distance', 'From', 'To', 'Haulage Charge (Pole/Mats)', 'Haulage Charge/Stay block', 'Transporter', 'Truck Size/Trailer', 'No. of Poles', 'No. of trips', 'Waybill No.', 'Vehicle No.', 'Haulage Cost']],
    body: (inv.invoice_lines ?? []).map((l) => {
      const w = l.waybills ?? {};
      const r = l.rate_snapshot?.rates ?? {};
      return [
        l.category ?? '',
        short(w.waybill_date),
        l.distance_km != null ? String(l.distance_km) : '',
        w.origins?.name ?? '',
        w.districts?.name ?? '',
        r.haulagePerUnitKm != null ? String(r.haulagePerUnitKm) : '',
        r.stayPerKm != null ? String(r.stayPerKm) : '',
        name,
        w.truck_size != null ? String(w.truck_size) : '',
        w.num_poles != null ? String(w.num_poles) : '',
        w.num_trips != null ? String(w.num_trips) : '',
        w.waybill_no ?? '',
        w.vehicle_no ?? '',
        num(l.computed_cost),
      ];
    }),
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 3, lineColor: [150, 150, 150], lineWidth: 0.5, overflow: 'linebreak' },
    headStyles: { fillColor: BLUE_LIGHT, textColor: 17, fontStyle: 'bold', fontSize: 7 },
    columnStyles: { 13: { halign: 'right' } },
  });

  // Three signature blocks stacked — fill if signed, blanks otherwise.
  let sy = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 50;
  const H = doc.internal.pageSize.getHeight();
  const col2 = M + 300;
  const col3 = W - M - 200;
  const slotMap: Record<string, string> = { 'Prepared by:': 'prepared', 'Checked by:': 'checked', 'Approved by:': 'approved' };
  for (const role of ['Prepared by:', 'Checked by:', 'Approved by:']) {
    if (sy > H - M) {
      doc.addPage();
      sy = M + 30;
    }
    const slot = slotMap[role];
    const sig = slot ? inv.signatures?.find((s) => s.slot === slot) : undefined;
    doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(17);
    doc.text(`${role} ____________________________`, M, sy);
    doc.text(sig ? `Name: ${sig.name || ''}` : 'Name: ____________________________', col2, sy);
    doc.text(sig ? `Date: ${short(sig.signed_at)}` : 'Date: ________________', col3, sy);
    if (sig?.sigDataUrl) {
      // Centre the signature image over the blank line, bottom edge resting on it.
      const lineX = M + doc.getTextWidth(`${role} `);
      try { doc.addImage(sig.sigDataUrl, 'PNG', lineX + 30, sy - 38, 100, 36); } catch { /* skip */ }
    }
    sy += 70;
  }

  return doc;
}

export function downloadInvoicePdf(inv: InvoiceDoc) {
  buildInvoice(inv).save(`Invoice_${ref(inv)}.pdf`);
}
export function downloadLetterPdf(inv: InvoiceDoc) {
  buildLetter(inv).save(`Payment_Request_${ref(inv)}.pdf`);
}
