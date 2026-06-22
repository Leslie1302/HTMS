import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';

/**
 * Admin portal — add/maintain reference data as things change over time.
 * All writes go through the Supabase client under the caller's JWT; the
 * `*_admin_write` RLS policies permit them only for admins, so a non-admin
 * physically cannot write here even if they reached the page.
 */
export default function Admin() {
  const { profile } = useAuth();
  const [tab, setTab] = useState<'transporters' | 'fuel' | 'rates'>('transporters');

  if (profile?.role !== 'admin') {
    return <div className="text-red-600">Admin access only.</div>;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-bold text-ministry-dark mb-4">Admin Portal</h1>
      <div className="flex gap-2 mb-5 border-b">
        {(['transporters', 'fuel', 'rates'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize ${
              tab === t ? 'border-b-2 border-ministry text-ministry-dark' : 'text-gray-500'
            }`}
          >
            {t === 'rates' ? 'Rates & FIDIC' : t}
          </button>
        ))}
      </div>
      {tab === 'transporters' && <Transporters />}
      {tab === 'fuel' && <Fuel />}
      {tab === 'rates' && <Rates />}
    </div>
  );
}

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return { msg, err, setMsg, setErr };
}

function Banner({ msg, err }: { msg: string | null; err: string | null }) {
  if (err) return <div className="mb-3 text-sm text-red-600 bg-red-50 p-2 rounded">{err}</div>;
  if (msg) return <div className="mb-3 text-sm text-green-700 bg-green-50 p-2 rounded">{msg}</div>;
  return null;
}

// ── Transporters ────────────────────────────────────────────────────────────
interface TransporterRow {
  id: string;
  display_name: string;
  active: boolean;
  address: string | null;
  email: string | null;
  phone: string | null;
  gps_address: string | null;
}

function Transporters() {
  const { msg, err, setMsg, setErr } = useToast();
  const [list, setList] = useState<TransporterRow[]>([]);
  const blank = { display_name: '', address: '', email: '', phone: '', gps_address: '' };
  const [f, setF] = useState(blank);
  const [editingId, setEditingId] = useState<string | null>(null);

  function load() {
    supabase
      .from('transporters')
      .select('id, display_name, active, address, email, phone, gps_address')
      .order('display_name')
      .then(({ data }) => setList((data as TransporterRow[]) ?? []));
  }
  useEffect(load, []);

  function startEdit(t: TransporterRow) {
    setEditingId(t.id);
    setF({
      display_name: t.display_name,
      address: t.address ?? '',
      email: t.email ?? '',
      phone: t.phone ?? '',
      gps_address: t.gps_address ?? '',
    });
    setMsg(null);
    setErr(null);
  }
  function cancelEdit() {
    setEditingId(null);
    setF(blank);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    const payload = {
      display_name: f.display_name.trim(),
      address: f.address.trim() || null,
      email: f.email.trim() || null,
      phone: f.phone.trim() || null,
      gps_address: f.gps_address.trim() || null,
    };
    const { error } = editingId
      ? await supabase.from('transporters').update(payload).eq('id', editingId)
      : await supabase.from('transporters').insert(payload);
    if (error) return setErr(error.message);
    setMsg(editingId ? `Updated "${payload.display_name}"` : `Added "${payload.display_name}"`);
    cancelEdit();
    load();
  }

  async function toggleActive(t: TransporterRow) {
    const { error } = await supabase.from('transporters').update({ active: !t.active }).eq('id', t.id);
    if (error) setErr(error.message);
    else load();
  }

  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="max-w-2xl mx-auto">
      <Banner msg={msg} err={err} />
      <p className="text-sm text-gray-500 mb-3">
        Name is required. Address, email, phone and GPS appear on the invoice/letter letterhead.
      </p>
      <form onSubmit={submit} className="bg-white rounded-lg shadow p-4 grid grid-cols-2 gap-3 mb-5">
        {editingId && (
          <div className="col-span-2 text-sm text-ministry-dark font-medium">Editing transporter</div>
        )}
        <input required placeholder="Transporter name *" value={f.display_name} onChange={set('display_name')} className="col-span-2 border rounded px-3 py-2" />
        <input placeholder="Address (e.g. P.O. Box LG 8261 Legon, Accra)" value={f.address} onChange={set('address')} className="col-span-2 border rounded px-3 py-2" />
        <input placeholder="Email" value={f.email} onChange={set('email')} className="border rounded px-3 py-2" />
        <input placeholder="Phone" value={f.phone} onChange={set('phone')} className="border rounded px-3 py-2" />
        <input placeholder="GPS address (e.g. GW-0375-7007)" value={f.gps_address} onChange={set('gps_address')} className="col-span-2 border rounded px-3 py-2" />
        <div className="col-span-2 flex gap-2">
          <button className="bg-ministry text-white rounded px-4 py-2 font-medium">
            {editingId ? 'Save changes' : 'Add transporter'}
          </button>
          {editingId && (
            <button type="button" onClick={cancelEdit} className="border rounded px-4 py-2 text-gray-600">
              Cancel
            </button>
          )}
        </div>
      </form>
      <ul className="bg-white rounded-lg shadow divide-y">
        {list.map((t) => (
          <li key={t.id} className="px-4 py-2 flex items-center justify-between text-sm gap-3">
            <div className="min-w-0">
              <div className="font-medium truncate">{t.display_name}</div>
              <div className="text-xs text-gray-500 truncate">
                {[t.email, t.phone, t.gps_address].filter(Boolean).join(' · ') || 'no contact details'}
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className={t.active ? 'text-green-600' : 'text-gray-400'}>{t.active ? 'active' : 'inactive'}</span>
              <button onClick={() => startEdit(t)} className="text-ministry-dark underline">Edit</button>
              <button onClick={() => toggleActive(t)} className="text-gray-500 underline">
                {t.active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </li>
        ))}
        {list.length === 0 && <li className="px-4 py-3 text-gray-400 text-sm">No transporters yet.</li>}
      </ul>
    </div>
  );
}

// ── Weekly fuel (manual add / override) ──────────────────────────────────────
function Fuel() {
  const { msg, err, setMsg, setErr } = useToast();
  const [list, setList] = useState<{ week_start: string; price_per_litre: number; status: string }[]>([]);
  const [week, setWeek] = useState('');
  const [price, setPrice] = useState('');

  function load() {
    supabase
      .from('weekly_fuel')
      .select('week_start, price_per_litre, status')
      .order('week_start', { ascending: false })
      .limit(12)
      .then(({ data }) => setList(data ?? []));
  }
  useEffect(load, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    const { error } = await supabase
      .from('weekly_fuel')
      .upsert({ week_start: week, price_per_litre: Number(price), status: 'manual' }, { onConflict: 'week_start' });
    if (error) setErr(error.message);
    else {
      setMsg(`Set ${week} = ₵${price}`);
      setPrice('');
      load();
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Banner msg={msg} err={err} />
      <p className="text-sm text-gray-500 mb-3">
        The GOIL scraper fills this weekly. Override or backfill a week here if needed.
      </p>
      <form onSubmit={add} className="flex gap-2 mb-5 items-end">
        <label className="text-sm">
          Week start
          <input type="date" required value={week} onChange={(e) => setWeek(e.target.value)} className="block border rounded px-3 py-2 mt-1" />
        </label>
        <label className="text-sm">
          Diesel ₵/L
          <input type="number" step="0.01" required value={price} onChange={(e) => setPrice(e.target.value)} className="block border rounded px-3 py-2 mt-1" />
        </label>
        <button className="bg-ministry text-white rounded px-4 py-2 font-medium">Save</button>
      </form>
      <table className="w-full text-sm bg-white rounded-lg shadow">
        <thead className="bg-gray-100 text-left">
          <tr>
            <th className="px-3 py-2">Week start</th>
            <th className="px-3 py-2">₵/L</th>
            <th className="px-3 py-2">Source</th>
          </tr>
        </thead>
        <tbody>
          {list.map((f) => (
            <tr key={f.week_start} className="border-t">
              <td className="px-3 py-2">{f.week_start}</td>
              <td className="px-3 py-2">{f.price_per_litre}</td>
              <td className="px-3 py-2">
                <span className={f.status === 'flagged' ? 'text-amber-600' : 'text-gray-500'}>{f.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Rates & FIDIC (edit by creating a new version) ───────────────────────────
const RATE_LABELS: Record<string, string> = {
  materialPerTonKm: 'Material — per ton per km',
  offloadTruck40: 'Offload flat — 40ft',
  offloadTruck20: 'Offload flat — 20ft',
  polePerKm: 'Pole — per pole per km',
  offloadPerPole: 'Offload — per pole',
  stayPerKm: 'Stay block — per km',
  offloadPerStay: 'Offload — per stay block',
  concretePerKm: 'Concrete pole — per km',
  offloadPerConcrete: 'Offload — per concrete pole',
};

function Rates() {
  const { msg, err, setMsg, setErr } = useToast();
  const [rates, setRates] = useState<Record<string, number>>({});
  const [fidic, setFidic] = useState<Record<string, number>>({});
  const [versionId, setVersionId] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('rate_versions')
      .select('id')
      .eq('is_active', true)
      .single()
      .then(({ data }) => {
        if (!data) return;
        setVersionId(data.id);
        supabase
          .from('rates')
          .select('item_key, base_rate')
          .eq('rate_version_id', data.id)
          .then(({ data: r }) => setRates(Object.fromEntries((r ?? []).map((x) => [x.item_key, Number(x.base_rate)]))));
        supabase
          .from('fidic_params')
          .select('a,b,c,w_old,w_new,f_old')
          .eq('rate_version_id', data.id)
          .single()
          .then(({ data: f }) => f && setFidic({ a: +f.a, b: +f.b, c: +f.c, w_old: +f.w_old, w_new: +f.w_new, f_old: +f.f_old }));
      });
  }, []);

  async function save() {
    setErr(null);
    setMsg(null);
    if (!versionId) return;
    // Update rates in place on the active version.
    for (const [item_key, base_rate] of Object.entries(rates)) {
      const { error } = await supabase
        .from('rates')
        .update({ base_rate })
        .eq('rate_version_id', versionId)
        .eq('item_key', item_key);
      if (error) return setErr(error.message);
    }
    const { error: fErr } = await supabase.from('fidic_params').update(fidic).eq('rate_version_id', versionId);
    if (fErr) return setErr(fErr.message);
    setMsg('Saved. New invoices will use these values; existing invoices keep their snapshot.');
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Banner msg={msg} err={err} />
      <p className="text-sm text-gray-500 mb-3">
        FIDIC weights must sum to 1. Fuel is indexed per trip from the weekly series; these are the baselines.
      </p>
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <h3 className="font-semibold mb-2 text-ministry-dark">FIDIC parameters</h3>
        <div className="grid grid-cols-3 gap-3">
          {(['a', 'b', 'c', 'w_old', 'w_new', 'f_old'] as const).map((k) => (
            <label key={k} className="text-sm">
              {k}
              <input
                type="number"
                step="0.0001"
                value={fidic[k] ?? ''}
                onChange={(e) => setFidic((s) => ({ ...s, [k]: Number(e.target.value) }))}
                className="block w-full border rounded px-2 py-1 mt-1"
              />
            </label>
          ))}
        </div>
      </div>
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <h3 className="font-semibold mb-2 text-ministry-dark">Base rates (GHS)</h3>
        <div className="grid grid-cols-2 gap-3">
          {Object.keys(RATE_LABELS).map((k) => (
            <label key={k} className="text-sm">
              {RATE_LABELS[k]}
              <input
                type="number"
                step="0.0000001"
                value={rates[k] ?? ''}
                onChange={(e) => setRates((s) => ({ ...s, [k]: Number(e.target.value) }))}
                className="block w-full border rounded px-2 py-1 mt-1"
              />
            </label>
          ))}
        </div>
      </div>
      <button onClick={save} className="bg-ministry text-white rounded px-5 py-2 font-medium">
        Save changes
      </button>
    </div>
  );
}
