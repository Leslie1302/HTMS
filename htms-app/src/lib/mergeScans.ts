/**
 * Merge the uploaded supporting scans (acknowledgement form, waybill, release
 * letter) onto the end of a generated invoice/letter PDF, producing a single
 * downloadable document package.
 *
 * Every scan is compressed before it is embedded so the output stays small and
 * fast to open: images are downscaled to MAX_SCAN_DIM and re-encoded (JPEG for
 * photos/webp, PNG preserved for PNG), and PDF scans are rasterised to compact
 * JPEGs via pdfjs-dist instead of copying their (often photo-sized) pages
 * verbatim. If a PDF cannot be rasterised it falls back to page-for-page copy.
 */
import { PDFDocument, type PDFImage } from 'pdf-lib';

export interface ScanInput {
  bytes: ArrayBuffer;
  mime: string;
  label?: string; // e.g. "Waybill", "Acknowledgement form"
}

/** Cap the longest edge of every embedded image — keeps files small and fast to open. */
const MAX_SCAN_DIM = 1600;

/** JPEG quality for re-encoded photos/rasterised PDF pages. */
const SCAN_JPEG_QUALITY = 0.72;

/** Scans at or below this size are embedded raw — compressing them buys nothing. */
const SMALL_SCAN_BYTES = 200 * 1024;

/** Guarantee a promise settles — compression/download must never hang the UI forever. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Normalise a Uint8Array view into its exact backing ArrayBuffer (TS-safe BlobPart). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image to ' + mime))),
      mime,
      quality,
    );
  });
}

/** Rasterise a browser-decodable image to PNG bytes, downscaled to MAX_SCAN_DIM (raw-embed fallback). */
async function imageToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mime }));
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

/** Embed raw bytes without re-encoding (used when compression fails/times out). */
async function embedRaw(
  out: PDFDocument,
  bytes: Uint8Array,
  mime: string,
): Promise<{ img: PDFImage; width: number; height: number }> {
  if (mime === 'image/png') {
    const img = await out.embedPng(bytes);
    return { img, width: img.width, height: img.height };
  }
  if (mime === 'image/jpeg') {
    const img = await out.embedJpg(bytes);
    return { img, width: img.width, height: img.height };
  }
  const png = await imageToPng(bytes, mime);
  const img = await out.embedPng(png);
  return { img, width: img.width, height: img.height };
}

/** Decode an image via the browser and re-encode it downscaled to MAX_SCAN_DIM. */
async function downscaleImage(bytes: Uint8Array, mime: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mime }));
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
    return canvasToBlob(canvas, mime === 'image/png' ? 'image/png' : 'image/jpeg', SCAN_JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Rasterise every page of a PDF scan to a compact JPEG. Returns one byte array
 * per page. pdfjs-dist is imported lazily so it stays out of the main bundle.
 */
async function rasterizePdfToJpegs(bytes: Uint8Array): Promise<Uint8Array[]> {
  const pdfjsLib = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  try {
    const out: Uint8Array[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(1, MAX_SCAN_DIM / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas context');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await canvasToBlob(canvas, 'image/jpeg', SCAN_JPEG_QUALITY);
      out.push(new Uint8Array(await blob.arrayBuffer()));
    }
    return out;
  } finally {
    void pdf.destroy();
  }
}

/** Create a fresh page in `out` and place an image on it, fitted and labelled. */
function addFigurePage(out: PDFDocument, width: number, height: number, img: PDFImage, label?: string): void {
  const page = out.addPage();
  const { width: pw, height: ph } = page.getSize();
  const margin = 36;
  const maxW = pw - margin * 2;
  const maxH = ph - margin * 2 - (label ? 18 : 0);
  const scale = Math.min(maxW / width, maxH / height, 1);
  const w = width * scale;
  const h = height * scale;
  if (label) {
    page.drawText(label, { x: margin, y: ph - margin, size: 11 });
  }
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2 - 10, width: w, height: h });
}

/** Embed a single scan, never hanging: compression is best-effort with a raw-bytes fallback. */
async function addScanPage(out: PDFDocument, bytes: Uint8Array, mime: string, label?: string): Promise<void> {
  try {
    if (bytes.byteLength <= SMALL_SCAN_BYTES) {
      const { img, width, height } = await embedRaw(out, bytes, mime);
      addFigurePage(out, width, height, img, label);
      return;
    }
    const blob = await withTimeout(downscaleImage(bytes, mime), 10_000);
    const arr = new Uint8Array(await blob.arrayBuffer());
    const img = blob.type === 'image/png' ? await out.embedPng(arr) : await out.embedJpg(arr);
    addFigurePage(out, img.width, img.height, img, label);
  } catch (e) {
    console.warn('Compressing scan failed, embedding raw:', label, e);
    const { img, width, height } = await embedRaw(out, bytes, mime);
    addFigurePage(out, width, height, img, label);
  }
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
        const bytes = scan.bytes instanceof Uint8Array ? scan.bytes : new Uint8Array(scan.bytes);
        let pages: Uint8Array[];
        try {
          pages = await withTimeout(rasterizePdfToJpegs(bytes), 20_000);
        } catch (e) {
          console.warn('Could not rasterise scan PDF, copying pages verbatim:', scan.label, e);
          const src = await PDFDocument.load(bytes);
          const copied = await out.copyPages(src, src.getPageIndices());
          copied.forEach((p) => out.addPage(p));
          continue;
        }
        for (const pageBytes of pages) {
          await addScanPage(out, pageBytes, 'image/jpeg', scan.label);
        }
        continue;
      }
      if (!scan.mime.startsWith('image/')) continue;
      const bytes = scan.bytes instanceof Uint8Array ? scan.bytes : new Uint8Array(scan.bytes);
      await addScanPage(out, bytes, scan.mime, scan.label);
    } catch (e) {
      console.warn('Skipping unreadable scan:', scan.label, e);
    }
  }
}

/** Trigger a browser download of raw PDF bytes. */
export function downloadBytes(bytes: Uint8Array, filename: string) {
  const ab = toArrayBuffer(bytes);
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