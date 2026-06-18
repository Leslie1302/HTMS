/**
 * /api/waybills — create & list waybills.
 * RLS does the heavy lifting (a transporter can only ever see/insert their own);
 * this layer adds validation, role gating, distance resolution, and audit.
 */
import type { Config } from '@netlify/functions';
import { audit, guard, json, parseBody } from './_lib';
import { waybillCreateSchema } from '../../shared/validation';
import { computeHaulageCost, chartToDistance } from '../../shared/calc';
import { loadCalcConfig } from './_calcConfig';

export default guard({ roles: ['admin', 'officer', 'transporter'] }, async (req, ctx) => {
  if (req.method === 'GET') {
    // RLS scopes the result set automatically.
    const { data, error } = await ctx.db
      .from('waybills')
      .select('*, transporters(display_name), districts(name), origins(name)')
      .order('waybill_date', { ascending: false })
      .limit(500);
    if (error) return json(400, { error: error.message });
    const list = data ?? [];

    // Compute each waybill's haulage cost on the fly (matches the spreadsheet's
    // per-row cost). Consolidated trips use the furthest destination.
    const ids = list.map((w) => w.id);
    const { data: destRows } = await ctx.db
      .from('waybill_destinations')
      .select('waybill_id, district_id')
      .in('waybill_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    const destsByWaybill = new Map<string, number[]>();
    for (const d of destRows ?? []) {
      destsByWaybill.set(d.waybill_id, [...(destsByWaybill.get(d.waybill_id) ?? []), d.district_id]);
    }

    const neededDistricts = new Set<number>();
    for (const w of list) (destsByWaybill.get(w.id) ?? [w.district_id]).forEach((id) => neededDistricts.add(id));
    const { data: distRows } = await ctx.db
      .from('distance_matrix')
      .select('origin_id, district_id, km')
      .in('district_id', neededDistricts.size ? [...neededDistricts] : [-1]);
    const distMap = new Map<string, number>();
    for (const r of distRows ?? []) distMap.set(`${r.origin_id}:${r.district_id}`, Number(r.km));

    const cfg = await loadCalcConfig(ctx.db);
    const waybills = list.map((w) => {
      try {
        const ds = destsByWaybill.get(w.id) ?? [w.district_id];
        const kms = ds.map((id) => distMap.get(`${w.origin_id}:${id}`)).filter((v): v is number => v != null);
        if (!kms.length) return { ...w, cost: null, distance_km: null };
        const distanceKm = chartToDistance(Math.max(...kms));
        const res = computeHaulageCost(
          {
            category: w.category,
            distanceKm,
            date: w.waybill_date,
            numPoles: w.num_poles,
            numStayBlocks: w.num_stay_blocks,
            numConcretePoles: w.num_concrete_poles,
            truckSize: (w.truck_size ? Number(w.truck_size) : 40) as 20 | 40,
            numTrips: w.num_trips,
          },
          cfg,
        );
        return { ...w, cost: res.cost, distance_km: distanceKm };
      } catch {
        return { ...w, cost: null, distance_km: null };
      }
    });
    return json(200, { waybills });
  }

  if (req.method === 'POST') {
    const body = await parseBody(req, waybillCreateSchema);

    // A transporter may only file under their own transporter_id.
    if (ctx.role === 'transporter' && body.transporterId !== ctx.transporterId) {
      return json(403, { error: 'Cannot create a waybill for another transporter' });
    }

    const { data, error } = await ctx.db
      .from('waybills')
      .insert({
        transporter_id: body.transporterId,
        category: body.category,
        waybill_no: body.waybillNo,
        vehicle_no: body.vehicleNo ?? null,
        origin_id: body.originId,
        district_id: body.districtId,
        num_poles: body.numPoles,
        num_stay_blocks: body.numStayBlocks,
        num_concrete_poles: body.numConcretePoles,
        truck_size: body.truckSize ? String(body.truckSize) : null,
        num_trips: body.numTrips,
        waybill_date: body.waybillDate,
        processed_date: body.processedDate ?? null,
        created_by: ctx.userId,
        status: 'draft',
      })
      .select()
      .single();
    if (error) return json(400, { error: error.message });

    // Record all consolidated destinations (primary + extras), deduped.
    const destIds = Array.from(new Set([body.districtId, ...(body.destinationDistrictIds ?? [])]));
    if (destIds.length) {
      const { error: destErr } = await ctx.db
        .from('waybill_destinations')
        .insert(destIds.map((district_id) => ({ waybill_id: data.id, district_id })));
      if (destErr) return json(400, { error: `Destinations: ${destErr.message}` });
    }

    await audit(ctx.userId, 'create', 'waybill', data.id, null, data);
    return json(201, { waybill: data });
  }

  return json(405, { error: 'Method not allowed' });
});

export const config: Config = { path: '/api/waybills' };
