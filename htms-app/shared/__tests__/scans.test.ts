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

  it('keeps scans grouped per waybill in canonical order', () => {
    const lines: ScanLine[] = [
      { waybills: { scans: [
        { id: '1', storage_path: 'a', mime_type: 'image/png', scan_type: 'waybill' },
        { id: '2', storage_path: 'b', mime_type: 'image/png', scan_type: 'acknowledgement' },
        { id: '3', storage_path: 'c', mime_type: 'application/pdf', scan_type: 'release_letter' },
      ] } },
      { waybills: { scans: [
        { id: '4', storage_path: 'd', mime_type: 'image/png', scan_type: 'release_letter' },
        { id: '5', storage_path: 'e', mime_type: 'image/png', scan_type: 'waybill' },
        { id: '6', storage_path: 'f', mime_type: 'image/png', scan_type: 'acknowledgement' },
      ] } },
    ];
    const result = extractScopedScans(lines);
    expect(result.map((s) => s.scan_type)).toEqual([
      'acknowledgement', 'waybill', 'release_letter',
      'acknowledgement', 'waybill', 'release_letter',
    ]);
  });

  it("keeps each waybill's scans together instead of grouping by type", () => {
    const lines: ScanLine[] = [
      { waybills: { scans: [
        { id: '1', storage_path: 'a', mime_type: 'image/png', scan_type: 'waybill' },
        { id: '2', storage_path: 'b', mime_type: 'image/png', scan_type: 'acknowledgement' },
        { id: '3', storage_path: 'c', mime_type: 'image/png', scan_type: 'release_letter' },
      ] } },
      { waybills: { scans: [
        { id: '4', storage_path: 'd', mime_type: 'image/png', scan_type: 'acknowledgement' },
        { id: '5', storage_path: 'e', mime_type: 'image/png', scan_type: 'waybill' },
        { id: '6', storage_path: 'f', mime_type: 'image/png', scan_type: 'release_letter' },
      ] } },
    ];
    const result = extractScopedScans(lines);
    // ids stay grouped per waybill: 1,2,3 then 4,5,6 (not sorted by type globally)
    expect(result.map((s) => s.id)).toEqual(['2', '1', '3', '4', '5', '6']);
  });
});
