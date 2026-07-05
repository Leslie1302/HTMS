import { describe, it, expect } from 'vitest';
import { toE164Digits } from '../../netlify/functions/_sms';

describe('toE164Digits', () => {
  it('normalises a Ghana local number', () => {
    expect(toE164Digits('024 123 4567')).toBe('233241234567');
  });
  it('keeps an international number, dropping the +', () => {
    expect(toE164Digits('+233241234567')).toBe('233241234567');
    expect(toE164Digits('00233241234567')).toBe('233241234567');
  });
  it('rejects blanks and too-short numbers', () => {
    expect(toE164Digits(null)).toBeNull();
    expect(toE164Digits('')).toBeNull();
    expect(toE164Digits('12345')).toBeNull();
  });
});
