/**
 * /api/invoice-sign — apply an MFA-gated electronic signature to an invoice.
 *
 * POST { invoice_id } → derives slot from caller's role, verifies AAL2,
 * checks preconditions, inserts invoice_signatures row + audit entry.
 */
import type { Config } from '@netlify/functions';
import { z } from 'zod';
import { audit, guard, json, parseBody, serviceDb } from './_lib';
import { roleToSlot, canSignSlot, isSlotSigned, type SignSlot } from '../../shared/signing';

const schema = z.object({ invoice_id: z.string().uuid() });

/** Decode the JWT payload (no verification — the token was already verified by guard). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const base64 = token.split('.')[1];
  const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json);
}

export default guard({ roles: ['admin', 'officer', 'transporter', 'deputy_director', 'director'] }, async (req, ctx) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await parseBody(req, schema);

  // ── MFA gate: verify AAL2 ────────────────────────────────────────────────
  const authz = req.headers.get('authorization') ?? '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  const payload = decodeJwtPayload(token);
  const aal = payload.aal as string | undefined;
  // ponytail: Supabase puts `aal` in the JWT when MFA is enrolled; aal2 = TOTP verified this session
  if (aal && aal !== 'aal2') {
    return json(403, { error: 'mfa_required', message: 'Multi-factor authentication is required to sign. Please step up to MFA first.' });
  }
  // If no aal claim at all, the user has no MFA enrolled — still block.
  if (!aal) {
    return json(403, { error: 'mfa_required', message: 'Multi-factor authentication must be enrolled and verified to sign documents.' });
  }

  // ── Derive slot from role ─────────────────────────────────────────────────
  const slot = roleToSlot(ctx.role);
  if (!slot) return json(400, { error: 'Your role does not have a signing slot' });

  // ── Fetch invoice ─────────────────────────────────────────────────────────
  const svc = serviceDb();
  const { data: invoice, error: invErr } = await svc
    .from('invoices')
    .select('id, stage, transporter_id, checklist, review_status')
    .eq('id', body.invoice_id)
    .single();
  if (invErr || !invoice) return json(404, { error: 'Invoice not found' });

  // ── Transporter slot: own invoice + submission-ready ───────────────────────
  if (slot === 'transporter') {
    if (invoice.transporter_id !== ctx.transporterId) {
      return json(403, { error: 'You can only sign your own invoice' });
    }
    // Must be at generated stage (submission-ready gate).
    if (invoice.stage !== 'generated') {
      return json(422, { error: 'Invoice must be at the Generated stage to apply the transporter signature' });
    }
    // Checklist + review must be complete.
    const checklist = (invoice.checklist ?? {}) as Record<string, boolean>;
    const missing = ['original_waybills', 'original_acknowledgement_forms', 'release_letters', 'contract_agreement_copy'].filter((k) => !checklist[k]);
    if (missing.length > 0) {
      return json(422, { error: `Cannot sign: checklist items incomplete: ${missing.join(', ')}` });
    }
    if (invoice.review_status !== 'approved') {
      return json(422, { error: 'Cannot sign: checklist must be approved by an officer first' });
    }
  }

  // ── Check existing signatures + ordering ──────────────────────────────────
  const { data: existing } = await svc
    .from('invoice_signatures')
    .select('slot')
    .eq('invoice_id', body.invoice_id);
  const signedSlots = (existing ?? []).map((r: { slot: string }) => r.slot as SignSlot);

  if (isSlotSigned(slot, signedSlots)) {
    return json(422, { error: `Slot '${slot}' is already signed` });
  }

  if (!canSignSlot(slot, signedSlots)) {
    const prev = slot === 'checked' ? 'prepared' : slot === 'approved' ? 'checked' : '';
    return json(422, { error: `Cannot sign '${slot}' yet: '${prev}' signature is required first` });
  }

  // ── Verify caller has a signature on file ─────────────────────────────────
  const { data: userProfile } = await svc
    .from('app_users')
    .select('signature_path, full_name')
    .eq('id', ctx.userId)
    .single();
  if (!userProfile?.signature_path) {
    return json(422, { error: 'No signature on file. Please upload your signature in Settings first.' });
  }

  // ── Insert signature row (service role bypasses RLS) ─────────────────────
  const { error: insErr } = await svc.from('invoice_signatures').insert({
    invoice_id: body.invoice_id,
    slot,
    user_id: ctx.userId,
  });
  if (insErr) return json(400, { error: insErr.message });

  await audit(ctx.userId, 'invoice.signed', 'invoice', body.invoice_id, null, { slot });

  return json(200, { ok: true, slot, signed_at: new Date().toISOString() });
});

export const config: Config = { path: '/api/invoice-sign' };
