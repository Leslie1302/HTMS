import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';

/** Minimal RFC-4180 CSV parser — handles quoted fields with commas/newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export default function Admin() {
  const { profile } = useAuth();
  const [tab, setTab] = useState<'transporters' | 'users' | 'audit' | 'fuel' | 'rates' | 'distances'>('transporters');

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
          { key: 'audit' as const, label: 'Reports' },
          { key: 'fuel' as const, label: 'Fuel Prices' },
          { key: 'rates' as const, label: 'Rates & FIDIC' },
          { key: 'distances' as const, label: 'Distance Chart' },
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
      {tab === 'audit' && <Reports />}
      {tab === 'fuel' && <Fuel />}
      {tab === 'rates' && <Rates />}
      {tab === 'distances' && <DistanceChart />}
    </div>
  );
}

/** Read-only reference: the surveyed chart distances the calc engine bills from. */
function DistanceChart() {
  const [rows, setRows] = useState<{ km: number; origin: string; district: string }[]>([]);
  const [origin, setOrigin] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('distance_matrix')
      .select('km, origins(name), districts(name)')
      .limit(10000)
      .then(({ data, error }) => {
        if (error) return setErr(error.message);
        setRows(
          ((data ?? []) as unknown as { km: number; origins: { name: string }; districts: { name: string } }[]).map(
            (r) => ({ km: Number(r.km), origin: r.origins?.name ?? '', district: r.districts?.name ?? '' }),
          ),
        );
      });
  }, []);

  const origins = [...new Set(rows.map((r) => r.origin))].sort();
  const filtered = rows
    .filter((r) => (!origin || r.origin === origin) && (!q || r.district.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => a.origin.localeCompare(b.origin) || b.km - a.km);

  return (
    <div>
      {err && <div className="mb-4 text-sm text-error bg-error-container p-3 rounded-lg">{err}</div>}
      <p className="text-sm text-on-surface-variant mb-3">
        Surveyed chart distances used for billing. Multi-drop trips are billed at the furthest destination's
        distance — verify a trip's billed km here against its drops.
      </p>
      <div className="flex gap-3 mb-4">
        <select value={origin} onChange={(e) => setOrigin(e.target.value)} className="border border-outline-variant rounded-lg px-3 py-2 text-sm">
          <option value="">All origins</option>
          {origins.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search district…"
          className="border border-outline-variant rounded-lg px-3 py-2 text-sm flex-1"
        />
        <span className="text-xs text-outline self-center">{filtered.length} routes</span>
      </div>
      <div className="bg-white rounded-lg border border-outline-variant overflow-auto max-h-[60vh]">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-left sticky top-0">
            <tr>
              {['Origin (warehouse)', 'District', 'Chart Km'].map((h) => (
                <th key={h} className="px-3 py-3 font-semibold text-on-surface-variant tracking-wider text-[11px] uppercase">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={i} className="border-t border-outline-variant">
                <td className="px-3 py-2">{r.origin}</td>
                <td className="px-3 py-2">{r.district}</td>
                <td className="px-3 py-2 font-mono">{r.km.toFixed(1)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-outline-variant">
                  No routes match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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
  manager_name: string | null;
  contract_path: string | null; contract_validated: boolean;
}

function Transporters() {
  const { msg, err, setMsg, setErr } = useToast();
  const [list, setList] = useState<TransporterRow[]>([]);
  const blank = { display_name: '', address: '', email: '', phone: '', gps_address: '', manager_name: '' };
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
    setF({ display_name: t.display_name, address: t.address ?? '', email: t.email ?? '', phone: t.phone ?? '', gps_address: t.gps_address ?? '', manager_name: t.manager_name ?? '' });
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
      manager_name: f.manager_name.trim() || null,
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

  const [deletingId, setDeletingId] = useState<string | null>(null);
  async function removeTransporter(t: TransporterRow) {
    if (!window.confirm(`Permanently delete "${t.display_name}" and ALL of its waybills, invoices, documents and user accounts?\n\nThis cannot be undone.`)) return;
    setErr(null); setMsg(null); setDeletingId(t.id);
    try {
      await api.adminDelete({ action: 'delete_transporter', id: t.id });
      setMsg(`Deleted "${t.display_name}" and all its data.`); load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  async function downloadContract(path: string) {
    const { data } = await supabase.storage.from('documents').download(path);
    if (!data) return;
    const url = URL.createObjectURL(data);
    window.open(url, '_blank');
  }

  // ── Bulk import (Excel / CSV) ──────────────────────────────────────────────
  const [importing, setImporting] = useState(false);

  function downloadTemplate() {
    const headers = ['Name', 'Address', 'Email', 'Phone', 'GPS', 'Manager'];
    const example = ['Among The Gods Ltd', 'No. 12 Spintex Road, Tema', 'ops@example.com', '024 123 4567', 'GA-123-4567', 'Kwame Mensah'];
    const csv = [headers, example].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'transporters_template.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  async function bulkImport(file: File) {
    setErr(null); setMsg(null); setImporting(true);
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) throw new Error('The file has a header row but no data.');
      const headers = rows[0].map((h) => h.trim().toLowerCase());
      const col = (keys: string[]) => headers.findIndex((h) => keys.includes(h));
      const iName = col(['name', 'company', 'transporter', 'display_name', 'company name']);
      if (iName < 0) throw new Error('Could not find a "Name" (or Company) column in the header row.');
      const iAddr = col(['address']);
      const iEmail = col(['email', 'e-mail']);
      const iPhone = col(['phone', 'contact', 'phone number', 'tel']);
      const iGps = col(['gps', 'gps address', 'digital address', 'ghana post gps']);
      const iMgr = col(['manager', 'manager name', 'signatory', 'signatory name']);
      const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');

      const existing = new Set(list.map((t) => t.display_name.toLowerCase()));
      const seen = new Set<string>();
      const payload: Record<string, string | null>[] = [];
      let skipped = 0, added = 0, updated = 0;
      for (const r of rows.slice(1)) {
        const name = cell(r, iName);
        if (!name || seen.has(name.toLowerCase())) { if (!name) skipped++; continue; }
        seen.add(name.toLowerCase());
        if (existing.has(name.toLowerCase())) updated++; else added++;
        payload.push({
          display_name: name,
          address: cell(r, iAddr) || null,
          email: cell(r, iEmail) || null,
          phone: cell(r, iPhone) || null,
          gps_address: cell(r, iGps) || null,
          manager_name: cell(r, iMgr) || null,
        });
      }
      if (!payload.length) throw new Error('No data rows with a name were found.');
      const { error } = await supabase.from('transporters').upsert(payload, { onConflict: 'display_name' });
      if (error) throw new Error(error.message);
      setMsg(`Imported ${payload.length} transporter(s): ${added} added, ${updated} updated${skipped ? `, ${skipped} skipped (no name)` : ''}.`);
      load();
    } catch (e) {
      setErr(`Import failed: ${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  }

  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="max-w-3xl mx-auto">
      <Banner msg={msg} err={err} />
      <div className="bg-white rounded-lg border border-outline-variant p-4 mb-5 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px]">
          <h3 className="text-sm font-semibold text-on-surface">Bulk import from CSV</h3>
          <p className="text-xs text-on-surface-variant mt-0.5">In Excel, use File → Save As → CSV, then upload here. Upserts on company name — new names are added, existing ones updated. Columns: Name, Address, Email, Phone, GPS, Manager.</p>
        </div>
        <button onClick={downloadTemplate} className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-2 text-sm hover:bg-surface-container-low">
          <span className="material-symbols-outlined text-[18px]">download</span> Template
        </button>
        <label className={`flex items-center gap-1 bg-[#2e7d32] text-white rounded-lg px-3 py-2 text-sm font-medium cursor-pointer hover:opacity-90 ${importing ? 'opacity-50 pointer-events-none' : ''}`}>
          <span className="material-symbols-outlined text-[18px]">upload_file</span>
          {importing ? 'Importing…' : 'Upload file'}
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) bulkImport(file); e.target.value = ''; }} />
        </label>
      </div>
      <div className="bg-white rounded-lg border border-outline-variant p-5 mb-5">
        <h3 className="text-sm font-semibold text-on-surface mb-3">{editingId ? 'Edit Transporter' : 'Add Transporter'}</h3>
        <form onSubmit={submit} className="grid grid-cols-2 gap-3">
          <input required placeholder="Transporter name *" value={f.display_name} onChange={set('display_name')} className="col-span-2 border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
          <input placeholder="Address" value={f.address} onChange={set('address')} className="col-span-2 border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
          <input placeholder="Email" value={f.email} onChange={set('email')} className="border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
          <input placeholder="Phone" value={f.phone} onChange={set('phone')} className="border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
          <input placeholder="GPS address" value={f.gps_address} onChange={set('gps_address')} className="col-span-2 border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
          <input placeholder="Manager / signatory name (printed under the signature)" value={f.manager_name} onChange={set('manager_name')} className="col-span-2 border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />

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
              <button onClick={() => removeTransporter(t)} disabled={deletingId === t.id} title="Delete transporter and all its data" className="text-error hover:text-error disabled:opacity-40">
                <span className="material-symbols-outlined text-[18px]">{deletingId === t.id ? 'hourglass_top' : 'delete'}</span>
              </button>
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="px-4 py-6 text-center text-outline-variant text-sm">No transporters yet.</div>}
      </div>

      <DangerZone onDone={load} />
    </div>
  );
}

/** Guarded bulk flush for going live — keeps config data and admin logins. */
function DangerZone({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function reset() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api.adminDelete({ action: 'reset_pilot' });
      setMsg('All transporters and payment-request activity have been cleared. Configuration and admin accounts were kept.');
      setOpen(false); setConfirm(''); onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 rounded-xl border border-error/40 bg-error-container/30 p-5">
      <div className="flex items-center gap-2 text-error font-semibold"><span className="material-symbols-outlined text-[20px]">warning</span> Danger zone</div>
      <p className="text-sm text-on-surface-variant mt-1">Flush every transporter, waybill, invoice, document and non-admin account to start the pilot fresh. Reference/config data (rates, fuel, distances) and admin logins are kept. This cannot be undone.</p>
      {msg && <div className="mt-3 text-sm text-[#0d631b] bg-[#e8f5e9] p-2 rounded-lg">{msg}</div>}
      {err && <div className="mt-3 text-sm text-error bg-error-container p-2 rounded-lg">{err}</div>}
      {!open ? (
        <button onClick={() => setOpen(true)} className="mt-3 border border-error text-error rounded-lg px-4 py-2 text-sm font-medium hover:bg-error-container/50">Reset pilot data…</button>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm">Type <span className="font-mono font-bold">RESET</span> to confirm:</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="border border-outline-variant rounded-lg px-3 py-1.5 text-sm w-28 outline-none focus:border-error" autoFocus />
          <button onClick={reset} disabled={confirm !== 'RESET' || busy} className="bg-error text-white rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-40">{busy ? 'Flushing…' : 'Flush all data'}</button>
          <button onClick={() => { setOpen(false); setConfirm(''); }} className="border border-outline-variant rounded-lg px-4 py-1.5 text-sm">Cancel</button>
        </div>
      )}
    </div>
  );
}

interface AppUserRow {
  id: string; role: 'admin' | 'officer' | 'transporter' | 'deputy_director' | 'director'; full_name: string | null;
  transporter_id: string | null; phone: string | null; created_at: string;
}

const ROLE_LABEL: Record<string, string> = { admin: 'System Admin', officer: 'Ministry Staff', transporter: 'Transporter', deputy_director: 'Deputy Director', director: 'Director' };

function UserManagement() {
  const { msg, err, setMsg, setErr } = useToast();
  const [users, setUsers] = useState<AppUserRow[]>([]);
  const [transporters, setTransporters] = useState<{ id: string; display_name: string }[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const blankNew = { full_name: '', email: '', role: 'transporter' as AppUserRow['role'], transporter_id: '', phone: '' };
  const [showNew, setShowNew] = useState(false);
  const [nf, setNf] = useState(blankNew);
  const [creating, setCreating] = useState(false);
  const [tempPw, setTempPw] = useState<{ email: string; password: string } | null>(null);

  function load() {
    supabase.from('app_users').select('id, role, full_name, transporter_id, phone, created_at').order('created_at', { ascending: false }).then(({ data }) => setUsers((data as AppUserRow[]) ?? []));
  }
  useEffect(() => {
    load();
    supabase.from('transporters').select('id, display_name').order('display_name').then(({ data }) => setTransporters(data ?? []));
  }, []);

  const orgOf = (id: string | null) => transporters.find((t) => t.id === id)?.display_name ?? '';

  function edit(id: string, patch: Partial<AppUserRow>) {
    setUsers((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }

  async function save(u: AppUserRow) {
    setErr(null); setMsg(null);
    if (u.role === 'transporter' && !u.transporter_id) return setErr('A transporter user must be assigned a company.');
    setSavingId(u.id);
    const { error } = await supabase.from('app_users').update({
      role: u.role,
      transporter_id: u.role === 'transporter' ? u.transporter_id : null,
      phone: u.phone?.trim() || null,
    }).eq('id', u.id);
    setSavingId(null);
    if (error) return setErr(error.message);
    setMsg('User updated'); load();
  }

  async function createUser() {
    setErr(null); setMsg(null);
    if (!nf.full_name.trim() || !nf.email.trim()) return setErr('Name and email are required.');
    if (nf.role === 'transporter' && !nf.transporter_id) return setErr('A transporter user must be assigned a company.');
    setCreating(true);
    try {
      const res = await api.createUser({
        full_name: nf.full_name.trim(),
        email: nf.email.trim(),
        role: nf.role,
        transporter_id: nf.role === 'transporter' ? nf.transporter_id : null,
        phone: nf.phone.trim() || undefined,
      });
      setTempPw({ email: nf.email.trim(), password: res.tempPassword });
      setShowNew(false); setNf(blankNew); load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const staff = users.filter((u) => u.role !== 'transporter').length;
  const transporterUsers = users.filter((u) => u.role === 'transporter').length;
  const unassigned = users.filter((u) => u.role === 'transporter' && !u.transporter_id).length;

  const filtered = users.filter((u) => {
    if (!q) return true;
    const hay = `${u.full_name ?? ''} ${u.role} ${orgOf(u.transporter_id)} ${u.phone ?? ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  function exportCsv() {
    const rows = [['name', 'role', 'organization', 'phone', 'created'],
      ...users.map((u) => [u.full_name ?? '', ROLE_LABEL[u.role] ?? u.role, orgOf(u.transporter_id), u.phone ?? '', new Date(u.created_at).toISOString()])];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `htms_users_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-on-surface">System Users</h2>
          <p className="text-sm text-on-surface-variant">Manage institutional access for Ministry staff, transporters and site admins. Assign each user a role and — for transporters — their company.</p>
        </div>
        <button onClick={() => { setShowNew(true); setTempPw(null); }} className="shrink-0 flex items-center gap-1.5 bg-[#0d631b] hover:opacity-90 text-white rounded-lg px-4 py-2.5 text-sm font-medium">
          <span className="material-symbols-outlined text-[18px]">person_add</span> Add New User
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Total Users" value={users.length.toLocaleString()} sub="all accounts" />
        <StatCard label="Transporters" value={transporterUsers.toLocaleString()} sub="external accounts" />
        <StatCard label="Ministry / Admin" value={staff.toLocaleString()} sub="internal staff" />
        <StatCard label="Unassigned" value={unassigned.toLocaleString()} sub="need a company" tone={unassigned ? 'alert' : 'default'} />
      </div>

      <Banner msg={msg} err={err} />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <span className="material-symbols-outlined text-[18px] absolute left-2 top-2.5 text-outline">search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, role or company…" className="w-full border border-outline-variant rounded-lg pl-8 pr-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
        </div>
        <button onClick={exportCsv} className="flex items-center gap-1.5 border border-outline-variant rounded-lg px-3 py-2 text-sm hover:bg-surface-container-low">
          <span className="material-symbols-outlined text-[18px]">download</span> Export CSV
        </button>
      </div>

      <div className="bg-white rounded-xl border border-outline-variant overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-left">
            <tr>
              {['Name & Identity', 'Role', 'Organization', 'Phone', ''].map((h) => (
                <th key={h} className="px-4 py-3 text-[11px] font-bold tracking-wide text-on-surface-variant uppercase whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {filtered.map((u) => (
              <tr key={u.id} className="hover:bg-surface-container-low align-top">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`w-9 h-9 rounded-full grid place-items-center text-xs font-bold text-white ${avatarColor(u.full_name ?? u.id)}`}>{initials(u.full_name)}</span>
                    <div className="leading-tight">
                      <div className="font-medium text-on-surface">{u.full_name ?? 'Unnamed user'}</div>
                      <div className="text-[11px] text-outline font-mono">{u.id.slice(0, 8)}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <select value={u.role} onChange={(e) => edit(u.id, { role: e.target.value as AppUserRow['role'] })} className="border border-outline-variant rounded-lg px-2 py-1.5 text-sm outline-none focus:border-[#0d631b]">
                    <option value="admin">System Admin</option>
                    <option value="officer">Ministry Staff</option>
                    <option value="deputy_director">Deputy Director</option>
                    <option value="director">Director</option>
                    <option value="transporter">Transporter</option>
                  </select>
                </td>
                <td className="px-4 py-3">
                  <select value={u.transporter_id ?? ''} disabled={u.role !== 'transporter'} onChange={(e) => edit(u.id, { transporter_id: e.target.value || null })} className="border border-outline-variant rounded-lg px-2 py-1.5 text-sm outline-none focus:border-[#0d631b] disabled:opacity-40 max-w-[180px]">
                    <option value="">{u.role === 'transporter' ? '— select company —' : 'n/a'}</option>
                    {transporters.map((t) => (<option key={t.id} value={t.id}>{t.display_name}</option>))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  <input value={u.phone ?? ''} onChange={(e) => edit(u.id, { phone: e.target.value })} placeholder="024… / +233…" className="border border-outline-variant rounded-lg px-2 py-1.5 text-sm outline-none focus:border-[#0d631b] w-32" />
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => save(u)} disabled={savingId === u.id} className="bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50">
                    {savingId === u.id ? 'Saving…' : 'Save'}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-outline-variant">No users match.</td></tr>}
          </tbody>
        </table>
        <div className="px-4 py-3 border-t border-outline-variant text-xs text-on-surface-variant">Showing {filtered.length.toLocaleString()} of {users.length.toLocaleString()} users</div>
      </div>

      <div className="bg-white rounded-xl border border-outline-variant p-4 mt-5">
        <h3 className="font-semibold text-on-surface mb-3 flex items-center gap-1.5"><span className="material-symbols-outlined text-[18px]">history</span> Recently Added Users</h3>
        <div className="space-y-2">
          {users.slice(0, 4).map((u) => (
            <div key={u.id} className="flex items-center gap-3 text-sm border border-outline-variant rounded-lg px-3 py-2">
              <span className={`w-7 h-7 rounded-full grid place-items-center text-[10px] font-bold text-white ${avatarColor(u.full_name ?? u.id)}`}>{initials(u.full_name)}</span>
              <div className="flex-1 leading-tight">
                <div className="font-medium">{u.full_name ?? 'Unnamed user'}</div>
                <div className="text-[11px] text-outline">{ROLE_LABEL[u.role] ?? u.role}{orgOf(u.transporter_id) ? ` · ${orgOf(u.transporter_id)}` : ''}</div>
              </div>
              <span className="text-[11px] text-outline">{new Date(u.created_at).toLocaleDateString()}</span>
            </div>
          ))}
          {users.length === 0 && <div className="text-sm text-outline-variant">No users yet.</div>}
        </div>
      </div>

      {tempPw && (
        <div className="mt-4 rounded-xl border border-[#0d631b]/40 bg-[#e8f5e9] p-4">
          <div className="font-semibold text-[#0c5216] flex items-center gap-1.5"><span className="material-symbols-outlined text-[18px]">key</span> User created — share these credentials once</div>
          <div className="text-sm mt-1">Email: <span className="font-mono">{tempPw.email}</span></div>
          <div className="text-sm">Temporary password: <span className="font-mono font-bold">{tempPw.password}</span></div>
          <p className="text-xs text-on-surface-variant mt-1">The user should sign in and change this password. This is shown only once.</p>
          <button onClick={() => setTempPw(null)} className="mt-2 text-xs text-[#0d631b] hover:underline">Dismiss</button>
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center p-4 z-50" onClick={() => setShowNew(false)}>
          <div className="bg-white rounded-xl border border-outline-variant w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-on-surface">Add New User</h3>
              <button onClick={() => setShowNew(false)} className="text-outline hover:text-on-surface"><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="space-y-3">
              <input value={nf.full_name} onChange={(e) => setNf({ ...nf, full_name: e.target.value })} placeholder="Full name" className="w-full border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
              <input value={nf.email} onChange={(e) => setNf({ ...nf, email: e.target.value })} type="email" placeholder="Email" className="w-full border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
              <select value={nf.role} onChange={(e) => setNf({ ...nf, role: e.target.value as AppUserRow['role'] })} className="w-full border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]">
                <option value="transporter">Transporter</option>
                <option value="officer">Ministry Staff</option>
                <option value="deputy_director">Deputy Director</option>
                <option value="director">Director</option>
                <option value="admin">System Admin</option>
              </select>
              {nf.role === 'transporter' && (
                <select value={nf.transporter_id} onChange={(e) => setNf({ ...nf, transporter_id: e.target.value })} className="w-full border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]">
                  <option value="">— select company —</option>
                  {transporters.map((t) => (<option key={t.id} value={t.id}>{t.display_name}</option>))}
                </select>
              )}
              <input value={nf.phone} onChange={(e) => setNf({ ...nf, phone: e.target.value })} placeholder="Phone (optional)" className="w-full border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowNew(false)} className="px-4 py-2 text-sm rounded-lg border border-outline-variant hover:bg-surface-container-low">Cancel</button>
              <button onClick={createUser} disabled={creating} className="px-4 py-2 text-sm rounded-lg bg-[#0d631b] text-white font-medium hover:opacity-90 disabled:opacity-50">{creating ? 'Creating…' : 'Create user'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small shared UI bits ─────────────────────────────────────────────────────
function initials(name?: string | null): string {
  const w = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase();
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return '—';
}
const AVATAR_BG = ['bg-[#1b5e20]', 'bg-[#0d631b]', 'bg-[#2e7d32]', 'bg-[#4a6572]', 'bg-[#5d4037]'];
function avatarColor(seed: string): string {
  let n = 0;
  for (const c of seed) n = (n + c.charCodeAt(0)) % AVATAR_BG.length;
  return AVATAR_BG[n];
}
function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'default' | 'alert' }) {
  return (
    <div className="bg-white rounded-xl border border-outline-variant p-4">
      <div className="text-[11px] font-bold tracking-wide text-on-surface-variant uppercase">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${tone === 'alert' ? 'text-error' : 'text-[#0d631b]'}`}>{value}</div>
      {sub && <div className={`text-xs mt-1 ${tone === 'alert' ? 'text-error' : 'text-on-surface-variant'}`}>{sub}</div>}
    </div>
  );
}

interface AuditRow { id: number; actor_id: string | null; action: string; entity: string; entity_id: string | null; before: unknown; after: unknown; created_at: string; }

/** Map an audit action to a status chip like the Reports design. */
function auditStatus(action: string): { label: string; cls: string } {
  if (action === 'void' || action.includes('disapprov') || action.includes('fail')) return { label: 'Failed', cls: 'bg-error-container text-error' };
  if (action.includes('review') || action === 'modified' || action === 'update') return { label: 'Modified', cls: 'bg-surface-container-high text-on-surface-variant' };
  if (action === 'lock') return { label: 'Locked', cls: 'bg-surface-container-high text-on-surface-variant' };
  return { label: 'Success', cls: 'bg-[#acf4a4] text-[#0c5216]' };
}

function Reports() {
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [names, setNames] = useState<Record<string, { name: string; role: string }>>({});
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<AuditRow | null>(null);
  const PAGE = 25;

  useEffect(() => {
    supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(500).then(({ data }) => setLogs((data as AuditRow[]) ?? []));
    supabase.from('audit_log').select('*', { count: 'exact', head: true }).then(({ count }) => setTotal(count ?? 0));
    supabase.from('app_users').select('id, full_name, role').then(({ data }) => {
      const m: Record<string, { name: string; role: string }> = {};
      for (const u of (data ?? []) as { id: string; full_name: string | null; role: string }[]) m[u.id] = { name: u.full_name ?? 'Unnamed', role: u.role };
      setNames(m);
    });
  }, []);

  const dayAgo = Date.now() - 864e5;
  const events24 = logs.filter((l) => new Date(l.created_at).getTime() > dayAgo);
  const activeUsers = new Set(events24.map((l) => l.actor_id).filter(Boolean)).size;
  const advances24 = events24.filter((l) => ALL_STAGES_SOME(l.action)).length;

  const actions = [...new Set(logs.map((l) => l.action))].sort();
  const actor = (id: string | null) => (id ? names[id]?.name ?? id.slice(0, 8) : 'System');

  const filtered = logs.filter((l) => {
    if (action && l.action !== action) return false;
    const t = new Date(l.created_at).getTime();
    if (from && t < new Date(from).getTime()) return false;
    if (to && t > new Date(to).getTime() + 864e5) return false;
    if (q) {
      const hay = `${actor(l.actor_id)} ${l.action} ${l.entity} ${l.entity_id ?? ''}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);

  // Hourly action frequency over the last 24h (bucketed by hour of day).
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const l of events24) hourly[new Date(l.created_at).getHours()]++;
  const peak = Math.max(1, ...hourly);

  function exportCsv() {
    const rows = [['timestamp', 'actor', 'action', 'entity', 'entity_id', 'after'],
      ...filtered.map((l) => [new Date(l.created_at).toISOString(), actor(l.actor_id), l.action, l.entity, l.entity_id ?? '', l.after ? JSON.stringify(l.after) : ''])];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `htms_audit_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h2 className="text-xl font-semibold text-on-surface">Audit Trail &amp; Logs</h2>
          <p className="text-sm text-on-surface-variant max-w-xl">Oversight for Ministry of Energy haulage logistics — every modification, approval and system event across the 11-step pipeline.</p>
        </div>
        <button onClick={exportCsv} className="shrink-0 flex items-center gap-1.5 bg-[#0d631b] hover:opacity-90 text-white rounded-lg px-4 py-2.5 text-sm font-medium">
          <span className="material-symbols-outlined text-[18px]">download</span> Export Audit Log
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Total Events (24h)" value={events24.length.toLocaleString()} sub={`${total.toLocaleString()} all-time`} />
        <StatCard label="Stage Advances (24h)" value={advances24.toLocaleString()} sub="pipeline transitions" />
        <StatCard label="Active Users (24h)" value={activeUsers.toLocaleString()} sub="distinct actors" />
        <StatCard label="Loaded Window" value={logs.length.toLocaleString()} sub="most recent events" />
      </div>

      <div className="bg-surface-container-low/60 rounded-xl border border-outline-variant p-3 mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="relative">
          <span className="material-symbols-outlined text-[18px] absolute left-2 top-2.5 text-outline">search</span>
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search actor, action, entity, ID…" className="w-full border border-outline-variant rounded-lg pl-8 pr-3 py-2 text-sm outline-none focus:border-[#0d631b]" />
        </div>
        <select value={action} onChange={(e) => { setAction(e.target.value); setPage(0); }} className="border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0d631b]">
          <option value="">All actions</option>
          {actions.map((a) => (<option key={a} value={a}>{a}</option>))}
        </select>
        <div className="flex items-center gap-2">
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} className="border border-outline-variant rounded-lg px-2 py-2 text-sm outline-none focus:border-[#0d631b] w-full" />
          <span className="text-outline text-xs">–</span>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} className="border border-outline-variant rounded-lg px-2 py-2 text-sm outline-none focus:border-[#0d631b] w-full" />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-outline-variant overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-left">
            <tr>
              {['Timestamp', 'Actor', 'Action', 'Entity ID', 'Status', 'Details'].map((h) => (
                <th key={h} className="px-4 py-3 text-[11px] font-bold tracking-wide text-on-surface-variant uppercase whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {shown.map((l) => {
              const st = auditStatus(l.action);
              const nm = actor(l.actor_id);
              return (
                <tr key={l.id} className="hover:bg-surface-container-low">
                  <td className="px-4 py-3 text-xs text-outline whitespace-nowrap">{new Date(l.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`w-7 h-7 rounded-full grid place-items-center text-[10px] font-bold text-white ${avatarColor(nm)}`}>{initials(nm)}</span>
                      <div className="leading-tight">
                        <div className="font-medium text-on-surface">{nm}</div>
                        <div className="text-[11px] text-outline capitalize">{l.actor_id ? names[l.actor_id]?.role ?? '—' : 'automated'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">{l.action}</td>
                  <td className="px-4 py-3 text-xs font-mono text-[#0d631b]">{l.entity}/{l.entity_id?.slice(0, 8) ?? '-'}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${st.cls}`}>{st.label}</span></td>
                  <td className="px-4 py-3 text-xs">
                    <button onClick={() => setDetail(l)} className="text-[#0d631b] hover:underline font-medium">View JSON</button>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-outline-variant">No events match your filters.</td></tr>}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-4 py-3 border-t border-outline-variant text-xs text-on-surface-variant">
          <span>Showing {filtered.length === 0 ? 0 : page * PAGE + 1}–{Math.min((page + 1) * PAGE, filtered.length)} of {filtered.length.toLocaleString()} entries</span>
          <div className="flex items-center gap-1">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 rounded border border-outline-variant disabled:opacity-40">‹</button>
            <span className="px-2">{page + 1} / {pages}</span>
            <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 rounded border border-outline-variant disabled:opacity-40">›</button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-5">
        <div className="bg-white rounded-xl border border-outline-variant p-4">
          <h3 className="font-semibold text-on-surface mb-3">Action Frequency (last 24h, by hour)</h3>
          <div className="flex items-end gap-[3px] h-40">
            {hourly.map((c, h) => (
              <div key={h} className="flex-1 rounded-t bg-[#0d631b]" style={{ height: `${(c / peak) * 100}%`, minHeight: c ? 4 : 1, opacity: 0.35 + 0.65 * (c / peak) }} title={`${String(h).padStart(2, '0')}:00 — ${c} events`} />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-outline mt-2"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
        </div>
        <div className="bg-white rounded-xl border border-outline-variant p-4">
          <h3 className="font-semibold text-on-surface mb-3">Recent Audit Summary</h3>
          <div className="space-y-3">
            {logs.slice(0, 5).map((l) => (
              <div key={l.id} className="flex gap-3">
                <span className={`mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${auditStatus(l.action).cls.includes('error') ? 'bg-error' : 'bg-[#0d631b]'}`} />
                <div className="leading-tight">
                  <div className="text-sm font-medium text-on-surface">{l.entity}/{l.entity_id?.slice(0, 8) ?? '-'} — {l.action}</div>
                  <div className="text-xs text-outline">{actor(l.actor_id)} · {new Date(l.created_at).toLocaleString()}</div>
                </div>
              </div>
            ))}
            {logs.length === 0 && <div className="text-sm text-outline-variant">No recent activity.</div>}
          </div>
        </div>
      </div>

      {detail && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center p-4 z-50" onClick={() => setDetail(null)}>
          <div className="bg-white rounded-xl border border-outline-variant max-w-lg w-full max-h-[80vh] overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">{detail.entity} · {detail.action}</h3>
              <button onClick={() => setDetail(null)} className="text-outline hover:text-on-surface"><span className="material-symbols-outlined">close</span></button>
            </div>
            <pre className="text-xs bg-surface-container-low rounded-lg p-3 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ actor: actor(detail.actor_id), entity_id: detail.entity_id, before: detail.before, after: detail.after }, null, 2)}</pre>
          </div>
        </div>
      )}
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
