import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';
import { SCAN_ALLOWED_MIME, SCAN_MAX_BYTES, SCAN_TYPES, type ScanType } from '../../shared/validation';

interface Origin { id: number; name: string }
interface District { id: number; name: string; region: string | null }
interface ScanRow { id: string; waybill_id: string; scan_type: string; storage_path: string; mime_type: string; byte_size: number }

interface DbWaybill {
  id: string;
  transporter_id: string;
  category: string;
  waybill_no: string;
  vehicle_no: string | null;
  origin_id: number;
  district_id: number;
  num_poles: number;
  num_stay_blocks: number;
  num_concrete_poles: number;
  truck_size: string | null;
  num_trips: number;
  waybill_date: string;
}

interface EditWb extends DbWaybill {
  destinations: number[];
  scans: ScanRow[];
  scanFiles: Record<ScanType, File | null>;
  removeScanIds: string[];
}

const SCAN_LABELS: Record<ScanType, string> = {
  acknowledgement: 'Acknowledgement form',
  waybill: 'Waybill',
  release_letter: 'Release letter',
};

export default function InvoiceEditor({
  invoiceId,
  transporterId,
  onSaved,
  onError,
}: {
  invoiceId: string;
  transporterId: string;
  onSaved: (newTotal: number) => void;
  onError: (msg: string | null) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [origSnapshot, setOrigSnapshot] = useState<Map<string, EditWb> | null>(null);
  const [rows, setRows] = useState<EditWb[]>([]);
  const [origins, setOrigins] = useState<Origin[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [region, setRegion] = useState('');
  const [districtPick, setDistrictPick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, d, inv] = await Promise.all([
        supabase.from('origins').select('id,name'),
        supabase.from('districts').select('id,name,region').order('name'),
        supabase.from('invoice_lines').select('waybill_id').eq('invoice_id', invoiceId),
      ]);
      const wbIds = ((inv.data ?? []) as { waybill_id: string }[]).map((r) => r.waybill_id);
      if (!wbIds.length) {
        setRows([]);
        setOrigSnapshot(null);
        return;
      }
      const [w, wd, sc] = await Promise.all([
        supabase.from('waybills').select('*').in('id', wbIds),
        supabase.from('waybill_destinations').select('waybill_id, district_id').in('waybill_id', wbIds),
        supabase.from('scans').select('id, waybill_id, scan_type, storage_path, mime_type, byte_size').in('waybill_id', wbIds),
      ]);
      const destByWb = new Map<string, number[]>();
      for (const x of (wd.data ?? []) as { waybill_id: string; district_id: number }[]) {
        destByWb.set(x.waybill_id, [...(destByWb.get(x.waybill_id) ?? []), x.district_id]);
      }
      const scanByWb = new Map<string, ScanRow[]>();
      for (const x of (sc.data ?? []) as ScanRow[]) {
        scanByWb.set(x.waybill_id, [...(scanByWb.get(x.waybill_id) ?? []), x]);
      }
      const loaded: EditWb[] = ((w.data ?? []) as DbWaybill[]).map((wb) => ({
        ...wb,
        destinations: destByWb.get(wb.id) ?? [wb.district_id],
        scans: scanByWb.get(wb.id) ?? [],
        scanFiles: { acknowledgement: null, waybill: null, release_letter: null },
        removeScanIds: [],
      }));
      setRows(loaded);
      setOrigSnapshot(new Map(loaded.map((r) => [r.id, { ...r, scans: [...r.scans] }])));
      setOrigins((o.data ?? []) as Origin[]);
      setDistricts((d.data ?? []) as District[]);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [invoiceId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const originMap = useMemo(() => new Map(origins.map((x) => [x.id, x.name])), [origins]);
  const districtMap = useMemo(() => new Map(districts.map((x) => [x.id, x])), [districts]);
  const regionOptions = useMemo(
    () => Array.from(new Set(districts.map((d) => d.region).filter(Boolean))).sort() as string[],
    [districts],
  );
  const districtOptions = useMemo(() => districts.filter((d) => !region || d.region === region), [districts, region]);

  function patch(id: string, p: Partial<EditWb>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }

  function setCategory(id: string, category: string) {
    setRows((rs) =>
      rs.map((r) =>
        r.id === id
          ? {
              ...r,
              category,
              // Zero counts that don't apply after a category switch (mirrors WaybillEntry).
              num_poles: category === 'Poles' ? r.num_poles : 0,
              num_concrete_poles: category === 'Concrete Poles' ? r.num_concrete_poles : 0,
              num_stay_blocks: category !== 'Material' ? r.num_stay_blocks : 0,
              truck_size: category === 'Material' ? r.truck_size : null,
              num_trips: category === 'Material' ? r.num_trips : 1,
            }
          : r,
      ),
    );
  }

  function addDestination(id: string) {
    const d = districts.find((x) => x.id === Number(districtPick));
    if (!d) return;
    const row = rows.find((r) => r.id === id);
    if (!row || row.destinations.includes(d.id)) return;
    patch(id, { destinations: [...row.destinations, d.id] });
    setDistrictPick(0);
  }
  function removeDestination(id: string, distId: number) {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    patch(id, { destinations: row.destinations.filter((x) => x !== distId) });
  }

  function removeScan(id: string, scan: ScanRow) {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    patch(id, {
      scans: row.scans.filter((s) => s.id !== scan.id),
      removeScanIds: [...row.removeScanIds, scan.id],
    });
  }

  function setScanFile(id: string, type: ScanType, file: File | null) {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    patch(id, { scanFiles: { ...row.scanFiles, [type]: file } });
  }

  function applyCounts(line: Record<string, unknown>, row: EditWb) {
    line.numPoles = row.category === 'Poles' ? Number(row.num_poles) : 0;
    line.numStayBlocks = row.category !== 'Material' ? Number(row.num_stay_blocks) : 0;
    line.numConcretePoles = row.category === 'Concrete Poles' ? Number(row.num_concrete_poles) : 0;
    line.numTrips = Number(row.num_trips);
    line.truckSize = row.category === 'Material' ? Number(row.truck_size) : null;
  }

  async function buildChange(row: EditWb): Promise<Record<string, unknown> | null> {
    const orig = origSnapshot?.get(row.id) ?? row;
    const line: Record<string, unknown> = { waybillId: row.id };
    if (row.waybill_no !== orig.waybill_no) line.waybillNo = row.waybill_no;
    if (row.vehicle_no !== orig.vehicle_no) line.vehicleNo = row.vehicle_no || null;
    if (row.category !== orig.category) line.category = row.category;
    if (row.waybill_date !== orig.waybill_date) line.waybillDate = row.waybill_date;
    const destChanged = JSON.stringify(row.destinations) !== JSON.stringify(orig.destinations);
    if (destChanged) {
      const sorted = [...row.destinations];
      line.districtId = sorted[0];
      line.destinationDistrictIds = sorted.slice(1);
    }
    const countsChanged = ['num_poles', 'num_stay_blocks', 'num_concrete_poles', 'num_trips', 'truck_size'].some(
      (k) => (row as unknown as Record<string, unknown>)[k] !== (orig as unknown as Record<string, unknown>)[k],
    );
    if (row.category !== orig.category || countsChanged) applyCounts(line, row);

    const addScans: { scanType: ScanType; storagePath: string; mimeType: string; byteSize: number }[] = [];
    const removeScanIds = [...row.removeScanIds];
    for (const t of SCAN_TYPES) {
      const file = row.scanFiles[t];
      if (!file) continue;
      // A file uploaded over an existing scan of the same type replaces it.
      const existing = row.scans.find((s) => s.scan_type === t);
      if (existing && !row.removeScanIds.includes(existing.id)) removeScanIds.push(existing.id);
      const safeName = file.name.replace(/[^\w.-]+/g, '_');
      const storagePath = `${transporterId}/${row.id}/${t}-${Date.now()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from('scans').upload(storagePath, file, { contentType: file.type });
      if (upErr) throw new Error(`${SCAN_LABELS[t]} upload: ${upErr.message}`);
      addScans.push({ scanType: t, storagePath, mimeType: file.type || 'application/octet-stream', byteSize: file.size });
    }
    if (addScans.length) line.addScans = addScans;
    if (removeScanIds.length) line.removeScanIds = removeScanIds;
    return Object.keys(line).length > 1 ? line : null;
  }

  async function save() {
    onError(null);
    setSaving(true);
    try {
      for (const row of rows) {
        for (const t of SCAN_TYPES) {
          const f = row.scanFiles[t];
          if (!f) continue;
          if (!SCAN_ALLOWED_MIME.includes(f.type as (typeof SCAN_ALLOWED_MIME)[number]))
            throw new Error('Scans must be PNG, JPEG, WebP or PDF');
          if (f.size > SCAN_MAX_BYTES) throw new Error('Each scan must be under 10 MB');
        }
      }
      await supabase.auth.refreshSession().catch(() => supabase.auth.getSession());
      const lines: Record<string, unknown>[] = [];
      for (const row of rows) {
        const line = await buildChange(row);
        if (line) lines.push(line);
      }
      if (!lines.length) throw new Error('Nothing to change — adjust a field or scan first.');
      const res = await api.editInvoice({ invoiceId, lines });
      await load();
      onSaved(res.total_cost);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    onError(null);
    setRows(origSnapshot ? Array.from(origSnapshot.values()).map((r) => ({ ...r, scans: [...r.scans] })) : []);
  }

  if (loading) return <div className="text-sm text-outline p-4">Loading waybills…</div>;
  if (!rows.length) return <div className="text-sm text-on-surface p-4">No waybills on this invoice.</div>;

  return (
    <div className="bg-surface-container-low border border-outline-variant rounded-xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-outlined text-lg text-[#0d631b]">edit_note</span>
        <span className="text-xs font-bold tracking-wide text-on-surface-variant uppercase">Edit Invoice (Generated)</span>
      </div>
      <p className="text-xs text-on-surface-variant mb-4">
        Correct the waybill details or supporting scans below. Costs and the invoice total are recomputed
        automatically on save.
      </p>

      <div className="space-y-4 mb-4">
        {rows.map((row) => (
          <div key={row.id} className="bg-white border border-outline-variant rounded-xl p-4">
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <span className="text-xs font-semibold text-on-surface-variant uppercase">Waybill {row.waybill_no}</span>
              <span className="text-xs text-outline">{originMap.get(row.origin_id) ?? `Origin ${row.origin_id}`}</span>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1">Waybill No(s).</label>
                <input className="input" value={row.waybill_no} onChange={(e) => patch(row.id, { waybill_no: e.target.value })} />
              </div>

              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1">Category</label>
                <div className="flex gap-1">
                  {(['Poles', 'Material', 'Concrete Poles'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCategory(row.id, c)}
                      className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                        row.category === c ? 'bg-[#2e7d32] text-white border-[#2e7d32]' : 'bg-white text-on-surface border-outline-variant'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1">To (district) — add one or more</label>
                <div className="flex gap-2">
                  <select className="input" value={region} onChange={(e) => { setRegion(e.target.value); setDistrictPick(0); }}>
                    <option value="">All regions</option>
                    {regionOptions.map((r) => (<option key={r}>{r}</option>))}
                  </select>
                  <select className="input shrink-0 w-40" value={districtPick} onChange={(e) => setDistrictPick(Number(e.target.value))}>
                    <option value={0}>Select…</option>
                    {districtOptions.map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
                  </select>
                  <button type="button" onClick={() => addDestination(row.id)} className="bg-[#2e7d32] text-white rounded-lg px-3 text-sm whitespace-nowrap hover:opacity-90">Add</button>
                </div>
                {row.destinations.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {row.destinations.map((did) => (
                      <span key={did} className="bg-[#e8f5e9] text-[#1b5e20] text-xs rounded-full px-2.5 py-1 flex items-center gap-1">
                        {districtMap.get(did)?.name ?? `District ${did}`}
                        <button type="button" onClick={() => removeDestination(row.id, did)} className="font-bold">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                {row.category === 'Poles' && (
                  <Field label="No. of Wooden Poles">
                    <input type="number" min={0} className="input" value={row.num_poles} onChange={(e) => patch(row.id, { num_poles: Number(e.target.value) })} />
                  </Field>
                )}
                {row.category !== 'Material' && (
                  <Field label="No. of Stay Blocks">
                    <input type="number" min={0} className="input" value={row.num_stay_blocks} onChange={(e) => patch(row.id, { num_stay_blocks: Number(e.target.value) })} />
                  </Field>
                )}
                {row.category === 'Concrete Poles' && (
                  <Field label="No. of Concrete Poles">
                    <input type="number" min={0} className="input" value={row.num_concrete_poles} onChange={(e) => patch(row.id, { num_concrete_poles: Number(e.target.value) })} />
                  </Field>
                )}
                {row.category === 'Material' && (
                  <>
                    <Field label="Truck size">
                      <select className="input" value={row.truck_size ?? '40'} onChange={(e) => patch(row.id, { truck_size: e.target.value })}>
                        <option value="20">20ft</option>
                        <option value="40">40ft</option>
                      </select>
                    </Field>
                    <Field label="No. of Trips">
                      <input type="number" min={1} className="input" value={row.num_trips} onChange={(e) => patch(row.id, { num_trips: Number(e.target.value) })} />
                    </Field>
                  </>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-2">Supporting scans</label>
                <div className="space-y-2">
                  {SCAN_TYPES.map((t) => {
                    const existing = row.scans.find((s) => s.scan_type === t);
                    const pending = row.scanFiles[t];
                    return (
                      <div key={t} className="flex items-center gap-2 border border-outline-variant rounded-lg px-3 py-2">
                        <span className="text-xs font-medium text-on-surface min-w-[7rem]">{SCAN_LABELS[t]}</span>
                        <span className="flex-1 text-xs text-outline truncate">
                          {pending ? <span className="text-[#0d631b]">{pending.name}</span> : existing ? existing.storage_path.split('/').pop() : '—'}
                        </span>
                        <label className="shrink-0 text-xs text-[#0d631b] cursor-pointer hover:underline">
                          {existing ? 'Replace' : 'Upload'}
                          <input type="file" accept=".pdf,image/png,image/jpeg,image/webp" className="hidden"
                            onChange={(e) => { setScanFile(row.id, t, e.target.files?.[0] ?? null); e.target.value = ''; }} />
                        </label>
                        {existing && !pending && (
                          <button type="button" onClick={() => removeScan(row.id, existing)} className="shrink-0 text-error text-sm" title="Remove scan">
                            <span className="material-symbols-outlined text-[16px]">delete</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <button type="button" onClick={discard} disabled={saving} className="border border-outline-variant rounded-lg px-4 py-2 text-sm text-on-surface-variant hover:bg-white disabled:opacity-50">
          Discard
        </button>
        <button type="button" onClick={save} disabled={saving} className="bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-5 py-2 text-sm font-medium disabled:opacity-50 ml-auto">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      <style>{`.input{width:100%;border:1px solid #bfcaba;border-radius:8px;padding:8px 12px;font-size:14px;outline:none;background:#fff}.input:focus{border-color:#0d631b;box-shadow:0 0 0 2px rgba(13,99,27,0.2)}`}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-on-surface-variant mb-1">{label}</span>
      {children}
    </label>
  );
}