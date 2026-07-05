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
 * same calc engine, rates and fuel series as invoicing. Add every drop on the
 * trip; the system finds the furthest one and bills that distance — same as
 * invoicing does.
 */
export default function Calculator() {
  const [cfg, setCfg] = useState<CalcConfig | null>(null);
  const [origins, setOrigins] = useState<Opt[]>([]);
  const [districts, setDistricts] = useState<Opt[]>([]);
  const [drops, setDrops] = useState<Opt[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    res: CalcResult;
    chartKm: number;
    distanceKm: number;
    billedName: string;
    breakdown: { name: string; km: number }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    category: 'Poles' as Category,
    originId: '',
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
  const addDrop = (id: number) => {
    const d = districts.find((x) => x.id === id);
    if (!d || drops.some((x) => x.id === id)) return;
    setDrops((prev) => [...prev, d]);
    setResult(null);
  };
  const removeDrop = (id: number) => {
    setDrops((prev) => prev.filter((x) => x.id !== id));
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
    if (!form.originId || drops.length === 0) return setErr('Choose an origin and add at least one drop.');
    setBusy(true);
    try {
      const { data: distRows } = await supabase
        .from('distance_matrix')
        .select('km, district_id')
        .eq('origin_id', Number(form.originId))
        .in('district_id', drops.map((d) => d.id));
      const kmById = new Map((distRows ?? []).map((r) => [r.district_id as number, Number(r.km)]));
      const missing = drops.filter((d) => !kmById.has(d.id));
      if (missing.length) {
        throw new Error(
          `No surveyed distance for: ${missing.map((d) => d.name).join(', ')} — these cannot be billed yet.`,
        );
      }
      // Same rule as invoicing: the FURTHEST drop sets the billed distance.
      const breakdown = drops
        .map((d) => ({ name: d.name, km: kmById.get(d.id)! }))
        .sort((a, b) => b.km - a.km);
      const chartKm = breakdown[0].km;
      const billedName = breakdown[0].name;
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
      setResult({ res, chartKm, distanceKm, billedName, breakdown });
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
        Estimate what a trip pays before you haul. Add <b>every drop</b> on the trip — the system finds the
        furthest one and bills that distance, exactly like invoicing. Uses the live rates and this week's fuel
        price; the actual invoice uses the fuel price of the trip's week, so treat this as an estimate.
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
          <span className="block text-xs font-medium text-on-surface-variant mb-1">Add drop(s) — every destination on the trip</span>
          <select
            value=""
            onChange={(e) => e.target.value && addDrop(Number(e.target.value))}
            className="input w-full border border-outline-variant rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Add a destination…</option>
            {districts
              .filter((d) => !drops.some((x) => x.id === d.id))
              .map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
          </select>
          {drops.length > 0 && (
            <span className="flex flex-wrap gap-1 mt-2">
              {drops.map((d) => (
                <span key={d.id} className="flex items-center gap-1 bg-[#e8f5e9] text-[#1b5e20] rounded px-2 py-0.5 text-xs">
                  {d.name}
                  <button onClick={() => removeDrop(d.id)} aria-label={`Remove ${d.name}`} className="material-symbols-outlined text-sm hover:text-error">
                    close
                  </button>
                </span>
              ))}
            </span>
          )}
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
            <span>Billed drop (furthest): <b>{result.billedName}</b></span>
            <span>Chart distance: <b>{result.chartKm.toFixed(1)} km</b></span>
            <span>Billed distance: <b>{result.distanceKm.toFixed(1)} km</b></span>
            <span>Fuel price used: <b>{ghs(result.res.fuelPrice)}/L</b></span>
            <span>Escalation factor: <b>{result.res.factor.toFixed(4)}</b></span>
          </div>
          {result.breakdown.length > 1 && (
            <div className="mt-3 text-xs text-on-surface-variant">
              {result.breakdown.map((d, i) => (
                <span key={d.name} className="inline-block mr-3">
                  {d.name}: {d.km.toFixed(1)} km{i === 0 ? ' ← billed' : ''}
                </span>
              ))}
            </div>
          )}
          <p className="text-xs text-outline mt-3">
            Estimate only — the invoice amount is computed from the fuel price of the week the trip happens and
            the rates active at invoicing time.
          </p>
        </div>
      )}
    </div>
  );
}
