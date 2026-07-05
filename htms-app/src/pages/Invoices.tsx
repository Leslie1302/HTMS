import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import { buildInvoice, buildLetter, loadLogo, invoiceRef, type InvoiceDoc } from '../lib/pdf';
import { appendScansToPdf, downloadBytes, type ScanInput } from '../lib/mergeScans';
import { ALL_STAGES, STAGE_MAP, STAGE_LABELS, type PriStage } from '../../shared/lifecycle';
import { CHECKLIST_ITEMS } from '../../shared/validation';

const SCAN_LABELS: Record<string, string> = {
  acknowledgement: 'Acknowledgement form',
  waybill: 'Waybill',
  release_letter: 'Release letter',
};

const ghs = (n: number) =>
  '₵' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface AuditTrailEntry {
  id: number;
  actor_id: string;
  action: string;
  created_at: string;
  after: { stage?: string };
}

interface InvoiceRow {
  id: string;
  reference_no: string | null;
  transporter_id: string;
  total_cost: number;
  status: string;
  stage: string;
  checklist: Record<string, boolean>;
  transporters?: { display_name: string };
  invoice_lines?: unknown[];
  created_at: string;
}

export default function Invoices() {
  const { profile } = useAuth();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [transporters, setTransporters] = useState<{ id: string; name: string }[]>([]);
  const [pick, setPick] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trail, setTrail] = useState<AuditTrailEntry[]>([]);
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});

  function load() {
    api
      .listInvoices()
      .then((d) => setInvoices(d.invoices ?? []))
      .catch((e) => setErr(e.message));
  }
  useEffect(load, []);
  useEffect(() => {
    supabase
      .from('transporters')
      .select('id,name:display_name')
      .order('display_name')
      .then(({ data }) => setTransporters((data as { id: string; name: string }[]) ?? []));
  }, []);

  const selected = invoices.find((i) => i.id === selectedId) ?? null;

  const loadDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setErr(null);
    try {
      const res = await fetch(`/api/invoice-stage?id=${id}`, {
        headers: { authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const inv = data.invoice;
      setTrail(data.trail ?? []);
      setChecklist(inv.checklist ?? {});
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  async function updateChecklist(key: string, value: boolean) {
    if (!selectedId) return;
    const next = { ...checklist, [key]: value };
    setChecklist(next);
    const { error } = await supabase.from('invoices').update({ checklist: next }).eq('id', selectedId);
    if (error) setErr(error.message);
  }

  async function advanceStage(invoiceId: string, targetStage: string) {
    setBusy(true);
    setErr(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch('/api/invoice-stage', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoiceId, stage: targetStage }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMsg(`Advanced to ${STAGE_LABELS[targetStage as PriStage] ?? targetStage}`);
      load();
      if (selectedId) loadDetail(selectedId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function assemble() {
    if (!pick) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const { waybills } = await api.listWaybills();
      const ids = (waybills ?? [])
        .filter((w: any) => w.transporter_id === pick && w.status !== 'invoiced')
        .map((w: any) => w.id);
      if (!ids.length) throw new Error('No un-invoiced waybills for that transporter');
      await api.createInvoice({ transporterId: pick, waybillIds: ids });
      setMsg(`Invoice assembled from ${ids.length} waybill(s).`);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: 'approve' | 'lock' | 'void') {
    setBusy(true);
    try {
      await api.approveInvoice(id, action);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeDoc(id: string, type: 'invoice' | 'letter') {
    setBusy(true);
    setErr(null);
    try {
      const { data: inv, error } = await supabase
        .from('invoices')
        .select(
          '*, transporters(display_name,address,email,phone,gps_address), invoice_lines(*, waybills(waybill_no,vehicle_no,waybill_date,num_trips,districts(name),origins(name), scans(storage_path,mime_type,scan_type)))',
        )
        .eq('id', id)
        .single();
      if (error || !inv) throw new Error(error?.message ?? 'Invoice not found');

      const logo = await loadLogo();
      const doc = type === 'invoice' ? buildInvoice(inv as InvoiceDoc, logo) : buildLetter(inv as InvoiceDoc, logo);
      const baseBytes = doc.output('arraybuffer') as ArrayBuffer;

      const scans: ScanInput[] = [];
      for (const line of (inv as any).invoice_lines ?? []) {
        for (const s of line.waybills?.scans ?? []) {
          const { data: blob } = await supabase.storage.from('scans').download(s.storage_path);
          if (blob) {
            scans.push({
              bytes: await blob.arrayBuffer(),
              mime: s.mime_type || blob.type,
              label: SCAN_LABELS[s.scan_type] ?? 'Supporting scan',
            });
          }
        }
      }

      const merged = await appendScansToPdf(baseBytes, scans);
      const prefix = type === 'invoice' ? 'Invoice' : 'Payment_Request';
      downloadBytes(merged, `${prefix}_${invoiceRef(inv as InvoiceDoc)}.pdf`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const currentStageIdx = selected ? ALL_STAGES.indexOf(selected.stage as PriStage) : -1;
  const nextStage = selected ? STAGE_MAP[selected.stage as PriStage] : null;
  const checklistAll = CHECKLIST_ITEMS.every((k) => checklist[k]);
  const isTransporter = profile?.role === 'transporter';

  return (
    <div>
      {err && <div className="mb-4 text-sm text-error bg-error-container p-3 rounded-lg flex items-center gap-2">{err}</div>}
      {msg && <div className="mb-4 text-sm text-[#0d631b] bg-[#e8f5e9] p-3 rounded-lg flex items-center gap-2">{msg}</div>}

      {!isTransporter && (
        <div className="mb-5 flex gap-2 items-center bg-white rounded-lg border border-outline-variant p-3">
          <span className="text-xs font-medium text-on-surface-variant">Assemble invoice for:</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none">
            <option value="">Select transporter…</option>
            {transporters.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button
            onClick={assemble}
            disabled={busy || !pick}
            className="bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Assemble invoice'}
          </button>
          <span className="text-xs text-outline">Groups un-invoiced waybills into one invoice.</span>
        </div>
      )}

      {/* Pipeline stepper for selected invoice */}
      {selected && (
        <div className="bg-white rounded-lg border border-outline-variant p-5 mb-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-on-surface">
                Invoice {selected.reference_no ?? selected.id.slice(0, 8)}
              </h2>
              <p className="text-sm text-on-surface-variant">{selected.transporters?.display_name}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => makeDoc(selected.id, 'invoice')} className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-1.5 text-xs hover:bg-surface-container-low" disabled={busy}>
                <span className="material-symbols-outlined text-sm">description</span> Invoice
              </button>
              <button onClick={() => makeDoc(selected.id, 'letter')} className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-1.5 text-xs hover:bg-surface-container-low" disabled={busy}>
                <span className="material-symbols-outlined text-sm">mail</span> Letter
              </button>
              {profile?.role === 'admin' && selected.status === 'draft' && (
                <button onClick={() => act(selected.id, 'approve')} className="flex items-center gap-1 border border-[#0d631b] text-[#0d631b] rounded-lg px-3 py-1.5 text-xs hover:bg-[#e8f5e9]" disabled={busy}>
                  <span className="material-symbols-outlined text-sm">check</span> Approve
                </button>
              )}
              {profile?.role === 'admin' && selected.status === 'approved' && (
                <button onClick={() => act(selected.id, 'lock')} className="flex items-center gap-1 border border-[#0d631b] text-[#0d631b] rounded-lg px-3 py-1.5 text-xs hover:bg-[#e8f5e9]" disabled={busy}>
                  <span className="material-symbols-outlined text-sm">lock</span> Lock
                </button>
              )}
            </div>
          </div>

          {/* 11-step horizontal stepper */}
          <div className="overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin' }}>
            <div className="flex items-start min-w-[1000px]">
              {ALL_STAGES.map((stage, idx) => {
                const isCompleted = idx < currentStageIdx;
                const isCurrent = idx === currentStageIdx;
                return (
                  <div key={stage} className="flex items-center flex-1 last:flex-none">
                    <div className="flex flex-col items-center w-28 text-center">
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center mb-1 ${
                          isCompleted
                            ? 'bg-[#0d631b] text-white'
                            : isCurrent
                              ? 'bg-white border-4 border-[#0d631b] ring-4 ring-[#0d631b]/20'
                              : 'bg-[#dce2f7] text-outline'
                        }`}
                      >
                        {isCompleted ? (
                          <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                        ) : (
                          <span className="text-xs font-bold">{idx + 1}</span>
                        )}
                      </div>
                      <span className={`text-[10px] font-bold tracking-wide ${isCurrent ? 'text-[#0d631b]' : 'text-outline'}`}>
                        {STAGE_LABELS[stage].replace('Power Directorate', 'Power Dir.')}
                      </span>
                      {isCurrent && (
                        <span className="text-[9px] text-[#0d631b] mt-0.5">Current</span>
                      )}
                    </div>
                    {idx < ALL_STAGES.length - 1 && (
                      <div className={`flex-1 h-[2px] mt-3.5 mx-1 ${isCompleted ? 'bg-[#0d631b]' : 'bg-[#e5e7eb]'}`} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Two-column detail: trail + checklist */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
            {/* Audit trail */}
            <div>
              <h3 className="text-xs font-bold tracking-wide text-outline uppercase mb-3">Status History</h3>
              <div className="space-y-2">
                {trail.length === 0 && (
                  <p className="text-sm text-outline-variant italic">No transitions yet.</p>
                )}
                {trail.map((t) => (
                  <div key={t.id} className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-[#0d631b] mt-2 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-on-surface">
                        {STAGE_LABELS[t.action as PriStage] ?? t.action}
                      </div>
                      <div className="text-xs text-outline">
                        {new Date(t.created_at).toLocaleString('en-GH', {
                          day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Checklist + Advance */}
            <div>
              <h3 className="text-xs font-bold tracking-wide text-outline uppercase mb-3">Checklist</h3>
              <div className="space-y-2 mb-4">
                {CHECKLIST_ITEMS.map((k) => (
                  <label
                    key={k}
                    className="flex items-center gap-3 p-2 bg-surface rounded-lg cursor-pointer border border-transparent hover:border-outline-variant transition-all"
                  >
                    <input
                      type="checkbox"
                      checked={!!checklist[k]}
                      onChange={(e) => updateChecklist(k, e.target.checked)}
                      className="w-5 h-5 text-[#0d631b] border-outline-variant rounded focus:ring-[#0d631b]"
                      disabled={isTransporter && selected?.stage !== 'generated'}
                    />
                    <span className="text-sm text-on-surface">
                      {k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                  </label>
                ))}
              </div>

              {nextStage && !isTransporter && (
                <button
                  onClick={() => advanceStage(selected.id, nextStage)}
                  disabled={busy || (!checklistAll && selected.stage === 'generated')}
                  className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all ${
                    checklistAll || selected.stage !== 'generated'
                      ? 'bg-[#2e7d32] text-white hover:opacity-90'
                      : 'bg-[#dce2f7] text-outline cursor-not-allowed opacity-50'
                  }`}
                >
                  <span>Advance to {STAGE_LABELS[nextStage as PriStage]}</span>
                  <span className="material-symbols-outlined text-lg">arrow_forward</span>
                </button>
              )}
              {nextStage && selected.stage === 'generated' && !checklistAll && (
                <p className="text-center text-[11px] text-error mt-2">Complete checklist to enable advancement</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Invoice list table */}
      <div className="bg-white rounded-lg border border-outline-variant overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-container-low text-left">
            <tr>
              {['Ref', 'Transporter', 'Lines', 'Total', 'Status', 'Stage', 'Actions'].map((h) => (
                <th key={h} className="px-3 py-3 font-semibold text-on-surface-variant tracking-wider text-[11px] uppercase whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr
                key={inv.id}
                className={`border-t border-outline-variant hover:bg-surface-container-low transition-colors cursor-pointer ${
                  selectedId === inv.id ? 'bg-[#e8f5e9]' : ''
                }`}
                onClick={() => loadDetail(inv.id)}
              >
                <td className="px-3 py-3 font-mono text-xs">{inv.reference_no ?? inv.id.slice(0, 8)}</td>
                <td className="px-3 py-3">{inv.transporters?.display_name}</td>
                <td className="px-3 py-3">{inv.invoice_lines?.length ?? 0}</td>
                <td className="px-3 py-3 font-medium">{ghs(inv.total_cost)}</td>
                <td className="px-3 py-3">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                    inv.status === 'locked' ? 'bg-[#dce2f7] text-on-surface-variant' :
                    inv.status === 'approved' ? 'bg-[#acf4a4] text-[#0c5216]' :
                    inv.status === 'void' ? 'bg-error-container text-error' :
                    'bg-[#e8f5e9] text-[#1b5e20]'
                  }`}>
                    {inv.status}
                  </span>
                </td>
                <td className="px-3 py-3">
                  <span className="border border-outline px-2 py-0.5 rounded text-[10px] text-on-surface-variant">
                    {STAGE_LABELS[inv.stage as PriStage] ?? inv.stage}
                  </span>
                </td>
                <td className="px-3 py-3 flex gap-1 whitespace-nowrap">
                  {profile?.role === 'admin' && inv.status === 'draft' && (
                    <button onClick={(e) => { e.stopPropagation(); act(inv.id, 'approve'); }} className="text-[11px] text-[#0d631b] underline" disabled={busy}>
                      Approve
                    </button>
                  )}
                  {profile?.role === 'admin' && inv.status === 'approved' && (
                    <button onClick={(e) => { e.stopPropagation(); act(inv.id, 'lock'); }} className="text-[11px] text-[#0d631b] underline" disabled={busy}>
                      Lock
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-outline-variant">
                  No invoices yet. Assemble one from waybills.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
