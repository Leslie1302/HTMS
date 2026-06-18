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
  // computed cost is joined from the latest invoice line if present; else null
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
      <h1 className="text-xl font-bold text-ministry-dark mb-4">Haulage Invoices</h1>
      {err && <div className="mb-4 text-sm text-red-600 bg-red-50 p-2 rounded">{err}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card label="Haulage Cost" value={ghs(totals.all)} />
        <Card label="Haulage Cost (Poles)" value={ghs(totals.poles)} />
        <Card label="Haulage Cost (Materials)" value={ghs(totals.materials)} />
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <input
          placeholder="Waybill No."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="border rounded px-3 py-2 text-sm"
        />
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="border rounded px-3 py-2 text-sm">
          <option value="">All categories</option>
          <option>Poles</option>
          <option>Material</option>
          <option>Concrete Poles</option>
        </select>
        <select
          value={transporter}
          onChange={(e) => setTransporter(e.target.value)}
          className="border rounded px-3 py-2 text-sm"
        >
          <option value="">All transporters</option>
          {transporters.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>

      <div className="overflow-auto bg-white rounded-lg shadow">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              {['Category', 'Date', 'From', 'To', 'Transporter', 'Truck', 'Poles', 'Trips', 'Waybill No.', 'Vehicle No.', 'Haulage Cost'].map(
                (h) => (
                  <th key={h} className="px-3 py-2 font-semibold whitespace-nowrap">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2">{r.category}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.waybill_date}</td>
                <td className="px-3 py-2">{r.origins?.name}</td>
                <td className="px-3 py-2">{r.districts?.name}</td>
                <td className="px-3 py-2">{r.transporters?.display_name}</td>
                <td className="px-3 py-2">{r.truck_size ?? '-'}</td>
                <td className="px-3 py-2">{r.num_poles || '-'}</td>
                <td className="px-3 py-2">{r.num_trips || '-'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.waybill_no}</td>
                <td className="px-3 py-2">{r.vehicle_no}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.cost != null ? ghs(r.cost) : '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-gray-400">
                  No waybills.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg shadow border-l-4 border-ministry p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-ministry-dark mt-1">{value}</div>
    </div>
  );
}
