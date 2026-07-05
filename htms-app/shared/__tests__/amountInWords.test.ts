import { describe, it, expect } from 'vitest';
import { amountInWords } from '../../src/lib/pdf';

describe('amountInWords', () => {
  it('formats cedis + pesewas', () => {
    expect(amountInWords(13695.86)).toBe(
      'Thirteen Thousand, Six Hundred and Ninety-Five Ghana Cedis and Eighty-Six Pesewas',
    );
  });
  it('whole cedis, no pesewas', () => {
    expect(amountInWords(2000)).toBe('Two Thousand Ghana Cedis');
  });
  it('handles hundreds with "and"', () => {
    expect(amountInWords(225.5)).toBe('Two Hundred and Twenty-Five Ghana Cedis and Fifty Pesewas');
  });
  it('handles zero', () => {
    expect(amountInWords(0)).toBe('Zero Ghana Cedis');
  });
});
