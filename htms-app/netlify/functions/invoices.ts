/**
 * /api/invoices — assemble an invoice from waybills (server-side calc), list,
 * and approve/lock. The cost is ALWAYS computed on the server from DB rates;
 * the client never supplies an amount. Each line stores an immutable snapshot.
 */
import type { Config } from '@netlify/functions';
import { audit, guard, json, parseBody, serviceDb } from './_lib';
import { invoiceCreateSchema } from '../../shared/validation';
import { computeHaulageCost, CalcError, chartToDistance, type WaybillInput } from '../../shared/calc';
import { loadCalcConfig } from './_calcConfig';
import type { Category } from '../../shared/rates';

export default guard({ roles: ['admin', 'officer', 'transporter', 'deputy_director', 'director'] }, async (req, ctx) => {
  // Reviewers are read-only: list yes, assemble/approve no.
  if (req.method !== 'GET' && (ctx.role === 'deputy_director' || ctx.role === 'director')) {
    return json(403, { error: 'Forbidden for your role' });
  }
  // ── List (RLS-scoped) ──
  if (req.method === 'GET') {
    const { data, error } = await ctx.db
      .from('invoices')
      .select('*, transporters(display_name), invoice_lines(*)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return json(400, { error: error.message });
    return json(200, { invoices: data });
  }

  // ── Create / assemble (staff only) ──
  if (req.method === 'POST') {
    const body = await parseBody(req, invoiceCreateSchema);
    // Transporters may only assemble their own invoices; staff assemble for anyone.
    const transporterId = ctx.role === 'transporter' ? ctx.transporterId : body.transporterId;
    if (!transporterId) return json(403, { error: 'No transporter to assemble for' });
    const cfg = await loadCalcConfig(ctx.db);

    // Fetch the waybills (RLS-scoped read — proves the caller owns them).
    const { data: wbs, error: wbErr } = await ctx.db
      .from('waybills')
      .select('*')
      .in('id', body.waybillIds)
      .eq('transporter_id', transporterId);
    if (wbErr) return json(400, { error: wbErr.message });
    if (!wbs || wbs.length !== body.waybillIds.length) {
      return json(400, { error: 'Some waybills not found or belong to another transporter' });
    }

    // Compute each line. A bad lookup throws — we surface it, never blank it.
    const lines: {
      waybill_id: string;
      distance_km: number;
      category: Category;
      rate_snapshot: unknown;
      computed_cost: number;
    }[] = [];
    let total = 0;
    for (const w of wbs) {
      // Consolidated trips: gather every destination (multi-drop). Fall back to
      // the single district_id if no extra destinations were recorded.
      const { data: dests } = await ctx.db
        .from('waybill_destinations')
        .select('district_id')
        .eq('waybill_id', w.id);
      const districtIds =
        dests && dests.length ? dests.map((d) => d.district_id) : [w.district_id];

      // Look up the surveyed distance to each drop, for this origin.
      const { data: distRows } = await ctx.db
        .from('distance_matrix')
        .select('km, district_id')
        .eq('origin_id', w.origin_id)
        .in('district_id', districtIds);
      // EVERY drop must have a surveyed distance. Silently skipping one would
      // bill a nearer destination (usually the first picked) and undercharge.
      const foundIds = new Set((distRows ?? []).map((r) => r.district_id));
      const missingIds = districtIds.filter((d) => !foundIds.has(d));
      if (missingIds.length) {
        return json(422, {
          error: `Waybill ${w.waybill_no}: no distance from this origin to district id(s) ${missingIds.join(', ')}. Add them to the distance matrix (Admin) before invoicing.`,
        });
      }
      // Same trip/car/day → bill using the FURTHEST destination.
      const furthestChartKm = Math.max(...(distRows ?? []).map((r) => Number(r.km)));

      const input: WaybillInput = {
        category: w.category,
        distanceKm: chartToDistance(furthestChartKm),
        date: w.waybill_date,
        numPoles: w.num_poles,
        numStayBlocks: w.num_stay_blocks,
        numConcretePoles: w.num_concrete_poles,
        truckSize: (w.truck_size ? Number(w.truck_size) : 40) as 20 | 40,
        numTrips: w.num_trips,
      };
      try {
        const res = computeHaulageCost(input, cfg);
        total += res.cost;
        lines.push({
          waybill_id: w.id,
          distance_km: input.distanceKm,
          category: w.category,
          rate_snapshot: { fuelPrice: res.fuelPrice, factor: res.factor, rates: res.rates },
          computed_cost: res.cost,
        });
      } catch (e) {
        if (e instanceof CalcError) {
          return json(422, { error: `Waybill ${w.waybill_no}: ${e.message}`, code: e.code });
        }
        throw e;
      }
    }

    const activeVersion = lines.length
      ? (await ctx.db.from('rate_versions').select('id').eq('is_active', true).single()).data?.id
      : null;

    // Writes go through the service role: ownership was validated above, and
    // this lets transporters raise their own invoices (RLS only lets staff write).
    const wdb = serviceDb();
    const { data: invoice, error: invErr } = await wdb
      .from('invoices')
      .insert({
        transporter_id: transporterId,
        rate_version_id: activeVersion,
        status: 'draft',
        total_cost: Math.round(total * 100) / 100,
        period_start: body.periodStart ?? null,
        period_end: body.periodEnd ?? null,
        reference_no: body.referenceNo ?? null,
        created_by: ctx.userId,
      })
      .select()
      .single();
    if (invErr) return json(400, { error: invErr.message });

    const { error: lineErr } = await wdb
      .from('invoice_lines')
      .insert(lines.map((l) => ({ ...l, invoice_id: invoice.id })));
    if (lineErr) return json(400, { error: lineErr.message });

    // Mark waybills invoiced.
    await wdb.from('waybills').update({ status: 'invoiced' }).in('id', body.waybillIds);
    await audit(ctx.userId, 'create', 'invoice', invoice.id, null, { total, lines: lines.length });
    return json(201, { invoice, lineCount: lines.length });
  }

  // ── Approve / lock (admin only) via PATCH ?id=&action= ──
  if (req.method === 'PATCH') {
    if (ctx.role !== 'admin') return json(403, { error: 'Only admin can approve/lock invoices' });
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const action = url.searchParams.get('action');
    if (!id || !['approve', 'lock', 'void'].includes(action ?? '')) {
      return json(400, { error: 'id and action (approve|lock|void) required' });
    }
    const status = action === 'approve' ? 'approved' : action === 'lock' ? 'locked' : 'void';
    const patch: Record<string, unknown> = { status };
    if (action === 'approve') {
      patch.approved_by = ctx.userId;
      patch.approved_at = new Date().toISOString();
    }
    const { data, error } = await ctx.db.from('invoices').update(patch).eq('id', id).select().single();
    if (error) return json(400, { error: error.message });
    await audit(ctx.userId, action!, 'invoice', id, null, data);
    return json(200, { invoice: data });
  }

  return json(405, { error: 'Method not allowed' });
});

export const config: Config = { path: '/api/invoices' };
