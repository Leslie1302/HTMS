import { describe, it, expect } from 'vitest';
import { isValidAudience, audienceAllowedForRole, audienceLabel, AUDIENCE_OPTIONS } from '../comments';
import type { UserRole } from '../signing';

describe('isValidAudience', () => {
  it('accepts the supported combos in any order', () => {
    for (const a of [['staff'], ['transporter'], ['dd'], ['dd', 'staff'], ['staff', 'dd'], ['staff', 'transporter'], ['transporter', 'staff']]) {
      expect(isValidAudience(a), a.join()).toBe(true);
    }
  });

  it('rejects bad combos, dupes, empties, unknown groups', () => {
    for (const a of [[], ['dd', 'transporter'], ['staff', 'staff'], ['staff', 'dd', 'transporter'], ['everyone'], ['staff', 'everyone']]) {
      expect(isValidAudience(a), a.join()).toBe(false);
    }
  });
});

describe('audienceAllowedForRole', () => {
  it('matches the per-role option lists exactly', () => {
    const cases: [UserRole, string[], boolean][] = [
      ['deputy_director', ['staff'], true],
      ['deputy_director', ['transporter'], true],
      ['deputy_director', ['staff', 'transporter'], true],
      ['deputy_director', ['dd'], false],
      ['director', ['dd'], true],
      ['director', ['dd', 'staff'], true],
      ['director', ['staff', 'transporter'], true],
      ['director', ['transporter'], false],
      ['officer', ['staff'], true],
      ['officer', ['dd', 'staff'], true],
      ['officer', ['transporter'], false],
      ['transporter', ['staff', 'transporter'], true],
      ['transporter', ['staff'], false],
    ];
    for (const [role, groups, ok] of cases) {
      expect(audienceAllowedForRole(role, groups as never), `${role} → ${groups}`).toBe(ok);
    }
  });

  it('every advertised option passes its own check', () => {
    for (const [role, opts] of Object.entries(AUDIENCE_OPTIONS)) {
      for (const o of opts) {
        expect(audienceAllowedForRole(role as UserRole, o.groups)).toBe(true);
      }
    }
  });
});

describe('audienceLabel', () => {
  it('labels known combos and falls back for unknown ones', () => {
    expect(audienceLabel(['staff', 'transporter'])).toBe('Staff & Transporter');
    expect(audienceLabel(['dd'])).toBe('Deputy Director');
    expect(audienceLabel(['dd', 'transporter'])).toBe('dd + transporter');
  });
});
