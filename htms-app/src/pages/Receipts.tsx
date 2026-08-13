import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { mustWrite } from '../lib/db';
import { useAuth } from '../auth/AuthProvider';

const RECIPIENT_LABELS: Record<'HM' | 'CD', string> = {
  HM: 'Honourable Minister',
  CD: 'Chief Director',
};

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

interface ReceiptRow {
  id: string;
  recipient: 'HM' | 'CD';
  storage_path: string;
  mime_type: string;
  byte_size: number;
  note: string | null;
  uploaded_by: string;
  uploaded_at: string;
  app_users?: { full_name: string | null }[] | null;
}

interface Proof {
  id: string;
  recipient: 'HM' | 'CD';
  storage_path: string;
  byte_size: number;
  note: string | null;
  uploaded_at: string;
  uploader_name: string | null;
  url: string | null;
}

export default function Receipts() {
  const { profile } = useAuth();
  const { invoiceId = '' } = useParams();
  const [ref, setRef] = useState<string | null>(null);
  const [transporterName, setTransporterName] = useState<string | null>(null);
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [recipient, setRecipient] = useState<'HM' | 'CD'>('HM');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const role = profile?.role ?? 'transporter';
  const isStaff = role === 'admin' || role === 'officer' || role === 'deputy_director' || role === 'director';
  const canManage = role === 'admin' || role === 'officer';

  const load = useCallback(async () => {
    if (!invoiceId) return;
    setErr(null);
    try {
      const { data: inv } = await supabase
        .from('invoices')
        .select('reference_no, transporters(display_name)')
        .eq('id', invoiceId)
        .single();
      setRef((inv as { reference_no: string | null } | null)?.reference_no ?? null);
      setTransporterName(
        (inv as { transporters?: { display_name: string } | null } | null)?.transporters?.display_name ?? null,
      );

      const { data: rows } = await supabase
        .from('receipt_proofs')
        .select('id, recipient, storage_path, mime_type, byte_size, note, uploaded_by, uploaded_at, app_users(full_name)')
        .eq('invoice_id', invoiceId)
        .order('uploaded_at', { ascending: false });
      const list = (rows ?? []) as ReceiptRow[];
      const { data: signed } = await supabase.storage
        .from('receipts')
        .createSignedUrls(list.map((r) => r.storage_path), 3600);
      setProofs(list.map((r, i) => ({
        id: r.id,
        recipient: r.recipient,
        storage_path: r.storage_path,
        byte_size: r.byte_size,
        note: r.note,
        uploaded_at: r.uploaded_at,
        uploader_name: r.app_users?.[0]?.full_name ?? null,
        url: signed?.[i]?.signedUrl ?? null,
      })));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [invoiceId]);

  useEffect(() => {
    if (isStaff) load();
  }, [load, isStaff]);

  async function uploadProof(file: File) {
    if (!canManage || !invoiceId) return;
    if (file.size > 15 * 1024 * 1024) { setErr('That file is over 15 MB — please upload a smaller scan or photo.'); return; }
    setBusy(true);
    setErr(null);
    setMsg(null);
    let path: string | null = null;
    try {
      // Make sure the session token is live so the upload doesn't hang on an expired one.
      await supabase.auth.refreshSession().catch(() => supabase.auth.getSession());
      const mime = file.type || 'application/octet-stream';
      const safeName = file.name.replace(/[^\w.-]+/g, '_');
      path = `${invoiceId}/${recipient}-${Date.now()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from('receipts').upload(path, file, { contentType: mime });
      if (upErr) throw new Error(upErr.message);
      await mustWrite(
        supabase
          .from('receipt_proofs')
          .insert({
            invoice_id: invoiceId,
            recipient,
            storage_path: path,
            mime_type: mime,
            byte_size: file.size,
            note: note.trim() || null,
          })
          .select('id')
          .single(),
        'the receipt proof',
      );
      setNote('');
      setMsg('Receipt proof uploaded.');
      await load();
    } catch (e) {
      // The file may have landed before the metadata row did — clean up the orphan.
      if (path) await supabase.storage.from('receipts').remove([path]).catch(() => {});
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeProof(p: Proof) {
    if (!canManage) return;
    if (!window.confirm('Remove this receipt proof and its file?')) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await mustWrite(
        supabase.from('receipt_proofs').delete().eq('id', p.id).select('id').single(),
        'the receipt proof',
      );
      await supabase.storage.from('receipts').remove([p.storage_path]).catch(() => {});
      setMsg('Receipt proof removed.');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Link to="/invoices" className="inline-flex items-center gap-1 text-sm text-on-surface-variant hover:text-on-surface mb-4">
        <span className="material-symbols-outlined text-lg">arrow_back</span>
        Back to payment requests
      </Link>

      {err && <div className="mb-4 text-sm text-error bg-error-container p-3 rounded-lg flex items-center gap-2">{err}</div>}
      {msg && <div className="mb-4 text-sm text-[#0d631b] bg-[#e8f5e9] p-3 rounded-lg flex items-center gap-2">{msg}</div>}

      {!isStaff ? (
        <div className="bg-white rounded-lg border border-outline-variant p-8 text-center">
          <span className="material-symbols-outlined text-4xl text-outline-variant mb-2">lock</span>
          <h2 className="text-base font-semibold text-on-surface mb-1">Access restricted</h2>
          <p className="text-sm text-outline">
            Only Ministry staff can view payment-request receipts. If you believe this is a mistake, contact an administrator.
          </p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-lg border border-outline-variant p-5 mb-5">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-2xl text-[#0d631b]">fact_check</span>
              <div>
                <h2 className="text-lg font-semibold text-on-surface">
                  Proof of receipt — {ref ?? invoiceId.slice(0, 8)}
                </h2>
                <p className="text-sm text-on-surface-variant">{transporterName ?? 'Payment request'}</p>
              </div>
            </div>
            <p className="text-sm text-on-surface-variant mt-3">
              Upload scans of the minuted payment-request documents, tagged with the office that acknowledged the receipt.
            </p>
          </div>

          {canManage && (
            <div className="bg-white rounded-lg border border-outline-variant p-5 mb-5">
              <h3 className="text-sm font-semibold text-on-surface mb-4">Upload a receipt scan</h3>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-on-surface-variant">
                  Received by
                  <select
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value as 'HM' | 'CD')}
                    className="border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none bg-white"
                  >
                    <option value="HM">{RECIPIENT_LABELS.HM}</option>
                    <option value="CD">{RECIPIENT_LABELS.CD}</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-on-surface-variant flex-1 min-w-[200px]">
                  Note (optional)
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Minuted on 14 Aug 2026"
                    className="border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className={`flex items-center gap-1 bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-4 py-2 text-sm font-medium cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                  <span className="material-symbols-outlined text-sm">upload_file</span>
                  {busy ? 'Uploading…' : 'Upload scan'}
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadProof(file);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>
          )}

          <div className="bg-white rounded-lg border border-outline-variant overflow-hidden">
            <div className="px-4 py-2.5 border-b border-outline-variant flex items-center justify-between">
              <h3 className="text-sm font-semibold text-on-surface">Uploaded receipts ({proofs.length})</h3>
            </div>
            {proofs.length === 0 ? (
              <p className="px-4 py-8 text-center text-outline-variant text-sm">No receipt proofs uploaded yet.</p>
            ) : (
              <ul className="divide-y divide-outline-variant">
                {proofs.map((p) => (
                  <li key={p.id} className="px-4 py-3 flex items-start gap-3">
                    <span className="material-symbols-outlined text-outline-variant mt-0.5">receipt_long</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          p.recipient === 'HM' ? 'bg-[#dce2f7] text-on-surface-variant' : 'bg-[#e8f5e9] text-[#1b5e20]'
                        }`}>
                          {p.recipient}
                        </span>
                        <span className="text-sm font-medium text-on-surface">{RECIPIENT_LABELS[p.recipient]}</span>
                        <span className="text-xs text-outline">{fmtBytes(p.byte_size)}</span>
                      </div>
                      {p.note && <p className="text-sm text-on-surface mt-1">{p.note}</p>}
                      <p className="text-xs text-outline mt-1">
                        {new Date(p.uploaded_at).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' })}
                        {p.uploader_name ? ` · ${p.uploader_name}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 border border-outline-variant rounded-lg px-3 py-1.5 text-xs hover:bg-surface-container-low">
                          <span className="material-symbols-outlined text-sm">visibility</span> View
                        </a>
                      ) : (
                        <span className="text-xs text-outline">Unavailable</span>
                      )}
                      {canManage && (
                        <button onClick={() => removeProof(p)} disabled={busy} className="flex items-center gap-1 border border-error text-error rounded-lg px-3 py-1.5 text-xs hover:bg-error-container/40">
                          <span className="material-symbols-outlined text-sm">delete</span> Remove
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
