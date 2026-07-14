import { describe, it, expect } from 'vitest';
import { roleToSlot, canSignSlot, isSlotSigned, isReviewerRole, isStaffRole } from '../signing';

describe('roleToSlot', () => {
  it('maps admin/officer to prepared', () => {
    expect(roleToSlot('admin')).toBe('prepared');
    expect(roleToSlot('officer')).toBe('prepared');
  });
  it('maps deputy_director to checked', () => {
    expect(roleToSlot('deputy_director')).toBe('checked');
  });
  it('maps director to approved', () => {
    expect(roleToSlot('director')).toBe('approved');
  });
  it('maps transporter to transporter', () => {
    expect(roleToSlot('transporter')).toBe('transporter');
  });
});

describe('canSignSlot', () => {
  it('allows prepared when no prior signatures', () => {
    expect(canSignSlot('prepared', [])).toBe(true);
  });
  it('allows checked when prepared is signed', () => {
    expect(canSignSlot('checked', ['prepared'])).toBe(true);
  });
  it('blocks checked when prepared is not signed', () => {
    expect(canSignSlot('checked', [])).toBe(false);
  });
  it('allows approved when checked is signed', () => {
    expect(canSignSlot('approved', ['prepared', 'checked'])).toBe(true);
  });
  it('blocks approved when checked is not signed', () => {
    expect(canSignSlot('approved', ['prepared'])).toBe(false);
  });
  it('blocks approved when no prior signatures', () => {
    expect(canSignSlot('approved', [])).toBe(false);
  });
  it('always allows transporter', () => {
    expect(canSignSlot('transporter', [])).toBe(true);
  });
});

describe('isSlotSigned', () => {
  it('returns true when slot is in the list', () => {
    expect(isSlotSigned('prepared', ['prepared', 'checked'])).toBe(true);
  });
  it('returns false when slot is not in the list', () => {
    expect(isSlotSigned('prepared', ['checked'])).toBe(false);
  });
});

describe('isReviewerRole', () => {
  it('returns true for deputy_director and director', () => {
    expect(isReviewerRole('deputy_director')).toBe(true);
    expect(isReviewerRole('director')).toBe(true);
  });
  it('returns false for admin, officer, transporter', () => {
    expect(isReviewerRole('admin')).toBe(false);
    expect(isReviewerRole('officer')).toBe(false);
    expect(isReviewerRole('transporter')).toBe(false);
  });
});

describe('isStaffRole', () => {
  it('returns true for all staff roles', () => {
    expect(isStaffRole('admin')).toBe(true);
    expect(isStaffRole('officer')).toBe(true);
    expect(isStaffRole('deputy_director')).toBe(true);
    expect(isStaffRole('director')).toBe(true);
  });
  it('returns false for transporter', () => {
    expect(isStaffRole('transporter')).toBe(false);
  });
});
