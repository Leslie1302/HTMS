/** Canonical display order for supporting scan types in merged PDFs. */
export const SCAN_ORDER = ['acknowledgement', 'waybill', 'release_letter'];

export interface RawScan {
  id: string;
  storage_path: string;
  mime_type: string;
  scan_type: string;
}

export interface ScanLine {
  waybills?: { scans?: RawScan[] } | null;
}

/**
 * Extract scans from nested-join invoice_lines (Supabase postgREST shape),
 * filter to known scan types, and order them grouped per waybill.
 *
 * Each invoice line maps to one waybill, so the scans of each line are kept
 * together and sorted by canonical order (acknowledgement → waybill →
 * release_letter). This yields an interleaved package per waybill rather than
 * grouping all acknowledgements together, then all waybills, then all release
 * letters.
 */
export function extractScopedScans(invoiceLines: ScanLine[]): RawScan[] {
  const result: RawScan[] = [];
  for (const line of invoiceLines ?? []) {
    const scans = (line.waybills?.scans ?? [])
      .filter((s) => SCAN_ORDER.includes(s.scan_type))
      .sort((a, b) => SCAN_ORDER.indexOf(a.scan_type) - SCAN_ORDER.indexOf(b.scan_type));
    result.push(...scans);
  }
  return result;
}
