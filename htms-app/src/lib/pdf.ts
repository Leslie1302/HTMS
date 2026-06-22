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

function monogram(name: string): string {
  const stop = new Set(['ENTERPRISES', 'ENTERPRISE', 'LIMITED', 'LTD', 'COMPANY', 'CO', 'GHANA', 'AND', '&', 'THE']);
  const words = name.toUpperCase().split(/[\s-]+/).filter((w) => w && !stop.has(w));
  if (words.length >= 2) return (words[0][0] + words[1][0]).slice(0, 2);
  if (words.length === 1) return words[0].slice(0, 2);
  return name.slice(0, 2).toUpperCase();
}

interface Line {
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

// ── Invoice PDF ──────────────────────────────────────────────────────────────
export function buildInvoice(inv: InvoiceDoc, logo?: string | null): jsPDF {
  const doc = newDoc();
  const W = pageWidth(doc);
  const t = inv.transporters ?? {};
  const s = summary(inv);
  let y = M;

  // Ministry crest, centered.
  if (logo) {
    const sz = 56;
    doc.addImage(logo, 'PNG', (W - sz) / 2, y, sz, sz);
    y += sz + 8;
  }

  // Centered letterhead.
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(17);
  doc.text(t.display_name ?? 'Transporter', W / 2, y, { align: 'center' });
  y += 16;
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
  y += 4;
  doc.setDrawColor(...GREEN).setLineWidth(1.4).line(M, y, W - M, y);
  y += 22;

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
export function buildLetter(inv: InvoiceDoc, logo?: string | null): jsPDF {
  const doc = newDoc();
  const W = pageWidth(doc);
  const H = doc.internal.pageSize.getHeight();
  const contentW = W - M * 2;
  const t = inv.transporters ?? {};
  const name = t.display_name ?? 'Transporter';
  const s = summary(inv);
  const route = `${s.origin} to ${s.dest}`;
  const period = `${long(s.ps)} - ${long(s.pe)}`;
  let y = M;

  // Letterhead: Ministry crest (or monogram fallback) + transporter name.
  if (logo) {
    doc.addImage(logo, 'PNG', M, y - 6, 44, 44);
  } else {
    doc.setFillColor(...GREEN).roundedRect(M, y - 6, 40, 40, 6, 6, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(255, 255, 255);
    doc.text(monogram(name), M + 20, y + 19, { align: 'center' });
  }
  doc.setTextColor(17).setFont('helvetica', 'bold').setFontSize(15);
  doc.text(name, M + 56, y + 18);
  y += 46;
  doc.setDrawColor(...GREEN).setLineWidth(1.4).line(M, y, W - M, y);
  y += 22;

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

export async function downloadInvoicePdf(inv: InvoiceDoc) {
  const logo = await loadLogo();
  buildInvoice(inv, logo).save(`Invoice_${ref(inv)}.pdf`);
}
export async function downloadLetterPdf(inv: InvoiceDoc) {
  const logo = await loadLogo();
  buildLetter(inv, logo).save(`Payment_Request_${ref(inv)}.pdf`);
}
