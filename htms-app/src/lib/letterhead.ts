/**
 * Letterhead utilities: PDF-to-PNG conversion. Used during upload so the
 * rest of the system only ever deals with PNG images.
 */

/**
 * Convert the first page of a PDF to a PNG data-URL at A4 screen resolution.
 * Dynamically imports pdfjs-dist so it stays out of the main bundle.
 */
export async function pdfFirstPageToDataUrl(pdfBytes: ArrayBuffer): Promise<string> {
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

  const canvas = new OffscreenCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
