import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';

export default function Admin() {
  const { profile } = useAuth();
  const [tab, setTab] = useState<'transporters' | 'users' | 'audit' | 'fuel' | 'rates'>('transporters');

  if (profile?.role !== 'admin') {
    return <div className="text-error">Admin access only.</div>;
  }

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold text-on-surface mb-5">Admin Portal</h1>
      <div className="flex gap-1 mb-6 border-b border-outline-variant">
        {([
          { key: 'transporters' as const, label: 'Transporters' },
          { key: 'users' as const, label: 'User Management' },
          { key: 'audit' as const, label: 'Audit Logs' },
          { key: 'fuel' as const, label: 'Fuel Prices' },
          { key: 'rates' as const, label: 'Rates & FIDIC' },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === key
                ? 'border-b-2 border-[#0d631b] text-[#0d631b]'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'transporters' && <Transporters />}
      {tab === 'users' && <UserManagement />}
      {tab === 'audit' && <AuditLogs />}
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
  if (err) return <div className="mb-4 text-sm text-error bg-error-container p-3 rounded-lg flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">error</span>{err}</div>;
  if (msg) return <div className="mb-4 text-sm text-[#0d631b] bg-[#e8f5e9] p-3 rounded-lg flex items-center gap-2"><span className="material-symbols-outlined text-[18px]">check_circle</span>{msg}</div>;
  return null;
}

interface TransporterRow {
  id: string; display_name: string; active: boolean;
  address: string | null; email: string | null; phone: string | null; gps_address: string | null;
  contract_path: string | null; contract_validated: boolean;
}

function Transporters() {
  const { msg, err, setMsg, setErr } = useToast();
  const [list, setList] = useState<TransporterRow[]>([]);
  const blank = { display_name: '', address: '', email: '', phone: '', gps_address: '' };
  const [f, setF] = useState(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [contractValidated, setContractValidated] = useState(false);

  function load() {
    supabase.from('transporters').select('*').order('display_name').then(({ data }) => setList((data as TransporterRow[]) ?? []));
  }
  useEffect(load, []);

  function startEdit(t: TransporterRow) {
    setEditingId(t.id);
    setF({ display_name: t.display_name, address: t.address ?? '', email: t.email ?? '', phone: t.phone ?? '', gps_address: t.gps_address ?? '' });
    setContractValidated(t.contract_validated ?? false);
    setContractFile(null);
  }
  function cancelEdit() {
    setEditingId(null);
    setF(blank);
    setContractFile(null);
    setContractValidated(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    let contractPath = editingId ? list.find((t) => t.id === editingId)?.contract_path ?? null : null;

    if (contractFile) {
      const ext = contractFile.name.split('.').pop() || 'pdf';
      const path = `contracts/${editingId ?? 'new'}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('documents').upload(path, contractFile, {
        contentType: contractFile.type,
        upsert: true,
      });
      if (upErr) return setErr(`Contract upload: ${upErr.message}`);
      contractPath = path;
    }

    const payload: Record<string, unknown> = {
      display_name: f.display_name.trim(), address: f.address.trim() || null,
      email: f.email.trim() || null, phone: f.phone.trim() || null, gps_address: f.gps_address.trim() || null,
      contract_path: contractPath,
      contract_validated: contractValidated,
    };

    const { error } = editingId
      ? await supabase.from('transporters').update(payload).eq('id', editingId)
      : await supabase.from('transporters').insert(payload);
    if (error) return setErr(error.message);
    setMsg(editingId ? `Updated "${payload.display_name}"` : `Added "${payload.display_name}"`);
    cancelEdit(); load();
  }

  async function toggleActive(t: TransporterRow) {
    const { error } = await supabase.from('transporters').update({ active: !t.active }).eq('id', t.id);
    if (error) setErr(error.message); else load();
  }

  async function downloadContract(path: string) {
    const { data } = await supabase.storage.from('documents').download(path);
    if (!data) return;
    const url = URL.createObjectURL(data);
    window.open(url, '_blank');
  }

  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="max-w-3xl mx-auto">
      <Banner msg={msg} err={err} />
      <div className="bg-white rounded-lg border border-outline-variant p-5 mb-5">
        <h3 className="text-sm font-semibold text-on-surface mb-3">{editingId ? 'Edit Transporter' : 'Add Transporter'}</h3>
        <form onSubmit={submit} className="grid grid-cols-2 gap-3">
          <input required placeholder="Transporter name *" value={f.display_name} onChange={set('display_name')} className="col-span-2 border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
          <input placeholder="Address" value={f.address} onChange={set('address')} className="col-span-2 border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
          <input placeholder="Email" value={f.email} onChange={set('email')} className="border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
          <input placeholder="Phone" value={f.phone} onChange={set('phone')} className="border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
          <input placeholder="GPS address" value={f.gps_address} onChange={set('gps_address')} className="col-span-2 border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />

          <div className="col-span-2 border-t border-outline-variant pt-3">
            <h4 className="text-xs font-bold uppercase text-on-surface-variant mb-2">Contract Agreement</h4>
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => setContractFile(e.target.files?.[0] ?? null)}
                className="text-sm"
              />
              {editingId && list.find((t) => t.id === editingId)?.contract_path && (
                <button type="button" onClick={() => downloadContract(list.find((t) => t.id === editingId)!.contract_path!)} className="text-[#0d631b] underline text-xs">
                  View current
                </button>
              )}
            </div>
            <label className="flex items-center gap-2 mt-2">
              <input
                type="checkbox"
                checked={contractValidated}
                onChange={(e) => setContractValidated(e.target.checked)}
                className="w-4 h-4 text-[#0d631b] border-outline-variant rounded focus:ring-[#0d631b]"
              />
              <span className="text-xs text-on-surface-variant">Contract validated by Ministry</span>
            </label>
          </div>

          <div className="col-span-2 flex gap-2 pt-2">
            <button className="bg-[#2e7d32] text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">
              {editingId ? 'Save changes' : 'Add transporter'}
            </button>
            {editingId && <button type="button" onClick={cancelEdit} className="border border-outline-variant rounded-lg px-4 py-2 text-sm text-on-surface-variant">Cancel</button>}
          </div>
        </form>
      </div>
      <div className="bg-white rounded-lg border border-outline-variant divide-y divide-outline-variant">
        {list.map((t) => (
          <div key={t.id} className="px-4 py-3 flex items-center justify-between text-sm gap-3">
            <div className="min-w-0">
              <div className="font-medium truncate">{t.display_name}</div>
              <div className="text-xs text-outline truncate flex items-center gap-2">
                {[t.email, t.phone, t.gps_address].filter(Boolean).join(' · ') || 'no contact'}
                {t.contract_path && (
                  <button onClick={() => downloadContract(t.contract_path!)} className="text-[#0d631b] underline ml-2">
                    Contract
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {t.contract_path && (
                <span className={`text-[10px] font-bold uppercase ${t.contract_validated ? 'text-[#0d631b]' : 'text-amber-600'}`}>
                  {t.contract_validated ? 'Validated' : 'Pending'}
                </span>
              )}
              <span className={`text-xs font-bold uppercase ${t.active ? 'text-[#0d631b]' : 'text-outline'}`}>{t.active ? 'Active' : 'Inactive'}</span>
              <button onClick={() => startEdit(t)} className="text-[#0d631b] underline text-xs">Edit</button>
              <button onClick={() => toggleActive(t)} className="text-outline underline text-xs">{t.active ? 'Deactivate' : 'Activate'}</button>
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="px-4 py-6 text-center text-outline-variant text-sm">No transporters yet.</div>}
      </div>
    </div>
  );
}

function UserManagement() {
  const [users, setUsers] = useState<any[]>([]);

  useEffect(() => {
    supabase.from('app_users').select('id, role, full_name, transporter_id, created_at').order('created_at', { ascending: false }).then(({ data }) => setUsers(data ?? []));
  }, []);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white rounded-lg border border-outline-variant overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-left">
            <tr>
              {['Name', 'Role', 'Transporter ID', 'Created'].map((h) => (
                <th key={h} className="px-4 py-3 text-[11px] font-bold tracking-wide text-on-surface-variant uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-surface-container-low">
                <td className="px-4 py-3">{u.full_name ?? '-'}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                    u.role === 'admin' ? 'bg-[#acf4a4] text-[#0c5216]' :
                    u.role === 'officer' ? 'bg-[#e8f5e9] text-[#1b5e20]' :
                    'bg-surface-container-high text-on-surface-variant'
                  }`}>{u.role}</span>
                </td>
                <td className="px-4 py-3 text-xs font-mono text-outline">{u.transporter_id?.slice(0, 8) ?? '-'}</td>
                <td className="px-4 py-3 text-xs text-outline">{new Date(u.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-outline-variant">No users found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuditLogs() {
  const [logs, setLogs] = useState<any[]>([]);

  useEffect(() => {
    supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(100).then(({ data }) => setLogs(data ?? []));
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="bg-white rounded-lg border border-outline-variant overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-left">
            <tr>
              {['Timestamp', 'Actor', 'Action', 'Entity', 'Entity ID', 'Details'].map((h) => (
                <th key={h} className="px-4 py-3 text-[11px] font-bold tracking-wide text-on-surface-variant uppercase whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {logs.map((l) => (
              <tr key={l.id} className="hover:bg-surface-container-low">
                <td className="px-4 py-3 text-xs text-outline whitespace-nowrap">{new Date(l.created_at).toLocaleString()}</td>
                <td className="px-4 py-3 font-mono text-xs">{l.actor_id?.slice(0, 8) ?? 'system'}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                    l.action === 'create' || l.action === 'approve' || ALL_STAGES_SOME(l.action) ? 'bg-[#acf4a4] text-[#0c5216]' :
                    l.action === 'lock' ? 'bg-surface-container-high text-on-surface-variant' :
                    l.action === 'void' ? 'bg-error-container text-error' :
                    'bg-surface-variant text-on-surface-variant'
                  }`}>{l.action}</span>
                </td>
                <td className="px-4 py-3 text-xs">{l.entity}</td>
                <td className="px-4 py-3 text-xs font-mono text-outline">{l.entity_id?.slice(0, 12) ?? '-'}</td>
                <td className="px-4 py-3 text-xs text-outline max-w-[200px] truncate">
                  {l.after ? JSON.stringify(l.after).slice(0, 60) : '-'}
                </td>
              </tr>
            ))}
            {logs.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-outline-variant">No audit logs.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ALL_STAGES_SOME(action: string): boolean {
  return ['generated', 'submitted', 'with_chief_director', 'minuted_to_pd', 'pd_processing', 'pd_processed',
    'cd_directive_audit', 'audit_validation', 'returned_to_cd', 'at_accounts', 'paid'].includes(action);
}

function Fuel() {
  const { msg, err, setMsg, setErr } = useToast();
  const [list, setList] = useState<{ week_start: string; price_per_litre: number; status: string }[]>([]);
  const [week, setWeek] = useState('');
  const [price, setPrice] = useState('');

  function load() {
    supabase.from('weekly_fuel').select('week_start, price_per_litre, status').order('week_start', { ascending: false }).limit(12).then(({ data }) => setList(data ?? []));
  }
  useEffect(load, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from('weekly_fuel').upsert({ week_start: week, price_per_litre: Number(price), status: 'manual' }, { onConflict: 'week_start' });
    if (error) setErr(error.message); else { setMsg(`Set ${week} = ₵${price}`); setPrice(''); load(); }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Banner msg={msg} err={err} />
      <form onSubmit={add} className="flex gap-3 mb-5 items-end bg-white rounded-lg border border-outline-variant p-4">
        <label className="text-sm text-on-surface-variant">Week start
          <input type="date" required value={week} onChange={(e) => setWeek(e.target.value)} className="block border border-outline-variant rounded-lg px-3 py-2 mt-1 text-sm outline-none focus:border-[#0d631b]" />
        </label>
        <label className="text-sm text-on-surface-variant">Diesel ₵/L
          <input type="number" step="0.01" required value={price} onChange={(e) => setPrice(e.target.value)} className="block border border-outline-variant rounded-lg px-3 py-2 mt-1 text-sm outline-none focus:border-[#0d631b]" />
        </label>
        <button className="bg-[#2e7d32] text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">Save</button>
      </form>
      <div className="bg-white rounded-lg border border-outline-variant overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-left">
            <tr>
              {['Week start', '₵/L', 'Source'].map((h) => (
                <th key={h} className="px-4 py-3 text-[11px] font-bold tracking-wide text-on-surface-variant uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {list.map((f) => (
              <tr key={f.week_start} className="hover:bg-surface-container-low">
                <td className="px-4 py-3">{f.week_start}</td>
                <td className="px-4 py-3 font-mono">{f.price_per_litre}</td>
                <td className="px-4 py-3"><span className={`text-xs ${f.status === 'flagged' ? 'text-amber-600' : 'text-outline'}`}>{f.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const RATE_LABELS: Record<string, string> = {
  materialPerTonKm: 'Material — per ton per km', offloadTruck40: 'Offload flat — 40ft', offloadTruck20: 'Offload flat — 20ft',
  polePerKm: 'Pole — per pole per km', offloadPerPole: 'Offload — per pole',
  stayPerKm: 'Stay block — per km', offloadPerStay: 'Offload — per stay block',
  concretePerKm: 'Concrete pole — per km', offloadPerConcrete: 'Offload — per concrete pole',
};

function Rates() {
  const { msg, err, setMsg, setErr } = useToast();
  const [rates, setRates] = useState<Record<string, number>>({});
  const [fidic, setFidic] = useState<Record<string, number>>({});
  const [versionId, setVersionId] = useState<string | null>(null);

  useEffect(() => {
    supabase.from('rate_versions').select('id').eq('is_active', true).single().then(({ data }) => {
      if (!data) return;
      setVersionId(data.id);
      supabase.from('rates').select('item_key, base_rate').eq('rate_version_id', data.id).then(({ data: r }) => setRates(Object.fromEntries((r ?? []).map((x) => [x.item_key, Number(x.base_rate)]))));
      supabase.from('fidic_params').select('a,b,c,w_old,w_new,f_old').eq('rate_version_id', data.id).single().then(({ data: f }) => f && setFidic({ a: +f.a, b: +f.b, c: +f.c, w_old: +f.w_old, w_new: +f.w_new, f_old: +f.f_old }));
    });
  }, []);

  async function save() {
    if (!versionId) return;
    for (const [item_key, base_rate] of Object.entries(rates)) {
      const { error } = await supabase.from('rates').update({ base_rate }).eq('rate_version_id', versionId).eq('item_key', item_key);
      if (error) return setErr(error.message);
    }
    const { error: fErr } = await supabase.from('fidic_params').update(fidic).eq('rate_version_id', versionId);
    if (fErr) return setErr(fErr.message);
    setMsg('Saved. New invoices will use these values.');
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Banner msg={msg} err={err} />
      <div className="bg-white rounded-lg border border-outline-variant p-5 mb-4">
        <h3 className="text-sm font-semibold text-on-surface mb-3">FIDIC parameters</h3>
        <div className="grid grid-cols-3 gap-3">
          {(['a', 'b', 'c', 'w_old', 'w_new', 'f_old'] as const).map((k) => (
            <label key={k} className="text-sm text-on-surface-variant">
              {k}
              <input type="number" step="0.0001" value={fidic[k] ?? ''} onChange={(e) => setFidic((s) => ({ ...s, [k]: Number(e.target.value) }))} className="block w-full border border-outline-variant rounded-lg px-2 py-1 mt-1 text-sm outline-none focus:border-[#0d631b]" />
            </label>
          ))}
        </div>
      </div>
      <div className="bg-white rounded-lg border border-outline-variant p-5 mb-4">
        <h3 className="text-sm font-semibold text-on-surface mb-3">Base rates (GHS)</h3>
        <div className="grid grid-cols-2 gap-3">
          {Object.keys(RATE_LABELS).map((k) => (
            <label key={k} className="text-sm text-on-surface-variant">
              {RATE_LABELS[k]}
              <input type="number" step="0.0000001" value={rates[k] ?? ''} onChange={(e) => setRates((s) => ({ ...s, [k]: Number(e.target.value) }))} className="block w-full border border-outline-variant rounded-lg px-2 py-1 mt-1 text-sm outline-none focus:border-[#0d631b]" />
            </label>
          ))}
        </div>
      </div>
      <button onClick={save} className="bg-[#2e7d32] text-white rounded-lg px-5 py-2 text-sm font-medium hover:opacity-90">Save changes</button>
    </div>
  );
}
