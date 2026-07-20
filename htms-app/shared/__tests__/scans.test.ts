import { describe, it, expect } from 'vitest';
import { extractScopedScans, type ScanLine } from '../scans';

describe('extractScopedScans', () => {
  it('returns scans in canonical order: acknowledgement → waybill → release_letter', () => {
    const lines: ScanLine[] = [
      { waybills: { scans: [
        { id: '1', storage_path: 'a', mime_type: 'image/png', scan_type: 'release_letter' },
        { id: '2', storage_path: 'b', mime_type: 'image/png', scan_type: 'acknowledgement' },
        { id: '3', storage_path: 'c', mime_type: 'application/pdf', scan_type: 'waybill' },
      ] } },
    ];
    const result = extractScopedScans(lines);
    expect(result.map((s) => s.scan_type)).toEqual(['acknowledgement', 'waybill', 'release_letter']);
  });

  it('filters out unknown scan types', () => {
    const lines: ScanLine[] = [
      { waybills: { scans: [
        { id: '1', storage_path: 'a', mime_type: 'image/png', scan_type: 'unknown_type' },
        { id: '2', storage_path: 'b', mime_type: 'image/png', scan_type: 'waybill' },
      ] } },
    ];
    const result = extractScopedScans(lines);
    expect(result).toHaveLength(1);
    expect(result[0].scan_type).toBe('waybill');
  });

  it('handles missing waybills or scans gracefully', () => {
    const lines: ScanLine[] = [
      { waybills: null },
      { waybills: { scans: undefined } },
      {},
    ];
    expect(extractScopedScans(lines)).toEqual([]);
  });

  it('flattens scans across multiple invoice lines', () => {
    const lines: ScanLine[] = [
      { waybills: { scans: [{ id: '1', storage_path: 'a', mime_type: 'image/png', scan_type: 'waybill' }] } },
      { waybills: { scans: [{ id: '2', storage_path: 'b', mime_type: 'image/png', scan_type: 'acknowledgement' }] } },
    ];
    const result = extractScopedScans(lines);
    expect(result).toHaveLength(2);
    expect(result[0].scan_type).toBe('acknowledgement');
    expect(result[1].scan_type).toBe('waybill');
  });
});
