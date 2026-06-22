import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import { buildInvoice, buildLetter, loadLogo, invoiceRef, type InvoiceDoc } from '../lib/pdf';
import { appendScansToPdf, downloadBytes, type ScanInput } from '../lib/mergeScans';

const SCAN_LABELS: Record<string, string> = {
  acknowledgement: 'Acknowledgement form',
  waybill: 'Waybill',
  release_letter: 'Release letter',
};

const ghs = (n: number) =>
  '₵' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Invoices() {
  const { profile } = useAuth();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [transporters, setTransporters] = useState<{ id: string; name: string }[]>([]);
  const [pick, setPick] = useState('');

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

  // Assemble an invoice from a transporter's not-yet-invoiced waybills.
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
      // Pull the full invoice (with joins + scan paths).
      const { data: inv, error } = await supabase
        .from('invoices')
        .select(
          '*, transporters(display_name,address,email,phone,gps_address), invoice_lines(*, waybills(waybill_no,vehicle_no,waybill_date,num_trips,districts(name),origins(name), scans(storage_path,mime_type,scan_type)))',
        )
        .eq('id', id)
        .single();
      if (error || !inv) throw new Error(error?.message ?? 'Invoice not found');

      // Build the base document PDF (jsPDF) client-side.
      const logo = await loadLogo();
      const doc = type === 'invoice' ? buildInvoice(inv as InvoiceDoc, logo) : buildLetter(inv as InvoiceDoc, logo);
      const baseBytes = doc.output('arraybuffer') as ArrayBuffer;

      // Download every scan attached to the invoice's waybills, then append them.
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

  return (
    <div>
      <h1 className="text-xl font-bold text-ministry-dark mb-4">Invoices and Letters</h1>
      {err && <div className="mb-4 text-sm text-red-600 bg-red-50 p-2 rounded">{err}</div>}
      {msg && <div className="mb-4 text-sm text-green-700 bg-green-50 p-2 rounded">{msg}</div>}

      {profile?.role !== 'transporter' && (
        <div className="mb-5 flex gap-2 items-center bg-white rounded-lg shadow p-3">
          <span className="text-sm text-gray-600">Assemble invoice for:</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="border rounded px-3 py-2 text-sm">
            <option value="">Select transporter…</option>
            {transporters.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button
            onClick={assemble}
            disabled={busy || !pick}
            className="bg-ministry hover:bg-ministry-dark text-white rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Assemble invoice'}
          </button>
          <span className="text-xs text-gray-400">Groups that transporter's un-invoiced waybills into one invoice.</span>
        </div>
      )}
      <div className="bg-white rounded-lg shadow overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              {['Ref', 'Transporter', 'Lines', 'Total', 'Status', 'Actions'].map((h) => (
                <th key={h} className="px-3 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-t align-top">
                <td className="px-3 py-2">{inv.reference_no ?? inv.id.slice(0, 8)}</td>
                <td className="px-3 py-2">{inv.transporters?.display_name}</td>
                <td className="px-3 py-2">{inv.invoice_lines?.length ?? 0}</td>
                <td className="px-3 py-2">{ghs(inv.total_cost)}</td>
                <td className="px-3 py-2">
                  <span className="px-2 py-0.5 rounded bg-ministry-light text-ministry-dark text-xs">{inv.status}</span>
                </td>
                <td className="px-3 py-2 space-x-2 whitespace-nowrap">
                  <button onClick={() => makeDoc(inv.id, 'invoice')} className="text-ministry-dark underline" disabled={busy}>
                    Invoice PDF
                  </button>
                  <button onClick={() => makeDoc(inv.id, 'letter')} className="text-ministry-dark underline" disabled={busy}>
                    Letter PDF
                  </button>
                  {profile?.role === 'admin' && inv.status === 'draft' && (
                    <button onClick={() => act(inv.id, 'approve')} className="text-blue-700 underline" disabled={busy}>
                      Approve
                    </button>
                  )}
                  {profile?.role === 'admin' && inv.status === 'approved' && (
                    <button onClick={() => act(inv.id, 'lock')} className="text-green-700 underline" disabled={busy}>
                      Lock
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-400">
                  No invoices yet. Assemble one from waybills via the API/CLI or extend this page.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
