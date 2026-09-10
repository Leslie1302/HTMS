/**
 * /api/invoice-edit — let a transporter (or staff on their behalf) correct the
 * waybills inside a raised invoice while it is still at the 'generated' stage.
 *
 * Everything the client CANNOT safely do directly is enforced here:
 *   - ownership + stage gate (generated only, not locked)
 *   - the invoice total is ALWAYS recomputed server-side from DB rates — the
 *     client never supplies an amount (mirrors POST /api/invoices)
 *   - scan adds are validated against the invoice's transporter tenancy,
 *     removes only within the invoice's own waybills, storage is cleaned up
 *   - an edited/scan-changed invoice drops back to 'pending' checklist review
 *     so a stale officer approval can't be carried forward after the docs
 *     (or the figures) changed
 *
 * All writes go through the SERVICE ROLE on purpose: transporter RLS is draft-
 * only, and even if we relaxed it the direct client write would skip these
 * recomputations. No RLS migration is needed.
 */
import type { Config } from '@netlify/functions';
import { audit, guard, json, parseBody, serviceDb } from './_lib';
import { invoiceEditSchema, type InvoiceEditLine } from '../../shared/validation';
import { computeHaulageCost, CalcError, chartToDistance, type WaybillInput } from '../../shared/calc';
import { loadCalcConfig } from './_calcConfig';
import type { Category } from '../../shared/rates';

/** Map the camelCase edit fields onto the waybills table columns. */
const FIELD_COLS: Record<string, string> = {
  waybillNo: 'waybill_no',
  vehicleNo: 'vehicle_no',
  category: 'category',
  originId: 'origin_id',
  districtId: 'district_id',
  numPoles: 'num_poles',
  numStayBlocks: 'num_stay_blocks',
  numConcretePoles: 'num_concrete_poles',
  truckSize: 'truck_size',
  numTrips: 'num_trips',
  waybillDate: 'waybill_date',
};

/** Final-state rules — mirrors the superRefine on waybillCreateSchema. */
function assertValid(w: Record<string, unknown>): string | null {
  if (w.category === 'Material' && !w.truck_size) return 'Material requires a truck size';
  if (w.category === 'Poles' && Number(w.num_poles) < 1) return 'Poles requires num_poles >= 1';
  if (w.category === 'Concrete Poles' && Number(w.num_concrete_poles) < 1 && Number(w.num_poles) < 1) {
    return 'Concrete Poles requires a pole count';
  }
  return null;
}

/** Recompute one waybill's line cost exactly like POST /api/invoices. */
async function recomputeLine(
  db: ReturnType<typeof serviceDb>,
  cfg: Awaited<ReturnType<typeof loadCalcConfig>>,
  waybillId: string,
  merged: Record<string, unknown>,
): Promise<{ distance_km: number; category: Category; rate_snapshot: unknown; computed_cost: number }> {
  const { data: dests } = await db
    .from('waybill_destinations')
    .select('district_id')
    .eq('waybill_id', waybillId);
  const districtIds = dests && dests.length ? dests.map((d: { district_id: number }) => d.district_id) : [merged.district_id as number];

  const { data: distRows } = await db
    .from('distance_matrix')
    .select('km, district_id')
    .eq('origin_id', merged.origin_id)
    .in('district_id', districtIds);
  const foundIds = new Set((distRows ?? []).map((r: { district_id: number }) => r.district_id));
  const missingIds = districtIds.filter((d) => !foundIds.has(d));
  if (missingIds.length) {
    throw new CalcError(
      `no distance from this origin to district id(s) ${missingIds.join(', ')}. Add them to the distance matrix before invoicing.`,
      'MISSING_DISTANCE',
    );
  }
  const furthestChartKm = Math.max(...(distRows ?? []).map((r: { km: string }) => Number(r.km)));

  const input: WaybillInput = {
    category: merged.category as Category,
    distanceKm: chartToDistance(furthestChartKm),
    date: merged.waybill_date as string,
    numPoles: Number(merged.num_poles ?? 0),
    numStayBlocks: Number(merged.num_stay_blocks ?? 0),
    numConcretePoles: Number(merged.num_concrete_poles ?? 0),
    truckSize: (merged.truck_size ? Number(merged.truck_size) : 40) as 20 | 40,
    numTrips: Number(merged.num_trips ?? 1),
  };
  const res = computeHaulageCost(input, cfg);
  return {
    distance_km: input.distanceKm,
    category: input.category,
    rate_snapshot: { fuelPrice: res.fuelPrice, factor: res.factor, rates: res.rates },
    computed_cost: res.cost,
  };
}

