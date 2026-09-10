/**
 * /api/archive-doc — record an immutable document-archives entry after a PDF
 * has been uploaded to the `archive` bucket.
 *
 * document_archives has NO direct-insert policy (see migration 0026: rows are
 * service-role only, append-only by trigger), so the client cannot write it.
 * This route fills that gap with the usual gate: authenticated + role check,
 * and for transporters the owning-invoice + storage-path-tenancy check.
 */
import type { Config } from '@netlify/functions';
import { guard, json, parseBody, serviceDb } from './_lib';
import { archiveDocSchema } from '../../shared/validation';

export default guard({ roles: ['admin', 'officer', 'transporter'] }, async (req, ctx) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await parseBody(req, archiveDocSchema);
  const db = serviceDb();

  // Transporters may only archive documents of their own invoices, and only
  // under their own storage tenancy ({transporterId}/{invoiceId}/…).
  if (ctx.role === 'transporter') {
    const { data: invoice, error: invErr } = await ctx.db
      .from('invoices')
      .select('transporter_id')
      .eq('id', body.invoiceId)
      .single();
    if (invErr || !invoice) return json(404, { error: 'Invoice not found' });
    if (invoice.transporter_id !== ctx.transporterId) {
      return json(403, { error: 'You can only archive documents for your own invoice' });
    }
    if (!body.storagePath.startsWith(`${ctx.transporterId}/${body.invoiceId}/`)) {
      return json(403, { error: 'Storage path is outside your tenancy' });
    }
  }

  const { error: insErr } = await db.from('document_archives').insert({
    invoice_id: body.invoiceId,
    doc_type: body.docType,
    storage_path: body.storagePath,
    label: body.label ?? null,
    archived_by: ctx.userId,
  });
  if (insErr) return json(500, { error: insErr.message });
  return json(200, { ok: true });
});

export const config: Config = { path: '/api/archive-doc' };