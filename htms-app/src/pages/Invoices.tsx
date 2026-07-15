import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import { buildInvoice, buildLetter, buildMemo, buildSignatory, loadLogo, invoiceRef, type InvoiceDoc } from '../lib/pdf';
import { appendScansToPdf, type ScanInput } from '../lib/mergeScans';
import { ALL_STAGES, STAGE_MAP, STAGE_LABELS, type PriStage } from '../../shared/lifecycle';
import { CHECKLIST_ITEMS } from '../../shared/validation';
import { roleToSlot, canSignSlot, isSlotSigned, isReviewerRole, type SignSlot } from '../../shared/signing';

const SCAN_LABELS: Record<string, string> = {
  acknowledgement: 'Acknowledgement form',
  waybill: 'Waybill',
  release_letter: 'Release letter',
  contract_agreement: 'Contract agreement',
};

/** Signature rows + signer names + signature images (as data URLs) for PDF rendering. */
async function fetchSignatures(invoiceId: string): Promise<{ slot: string; signed_at: string; name: string; sigDataUrl?: string | null }[]> {
  const { data: sigRows } = await supabase.from('invoice_signatures').select('slot, signed_at, user_id').eq('invoice_id', invoiceId);
  const sigData: { slot: string; signed_at: string; name: string; sigDataUrl?: string | null }[] = [];
  if (!sigRows || sigRows.length === 0) return sigData;
  const userIds = [...new Set(sigRows.map((s: { user_id: string }) => s.user_id))];
  const { data: users } = await supabase.from('app_users').select('id, full_name, signature_path').in('id', userIds);
  const userMap = new Map((users ?? []).map((u: { id: string; full_name: string | null; signature_path: string | null }) => [u.id, u]));
  for (const s of sigRows) {
    const u = userMap.get(s.user_id);
    let sigDataUrl: string | null = null;
    if (u?.signature_path) {
      const { data: signedUrl } = await supabase.storage.from('documents').createSignedUrl(u.signature_path, 3600);
      if (signedUrl?.signedUrl) {
        const resp = await fetch(signedUrl.signedUrl);
        const blob = await resp.blob();
        sigDataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      }
    }
    sigData.push({ slot: s.slot, signed_at: s.signed_at, name: u?.full_name ?? '', sigDataUrl });
  }
  return sigData;
}

const ghs = (n: number) =>
  '₵' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface AuditTrailEntry {
  id: number;
  actor_id: string;
  action: string;
  created_at: string;
  after: { stage?: string };
}

interface TripRow {
  waybill_no: string;
  vehicle_no: string;
  date: string;
  origin: string;
  destination: string;
  distance: number | null;
  category: string;
  poles: number | null;
  trips: number | null;
  truck: string;
  cost: number;
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
  const [search, setSearch] = useState('');
  const [trail, setTrail] = useState<AuditTrailEntry[]>([]);
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [lineRows, setLineRows] = useState<TripRow[]>([]);
  const [docLinks, setDocLinks] = useState<
    { label: string; url: string; type: string; scanId?: string; flagged?: string | null }[]
  >([]);
  const [contractOk, setContractOk] = useState(false);
  const [signatures, setSignatures] = useState<{ slot: string; signed_at: string; user_id: string; full_name: string | null }[]>([]);
  const [sigBusy, setSigBusy] = useState(false);

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
      setLineRows([]);
      type ScanMeta = { id: string; storage_path: string; scan_type: string; flagged_reason: string | null };
      type Wb = {
        waybill_no?: string; vehicle_no?: string; waybill_date?: string; num_poles?: number; num_trips?: number;
        truck_size?: string | number; origins?: { name?: string }; districts?: { name?: string }; scans?: ScanMeta[];
      };
      type LineRec = { computed_cost?: number; category?: string; distance_km?: number; waybills?: Wb };
      const { data: docs } = await supabase
        .from('invoices')
        .select(
          'transporters(contract_path,contract_validated), invoice_lines(computed_cost, category, distance_km, waybills(waybill_no, vehicle_no, waybill_date, num_poles, num_trips, truck_size, origins(name), districts(name), scans(id,storage_path,scan_type,flagged_reason)))',
        )
        .eq('id', id)
        .single();
      const lines = (docs?.invoice_lines ?? []) as (LineRec & { waybills?: { scans?: ScanMeta[] } })[];

