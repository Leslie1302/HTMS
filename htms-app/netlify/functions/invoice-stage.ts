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
      .select('id, stage, checklist, transporter_id, reference_no, total_cost, status, review_status, review_note')
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

    // ── Checklist review verdict (staff only) ──
    if (body.review) {
      if (ctx.role === 'transporter') return json(403, { error: 'Only staff may review the checklist' });
      const patch =
        body.review === 'approved'
          ? { review_status: 'approved', review_note: null }
          : { review_status: 'disapproved', review_note: body.note!.trim() };
      const { error: revErr } = await ctx.db.from('invoices').update(patch).eq('id', invoiceId);
      if (revErr) return json(400, { error: revErr.message });
      await audit(ctx.userId, `review_${body.review}`, 'invoice', invoiceId, null, patch);
      return json(200, { invoiceId, ...patch });
    }

    if (!ALL_STAGES.includes(targetStage as PriStage)) {
      return json(400, { error: `Invalid stage: ${targetStage}` });
    }

    const { data: invoice, error } = await ctx.db
      .from('invoices')
      .select('id, stage, checklist, transporter_id, review_status, review_note')
      .eq('id', invoiceId)
      .single();
    if (error || !invoice) return json(404, { error: 'Invoice not found' });

    // A disapproved checklist freezes the workflow; it resumes at the same
    // stage once an officer re-approves.
    if (invoice.review_status === 'disapproved') {
      return json(400, {
        error: `Checklist disapproved: ${invoice.review_note ?? 'see officer'}. Resolve and obtain approval to continue.`,
      });
    }

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

      // Submission requires the officer's approval verdict on the checklist.
      if (invoice.review_status !== 'approved') {
        return json(400, { error: 'Cannot submit: checklist must be approved by an officer first' });
      }

      // Flagged (substandard) documents block submission until corrected.
      const { data: lineRows } = await ctx.db
        .from('invoice_lines')
        .select('waybill_id')
        .eq('invoice_id', invoiceId);
      const wbIds = (lineRows ?? []).map((r: { waybill_id: string }) => r.waybill_id);
      if (wbIds.length > 0) {
        const { data: flagged } = await ctx.db
          .from('scans')
          .select('id, flagged_reason')
          .in('waybill_id', wbIds)
          .not('flagged_reason', 'is', null);
        if (flagged && flagged.length > 0) {
          return json(400, {
            error: `Cannot submit: ${flagged.length} flagged document(s) must be corrected first`,
            flagged,
          });
        }
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
