import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { CATEGORIES, type Category } from '../../shared/rates';
import { chartToDistance, computeHaulageCost, type CalcConfig, type CalcResult } from '../../shared/calc';
import { loadCalcConfig } from '../../shared/calcConfig';

const ghs = (n: number) =>
  '₵' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Opt { id: number; name: string }

/**
 * Trip Calculator — estimate what a trip pays BEFORE hauling, using the exact
 * same calc engine, rates and fuel series as invoicing. For multi-drop trips,
 * pick the FURTHEST destination (that is the billed distance).
 */
export default function Calculator() {
  const [cfg, setCfg] = useState<CalcConfig | null>(null);
  const [origins, setOrigins] = useState<Opt[]>([]);
  const [districts, setDistricts] = useState<Opt[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ res: CalcResult; chartKm: number; distanceKm: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    category: 'Poles' as Category,
    originId: '',
    districtId: '',
    numPoles: 0,
    numStayBlocks: 0,
    numConcretePoles: 0,
    truckSize: 40,
    numTrips: 1,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setResult(null);
  };

  useEffect(() => {
    loadCalcConfig(supabase).then(setCfg).catch((e) => setErr((e as Error).message));
    supabase.from('origins').select('id, name').order('name').then(({ data }) => setOrigins((data ?? []) as Opt[]));
    supabase.from('districts').select('id, name').order('name').then(({ data }) => setDistricts((data ?? []) as Opt[]));
  }, []);

  async function calculate() {
    setErr(null);
    setResult(null);
    if (!cfg) return setErr('Rates are still loading — try again in a moment.');
    if (!form.originId || !form.districtId) return setErr('Choose an origin and a destination.');
    setBusy(true);
    try {
      const { data: dist } = await supabase
        .from('distance_matrix')
        .select('km')
        .eq('origin_id', Number(form.originId))
        .eq('district_id', Number(form.districtId))
        .maybeSingle();
      if (!dist) throw new Error('No surveyed distance for this origin/destination — it cannot be billed yet.');
      const chartKm = Number(dist.km);
      const distanceKm = chartToDistance(chartKm);
      const res = computeHaulageCost(
        {
          category: form.category,
          distanceKm,
          date: new Date().toISOString().slice(0, 10),
          numPoles: form.category === 'Poles' ? Number(form.numPoles) : 0,
          numStayBlocks: form.category !== 'Material' ? Number(form.numStayBlocks) : 0,
          numConcretePoles: form.category === 'Concrete Poles' ? Number(form.numConcretePoles) : 0,
          truckSize: Number(form.truckSize) as 20 | 40,
          numTrips: Number(form.numTrips),
        },
        cfg,
      );
      setResult({ res, chartKm, distanceKm });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-xl font-bold text-ministry-dark mb-1">Trip Calculator</h1>
      <p className="text-sm text-on-surface-variant mb-5">
        Estimate what a trip pays before you haul. Uses the live rates and this week's fuel price — the actual
        invoice uses the fuel price of the trip's week, so treat this as an estimate. For multi-drop trips, pick
        your <b>furthest</b> destination.
      </p>

      {err && <div className="mb-4 text-sm text-error bg-error-container p-3 rounded-lg">{err}</div>}

      <div className="bg-white rounded-lg border border-outline-variant p-5 grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <span className="block text-xs font-medium text-on-surface-variant mb-1">Category</span>
          <div className="flex gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => set('category', c)}
                className={`px-3 py-2 rounded-lg text-sm border ${
                  form.category === c ? 'bg-[#2e7d32] text-white border-[#2e7d32]' : 'border-outline-variant'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="block text-xs font-medium text-on-surface-variant mb-1">Origin (warehouse)</span>
          <select value={form.originId} onChange={(e) => set('originId', e.target.value)} className="input w-full border border-outline-variant rounded-lg px-3 py-2 text-sm">
            <option value="">Select…</option>
            {origins.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-on-surface-variant mb-1">Destination (furthest drop)</span>
          <select value={form.districtId} onChange={(e) => set('districtId', e.target.value)} className="input w-full border border-outline-variant rounded-lg px-3 py-2 text-sm">
            <option value="">Select…</option>
            {districts.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>

        {form.category === 'Poles' && (
          <label className="block">
            <span className="block text-xs font-medium text-on-surface-variant mb-1">No. of Wooden Poles</span>
            <input type="number" min={0} value={form.numPoles} onChange={(e) => set('numPoles', Number(e.target.value))} className="input w-full border border-outline-variant rounded-lg px-3 py-2 text-sm" />
          </label>
        )}
        {form.category === 'Concrete Poles' && (
          <label className="block">
            <span className="block text-xs font-medium text-on-surface-variant mb-1">No. of Concrete Poles</span>
            <input type="number" min={0} value={form.numConcretePoles} onChange={(e) => set('numConcretePoles', Number(e.target.value))} className="input w-full border border-outline-variant rounded-lg px-3 py-2 text-sm" />
          </label>
        )}
        {form.category !== 'Material' && (
          <label className="block">
            <span className="block text-xs font-medium text-on-surface-variant mb-1">No. of Stay Blocks</span>
            <input type="number" min={0} value={form.numStayBlocks} onChange={(e) => set('numStayBlocks', Number(e.target.value))} className="input w-full border border-outline-variant rounded-lg px-3 py-2 text-sm" />
          </label>
        )}
        {form.category === 'Material' && (
          <label className="block">
            <span className="block text-xs font-medium text-on-surface-variant mb-1">Truck size (ft)</span>
            <select value={form.truckSize} onChange={(e) => set('truckSize', Number(e.target.value))} className="input w-full border border-outline-variant rounded-lg px-3 py-2 text-sm">
              <option value={20}>20</option>
              <option value={40}>40</option>
            </select>
          </label>
        )}
        <label className="block">
          <span className="block text-xs font-medium text-on-surface-variant mb-1">No. of Trips</span>
          <input type="number" min={1} value={form.numTrips} onChange={(e) => set('numTrips', Number(e.target.value))} className="input w-full border border-outline-variant rounded-lg px-3 py-2 text-sm" />
        </label>

        <button
          onClick={calculate}
          disabled={busy || !cfg}
          className="col-span-2 bg-[#2e7d32] text-white rounded-lg py-3 font-bold text-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Calculating…' : 'Calculate estimate'}
        </button>
      </div>

      {result && (
        <div className="mt-5 bg-surface-container-low border border-outline-variant rounded-lg p-5">
          <div className="text-xs font-bold tracking-wide text-on-surface-variant uppercase mb-1">Estimated payment</div>
          <div className="text-[32px] font-bold text-[#0d631b] mb-3">{ghs(result.res.cost)}</div>
          <div className="grid grid-cols-2 gap-2 text-sm text-on-surface-variant">
            <span>Chart distance: <b>{result.chartKm.toFixed(1)} km</b></span>
            <span>Billed distance: <b>{result.distanceKm.toFixed(1)} km</b></span>
            <span>Fuel price used: <b>{ghs(result.res.fuelPrice)}/L</b></span>
            <span>Escalation factor: <b>{result.res.factor.toFixed(4)}</b></span>
          </div>
          <p className="text-xs text-outline mt-3">
            Estimate only — the invoice amount is computed from the fuel price of the week the trip happens and
            the rates active at invoicing time.
          </p>
        </div>
      )}
    </div>
  );
}
