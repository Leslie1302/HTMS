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
 * filter to known scan types, and sort by canonical order.
 */
export function extractScopedScans(invoiceLines: ScanLine[]): RawScan[] {
  return (invoiceLines ?? [])
    .flatMap((l) => l.waybills?.scans ?? [])
    .filter((s) => SCAN_ORDER.includes(s.scan_type))
    .sort((a, b) => SCAN_ORDER.indexOf(a.scan_type) - SCAN_ORDER.indexOf(b.scan_type));
}
