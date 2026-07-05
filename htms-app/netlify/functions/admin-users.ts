/**
 * /api/admin-users — admin-only user provisioning.
 *
 * POST creates a Supabase auth user (service role) and its app_users profile
 * (role + company + phone), returning a one-time temporary password for the
 * admin to share. Creating auth users requires the service key, so this must
 * live server-side — never in the browser.
 */
import crypto from 'node:crypto';
import type { Config } from '@netlify/functions';
import { z } from 'zod';
import { guard, json, parseBody, serviceDb } from './_lib';

const schema = z.object({
  email: z.string().email(),
  full_name: z.string().trim().min(1),
  role: z.enum(['admin', 'officer', 'transporter']),
  transporter_id: z.string().uuid().nullable().optional(),
  phone: z.string().trim().optional(),
});

export default guard({ roles: ['admin'] }, async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await parseBody(req, schema);
  if (body.role === 'transporter' && !body.transporter_id) {
    return json(400, { error: 'A transporter user must be assigned a company.' });
  }

  const svc = serviceDb();
  // Temp password: meets typical complexity rules; admin shares it once.
  const tempPassword = crypto.randomUUID().replace(/-/g, '').slice(0, 12) + 'Aa1!';

  const { data: created, error } = await svc.auth.admin.createUser({
    email: body.email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { full_name: body.full_name },
  });
  if (error || !created.user) return json(400, { error: error?.message ?? 'Could not create user' });

  const { error: upErr } = await svc.from('app_users').upsert(
    {
      id: created.user.id,
      role: body.role,
      transporter_id: body.role === 'transporter' ? body.transporter_id : null,
      full_name: body.full_name,
      phone: body.phone?.trim() || null,
    },
    { onConflict: 'id' },
  );
  if (upErr) {
    // Don't leave an orphaned auth user if the profile insert fails.
    await svc.auth.admin.deleteUser(created.user.id).catch(() => {});
    return json(400, { error: upErr.message });
  }

  return json(200, { id: created.user.id, tempPassword });
});

export const config: Config = { path: '/api/admin-users' };
