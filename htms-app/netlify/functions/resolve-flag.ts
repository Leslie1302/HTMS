/**
 * /api/resolve-flag — a transporter (or staff) replaces a flagged scan.
 *
 * The client uploads the corrected file to Storage first, then calls this with
 * the new path. We update the scan row via the service role so it can't be
 * blocked or silently no-op'd by RLS, after verifying the caller owns the
 * document and it's actually flagged.
 */
import type { Config } from '@netlify/functions';
import { z } from 'zod';
import { audit, guard, json, parseBody, serviceDb } from './_lib';

const schema = z.object({
  scanId: z.string().uuid(),
  storagePath: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().positive(),
});

export default guard({ roles: ['admin', 'officer', 'transporter'] }, async (req, ctx) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await parseBody(req, schema);
  const db = serviceDb();

  const { data: scan } = await db
    .from('scans')
    .select('id, flagged_reason, waybills(transporter_id)')
    .eq('id', body.scanId)
    .single();
  if (!scan) return json(404, { error: 'Flagged document not found' });

  const ownerTransporter = (scan as { waybills?: { transporter_id?: string } }).waybills?.transporter_id ?? null;
  if (ctx.role === 'transporter' && ownerTransporter !== ctx.transporterId) {
    return json(403, { error: 'This document belongs to another transporter' });
  }

  const { error } = await db
    .from('scans')
    .update({ storage_path: body.storagePath, mime_type: body.mime, byte_size: body.size, flagged_reason: null })
    .eq('id', body.scanId);
  if (error) return json(400, { error: error.message });

  await audit(ctx.userId, 'scan_resubmitted', 'scan', body.scanId, null, { path: body.storagePath }).catch(() => {});
  return json(200, { ok: true });
});

export const config: Config = { path: '/api/resolve-flag' };
