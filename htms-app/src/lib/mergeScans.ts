/**
 * Merge the uploaded supporting scans (acknowledgement form, waybill, release
 * letter) onto the end of a generated invoice/letter PDF, producing a single
 * downloadable document package. PDF scans are appended page-for-page; image
 * scans (png/jpeg/webp) are normalised to PNG via canvas and placed one per page.
 */
import { PDFDocument } from 'pdf-lib';

export interface ScanInput {
  bytes: ArrayBuffer;
  mime: string;
  label?: string; // e.g. "Waybill", "Acknowledgement form"
}

/** Rasterise any browser-decodable image to PNG bytes (handles webp/jpeg/png). */
async function imageToPng(bytes: ArrayBuffer, mime: string): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    ctx.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const b64 = dataUrl.split(',')[1];
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Append scans to a base PDF (bytes from jsPDF) and return the merged bytes.
 * Never throws on a single bad scan — it's skipped so the document still issues.
 */
export async function appendScansToPdf(baseBytes: ArrayBuffer, scans: ScanInput[]): Promise<Uint8Array> {
  const out = await PDFDocument.load(baseBytes);

  for (const scan of scans) {
    try {
      if (scan.mime === 'application/pdf') {
        const src = await PDFDocument.load(scan.bytes);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } else if (scan.mime.startsWith('image/')) {
        const png = await imageToPng(scan.bytes, scan.mime);
        const img = await out.embedPng(png);
        const page = out.addPage();
        const { width, height } = page.getSize();
        const margin = 36;
        const maxW = width - margin * 2;
        const maxH = height - margin * 2 - (scan.label ? 18 : 0);
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        if (scan.label) {
          page.drawText(scan.label, { x: margin, y: height - margin, size: 11 });
        }
        page.drawImage(img, { x: (width - w) / 2, y: (height - h) / 2 - 10, width: w, height: h });
      }
    } catch (e) {
      console.warn('Skipping unreadable scan:', scan.label, e);
    }
  }
  return out.save();
}

/** Trigger a browser download of raw PDF bytes. */
export function downloadBytes(bytes: Uint8Array, filename: string) {
  // Copy into a plain ArrayBuffer (TS 5.7 no longer treats Uint8Array as a BlobPart).
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([ab], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
