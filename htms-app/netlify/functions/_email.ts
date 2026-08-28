/**
 * Transactional email via the Resend API — server-side only.
 * https://resend.com/docs/api-reference/emails/send-email
 *
 * Plain fetch, no SDK. Every send is best-effort: if RESEND_API_KEY is unset
 * the helpers no-op, so the app runs fine before email is wired up.
 * Mirrors the shape of _fcm.ts.
 *
 * Env:
 *   RESEND_API_KEY — Resend API key
 *   RESEND_FROM    — e.g. "HTMS <onboarding@resend.dev>" (default) until a
 *                    sending domain is verified in Resend.
 *   APP_URL        — absolute app origin for links in emails (optional).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceDb } from './_lib';
import type { AudienceGroup } from '../../shared/comments';

const FROM = process.env.RESEND_FROM ?? 'HTMS <onboarding@resend.dev>';

export async function sendEmail(to: string[], subject: string, html: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key || to.length === 0) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!res.ok) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'resend_send_failed', status: res.status }));
    }
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'resend_send_error', err: String(err) }));
  }
}

/** Resolve auth emails for a set of app_user ids via the admin API. */
// ponytail: listUsers is one call, paginated (default 50/page) — fine at pilot
// scale; page through or add an emails view if the directory outgrows a page.
async function emailsOfUsers(svc: SupabaseClient, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const want = new Set(userIds);
  const emails: string[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) break;
    for (const u of data.users) {
      if (want.has(u.id) && u.email) emails.push(u.email);
    }
    if (data.users.length < 200) break;
    page += 1;
  }
  return emails;
}

/** User ids belonging to an audience group, for one invoice. */
async function recipientsOfAudience(
  svc: SupabaseClient,
  invoiceId: string,
  audience: AudienceGroup[],
): Promise<string[]> {
  const ids: string[] = [];
  if (audience.includes('staff')) {
    const { data } = await svc.from('app_users').select('id').in('role', ['admin', 'officer']);
    ids.push(...(data ?? []).map((u: { id: string }) => u.id));
  }
  if (audience.includes('dd')) {
    const { data } = await svc.from('app_users').select('id').in('role', ['deputy_director', 'director']);
    ids.push(...(data ?? []).map((u: { id: string }) => u.id));
  }
  if (audience.includes('transporter')) {
    const { data: inv } = await svc.from('invoices').select('transporter_id').eq('id', invoiceId).single();
    if (inv?.transporter_id) {
      const { data } = await svc.from('app_users').select('id').eq('transporter_id', inv.transporter_id);
      ids.push(...(data ?? []).map((u: { id: string }) => u.id));
    }
  }
  return [...new Set(ids)];
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Email the audience of a new invoice comment (everyone except the author). */
export async function notifyComment(
  invoiceId: string,
  audience: AudienceGroup[],
  authorId: string,
  authorName: string,
  body: string,
): Promise<void> {
  const svc = serviceDb();
  const { data: inv } = await svc.from('invoices').select('reference_no').eq('id', invoiceId).single();
  const ref = inv?.reference_no ?? invoiceId.slice(0, 8).toUpperCase();

  const ids = (await recipientsOfAudience(svc, invoiceId, audience)).filter((id) => id !== authorId);
  const emails = await emailsOfUsers(svc, ids);
  if (emails.length === 0) return;

  const excerpt = body.length > 280 ? `${body.slice(0, 280)}…` : body;
  const appUrl = process.env.APP_URL;
  const link = appUrl ? `<p><a href="${esc(appUrl)}">Open HTMS</a> to view the invoice and respond.</p>` : '';
  await sendEmail(
    emails,
    `Invoice ${ref} — comment from ${authorName}`,
    `<p><strong>${esc(authorName)}</strong> commented on invoice <strong>${esc(ref)}</strong>:</p>` +
      `<blockquote style="border-left:3px solid #ccc;margin:8px 0;padding:4px 12px">${esc(excerpt)}</blockquote>` +
      link,
  );
}
