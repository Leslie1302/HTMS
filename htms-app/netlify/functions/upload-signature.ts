/**
 * /api/upload-signature — persist the caller's signature_path in app_users.
 *
 * POST { path } → verifies the caller owns the storage path, then updates
 * app_users.signature_path via the service-role client (bypasses RLS).
 *
 * The file itself is uploaded to Supabase Storage by the client; this endpoint
 * only writes the DB pointer so non-admin users aren't blocked by the
 * app_users_admin_write RLS policy.
 */
import type { Config } from '@netlify/functions';
import { z } from 'zod';
import { guard, json, parseBody, serviceDb } from './_lib';

const schema = z.object({ path: z.string().min(1) });

export default guard({ roles: ['admin', 'officer', 'transporter', 'deputy_director', 'director'] }, async (req, ctx) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await parseBody(req, schema);

  // Sanity: the path must point to this user's own signature file.
  const expected = `signatures/${ctx.userId}.png`;
  if (body.path !== expected) {
    return json(403, { error: 'You can only update your own signature' });
  }

  const svc = serviceDb();
  const { error } = await svc
    .from('app_users')
    .update({ signature_path: body.path })
    .eq('id', ctx.userId);
  if (error) return json(500, { error: error.message });

  return json(200, { ok: true });
});

export const config: Config = { path: '/api/upload-signature' };
