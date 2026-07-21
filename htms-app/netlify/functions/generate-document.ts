/**
 * /api/generate-document — produce a branded Payment Request Invoice or Letter
 * (Ministry of Energy and Green Transition) as a self-contained, printable HTML
 * document, store it in the private `documents` bucket, and return a short-lived
 * signed URL. The uploaded waybill scans are referenced for appending.
 *
 * Tighter rate limit here (document generation is the Denial-of-Wallet surface).
 * HTML is returned so the client can render/print-to-PDF; a server-side
 * Puppeteer render can be swapped in behind the same contract for true PDFs.
 */
import type { Config } from '@netlify/functions';
import { audit, guard, json, parseBody } from './_lib';
import { generateDocSchema } from '../../shared/validation';
import { renderInvoiceHtml, renderLetterHtml } from '../../shared/documents';

const DOC_LIMIT = Number(process.env.RATE_LIMIT_MAX_DOC_GEN ?? 10);

export default guard({ roles: ['admin', 'officer'], rateLimit: DOC_LIMIT }, async (req, ctx) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await parseBody(req, generateDocSchema);

  // Pull invoice + lines + transporter + scans (RLS-scoped read).
  const { data: invoice, error } = await ctx.db
    .from('invoices')
    .select(
      '*, transporters(display_name, address, email, phone, gps_address), invoice_lines(*, waybills(*, scans(*), districts(name), origins(name)))',
    )
    .eq('id', body.invoiceId)
    .single();
  if (error || !invoice) return json(404, { error: 'Invoice not found' });

  // ponytail: memo template blocked on Ministry sample
  const html =
    body.type === 'invoice'
      ? renderInvoiceHtml(invoice, { referenceNo: body.referenceNo, addressee: body.addressee, notes: body.notes })
      : renderLetterHtml(invoice, { referenceNo: body.referenceNo, addressee: body.addressee, notes: body.notes });

  // Store under documents/<transporter_id>/<invoice_id>/<type>-<ts>.html
  const path = `${invoice.transporter_id}/${invoice.id}/${body.type}-${Date.now()}.html`;
  const { error: upErr } = await ctx.db.storage
    .from('documents')
    .upload(path, new Blob([html], { type: 'text/html' }), { upsert: true, contentType: 'text/html' });
  if (upErr) return json(400, { error: `Storage: ${upErr.message}` });

  const { error: docErr } = await ctx.db.from('documents').insert({
    invoice_id: invoice.id,
    type: body.type,
    storage_path: path,
    reference_no: body.referenceNo ?? null,
    generated_by: ctx.userId,
  });
  if (docErr) return json(400, { error: `Document record: ${docErr.message}` });

  // Short-lived signed URL (10 minutes).
  const { data: signed } = await ctx.db.storage.from('documents').createSignedUrl(path, 600);
  await audit(ctx.userId, 'generate', 'document', invoice.id, null, { type: body.type, path }).catch(() => {});

  return json(201, { path, url: signed?.signedUrl ?? null, html });
});

export const config: Config = { path: '/api/generate-document' };