      // Trip details for review validation.
      setLineRows(
        (docs?.invoice_lines as LineRec[] | undefined ?? []).map((l) => ({
          waybill_no: l.waybills?.waybill_no ?? '—',
          vehicle_no: l.waybills?.vehicle_no ?? '—',
          date: l.waybills?.waybill_date ?? '',
          origin: l.waybills?.origins?.name ?? '—',
          destination: l.waybills?.districts?.name ?? '—',
          distance: l.distance_km ?? null,
          category: l.category ?? '',
          poles: l.waybills?.num_poles ?? null,
          trips: l.waybills?.num_trips ?? null,
          truck: l.waybills?.truck_size != null ? String(l.waybills.truck_size) : '—',
          cost: l.computed_cost ?? 0,
        })),
      );
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

      // Fetch signatures for this invoice
      const { data: sigRows } = await supabase
        .from('invoice_signatures')
        .select('slot, signed_at, user_id')
        .eq('invoice_id', id);
      if (sigRows && sigRows.length > 0) {
        const userIds = [...new Set(sigRows.map((s: { user_id: string }) => s.user_id))];
        const { data: users } = await supabase.from('app_users').select('id, full_name').in('id', userIds);
        const nameMap = new Map((users ?? []).map((u: { id: string; full_name: string | null }) => [u.id, u.full_name]));
        setSignatures(sigRows.map((s: { slot: string; signed_at: string; user_id: string }) => ({
          slot: s.slot,
          signed_at: s.signed_at,
          user_id: s.user_id,
          full_name: nameMap.get(s.user_id) ?? null,
        })));
      } else {
        setSignatures([]);
      }
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

