/**
 * /api/admin-delete — admin-only destructive cleanup (safer than raw SQL).
 *
 *   delete_transporter  → a company and everything under it (waybills, scans,
 *                          invoices, lines, documents, its user accounts, files).
 *   delete_invoice      → one payment request (lines + generated docs), and
 *                          releases its waybills back to 'submitted'.
 *   reset_pilot         → flush ALL transporters + payment-request activity for
 *                          go-live, keeping config data and admin logins.
 *
 * Runs with the service role so it can cascade across tables/Storage and delete
 * auth users. RLS is bypassed deliberately — the route is admin-guarded.
 */
import type { Config } from '@netlify/functions';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { audit, guard, json, parseBody, serviceDb } from './_lib';

const ZERO = '00000000-0000-0000-0000-000000000000';
const schema = z.object({
  action: z.enum(['delete_transporter', 'delete_invoice', 'reset_pilot']),
  id: z.string().uuid().optional(),
});

type Db = SupabaseClient;
const ids = <T extends { id: string }>(rows: T[] | null): string[] => (rows ?? []).map((r) => r.id);

async function rmFiles(db: Db, bucket: string, paths: (string | null | undefined)[]): Promise<void> {
  const clean = paths.filter((p): p is string => !!p);
  if (clean.length) await db.storage.from(bucket).remove(clean);
}

async function deleteInvoices(db: Db, invoiceIds: string[]): Promise<void> {
  if (!invoiceIds.length) return;
  const { data: docs } = await db.from('documents').select('storage_path').in('invoice_id', invoiceIds);
  await rmFiles(db, 'documents', (docs ?? []).map((d: { storage_path: string }) => d.storage_path));
  await db.from('documents').delete().in('invoice_id', invoiceIds);
  await db.from('invoice_lines').delete().in('invoice_id', invoiceIds);
  const { error } = await db.from('invoices').delete().in('id', invoiceIds);
  if (error) throw new Error(`invoices: ${error.message}`);
  // Flush the payment-request status trail + generated-doc audit rows.
  await db.from('audit_log').delete().in('entity', ['invoice', 'document']).in('entity_id', invoiceIds);
}

/** Permanently remove waybills: their scans (+ files), the rows, and audit trail. */
async function deleteWaybills(db: Db, wbIds: string[]): Promise<void> {
  if (!wbIds.length) return;
  const { data: scans } = await db.from('scans').select('storage_path').in('waybill_id', wbIds);
  await rmFiles(db, 'scans', (scans ?? []).map((s: { storage_path: string }) => s.storage_path));
  await db.from('scans').delete().in('waybill_id', wbIds);
  await db.from('waybills').delete().in('id', wbIds);
  await db.from('audit_log').delete().eq('entity', 'waybill').in('entity_id', wbIds);
}

async function deleteInvoice(db: Db, id: string): Promise<void> {
  // A payment request and its underlying trips are removed together — otherwise
  // the "released" waybills get re-summed into the next invoice.
  const { data: lines } = await db.from('invoice_lines').select('waybill_id').eq('invoice_id', id);
  const wbIds = (lines ?? []).map((l: { waybill_id: string }) => l.waybill_id);
  await deleteInvoices(db, [id]);
  await deleteWaybills(db, wbIds);
}

async function deleteTransporter(db: Db, id: string): Promise<void> {
  await deleteInvoices(db, ids(await db.from('invoices').select('id').eq('transporter_id', id).then((r) => r.data)));

  await deleteWaybills(db, ids(await db.from('waybills').select('id').eq('transporter_id', id).then((r) => r.data)));

  const { data: t } = await db.from('transporters').select('contract_path').eq('id', id).single();
  await rmFiles(db, 'documents', [(t as { contract_path?: string } | null)?.contract_path]);

  // Remove the company's user logins. Drop the app_users rows explicitly first
  // (this is the FK that otherwise blocks the transporter delete), then
  // best-effort remove their auth accounts.
  const { data: us } = await db.from('app_users').select('id').eq('transporter_id', id);
  await db.from('app_users').delete().eq('transporter_id', id);
  for (const u of us ?? []) await db.auth.admin.deleteUser((u as { id: string }).id).catch(() => {});

  const { error } = await db.from('transporters').delete().eq('id', id);
  if (error) throw new Error(`transporter: ${error.message}`);
}

/** Remove every auth user that isn't an admin (covers parked signups too). */
async function deleteNonAdminUsers(db: Db): Promise<void> {
  const { data: admins } = await db.from('app_users').select('id').eq('role', 'admin');
  const adminIds = new Set((admins ?? []).map((a: { id: string }) => a.id));
  const all: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    all.push(...users.map((u) => u.id));
    if (users.length < 200) break;
  }
  for (const uid of all) if (!adminIds.has(uid)) await db.auth.admin.deleteUser(uid).catch(() => {});
}

async function resetPilot(db: Db): Promise<void> {
  // Collect known Storage paths before dropping the rows that point to them.
  const { data: docs } = await db.from('documents').select('storage_path');
  const { data: scans } = await db.from('scans').select('storage_path');
  const { data: contracts } = await db.from('transporters').select('contract_path');
  await rmFiles(db, 'documents', [
    ...(docs ?? []).map((d: { storage_path: string }) => d.storage_path),
    ...(contracts ?? []).map((c: { contract_path: string | null }) => c.contract_path),
  ]);
  await rmFiles(db, 'scans', (scans ?? []).map((s: { storage_path: string }) => s.storage_path));

  await db.from('documents').delete().neq('id', ZERO);
  await db.from('invoice_lines').delete().neq('id', ZERO);
  await db.from('invoices').delete().neq('id', ZERO);
  await db.from('scans').delete().neq('id', ZERO);
  await db.from('waybills').delete().neq('id', ZERO);
  await db.from('device_tokens').delete().neq('id', ZERO);
  await db.from('audit_log').delete().neq('id', 0);

  await deleteNonAdminUsers(db);
  await db.from('transporters').delete().neq('id', ZERO);
}

export default guard({ roles: ['admin'] }, async (req, ctx) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await parseBody(req, schema);
  const db = serviceDb();

  if (body.action === 'reset_pilot') {
    try {
      await resetPilot(db);
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
    await audit(ctx.userId, 'reset_pilot', 'system', 'all', null, null).catch(() => {});
    return json(200, { ok: true });
  }

  if (!body.id) return json(400, { error: 'id required' });
  try {
    if (body.action === 'delete_transporter') await deleteTransporter(db, body.id);
    else await deleteInvoice(db, body.id);
  } catch (e) {
    // Surface the real reason (e.g. a foreign-key block) instead of a false success.
    return json(400, { error: (e as Error).message });
  }
  await audit(ctx.userId, body.action, body.action === 'delete_invoice' ? 'invoice' : 'transporter', body.id, null, null).catch(() => {});
  return json(200, { ok: true });
});

export const config: Config = { path: '/api/admin-delete' };
