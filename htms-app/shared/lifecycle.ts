/**
 * PR/I lifecycle stage definitions — shared between client and server.
 * The transition map and function logic live in netlify/functions/invoice-stage.ts.
 */

export type PriStage =
  | 'generated'
  | 'submitted'
  | 'with_chief_director'
  | 'minuted_to_pd'
  | 'pd_processing'
  | 'pd_processed'
  | 'cd_directive_audit'
  | 'audit_validation'
  | 'returned_to_cd'
  | 'at_accounts'
  | 'paid';

export const ALL_STAGES: PriStage[] = [
  'generated',
  'submitted',
  'with_chief_director',
  'minuted_to_pd',
  'pd_processing',
  'pd_processed',
  'cd_directive_audit',
  'audit_validation',
  'returned_to_cd',
  'at_accounts',
  'paid',
];

export const STAGE_MAP: Record<PriStage, PriStage | null> = {
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

export const STAGE_LABELS: Record<PriStage, string> = {
  generated: 'Generated',
  submitted: 'Submitted',
  with_chief_director: 'With Chief Director',
  minuted_to_pd: 'Minuted to Power Directorate',
  pd_processing: 'PD Processing',
  pd_processed: 'PD Processed',
  cd_directive_audit: 'CD Directs Audit',
  audit_validation: 'Audit Validation',
  returned_to_cd: 'Returned to CD',
  at_accounts: 'At Accounts',
  paid: 'Paid',
};