export default guard({ roles: ['admin', 'officer', 'transporter'] }, async (req, ctx) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await parseBody(req, invoiceEditSchema);
  const db = serviceDb();

  // ── Ownership + stage gate (RLS-scoped read proves the caller can see it) ──
  const { data: invoice, error: invErr } = await ctx.db
    .from('invoices')
    .select('id, transporter_id, stage, status, review_status, review_note')
    .eq('id', body.invoiceId)
    .single();
  if (invErr || !invoice) return json(404, { error: 'Invoice not found' });
  if (ctx.role === 'transporter' && invoice.transporter_id !== ctx.transporterId) {
    return json(403, { error: 'You can only edit your own invoice' });
  }
  if (invoice.stage !== 'generated') {
    return json(400, { error: 'Invoices can only be edited while at the Generated stage' });
  }
  if (invoice.status === 'locked') return json(400, { error: 'Locked invoices cannot be edited' });

  // ── Every edited waybill must already be a line of this invoice ──
  const { data: lineRows } = await db
    .from('invoice_lines')
    .select('waybill_id, computed_cost')
    .eq('invoice_id', body.invoiceId);
  const lineByWb = new Map((lineRows ?? []).map((r: { waybill_id: string; computed_cost: string }) => [r.waybill_id, Number(r.computed_cost)]));
  if (lineByWb.size === 0) return json(400, { error: 'Invoice has no waybills' });
  for (const l of body.lines) {
    if (!lineByWb.has(l.waybillId)) {
      return json(400, { error: `Waybill ${l.waybillId} is not part of this invoice` });
    }
  }
  const invoiceWbIds = new Set(lineByWb.keys());

  const cfg = await loadCalcConfig(ctx.db);
  let contentChanged = false;
  const editedCount = body.lines.length;

  for (const edit of body.lines) {
    // ── Load + merge ──
    const { data: wb } = await db.from('waybills').select('*').eq('id', edit.waybillId).single();
    if (!wb) return json(404, { error: 'Waybill not found' });
    if (wb.transporter_id !== invoice.transporter_id) {
      return json(403, { error: 'Waybill belongs to another transporter' });
    }

    const merged: Record<string, unknown> = { ...wb };
    for (const [field, col] of Object.entries(FIELD_COLS)) {
      const v = edit[field as keyof InvoiceEditLine];
      if (v !== undefined) merged[col] = v === null ? null : v;
    }
    const invalid = assertValid(merged);
    if (invalid) return json(422, { error: `Waybill ${merged.waybill_no}: ${invalid}` });

    // ── Persist waybill fields ──
    const patch = Object.fromEntries(
      Object.entries(FIELD_COLS)
        .filter(([field]) => edit[field as keyof InvoiceEditLine] !== undefined)
        .map(([, col]) => [col, merged[col]]),
    );
    if (Object.keys(patch).length) {
      const { error: uErr } = await db.from('waybills').update(patch).eq('id', edit.waybillId);
      if (uErr) return json(400, { error: uErr.message });
    }

    // ── Destination rows (only when the client asked to change them) ──
    if (edit.districtId !== undefined || edit.destinationDistrictIds !== undefined) {
      const destIds = Array.from(new Set([edit.districtId ?? (merged.district_id as number), ...(edit.destinationDistrictIds ?? [])]));
      await db.from('waybill_destinations').delete().eq('waybill_id', edit.waybillId);
      if (destIds.length) {
        const { error: dErr } = await db
          .from('waybill_destinations')
          .insert(destIds.map((district_id) => ({ waybill_id: edit.waybillId, district_id })));
        if (dErr) return json(400, { error: `Destinations: ${dErr.message}` });
      }
    }

    // ── Recompute the line (server-side, mirrors invoice creation) ──
    let line: { distance_km: number; category: Category; rate_snapshot: unknown; computed_cost: number };
    try {
      line = await recomputeLine(db, cfg, edit.waybillId, merged);
    } catch (e) {
      if (e instanceof CalcError) {
        return json(422, { error: `Waybill ${merged.waybill_no}: ${e.message}`, code: e.code });
      }
      throw e;
    }
    if (line.computed_cost !== (lineByWb.get(edit.waybillId) ?? 0)) contentChanged = true;
    const { error: lErr } = await db
      .from('invoice_lines')
      .update(line)
      .eq('invoice_id', body.invoiceId)
      .eq('waybill_id', edit.waybillId);
    if (lErr) return json(400, { error: lErr.message });

    // ── Scan adds (uploads already landed client-side) ──
    for (const s of edit.addScans!) {
      if (!s.storagePath.startsWith(`${invoice.transporter_id}/${edit.waybillId}/`)) {
        return json(400, { error: 'Scan path must be within your own waybill folder' });
      }
      const { error: iErr } = await db.from('scans').insert({
        waybill_id: edit.waybillId,
        storage_path: s.storagePath,
        mime_type: s.mimeType,
        byte_size: s.byteSize,
        scan_type: s.scanType,
        uploaded_by: ctx.userId,
      });
      if (iErr) return json(400, { error: iErr.message });
      contentChanged = true;
    }

    // ── Scan removes (row delete + best-effort storage cleanup) ──
    for (const scanId of edit.removeScanIds!) {
      const { data: scan, error: gErr } = await db
        .from('scans')
        .select('id, storage_path')
        .eq('id', scanId)
        .eq('waybill_id', edit.waybillId)
        .maybeSingle();
      if (gErr) return json(400, { error: gErr.message });
      if (!scan) return json(400, { error: 'Scan to remove not found on this waybill' });
      if (!invoiceWbIds.has(edit.waybillId)) return json(400, { error: 'Scan belongs to a waybill outside this invoice' });
      const { error: dErr } = await db.from('scans').delete().eq('id', scanId);
      if (dErr) return json(400, { error: dErr.message });
      await db.storage.from('scans').remove([scan.storage_path]).catch(() => {});
      contentChanged = true;
    }
  }

  // ── Recompute the invoice total from ALL lines (in case previous edits drifted) ──
  const { data: allLines } = await db
    .from('invoice_lines')
    .select('computed_cost')
    .eq('invoice_id', body.invoiceId);
  const total = Math.round(((allLines ?? []).reduce((s: number, l: { computed_cost: string }) => s + Number(l.computed_cost), 0)) * 100) / 100;

  const patch: Record<string, unknown> = { total_cost: total };
  // Drop a stale officer verdict if the documents/figures it approved changed.
  if (contentChanged && invoice.review_status !== 'pending') {
    patch.review_status = 'pending';
    patch.review_note = null;
  }
  // A totals approval (Deputy Director) must not survive a figure change —
  // otherwise the audit trail shows an approval against a total that no
  // longer exists. Step it back to draft so it must be re-approved.
  if (contentChanged && invoice.status === 'approved') {
    patch.status = 'draft';
    patch.approved_by = null;
    patch.approved_at = null;
  }
  const { error: pErr } = await db.from('invoices').update(patch).eq('id', body.invoiceId);
  if (pErr) return json(400, { error: `Failed to update invoice total: ${pErr.message}` });

  await audit(ctx.userId, 'invoice_edited', 'invoice', body.invoiceId, null, { total, lines: editedCount }).catch(() => {});
  return json(200, { ok: true, total_cost: total, editedLines: editedCount });
});

export const config: Config = { path: '/api/invoice-edit' };