  async function assembleFor(transporterId: string) {
    if (!transporterId) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const { waybills } = await api.listWaybills();
      const ids = (waybills ?? [])
        .filter((w: any) => w.transporter_id === transporterId && w.status !== 'invoiced')
        .map((w: any) => w.id);
      if (!ids.length) throw new Error('No un-invoiced waybills to raise an invoice from');
      await api.createInvoice({ transporterId, waybillIds: ids });
      setMsg(`Invoice assembled from ${ids.length} waybill(s).`);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const assemble = () => assembleFor(pick);

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

  async function signInvoice(invoiceId: string) {
    setSigBusy(true);
    setErr(null);
    try {
      // Step-up to AAL2 if needed
      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalData?.currentLevel !== 'aal2') {
        // Need to step up — challenge a TOTP factor
        const { data: factors } = await supabase.auth.mfa.listFactors();
        const totp = factors?.totp?.[0];
        if (!totp) {
          setErr('No MFA factor enrolled. Please set up MFA in Settings first.');
          setSigBusy(false);
          return;
        }
        const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId: totp.id });
        if (chErr) throw new Error(chErr.message);
        const code = window.prompt('Enter your 6-digit MFA code:');
        if (!code) { setSigBusy(false); return; }
        const { error: vErr } = await supabase.auth.mfa.verify({ factorId: totp.id, challengeId: challenge.id, code });
        if (vErr) throw new Error(`MFA verification failed: ${vErr.message}`);
      }
      await api.signInvoice(invoiceId);
      setMsg('Signature applied successfully.');
      load();
      if (selectedId) loadDetail(selectedId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSigBusy(false);
    }
  }

  /** Build the reviewer's merged "Payment request documentation" PDF. */
  async function buildReviewerDoc(id: string) {
    setBusy(true);
    setErr(null);
    try {
      const { data: inv, error } = await supabase
        .from('invoices')
        .select(
          '*, transporters(display_name,address,email,phone,gps_address,manager_name,contract_path,contract_validated), invoice_lines(*, waybills(waybill_no,vehicle_no,waybill_date,num_trips,truck_size,num_poles,districts(name),origins(name), scans(id,storage_path,mime_type,scan_type)))',
        )
        .eq('id', id)
        .single();
      if (error || !inv) throw new Error(error?.message ?? 'Invoice not found');

      const sigData = await fetchSignatures(id);

      const docInv = inv as InvoiceDoc;
      (docInv as InvoiceDoc & { signatures?: typeof sigData }).signatures = sigData;

      // 1. Letter + Invoice (with signatures)
      const letterBytes = buildLetter(docInv).output('arraybuffer') as ArrayBuffer;
      const invoiceBytes = buildInvoice(docInv).output('arraybuffer') as ArrayBuffer;

      // Merge letter + invoice
      const { PDFDocument } = await import('pdf-lib');
      const merged = await PDFDocument.create();
      const letterDoc = await PDFDocument.load(letterBytes);
      const invoiceDoc = await PDFDocument.load(invoiceBytes);
      const letterPages = await merged.copyPages(letterDoc, letterDoc.getPageIndices());
      letterPages.forEach((p) => merged.addPage(p));
      const invoicePages = await merged.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
      invoicePages.forEach((p) => merged.addPage(p));

      // 2. Append scans in order: acknowledgement → waybill → release_letter
      const scanOrder = ['acknowledgement', 'waybill', 'release_letter'];
      const allScans: ScanInput[] = [];
      const lines = (inv as any).invoice_lines ?? [];
      const scans = lines.flatMap((l: any) => l.waybills?.scans ?? []);
      // Sort scans by type order, then by created_at
      const sortedScans = [...scans].sort((a: any, b: any) => {
        const ai = scanOrder.indexOf(a.scan_type);
        const bi = scanOrder.indexOf(b.scan_type);
        const aIdx = ai === -1 ? scanOrder.length : ai;
        const bIdx = bi === -1 ? scanOrder.length : bi;
        return aIdx - bIdx;
      });
      let skipped = 0;
      for (const s of sortedScans) {
        const { data: blob } = await supabase.storage.from('scans').download(s.storage_path);
        if (blob) {
          allScans.push({
            bytes: await blob.arrayBuffer(),
            mime: s.mime_type || blob.type,
            label: SCAN_LABELS[s.scan_type] ?? 'Supporting scan',
          });
        } else {
          skipped++;
        }
      }
      if (skipped > 0) setErr(`${skipped} scan(s) could not be included in the document — check storage access.`);

      const mergedBytes = await merged.save();
      const finalBytes = allScans.length > 0
        ? await appendScansToPdf(mergedBytes.buffer.slice(mergedBytes.byteOffset, mergedBytes.byteOffset + mergedBytes.byteLength) as ArrayBuffer, allScans)
        : mergedBytes;

      // Open in new tab
      const ab = finalBytes.buffer.slice(finalBytes.byteOffset, finalBytes.byteOffset + finalBytes.byteLength) as ArrayBuffer;
      const blob = new Blob([ab], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeDoc(id: string, type: 'invoice' | 'letter' | 'memo' | 'signatory') {
    setBusy(true);
    setErr(null);
    try {
      const { data: inv, error } = await supabase
        .from('invoices')
        .select(
          '*, transporters(display_name,address,email,phone,gps_address,manager_name,contract_path,contract_validated), invoice_lines(*, waybills(waybill_no,vehicle_no,waybill_date,num_trips,truck_size,num_poles,districts(name),origins(name), scans(storage_path,mime_type,scan_type)))',
        )
        .eq('id', id)
        .single();
      if (error || !inv) throw new Error(error?.message ?? 'Invoice not found');
      (inv as InvoiceDoc).signatures = await fetchSignatures(id);

      const logo = await loadLogo();

      // Memo & signatory: no appended scans — build and save directly.
      if (type === 'memo') {
        const d = inv as InvoiceDoc;
        const ls = (k: string, def: string) => localStorage.getItem(k) ?? def;
        const fromTitle = window.prompt('FROM (designation)', ls('htms.memo.fromTitle', 'AG. DIRECTOR, POWER'));
        if (fromTitle == null) return;
        const signatoryName = window.prompt('Signatory name', ls('htms.memo.signatoryName', 'ING. SULEMANA ABUBAKARI'));
        if (signatoryName == null) return;
        const letterDefault = (d.period_end ?? d.created_at ?? '').slice(0, 10);
        const letterDate = window.prompt("Date on the transporter's payment request letter (yyyy-mm-dd)", letterDefault);
        if (letterDate == null) return;
        localStorage.setItem('htms.memo.fromTitle', fromTitle);
        localStorage.setItem('htms.memo.signatoryName', signatoryName);
        buildMemo(d, { fromTitle, signatoryName, letterDate }, logo).save(`Memo_${invoiceRef(d)}.pdf`);
        return;
      }
      if (type === 'signatory') {
        buildSignatory(inv as InvoiceDoc, logo).save(`Signatory_${invoiceRef(inv as InvoiceDoc)}.pdf`);
        return;
      }
      // Letter is a standalone one-pager — no appended scans.
      if (type === 'letter') {
        buildLetter(inv as InvoiceDoc).save(`Payment_Request_${invoiceRef(inv as InvoiceDoc)}.pdf`);
        return;
      }

      // Invoice is standalone too — the merged package (invoice + scans) is the
      // reviewers' "Payment request documentation" button only.
      buildInvoice(inv as InvoiceDoc).save(`Invoice_${invoiceRef(inv as InvoiceDoc)}.pdf`);
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
  const isReviewer = isReviewerRole(profile?.role ?? 'transporter');

  return (
    <div>
      {err && <div className="mb-4 text-sm text-error bg-error-container p-3 rounded-lg flex items-center gap-2">{err}</div>}
      {msg && <div className="mb-4 text-sm text-[#0d631b] bg-[#e8f5e9] p-3 rounded-lg flex items-center gap-2">{msg}</div>}

      {isTransporter ? (
        <div className="mb-5 flex gap-2 items-center bg-white rounded-lg border border-outline-variant p-3">
          <button
            onClick={() => { if (profile?.transporter_id) { setPick(profile.transporter_id); assembleFor(profile.transporter_id); } }}
            disabled={busy || !profile?.transporter_id}
            className="bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-sm">receipt_long</span>
            {busy ? 'Working…' : 'Raise invoice from my waybills'}
          </button>
          <span className="text-xs text-outline">Groups your un-invoiced waybills into one invoice, then print the letter &amp; invoice below.</span>
        </div>
      ) : !isReviewer ? (
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
      ) : null /* ponytail: reviewers (DD/Director) are read-only — no assemble bar */}

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
              {/* Scan chips: hidden for reviewers */}
              {!isReviewer && docLinks.map((d) => (
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
                  {!isTransporter && !isReviewer && d.scanId && (
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
              {!isReviewer ? (
                <>
                  <button onClick={() => makeDoc(selected.id, 'invoice')} className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-1.5 text-xs hover:bg-surface-container-low" disabled={busy}>
                    <span className="material-symbols-outlined text-sm">description</span> Invoice
                  </button>
                  <button onClick={() => makeDoc(selected.id, 'letter')} className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-1.5 text-xs hover:bg-surface-container-low" disabled={busy}>
                    <span className="material-symbols-outlined text-sm">mail</span> Letter
                  </button>
                  {!isTransporter && (
                    <button onClick={() => makeDoc(selected.id, 'memo')} className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-1.5 text-xs hover:bg-surface-container-low" disabled={busy}>
                      <span className="material-symbols-outlined text-sm">assignment</span> Memo
                    </button>
                  )}
                  {!isTransporter && (
                    <button onClick={() => makeDoc(selected.id, 'signatory')} className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-1.5 text-xs hover:bg-surface-container-low" disabled={busy}>
                      <span className="material-symbols-outlined text-sm">draw</span> Signatory
                    </button>
                  )}
                </>
              ) : (
                <button onClick={() => buildReviewerDoc(selected.id)} className="flex items-center gap-1 bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-4 py-1.5 text-xs font-medium" disabled={busy}>
                  <span className="material-symbols-outlined text-sm">description</span> Payment request documentation
                </button>
              )}
              {profile?.role === 'admin' && selected.status === 'draft' && (
                <button onClick={() => act(selected.id, 'approve')} className="flex items-center gap-1 border border-[#0d631b] text-[#0d631b] rounded-lg px-3 py-1.5 text-xs hover:bg-[#e8f5e9]" disabled={busy}>
                  <span className="material-symbols-outlined text-sm">check</span> Approve totals
                </button>
              )}
              {profile?.role === 'admin' && (
                <button
                  onClick={async () => {
                    if (!window.confirm(`Permanently delete invoice ${selected.reference_no ?? selected.id.slice(0, 8)}, its generated documents AND its underlying waybills?\n\nThe trips are removed entirely so they won't be re-invoiced. This cannot be undone.`)) return;
                    setBusy(true);
                    setErr(null);
                    try {
                      await api.adminDelete({ action: 'delete_invoice', id: selected.id });
                      setSelectedId(null);
                      load();
                    } catch (e) {
                      setErr((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                  title="Delete this payment request"
                  className="flex items-center gap-1 border border-error text-error rounded-lg px-3 py-1.5 text-xs hover:bg-error-container/40"
                >
                  <span className="material-symbols-outlined text-sm">delete</span> Delete
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

          {/* Signature status strip + Approve button */}
          {!isTransporter && (
            <div className="mt-4 p-4 bg-surface rounded-lg border border-outline-variant">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-4">
                  <span className="text-xs font-bold tracking-wide text-on-surface-variant uppercase">Signatures</span>
                  {(['prepared', 'checked', 'approved'] as const).map((slot) => {
                    const sig = signatures.find((s) => s.slot === slot);
                    const label = slot === 'prepared' ? 'Prepared' : slot === 'checked' ? 'Checked' : 'Approved';
                    return (
                      <div key={slot} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs ${sig ? 'bg-[#e8f5e9] border border-[#0d631b]/30' : 'bg-surface-container-low border border-outline-variant'}`}>
                        <span className={`material-symbols-outlined text-sm ${sig ? 'text-[#0d631b]' : 'text-outline'}`}>
                          {sig ? 'check_circle' : 'radio_button_unchecked'}
                        </span>
                        <span className={sig ? 'font-medium text-on-surface' : 'text-outline'}>{label}</span>
                        {sig && (
                          <span className="text-outline ml-1">
                            {sig.full_name ?? '—'} · {new Date(sig.signed_at).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const mySlot = roleToSlot(profile?.role ?? 'transporter');
                  if (!mySlot || mySlot === 'transporter') return null;
                  const alreadySigned = isSlotSigned(mySlot, signatures.map((s) => s.slot as SignSlot));
                  const prereqOk = canSignSlot(mySlot, signatures.map((s) => s.slot as SignSlot));
                  const label = mySlot === 'prepared' ? 'Sign (Prepared by)' : 'Approve';
                  return (
                    <button
                      onClick={() => signInvoice(selected.id)}
                      disabled={sigBusy || alreadySigned || !prereqOk}
                      title={alreadySigned ? 'Already signed' : !prereqOk ? 'Prerequisite signature missing' : undefined}
                      className="flex items-center gap-1.5 bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="material-symbols-outlined text-sm">draw</span>
                      {sigBusy ? 'Signing…' : alreadySigned ? 'Signed' : label}
                    </button>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Trip / waybill details for review validation */}
          <div className="mt-5 bg-white rounded-lg border border-outline-variant overflow-hidden">
            <div className="px-4 py-2.5 border-b border-outline-variant flex items-center justify-between">
              <h3 className="text-sm font-semibold text-on-surface">Trips in this request ({lineRows.length})</h3>
              <span className="text-xs text-outline">Total: {ghs(selected.total_cost)}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-container-low text-left">
                  <tr>
                    {['Date', 'Category', 'From', 'Destination', 'Distance (km)', 'Poles', 'Trips', 'Truck', 'Waybill No.', 'Vehicle', 'Cost'].map((h) => (
                      <th key={h} className="px-3 py-2 text-[11px] font-bold tracking-wide text-on-surface-variant uppercase whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {lineRows.map((r, i) => (
                    <tr key={i} className="hover:bg-surface-container-low">
                      <td className="px-3 py-2 whitespace-nowrap">{r.date ? new Date(r.date).toLocaleDateString() : '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.category || '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.origin}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{r.destination}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{r.distance ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.poles ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.trips ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.truck}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{r.waybill_no}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{r.vehicle_no}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-right font-medium">{ghs(r.cost)}</td>
                    </tr>
                  ))}
                  {lineRows.length === 0 && (
                    <tr><td colSpan={11} className="px-3 py-6 text-center text-outline-variant">No trips linked to this request.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Two-column detail: trail + checklist — hidden for reviewers */}
          {!isReviewer && (
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
                      disabled={busy || selected.review_status !== 'pending'}
                      title={selected.review_status === 'approved' ? 'Checklist already approved' : undefined}
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
          )}
        </div>
      )}

      {/* Search */}
      <div className="mb-3 relative">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline-variant text-lg">search</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by reference, transporter, stage or status…"
          className="w-full border border-outline-variant rounded-lg pl-10 pr-3 py-2 text-sm bg-white"
        />
      </div>

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
            {invoices.filter((inv) => {
              const s = search.trim().toLowerCase();
              if (!s) return true;
              return (
                (inv.reference_no ?? inv.id).toLowerCase().includes(s) ||
                (inv.transporters?.display_name ?? '').toLowerCase().includes(s) ||
                (STAGE_LABELS[inv.stage as PriStage] ?? inv.stage).toLowerCase().includes(s) ||
                inv.status.toLowerCase().includes(s)
              );
            }).map((inv) => (
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
