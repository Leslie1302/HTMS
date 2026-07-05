import { describe, expect, it } from 'vitest';
import { ALL_STAGES, STAGE_MAP, STAGE_LABELS } from '../lifecycle';
import { CHECKLIST_ITEMS } from '../validation';

/**
 * The transition map is linear forward-only:
 *
 *   generated → submitted → with_chief_director → minuted_to_pd →
 *   pd_processing → pd_processed → cd_directive_audit →
 *   audit_validation → returned_to_cd → at_accounts → paid
 */
const EXPECTED_CHAIN: Record<string, string | null> = {
  generated: 'submitted',
  submitted: 'with_chief_director',
  with_chief_director: 'minuted_to_pd',
  minuted_to_pd: 'pd_processing',
  pd_processing: 'pd_processed',
  pd_processed: 'cd_directive_audit',
  cd_directive_audit: 'audit_validation',
  audit_validation: 'returned_to_cd',
  returned_to_cd: 'at_accounts',
  at_accounts: 'paid',
  paid: null,
};

describe('STAGE_MAP — allowed transitions', () => {
  it('every stage has an expected next stage (except paid)', () => {
    for (const stage of ALL_STAGES) {
      expect(STAGE_MAP[stage]).toBe(EXPECTED_CHAIN[stage] ?? null);
    }
  });

  it('forward transition for every non-terminal stage succeeds', () => {
    for (const [current, expectedNext] of Object.entries(EXPECTED_CHAIN)) {
      if (expectedNext === null) continue; // skip paid
      expect(STAGE_MAP[current as keyof typeof STAGE_MAP]).toBe(expectedNext);
    }
  });

  it('paid is terminal (no next stage)', () => {
    expect(STAGE_MAP.paid).toBeNull();
  });
});

describe('STAGE_MAP — stage-skips fail', () => {
  it('skipping a stage is not allowed', () => {
    // Try every non-adjacent pair.
    for (let i = 0; i < ALL_STAGES.length; i++) {
      for (let j = i + 2; j < ALL_STAGES.length; j++) {
        const current = ALL_STAGES[i];
        const skip = ALL_STAGES[j];
        // The map only allows i → i+1, never i → i+2.
        expect(STAGE_MAP[current]).not.toBe(skip);
      }
    }
  });

  it('a stage cannot go backwards', () => {
    for (let i = 1; i < ALL_STAGES.length; i++) {
      for (let j = 0; j < i; j++) {
        const current = ALL_STAGES[i];
        const prev = ALL_STAGES[j];
        expect(STAGE_MAP[current]).not.toBe(prev);
      }
    }
  });
});

describe('CHECKLIST_ITEMS', () => {
  it('has exactly 4 required items', () => {
    expect(CHECKLIST_ITEMS).toHaveLength(4);
    expect(CHECKLIST_ITEMS).toContain('original_waybills');
    expect(CHECKLIST_ITEMS).toContain('original_acknowledgement_forms');
    expect(CHECKLIST_ITEMS).toContain('release_letters');
    expect(CHECKLIST_ITEMS).toContain('contract_agreement_copy');
  });
});

describe('Stage labels', () => {
  it('every stage has a display label', () => {
    for (const stage of ALL_STAGES) {
      expect(STAGE_LABELS[stage]).toBeDefined();
      expect(STAGE_LABELS[stage].length).toBeGreaterThan(0);
    }
  });
});
