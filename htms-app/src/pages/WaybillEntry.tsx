import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import { SCAN_ALLOWED_MIME, SCAN_MAX_BYTES } from '../../shared/validation';

interface Origin { id: number; name: string }
interface District { id: number; name: string; region: string | null }
interface Transporter { id: string; name: string }

const SCAN_TYPES = [
  { key: 'acknowledgement', label: 'Acknowledgement form' },
  { key: 'waybill', label: 'Waybill' },
  { key: 'release_letter', label: 'Release letter' },
] as const;
type ScanKey = (typeof SCAN_TYPES)[number]['key'];

export default function WaybillEntry() {
  const { profile } = useAuth();
  const [origins, setOrigins] = useState<Origin[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [transporters, setTransporters] = useState<Transporter[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // region/district cascade + consolidated destinations
  const [region, setRegion] = useState('');
  const [districtPick, setDistrictPick] = useState(0);
  const [destinations, setDestinations] = useState<District[]>([]);

  // three categorized scans
  const [scans, setScans] = useState<Record<ScanKey, File | null>>({
    acknowledgement: null,
    waybill: null,
    release_letter: null,
  });

  const [form, setForm] = useState({
    transporterId: profile?.transporter_id ?? '',
    category: 'Poles',
    waybillNo: '',
    vehicleNo: '',
    originId: 1,
    numPoles: 0,
    numStayBlocks: 0,
    numConcretePoles: 0,
    truckSize: 40,
    numTrips: 1,
    waybillDate: new Date().toISOString().slice(0, 10),
  });

  useEffect(() => {
    supabase.from('origins').select('id,name').then(({ data }) => setOrigins((data as Origin[]) ?? []));
    supabase
      .from('districts')
      .select('id,name,region')
      .order('name')
      .then(({ data }) => setDistricts((data as District[]) ?? []));
    if (profile?.role !== 'transporter') {
      supabase
        .from('transporters')
        .select('id,name:display_name')
        .order('display_name')
        .then(({ data }) => setTransporters((data as Transporter[]) ?? []));
    }
  }, [profile]);

  const regions = useMemo(
    () => Array.from(new Set(districts.map((d) => d.region).filter(Boolean))).sort() as string[],
    [districts],
  );
  const districtOptions = useMemo(
    () => districts.filter((d) => !region || d.region === region),
    [districts, region],
  );

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function addDestination() {
    const d = districts.find((x) => x.id === Number(districtPick));
    if (!d) return;
    if (destinations.some((x) => x.id === d.id)) return;
    setDestinations((arr) => [...arr, d]);
    setDistrictPick(0);
  }
  function removeDestination(id: number) {
    setDestinations((arr) => arr.filter((x) => x.id !== id));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (destinations.length === 0) throw new Error('Add at least one destination district');
      for (const f of Object.values(scans)) {
        if (!f) continue;
        if (!SCAN_ALLOWED_MIME.includes(f.type as (typeof SCAN_ALLOWED_MIME)[number]))
          throw new Error('Scans must be PNG, JPEG, WebP or PDF');
        if (f.size > SCAN_MAX_BYTES) throw new Error('Each scan must be under 10 MB');
      }

      const created = (await api.createWaybill({
        ...form,
        originId: Number(form.originId),
        districtId: destinations[0].id, // primary; furthest is chosen at calc time
        destinationDistrictIds: destinations.map((d) => d.id),
        numPoles: Number(form.numPoles),
        numStayBlocks: Number(form.numStayBlocks),
        numConcretePoles: Number(form.numConcretePoles),
        numTrips: Number(form.numTrips),
        truckSize: Number(form.truckSize),
      })) as { waybill: { id: string; transporter_id: string } };

      const wb = created.waybill;
      for (const { key } of SCAN_TYPES) {
        const file = scans[key];
        if (!file) continue;
        const path = `${wb.transporter_id}/${wb.id}/${key}-${Date.now()}-${file.name}`;
        const { error: upErr } = await supabase.storage.from('scans').upload(path, file, { contentType: file.type });
        if (upErr) throw new Error(`${key} upload: ${upErr.message}`);
        await supabase.from('scans').insert({
          waybill_id: wb.id,
          storage_path: path,
          mime_type: file.type,
          byte_size: file.size,
          scan_type: key,
        });
      }

      setMsg('Waybill saved.');
      setDestinations([]);
      setScans({ acknowledgement: null, waybill: null, release_letter: null });
      set('waybillNo', '');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-bold text-ministry-dark mb-1">New Waybill</h1>
      <p className="text-sm text-gray-500 mb-4">
        For a consolidated trip (same car, same day), enter all waybill numbers comma-separated and add
        every destination — the cost is calculated using the furthest one.
      </p>
      {msg && <div className="mb-3 text-sm text-green-700 bg-green-50 p-2 rounded">{msg}</div>}
      {err && <div className="mb-3 text-sm text-red-600 bg-red-50 p-2 rounded">{err}</div>}

      <form onSubmit={submit} className="bg-white rounded-lg shadow p-6 grid grid-cols-2 gap-4">
        {profile?.role !== 'transporter' && (
          <Field label="Transporter" full>
            <select required value={form.transporterId} onChange={(e) => set('transporterId', e.target.value)} className="input">
              <option value="">Select…</option>
              {transporters.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Category">
          <select value={form.category} onChange={(e) => set('category', e.target.value)} className="input">
            <option>Poles</option>
            <option>Material</option>
            <option>Concrete Poles</option>
          </select>
        </Field>
        <Field label="Waybill No(s). — comma-separated">
          <input required placeholder="e.g. 12776, 12777" value={form.waybillNo} onChange={(e) => set('waybillNo', e.target.value)} className="input" />
        </Field>

        <Field label="From (origin)">
          <select value={form.originId} onChange={(e) => set('originId', Number(e.target.value))} className="input">
            {origins.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Vehicle No.">
          <input value={form.vehicleNo} onChange={(e) => set('vehicleNo', e.target.value)} className="input" />
        </Field>

        {/* Region → District cascade + add to destinations */}
        <Field label="Region (filters districts)">
          <select value={region} onChange={(e) => { setRegion(e.target.value); setDistrictPick(0); }} className="input">
            <option value="">All regions</option>
            {regions.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field label="To (district) — add one or more">
          <div className="flex gap-2">
            <select value={districtPick} onChange={(e) => setDistrictPick(Number(e.target.value))} className="input">
              <option value={0}>Select…</option>
              {districtOptions.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <button type="button" onClick={addDestination} className="bg-ministry text-white rounded px-3 text-sm whitespace-nowrap">
              Add
            </button>
          </div>
        </Field>

        {destinations.length > 0 && (
          <div className="col-span-2 flex flex-wrap gap-2">
            {destinations.map((d) => (
              <span key={d.id} className="bg-ministry-light text-ministry-dark text-sm rounded-full px-3 py-1 flex items-center gap-2">
                {d.name}
                <button type="button" onClick={() => removeDestination(d.id)} className="font-bold">×</button>
              </span>
            ))}
          </div>
        )}

        <Field label="Truck size">
          <select value={form.truckSize} onChange={(e) => set('truckSize', Number(e.target.value))} className="input">
            <option value={20}>20ft</option>
            <option value={40}>40ft</option>
          </select>
        </Field>
        <Field label="No. of Poles">
          <input type="number" min={0} value={form.numPoles} onChange={(e) => set('numPoles', Number(e.target.value))} className="input" />
        </Field>
        <Field label="No. of Stay Blocks">
          <input type="number" min={0} value={form.numStayBlocks} onChange={(e) => set('numStayBlocks', Number(e.target.value))} className="input" />
        </Field>
        <Field label="No. of Trips">
          <input type="number" min={1} value={form.numTrips} onChange={(e) => set('numTrips', Number(e.target.value))} className="input" />
        </Field>
        <Field label="Waybill date">
          <input type="date" value={form.waybillDate} onChange={(e) => set('waybillDate', e.target.value)} className="input" />
        </Field>

        {/* Three categorized scans */}
        <div className="col-span-2 border-t pt-4">
          <h3 className="text-sm font-semibold text-ministry-dark mb-2">Supporting scans (PDF/image)</h3>
          <div className="grid grid-cols-3 gap-3">
            {SCAN_TYPES.map(({ key, label }) => (
              <label key={key} className="text-sm">
                <span className="block text-gray-600 mb-1">{label}</span>
                <input
                  type="file"
                  accept=".pdf,image/png,image/jpeg,image/webp"
                  onChange={(e) => setScans((s) => ({ ...s, [key]: e.target.files?.[0] ?? null }))}
                  className="text-xs"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="col-span-2">
          <button disabled={busy} className="bg-ministry hover:bg-ministry-dark text-white rounded px-5 py-2 font-medium disabled:opacity-50">
            {busy ? 'Saving…' : 'Save waybill'}
          </button>
        </div>
      </form>
      <style>{`.input{width:100%;border:1px solid #d1d5db;border-radius:6px;padding:8px 10px;font-size:14px}`}</style>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={`block ${full ? 'col-span-2' : ''}`}>
      <span className="block text-sm text-gray-600 mb-1">{label}</span>
      {children}
    </label>
  );
}
