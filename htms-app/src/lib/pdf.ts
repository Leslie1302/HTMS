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

const GREEN: [number, number, number] = [27, 94, 32];
const GREEN_LIGHT: [number, number, number] = [232, 245, 233];
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
  };
  invoice_lines?: Line[];
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
 * Makeshift letterhead built from the transporter's registration details
 * (name, address, email, phone, GPS) — no external logo. Returns the y below it.
 */
function letterhead(doc: jsPDF, inv: InvoiceDoc, y: number): number {
  const W = pageWidth(doc);
  const t = inv.transporters ?? {};
  doc.setFont('helvetica', 'bold').setFontSize(17).setTextColor(17);
  doc.text(t.display_name ?? 'Transporter', W / 2, y, { align: 'center' });
  y += 18;
  doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(60);
  if (t.address) {
    doc.text(t.address, W / 2, y, { align: 'center' });
    y += 12;
  }
  const contact = [t.email, t.phone, t.gps_address ? `GPS ${t.gps_address}` : ''].filter(Boolean).join('   |   ');
  if (contact) {
    doc.text(contact, W / 2, y, { align: 'center' });
    y += 12;
  }
  y += 6;
  doc.setDrawColor(...GREEN).setLineWidth(1.4).line(M, y, W - M, y);
  return y + 22;
}

// ── Invoice PDF ──────────────────────────────────────────────────────────────
export function buildInvoice(inv: InvoiceDoc): jsPDF {
  const doc = newDoc();
  const W = pageWidth(doc);
  const s = summary(inv);
  let y = letterhead(doc, inv, M);

  // Invoice no (right) + date.
  doc.setTextColor(17);
  doc.setFont('helvetica', 'bold').setFontSize(11);
  doc.text(`Invoice No: ${ref(inv)}`, W - M, y, { align: 'right' });
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.text(`Date: ${long(inv.created_at)}`, M, y);
  y += 22;

  // Bill To.
  doc.setFont('helvetica', 'bold').text('Bill To:', M, y);
  y += 15;
  doc.setFont('helvetica', 'normal');
  for (const lineTxt of RECIPIENT) {
    doc.text(lineTxt, M, y);
    y += 13;
  }
  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.text(`Haulage of Electrical Poles & Materials - ${s.origin} to ${s.dest}`, M, y);
  y += 10;

  // Table.
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
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
    headStyles: { fillColor: GREEN_LIGHT, textColor: 17, fontStyle: 'bold' },
    columnStyles: { 5: { halign: 'right' } },
  });

  // Total + footer.
  const afterTable = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;
  doc.setFont('helvetica', 'bold').setFontSize(13);
  doc.text(`Total Amount Due: GHS ${num(inv.total_cost)}`, W - M, afterTable, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(90);
  doc.text('Thank you for your business. Payment is due within 30 days.', W / 2, afterTable + 28, { align: 'center' });

  return doc;
}

// ── Letter PDF ───────────────────────────────────────────────────────────────
export function buildLetter(inv: InvoiceDoc): jsPDF {
  const doc = newDoc();
  const W = pageWidth(doc);
  const H = doc.internal.pageSize.getHeight();
  const contentW = W - M * 2;
  const t = inv.transporters ?? {};
  const name = t.display_name ?? 'Transporter';
  const s = summary(inv);
  const route = `${s.origin} to ${s.dest}`;
  const period = `${long(s.ps)} - ${long(s.pe)}`;

  // Makeshift letterhead from the transporter's registration details.
  let y = letterhead(doc, inv, M);

  const para = (text: string, opts: { bold?: boolean; gap?: number; align?: 'left' | 'justify' } = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal').setFontSize(12).setTextColor(17);
    const lines = doc.splitTextToSize(text, contentW) as string[];
    // page-break guard
    if (y + lines.length * 15 > H - M) {
      doc.addPage();
      y = M;
    }
    doc.text(lines, M, y, { align: opts.align ?? 'left', maxWidth: contentW });
    y += lines.length * 15 + (opts.gap ?? 8);
  };

  doc.setFont('helvetica', 'normal').setFontSize(12);
  doc.text(long(inv.created_at), M, y);
  y += 20;
  for (const lineTxt of RECIPIENT) {
    doc.text(lineTxt, M, y);
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
    if (y + 16 > H - M) {
      doc.addPage();
      y = M;
    }
    doc.setFont('helvetica', 'bold').text(k, M, y);
    doc.setFont('helvetica', 'normal').text(v, M + 150, y);
    y += 16;
  }
  y += 8;

  para('The haulage services were completed satisfactorily and in accordance with the agreed terms. All electrical poles and materials were delivered safely and on schedule.', { align: 'justify' });
  para(`Attached please find Invoice ${ref(inv)} with detailed trip information for your review and processing. I kindly request that payment be processed at your earliest convenience.`, { align: 'justify' });
  para('Should you require any additional information, supporting documentation, or clarification regarding this invoice, please do not hesitate to contact me.', { align: 'justify' });
  para('Thank you for your attention to this matter. I look forward to your prompt response.', { align: 'justify' });
  para('Yours faithfully,', { gap: 30 });
  doc.text('______________________________', M, y);
  y += 16;
  doc.text(name, M, y);

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
  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(17);
  doc.text(opts.signatoryName.toUpperCase(), M, y);

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
    headStyles: { fillColor: GREEN_LIGHT, textColor: 17, fontStyle: 'bold', fontSize: 7 },
    columnStyles: { 13: { halign: 'right' } },
  });

  // Three signature blocks stacked.
  let sy = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 50;
  const H = doc.internal.pageSize.getHeight();
  const col2 = M + 300;
  const col3 = W - M - 200;
  for (const role of ['Prepared by:', 'Checked by:', 'Approved by:']) {
    if (sy > H - M) {
      doc.addPage();
      sy = M + 30;
    }
    doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(17);
    doc.text(`${role} ____________________________`, M, sy);
    doc.text('Name: ____________________________', col2, sy);
    doc.text('Date: ________________', col3, sy);
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
