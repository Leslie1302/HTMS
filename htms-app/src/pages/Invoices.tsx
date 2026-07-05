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
  contract_agreement: 'Contract agreement',
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
  review_status: 'pending' | 'approved' | 'disapproved';
  review_note: string | null;
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
  const [docLinks, setDocLinks] = useState<
    { label: string; url: string; type: string; scanId?: string; flagged?: string | null }[]
  >([]);
  const [contractOk, setContractOk] = useState(false);

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

      // Supporting documents: signed links for waybill/ack/release scans + contract.
      setDocLinks([]);
      type ScanMeta = { id: string; storage_path: string; scan_type: string; flagged_reason: string | null };
      const { data: docs } = await supabase
        .from('invoices')
        .select(
          'transporters(contract_path,contract_validated), invoice_lines(waybills(scans(id,storage_path,scan_type,flagged_reason)))',
        )
        .eq('id', id)
        .single();
      const lines = (docs?.invoice_lines ?? []) as { waybills?: { scans?: ScanMeta[] } }[];
      const scans = lines.flatMap((l) => l.waybills?.scans ?? []);
      const links: typeof docLinks = [];
      if (scans.length) {
        const { data: signed } = await supabase.storage
          .from('scans')
          .createSignedUrls(scans.map((s) => s.storage_path), 3600);
        const totals: Record<string, number> = {};
        for (const s of scans) totals[s.scan_type] = (totals[s.scan_type] ?? 0) + 1;
        const seen: Record<string, number> = {};
        scans.forEach((s, i) => {
          const url = signed?.[i]?.signedUrl;
          if (!url) return;
          const n = (seen[s.scan_type] = (seen[s.scan_type] ?? 0) + 1);
          const base = SCAN_LABELS[s.scan_type] ?? s.scan_type;
          links.push({
            label: totals[s.scan_type] > 1 ? `${base} ${n}` : base,
            url,
            type: s.scan_type,
            scanId: s.id,
            flagged: s.flagged_reason,
          });
        });
      }
      const tp = docs?.transporters as { contract_path?: string; contract_validated?: boolean } | null;
      setContractOk(!!tp?.contract_validated);
      if (tp?.contract_path) {
        const { data: c } = await supabase.storage.from('documents').createSignedUrl(tp.contract_path, 3600);
        if (c?.signedUrl) links.push({ label: SCAN_LABELS.contract_agreement, url: c.signedUrl, type: 'contract_agreement' });
      }
      setDocLinks(links);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  async function review(verdict: 'approved' | 'disapproved') {
    if (!selectedId) return;
    let note: string | undefined;
    if (verdict === 'disapproved') {
      const v = window.prompt('Reason for disapproval (logged and shown to the transporter):');
      if (!v?.trim()) return;
      note = v.trim();
    }
    setBusy(true);
    setErr(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch('/api/invoice-stage', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoiceId: selectedId, review: verdict, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMsg(verdict === 'approved' ? 'Checklist approved — workflow may continue.' : 'Checklist disapproved — reason logged for the transporter.');
      load();
      loadDetail(selectedId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ponytail: window.prompt/confirm for flag reasons — a modal earns its place when someone complains
  async function toggleFlag(scanId: string, current: string | null) {
    let reason: string | null = null;
    if (!current) {
      reason = window.prompt('Reason for flagging (what must the transporter fix)?');
      if (!reason) return;
    } else if (!window.confirm('Clear this flag? Only do this once a compliant copy is in hand.')) {
      return;
    }
    const { error } = await supabase.from('scans').update({ flagged_reason: reason }).eq('id', scanId);
    if (error) setErr(error.message);
    else if (selectedId) loadDetail(selectedId);
  }

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
          '*, transporters(display_name,address,email,phone,gps_address,contract_path,contract_validated), invoice_lines(*, waybills(waybill_no,vehicle_no,waybill_date,num_trips,districts(name),origins(name), scans(storage_path,mime_type,scan_type)))',
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

      const tp = (inv as any).transporters;
      if (tp?.contract_path) {
        const { data: contractBlob } = await supabase.storage.from('documents').download(tp.contract_path);
        if (contractBlob) {
          scans.push({
            bytes: await contractBlob.arrayBuffer(),
            mime: contractBlob.type || 'application/pdf',
            label: 'Contract agreement',
          });
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
            <div className="flex flex-wrap gap-2 justify-end">
              {docLinks.map((d) => (
                <span
                  key={d.scanId ?? d.url}
                  className={`flex items-center rounded-lg border text-xs ${
                    d.flagged ? 'border-error bg-error-container/40' : 'border-outline-variant'
                  }`}
                >
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    title={d.flagged ? `Flagged: ${d.flagged}` : d.label}
                    className="flex items-center gap-1 px-3 py-1.5 hover:bg-surface-container-low rounded-l-lg"
                  >
                    <span className={`material-symbols-outlined text-sm ${d.flagged ? 'text-error' : ''}`}>
                      {d.flagged ? 'flag' : 'attach_file'}
                    </span>
                    {d.label}
                  </a>
                  {!isTransporter && d.scanId && (
                    <button
                      onClick={() => toggleFlag(d.scanId!, d.flagged ?? null)}
                      title={d.flagged ? 'Clear flag' : 'Flag as substandard'}
                      className="px-1.5 py-1.5 border-l border-outline-variant/50 hover:bg-surface-container-low rounded-r-lg"
                    >
                      <span className={`material-symbols-outlined text-sm ${d.flagged ? 'text-[#0d631b]' : 'text-outline'}`}>
                        {d.flagged ? 'flag_check' : 'flag'}
                      </span>
                    </button>
                  )}
                </span>
              ))}
              <button onClick={() => makeDoc(selected.id, 'invoice')} className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-1.5 text-xs hover:bg-surface-container-low" disabled={busy}>
                <span className="material-symbols-outlined text-sm">description</span> Invoice
              </button>
              <button onClick={() => makeDoc(selected.id, 'letter')} className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-1.5 text-xs hover:bg-surface-container-low" disabled={busy}>
                <span className="material-symbols-outlined text-sm">mail</span> Letter
              </button>
              {profile?.role === 'admin' && selected.status === 'draft' && (
                <button onClick={() => act(selected.id, 'approve')} className="flex items-center gap-1 border border-[#0d631b] text-[#0d631b] rounded-lg px-3 py-1.5 text-xs hover:bg-[#e8f5e9]" disabled={busy}>
                  <span className="material-symbols-outlined text-sm">check</span> Approve totals
                </button>
              )}
              {profile?.role === 'admin' && selected.status === 'approved' && (
                <button onClick={() => act(selected.id, 'lock')} className="flex items-center gap-1 border border-[#0d631b] text-[#0d631b] rounded-lg px-3 py-1.5 text-xs hover:bg-[#e8f5e9]" disabled={busy}>
                  <span className="material-symbols-outlined text-sm">lock</span> Lock
                </button>
              )}
              <button
                onClick={() => setSelectedId(null)}
                title="Minimize"
                aria-label="Minimize invoice details"
                className="flex items-center border border-outline-variant rounded-lg px-2 py-1.5 text-xs hover:bg-surface-container-low"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
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
                {CHECKLIST_ITEMS.map((k) => {
                  // Tick only when the matching files exist and none are flagged.
                  const scanType = (
                    {
                      original_waybills: 'waybill',
                      original_acknowledgement_forms: 'acknowledgement',
                      release_letters: 'release_letter',
                    } as Record<string, string>
                  )[k];
                  const files = docLinks.filter((d) =>
                    scanType ? d.type === scanType : k === 'contract_agreement_copy' && d.type === 'contract_agreement',
                  );
                  const blocked = scanType
                    ? files.length === 0 || files.some((d) => d.flagged)
                    : k === 'contract_agreement_copy' && !contractOk;
                  const why =
                    blocked && scanType
                      ? files.length === 0
                        ? 'No file uploaded'
                        : 'Has flagged files'
                      : blocked
                        ? 'Contract not validated (Admin)'
                        : '';
                  return (
                    <div
                      key={k}
                      className={`flex items-center gap-3 p-2 bg-surface rounded-lg border border-transparent transition-all ${
                        blocked ? 'opacity-60' : 'hover:border-outline-variant'
                      }`}
                    >
                      <label title={why} className={`flex items-center gap-3 flex-1 min-w-0 ${blocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                        <input
                          type="checkbox"
                          checked={!!checklist[k]}
                          onChange={(e) => updateChecklist(k, e.target.checked)}
                          className="w-5 h-5 text-[#0d631b] border-outline-variant rounded focus:ring-[#0d631b]"
                          disabled={blocked || (isTransporter && selected?.stage !== 'generated')}
                        />
                        <span className="text-sm text-on-surface">
                          {k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                          {why && <span className="block text-[10px] text-error">{why}</span>}
                        </span>
                      </label>
                      {/* Preview links for this item's files */}
                      <span className="flex gap-1 shrink-0">
                        {files.map((f, i) => (
                          <a
                            key={f.scanId ?? f.url}
                            href={f.url}
                            target="_blank"
                            rel="noreferrer"
                            title={`Preview ${f.label}${f.flagged ? ` — flagged: ${f.flagged}` : ''}`}
                            className={`flex items-center gap-0.5 px-1.5 py-1 rounded border text-[10px] hover:bg-surface-container-low ${
                              f.flagged ? 'border-error text-error' : 'border-outline-variant text-on-surface-variant'
                            }`}
                          >
                            <span className="material-symbols-outlined text-sm">visibility</span>
                            {files.length > 1 ? i + 1 : ''}
                          </a>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Officer verdict on the checklist */}
              {!isTransporter && (
                <div className="mb-3">
                  <div className="flex gap-2">
                    <button
                      onClick={() => review('approved')}
                      disabled={busy || !checklistAll || docLinks.some((d) => d.flagged) || selected.review_status === 'approved'}
                      className="flex-1 flex items-center justify-center gap-1 border border-[#0d631b] text-[#0d631b] rounded-lg py-2 text-sm font-medium hover:bg-[#e8f5e9] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span className="material-symbols-outlined text-sm">check_circle</span> Approve
                    </button>
                    <button
                      onClick={() => review('disapproved')}
                      disabled={busy || selected.review_status === 'disapproved'}
                      className="flex-1 flex items-center justify-center gap-1 border border-error text-error rounded-lg py-2 text-sm font-medium hover:bg-error-container/40 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span className="material-symbols-outlined text-sm">cancel</span> Disapprove
                    </button>
                  </div>
                  {selected.review_status === 'approved' && (
                    <p className="text-center text-[11px] text-[#0d631b] mt-2">Checklist approved</p>
                  )}
                  {selected.review_status === 'disapproved' && (
                    <p className="text-center text-[11px] text-error mt-2">Disapproved: {selected.review_note}</p>
                  )}
                </div>
              )}

              {nextStage && !isTransporter && (
                <button
                  onClick={() => advanceStage(selected.id, nextStage)}
                  disabled={
                    busy ||
                    selected.review_status === 'disapproved' ||
                    (selected.stage === 'generated' && (!checklistAll || selected.review_status !== 'approved'))
                  }
                  className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all ${
                    selected.review_status !== 'disapproved' &&
                    (selected.stage !== 'generated' || (checklistAll && selected.review_status === 'approved'))
                      ? 'bg-[#2e7d32] text-white hover:opacity-90'
                      : 'bg-[#dce2f7] text-outline cursor-not-allowed opacity-50'
                  }`}
                >
                  <span>Advance to {STAGE_LABELS[nextStage as PriStage]}</span>
                  <span className="material-symbols-outlined text-lg">arrow_forward</span>
                </button>
              )}
              {nextStage && selected.stage === 'generated' && selected.review_status !== 'approved' && (
                <p className="text-center text-[11px] text-error mt-2">
                  {!checklistAll ? 'Complete checklist, then approve it to enable advancement' : 'Approve the checklist to enable advancement'}
                </p>
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
                onClick={() => (selectedId === inv.id ? setSelectedId(null) : loadDetail(inv.id))}
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
                      Approve totals
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
