/**
 * Letterhead utilities: PDF-to-PNG conversion. Used during upload so the
 * rest of the system only ever deals with PNG images.
 */

/**
 * Convert the first page of a PDF to a PNG Blob at A4 screen resolution.
 * Dynamically imports pdfjs-dist so it stays out of the main bundle.
 *
 * Returns a Blob, not a data URL: a full-page PNG data URL is megabytes of
 * base64, and `fetch()`-ing one back into a Blob fails outright in Safari
 * ("Load failed"). The canvas already gives us a Blob — don't round-trip it.
 */
export async function pdfFirstPageToPngBlob(pdfBytes: ArrayBuffer): Promise<Blob> {
  const pdfjsLib = await import('pdfjs-dist');
  // Serve the worker from our own bundle. The CDN variant failed with
  // "Setting up fake worker failed" — a cross-origin module script the browser
  // refuses to import — and would also drift from the installed version.
  // Vite's `?url` gives a same-origin, version-matched URL.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const page = await pdf.getPage(1);
  const scale = 2; // ~150 DPI — good balance of quality vs file size
  const viewport = page.getViewport({ scale });

  // ponytail: plain <canvas> — OffscreenCanvas buys nothing here and is patchier across browsers.
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not render the PDF (no canvas context).');
  await page.render({ canvasContext: ctx, viewport }).promise;

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not convert the PDF page to an image.'))),
      'image/png',
    );
  });
}
