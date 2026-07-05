import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

const ghs = (n: number) =>
  '₵' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Row {
  id: string;
  category: string;
  waybill_date: string;
  waybill_no: string;
  vehicle_no: string;
  num_poles: number;
  num_trips: number;
  truck_size: string | null;
  transporters?: { display_name: string };
  districts?: { name: string };
  origins?: { name: string };
  cost?: number | null;
}

export default function Dashboard() {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [transporter, setTransporter] = useState('');

  useEffect(() => {
    api
      .listWaybills()
      .then((d) => setRows((d.waybills ?? []) as Row[]))
      .catch((e) => setErr(e.message));
  }, []);

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!q || r.waybill_no?.toLowerCase().includes(q.toLowerCase())) &&
          (!cat || r.category === cat) &&
          (!transporter || r.transporters?.display_name === transporter),
      ),
    [rows, q, cat, transporter],
  );

  const totals = useMemo(() => {
    let all = 0,
      poles = 0,
      materials = 0;
    for (const r of filtered) {
      const c = Number(r.cost ?? 0);
      all += c;
      if (r.category === 'Material') materials += c;
      else poles += c;
    }
    return { all, poles, materials };
  }, [filtered]);

  const transporters = useMemo(
    () => Array.from(new Set(rows.map((r) => r.transporters?.display_name).filter(Boolean))) as string[],
    [rows],
  );

  return (
    <div>
      {err && <div className="mb-4 text-sm text-error bg-error-container p-3 rounded-lg flex items-center gap-2">{err}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card label="Haulage Cost" value={ghs(totals.all)} icon="payments" />
        <Card label="Haulage Cost (Poles)" value={ghs(totals.poles)} icon="landslide" />
        <Card label="Haulage Cost (Materials)" value={ghs(totals.materials)} icon="inventory_2" />
      </div>

      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline-variant text-lg">
            search
          </span>
          <input
            placeholder="Waybill No."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-52 h-10 pl-10 pr-3 border border-outline-variant rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#0d631b]"
          />
        </div>
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="h-10 border border-outline-variant rounded-lg px-3 text-sm outline-none focus:ring-2 focus:ring-[#0d631b]">
          <option value="">All categories</option>
          <option>Poles</option>
          <option>Material</option>
          <option>Concrete Poles</option>
        </select>
        <select
          value={transporter}
          onChange={(e) => setTransporter(e.target.value)}
          className="h-10 border border-outline-variant rounded-lg px-3 text-sm outline-none focus:ring-2 focus:ring-[#0d631b]"
        >
          <option value="">All transporters</option>
          {transporters.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>

      <div className="overflow-auto bg-white rounded-lg border border-outline-variant">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-left">
            <tr>
              {['Category', 'Date', 'From', 'To', 'Transporter', 'Truck', 'Poles', 'Trips', 'Waybill No.', 'Vehicle No.', 'Haulage Cost'].map(
                (h) => (
                  <th key={h} className="px-3 py-3 font-semibold text-on-surface-variant tracking-wider text-[11px] uppercase whitespace-nowrap">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-t border-outline-variant hover:bg-surface-container-low transition-colors">
                <td className="px-3 py-3">{r.category}</td>
                <td className="px-3 py-3 whitespace-nowrap">{r.waybill_date}</td>
                <td className="px-3 py-3">{r.origins?.name}</td>
                <td className="px-3 py-3">{r.districts?.name}</td>
                <td className="px-3 py-3">{r.transporters?.display_name}</td>
                <td className="px-3 py-3">{r.truck_size ?? '-'}</td>
                <td className="px-3 py-3">{r.num_poles || '-'}</td>
                <td className="px-3 py-3">{r.num_trips || '-'}</td>
                <td className="px-3 py-3 whitespace-nowrap font-medium">{r.waybill_no}</td>
                <td className="px-3 py-3">{r.vehicle_no}</td>
                <td className="px-3 py-3 whitespace-nowrap font-mono text-sm">{r.cost != null ? ghs(r.cost) : '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-outline-variant">
                  No waybills found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({ label, value, icon }: { label: string; value: string; icon?: string }) {
  return (
    <div className="bg-white rounded-lg border border-outline-variant p-5">
      <div className="flex items-center gap-2 mb-1">
        {icon && <span className="material-symbols-outlined text-outline text-lg">{icon}</span>}
        <div className="text-[11px] font-bold tracking-[0.05em] uppercase text-outline">{label}</div>
      </div>
      <div className="text-3xl font-bold text-[#0d631b] mt-1">{value}</div>
    </div>
  );
}
