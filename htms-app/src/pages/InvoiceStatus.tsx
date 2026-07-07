import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import { ALL_STAGES, STAGE_LABELS, type PriStage } from '../../shared/lifecycle';
import { CHECKLIST_ITEMS } from '../../shared/validation';

const ghs = (n: number) =>
  '₵' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface InvoiceStatus {
  id: string;
  stage: string;
  checklist: Record<string, boolean>;
  reference_no: string | null;
  total_cost: number;
  transporter_id: string;
  created_at: string;
  review_status: 'pending' | 'approved' | 'disapproved';
  review_note: string | null;
}

interface TrailEntry {
  id: number;
  actor_id: string;
  action: string;
  created_at: string;
  after: Record<string, unknown>;
}

export default function InvoiceStatus() {
  const { profile } = useAuth();
  const [invoices, setInvoices] = useState<InvoiceStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trail, setTrail] = useState<TrailEntry[]>([]);
  const [flags, setFlags] = useState<{ id: string; waybill_id: string; scan_type: string; flagged_reason: string; waybill_no?: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const SCAN_LABELS: Record<string, string> = {
    acknowledgement: 'Acknowledgement form',
    waybill: 'Waybill',
    release_letter: 'Release letter',
  };

  useEffect(() => {
    if (!profile?.transporter_id) return;
    supabase
      .from('invoices')
      .select('id, stage, checklist, reference_no, total_cost, transporter_id, created_at, review_status, review_note')
      .eq('transporter_id', profile.transporter_id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) setErr(error.message);
        else setInvoices((data ?? []) as InvoiceStatus[]);
      });
  }, [profile]);

  const loadDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setErr(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`/api/invoice-stage?id=${id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTrail(data.trail ?? []);

      // Flagged documents → "action required" prompt.
      setFlags([]);
      const { data: lineRows } = await supabase.from('invoice_lines').select('waybill_id').eq('invoice_id', id);
      const wbIds = (lineRows ?? []).map((r) => r.waybill_id as string);
      if (wbIds.length) {
        const { data: flagged } = await supabase
          .from('scans')
          .select('id, waybill_id, scan_type, flagged_reason, waybills(waybill_no)')
          .in('waybill_id', wbIds)
          .not('flagged_reason', 'is', null);
        setFlags(
          ((flagged ?? []) as { id: string; waybill_id: string; scan_type: string; flagged_reason: string; waybills?: { waybill_no?: string } }[]).map(
            (f) => ({ id: f.id, waybill_id: f.waybill_id, scan_type: f.scan_type, flagged_reason: f.flagged_reason, waybill_no: f.waybills?.waybill_no }),
          ),
        );
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // Re-upload a corrected copy for a flagged document, clearing the flag.
  async function resolveFlag(flag: { id: string; waybill_id: string; scan_type: string }, file: File) {
    if (!profile?.transporter_id || !selectedId) return;
    if (file.size > 15 * 1024 * 1024) { setErr('That file is over 15 MB — please upload a smaller scan or photo.'); return; }
    setErr(null); setBusy(true);
    try {
      // Make sure the session token is live so the upload doesn't hang on an expired one.
      await supabase.auth.refreshSession().catch(() => supabase.auth.getSession());
      const mime = file.type || 'application/octet-stream';
      const safeName = file.name.replace(/[^\w.-]+/g, '_');
      const path = `${profile.transporter_id}/${flag.waybill_id}/${flag.scan_type}-${Date.now()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from('scans').upload(path, file, { contentType: mime, upsert: true });
      if (upErr) throw new Error(upErr.message);
      // Update the record via the server (service role) so RLS can't silently block it.
      await api.resolveFlag({ scanId: flag.id, storagePath: path, mime, size: file.size });
      await loadDetail(selectedId);
    } catch (e) {
      setErr(`Replace failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // ponytail: auto-open the only invoice — with n=1 neither list nor empty state renders
  useEffect(() => {
    if (invoices.length === 1 && !selectedId) loadDetail(invoices[0].id);
  }, [invoices, selectedId, loadDetail]);

  async function markSubmitted() {
    if (!selectedId || !window.confirm('Confirm: you have submitted this invoice in person at the Ministry?')) return;
    setBusy(true);
    setErr(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch('/api/invoice-stage', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoiceId: selectedId, stage: 'submitted' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setInvoices((prev) => prev.map((i) => (i.id === selectedId ? { ...i, stage: 'submitted' } : i)));
      loadDetail(selectedId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selected = invoices.find((i) => i.id === selectedId) ?? null;
  const currentStageIdx = selected ? ALL_STAGES.indexOf(selected.stage as PriStage) : -1;
  const checklistItems = selected?.checklist ?? {};

  return (
    <div className="max-w-md mx-auto">
      {err && <div className="mb-4 text-sm text-error bg-error-container p-3 rounded-lg flex items-center gap-2">{err}</div>}

      {/* Invoice selector */}
      {invoices.length > 1 && !selected && (
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-on-surface mb-3">Your Invoices</h2>
          <div className="space-y-2">
            {invoices.map((inv) => (
              <button
                key={inv.id}
                onClick={() => loadDetail(inv.id)}
                className="w-full text-left bg-white border border-outline-variant rounded-xl p-4 hover:bg-surface-container-low transition-colors"
              >
                <div className="flex justify-between items-center">
                  <span className="font-medium text-sm">{inv.reference_no ?? inv.id.slice(0, 8)}</span>
                  <span className="text-xs border border-outline px-2 py-0.5 rounded">
                    {STAGE_LABELS[inv.stage as PriStage] ?? inv.stage}
                  </span>
                </div>
                <div className="text-lg font-bold text-[#0d631b] mt-1">{ghs(inv.total_cost)}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <div>
          {/* Back button when multiple */}
          {invoices.length > 1 && (
            <button
              onClick={() => { setSelectedId(null); setTrail([]); }}
              className="flex items-center gap-1 text-sm text-on-surface-variant mb-4 hover:text-on-surface"
            >
              <span className="material-symbols-outlined text-lg">arrow_back</span>
              Back to list
            </button>
          )}

          <div className="flex h-[3px] rounded-full overflow-hidden mb-4">
            <div className="flex-1 bg-ghana-red" />
            <div className="flex-1 bg-ghana-gold" />
            <div className="flex-1 bg-ghana-green" />
          </div>

          {/* Checklist disapproved by officer */}
          {selected.review_status === 'disapproved' && (
            <div className="bg-error-container border border-error rounded-xl p-4 mb-4">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-error">cancel</span>
                <span className="text-xs font-bold tracking-wide text-error uppercase">Checklist Disapproved</span>
              </div>
              <p className="text-sm text-on-surface mb-1">{selected.review_note}</p>
              <p className="text-xs text-on-surface-variant">
                Once resolved, the Power Directorate will re-approve and your invoice continues from its current stage.
              </p>
            </div>
          )}

          {/* Action required: flagged documents */}
          {flags.length > 0 && (
            <div className="bg-error-container border border-error rounded-xl p-4 mb-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-error">flag</span>
                <span className="text-xs font-bold tracking-wide text-error uppercase">
                  Action Required — {flags.length} document{flags.length > 1 ? 's' : ''} flagged
                </span>
              </div>
              <ul className="space-y-2 mb-2">
                {flags.map((f) => (
                  <li key={f.id} className="text-sm text-on-surface flex items-start justify-between gap-3">
                    <div>
                      <span className="font-medium">
                        {SCAN_LABELS[f.scan_type] ?? f.scan_type}
                        {f.waybill_no ? ` (WB ${f.waybill_no})` : ''}:
                      </span>{' '}
                      {f.flagged_reason}
                    </div>
                    <label className={`shrink-0 flex items-center gap-1 bg-[#2e7d32] text-white rounded-lg px-3 py-1.5 text-xs font-medium cursor-pointer hover:opacity-90 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                      <span className="material-symbols-outlined text-[16px]">upload_file</span>
                      {busy ? 'Uploading…' : 'Replace document'}
                      <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) resolveFlag(f, file); e.target.value = ''; }} />
                    </label>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-on-surface-variant">
                Upload a corrected copy for each flagged item above. Once replaced, the flag clears and you can
                submit — the Power Directorate will review the new document.
              </p>
            </div>
          )}

          {/* Current status banner */}
          <div className="bg-white border border-outline-variant rounded-xl p-4 mb-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-[#0d631b]">verified_user</span>
              <span className="text-xs font-bold tracking-wide text-on-surface-variant uppercase">Current Status</span>
            </div>
            <h2 className="text-lg font-semibold text-[#0d631b]">
              Your invoice is at: {STAGE_LABELS[selected.stage as PriStage] ?? selected.stage}
            </h2>
            {selected.stage === 'generated' && (
              <button
                onClick={markSubmitted}
                disabled={busy}
                className="w-full mt-3 flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm bg-[#2e7d32] text-white hover:opacity-90 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-lg">assignment_turned_in</span>
                Mark as submitted at Ministry
              </button>
            )}
          </div>

          {/* Summary card */}
          <div className="bg-surface-container-low border border-outline-variant rounded-xl p-4 mb-4">
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className="text-xs font-bold tracking-wide text-on-surface-variant uppercase block mb-1">Invoice Total</span>
                <span className="text-[28px] font-bold text-[#0d631b]">{ghs(selected.total_cost)}</span>
              </div>
              <div className="text-right">
                <span className="text-xs font-bold tracking-wide text-on-surface-variant uppercase block mb-1">Invoice No.</span>
                <span className="text-sm font-mono font-bold">{selected.reference_no ?? selected.id.slice(0, 8)}</span>
              </div>
            </div>
            <div className="pt-4 border-t border-outline-variant/30">
              <span className="text-xs font-bold tracking-wide text-on-surface-variant uppercase block mb-2">Checklist Status</span>
              <div className="grid grid-cols-2 gap-2">
                {CHECKLIST_ITEMS.map((k) => (
                  <div key={k} className="flex items-center gap-1">
                    <span
                      className={`material-symbols-outlined text-sm ${
                        checklistItems[k] ? 'text-[#0d631b]' : 'text-outline-variant'
                      }`}
                      style={{ fontVariationSettings: checklistItems[k] ? "'FILL' 1" : "'FILL' 0" }}
                    >
                      {checklistItems[k] ? 'check_circle' : 'radio_button_unchecked'}
                    </span>
                    <span className="text-xs font-medium">
                      {k === 'original_waybills' ? 'Waybills' :
                       k === 'original_acknowledgement_forms' ? 'Acknowledge' :
                       k === 'release_letters' ? 'Release Ltr' :
                       k === 'contract_agreement_copy' ? 'Contract' : k}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Vertical timeline */}
          <div className="bg-white border border-outline-variant rounded-xl p-4">
            <h3 className="text-base font-semibold mb-4 flex items-center gap-2">
              <span className="material-symbols-outlined text-lg">account_tree</span>
              Processing Pipeline
            </h3>
            <div className="relative">
              <div className="absolute left-4 top-2 bottom-2 w-0.5 bg-outline-variant" />
              <div className="space-y-0">
                {ALL_STAGES.map((stage, idx) => {
                  const isCompleted = idx < currentStageIdx;
                  const isCurrent = idx === currentStageIdx;
                  const trailEntry = trail.find((t) => t.action === stage);
                  return (
                    <div key={stage} className="relative flex items-start gap-4 pb-6 last:pb-0">
                      <div className="relative z-10 mt-0.5">
                        {isCompleted ? (
                          <div className="w-8 h-8 rounded-full bg-[#0d631b] text-white flex items-center justify-center">
                            <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                          </div>
                        ) : isCurrent ? (
                          <div className="w-8 h-8 rounded-full bg-white border-4 border-[#0d631b] ring-4 ring-[#0d631b]/20 flex items-center justify-center step-pulse">
                            <div className="w-2 h-2 bg-[#0d631b] rounded-full" />
                          </div>
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-[#dce2f7] text-outline flex items-center justify-center">
                            <span className="text-xs font-bold">{idx + 1}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 pt-1">
                        <div className={`text-sm font-medium ${isCurrent ? 'text-[#0d631b] font-bold' : isCompleted ? 'text-on-surface' : 'text-outline'}`}>
                          {STAGE_LABELS[stage]}
                        </div>
                        {trailEntry && (
                          <div className="text-xs text-outline mt-0.5">
                            {new Date(trailEntry.created_at).toLocaleString('en-GH', {
                              day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                            })}
                          </div>
                        )}
                        {isCurrent && !trailEntry && (
                          <div className="text-xs text-[#0d631b] mt-0.5">Pending action</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {invoices.length === 0 && !selected && (
        <div className="text-center py-12 text-outline-variant">
          <span className="material-symbols-outlined text-4xl mb-2">receipt_long</span>
          <p>No invoices found for your account.</p>
        </div>
      )}
    </div>
  );
}
