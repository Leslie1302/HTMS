/**
 * Merge the uploaded supporting scans (acknowledgement form, waybill, release
 * letter) onto the end of a generated invoice/letter PDF, producing a single
 * downloadable document package. PDF scans are appended page-for-page; image
 * scans (png/jpeg) are embedded natively with no re-encode, and webp is
 * normalised via canvas.
 */
import { PDFDocument, type PDFImage } from 'pdf-lib';

export interface ScanInput {
  bytes: ArrayBuffer;
  mime: string;
  label?: string; // e.g. "Waybill", "Acknowledgement form"
}

/** Cap the longest edge when an image has to be re-encoded — keeps the merged PDF small and fast to open. */
const MAX_SCAN_DIM = 1600;

/** Rasterise a browser-decodable image to PNG bytes, downscaled to MAX_SCAN_DIM. */
async function imageToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed view (TS BlobPart typings reject SharedArrayBuffer).
  const copy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, MAX_SCAN_DIM / img.naturalWidth, MAX_SCAN_DIM / img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    const b64 = dataUrl.split(',')[1];
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Embed a scan image into the target document. JPEG/PNG are embedded natively
 * (no canvas round-trip — that was the main slowdown); other types are
 * normalised to a downscaled PNG.
 */
async function embedScan(out: PDFDocument, bytes: Uint8Array, mime: string): Promise<{ img: PDFImage; width: number; height: number }> {
  if (mime === 'image/jpeg') {
    const img = await out.embedJpg(bytes);
    return { img, width: img.width, height: img.height };
  }
  if (mime === 'image/png') {
    const img = await out.embedPng(bytes);
    return { img, width: img.width, height: img.height };
  }
  // webp and anything else the browser can decode → downscaled PNG.
  const png = await imageToPng(bytes, mime);
  const img = await out.embedPng(png);
  return { img, width: img.width, height: img.height };
}

/**
 * Append scan pages into an already-loaded PDFDocument, in array order.
 * Shared by callers that need to inject scans into an existing document
 * (e.g. putting the proof-of-receipt first in the reviewer package).
 */
export async function copyScansIntoDoc(out: PDFDocument, scans: ScanInput[]): Promise<void> {
  for (const scan of scans) {
    try {
      if (scan.mime === 'application/pdf') {
        const src = await PDFDocument.load(scan.bytes);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
        continue;
      }
      if (!scan.mime.startsWith('image/')) continue;
      const bytes = scan.bytes instanceof Uint8Array ? scan.bytes : new Uint8Array(scan.bytes);
      const { img, width, height } = await embedScan(out, bytes, scan.mime);
      const page = out.addPage();
      const { width: pw, height: ph } = page.getSize();
      const margin = 36;
      const maxW = pw - margin * 2;
      const maxH = ph - margin * 2 - (scan.label ? 18 : 0);
      const scale = Math.min(maxW / width, maxH / height, 1);
      const w = width * scale;
      const h = height * scale;
      if (scan.label) {
        page.drawText(scan.label, { x: margin, y: ph - margin, size: 11 });
      }
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2 - 10, width: w, height: h });
    } catch (e) {
      console.warn('Skipping unreadable scan:', scan.label, e);
    }
  }
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
