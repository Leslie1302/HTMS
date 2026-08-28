/**
 * Pure invoice-comment logic — audience groups + per-role audience options.
 * Imported by both the Netlify function (trust boundary) and the client.
 * Do NOT add I/O here.
 */
import type { UserRole } from './signing';

export type AudienceGroup = 'staff' | 'transporter' | 'dd';

export const AUDIENCE_GROUPS = ['staff', 'transporter', 'dd'] as const;

/** Combos the feature supports (sorted-join keys). 'dd+transporter' is not one. */
const VALID_COMBOS = new Set(['staff', 'transporter', 'dd', 'dd,staff', 'staff,transporter']);

export interface AudienceOption {
  groups: AudienceGroup[];
  label: string;
}

/** Audience choices shown in the comment form, per commenter role. */
export const AUDIENCE_OPTIONS: Record<UserRole, AudienceOption[]> = {
  admin: [
    { groups: ['staff'], label: 'Staff' },
    { groups: ['dd', 'staff'], label: 'DD & Director' },
  ],
  officer: [
    { groups: ['staff'], label: 'Staff' },
    { groups: ['dd', 'staff'], label: 'DD & Director' },
  ],
  deputy_director: [
    { groups: ['staff'], label: 'Staff' },
    { groups: ['transporter'], label: 'Transporter' },
    { groups: ['staff', 'transporter'], label: 'Staff & Transporter' },
  ],
  director: [
    { groups: ['dd'], label: 'Deputy Director' },
    { groups: ['dd', 'staff'], label: 'DD & Staff' },
    { groups: ['staff', 'transporter'], label: 'Staff & Transporter' },
  ],
  transporter: [{ groups: ['staff', 'transporter'], label: 'HTMS Staff' }],
};

const keyOf = (groups: string[]) => [...groups].sort().join(',');

/** Shape check: known groups, no dupes, 1–2 entries, a supported combo. */
export function isValidAudience(groups: string[]): groups is AudienceGroup[] {
  return (
    groups.length >= 1 &&
    groups.length <= 2 &&
    new Set(groups).size === groups.length &&
    groups.every((g) => (AUDIENCE_GROUPS as readonly string[]).includes(g)) &&
    VALID_COMBOS.has(keyOf(groups))
  );
}

/** Server-side check: may this role address this audience? */
export function audienceAllowedForRole(role: UserRole, groups: AudienceGroup[]): boolean {
  const key = keyOf(groups);
  return (AUDIENCE_OPTIONS[role] ?? []).some((o) => keyOf(o.groups) === key);
}

/** Display label for an audience (falls back to the raw groups). */
export function audienceLabel(groups: string[]): string {
  const key = keyOf(groups);
  for (const opts of Object.values(AUDIENCE_OPTIONS)) {
    const hit = opts.find((o) => keyOf(o.groups) === key);
    if (hit) return hit.label;
  }
  return groups.join(' + ');
}
