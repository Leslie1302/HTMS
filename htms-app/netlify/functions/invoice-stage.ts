/**
 * /api/invoice-stage — advance (or read) an invoice's PR/I lifecycle stage.
 *
 * GET  /api/invoice-stage?id=<invoiceId>  → current stage + transition audit trail
 * POST /api/invoice-stage                  → advance stage (body: { invoiceId, stage })
 *
 * Transition rules are hardcoded in STAGE_MAP (forward-only linear DAG).
 * See shared/__tests__/invoice-stage.test.ts for the full transition matrix.
 */
import type { Config } from '@netlify/functions';
import { audit, guard, json, parseBody } from './_lib';
import { CHECKLIST_ITEMS, stageTransitionSchema } from '../../shared/validation';
import { ALL_STAGES, STAGE_MAP, STAGE_LABELS, type PriStage } from '../../shared/lifecycle';
export { ALL_STAGES, STAGE_MAP, STAGE_LABELS };
export type { PriStage };

export default guard({ roles: ['admin', 'officer', 'transporter'] }, async (req, ctx) => {
  // ── Read current stage + audit trail ──
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return json(400, { error: 'id query param required' });

    const { data: invoice, error } = await ctx.db
      .from('invoices')
      .select('id, stage, checklist, transporter_id, reference_no, total_cost, status')
      .eq('id', id)
      .single();
    if (error || !invoice) return json(404, { error: 'Invoice not found' });

    const { data: trail } = await ctx.db
      .from('audit_log')
      .select('id, actor_id, action, created_at, after')
      .eq('entity', 'invoice')
      .eq('entity_id', id)
      .in('action', ALL_STAGES)
      .order('created_at', { ascending: true });
    return json(200, { invoice, trail: trail ?? [] });
  }

  // ── Advance stage ──
  if (req.method === 'POST') {
    const body = await parseBody(req, stageTransitionSchema);
    const { invoiceId, stage: targetStage } = body;

    if (!ALL_STAGES.includes(targetStage as PriStage)) {
      return json(400, { error: `Invalid stage: ${targetStage}` });
    }

    const { data: invoice, error } = await ctx.db
      .from('invoices')
      .select('id, stage, checklist, transporter_id')
      .eq('id', invoiceId)
      .single();
    if (error || !invoice) return json(404, { error: 'Invoice not found' });

    const currentStage = invoice.stage as PriStage;

    // Verify the transition is allowed by the map.
    const expected = STAGE_MAP[currentStage];
    if (expected !== targetStage) {
      return json(400, {
        error: `Cannot transition from ${currentStage} to ${targetStage}. Allowed: ${expected ?? 'none (terminal)'}`,
      });
    }

    // Role enforcement.
    if (ctx.role === 'transporter') {
      // Transporters can only do generated → submitted on their own invoice.
      if (currentStage !== 'generated' || targetStage !== 'submitted') {
        return json(403, { error: 'Transporters may only submit their own generated invoices' });
      }
      if (invoice.transporter_id !== ctx.transporterId) {
        return json(403, { error: 'You can only submit your own invoice' });
      }
    }

    // Checklist must be complete for generated → submitted — for EVERY role.
    // An officer submitting on a transporter's behalf must not bypass it.
    if (targetStage === 'submitted') {
      const checklist = (invoice.checklist ?? {}) as Record<string, boolean>;
      const missing = CHECKLIST_ITEMS.filter((k) => !checklist[k]);
      if (missing.length > 0) {
        return json(400, {
          error: `Cannot submit: checklist items incomplete: ${missing.join(', ')}`,
          missing,
        });
      }
    }

    // Perform the transition.
    const before = { stage: currentStage };
    const after = { stage: targetStage };
    const { error: updateErr } = await ctx.db
      .from('invoices')
      .update({ stage: targetStage })
      .eq('id', invoiceId);
    if (updateErr) return json(400, { error: updateErr.message });

    await audit(ctx.userId, targetStage, 'invoice', invoiceId, before, after);
    return json(200, { invoiceId, stage: targetStage, previous: currentStage });
  }

  return json(405, { error: 'Method not allowed' });
});

export const config: Config = { path: '/api/invoice-stage' };
