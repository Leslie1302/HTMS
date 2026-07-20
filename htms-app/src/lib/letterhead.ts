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
  // Point the worker at the CDN — the user needs internet to upload to
  // Supabase anyway, so this is acceptable.
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

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
