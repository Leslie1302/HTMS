/**
 * Firebase Cloud Messaging (HTTP v1) push sending — server-side only.
 * https://firebase.google.com/docs/cloud-messaging/send-message
 *
 * Auth is a short-lived OAuth2 access token minted from the service account
 * (env FCM_SERVICE_ACCOUNT = the service-account JSON). No firebase-admin dep —
 * we sign the JWT with node:crypto and cache the token until it expires.
 *
 * Every send is best-effort: if FCM_SERVICE_ACCOUNT is unset the helpers no-op,
 * so the app runs fine before Firebase is wired up. Stale (unregistered) tokens
 * are pruned automatically.
 */
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceDb } from './_lib';
import { STAGE_LABELS, type PriStage } from '../../shared/lifecycle';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

/**
 * The FCM v1 message payload for a single device token. Pure — unit tested.
 * We send only the cross-platform `notification`; the web service worker builds
 * the click target itself (webpush.fcm_options.link requires an absolute HTTPS
 * URL, which we don't know server-side).
 */
export function buildFcmMessage(token: string, title: string, body: string) {
  return {
    message: {
      token,
      notification: { title, body },
    },
  };
}

let saCache: ServiceAccount | null | undefined;
function serviceAccount(): ServiceAccount | null {
  if (saCache !== undefined) return saCache;
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  try {
    saCache = raw ? (JSON.parse(raw) as ServiceAccount) : null;
  } catch {
    console.warn(JSON.stringify({ level: 'warn', msg: 'fcm_bad_service_account' }));
    saCache = null;
  }
  return saCache;
}

let tokenCache: { token: string; exp: number } | null = null;
async function accessToken(sa: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 60 > now) return tokenCache.token;

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned =
    b64({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    b64({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${sig}`,
      }),
    });
    if (!res.ok) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'fcm_token_failed', status: res.status }));
      return null;
    }
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    tokenCache = { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
    return tokenCache.token;
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'fcm_token_error', err: String(err) }));
    return null;
  }
}

async function sendToToken(at: string, projectId: string, token: string, title: string, body: string): Promise<'ok' | 'stale' | 'fail'> {
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${at}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildFcmMessage(token, title, body)),
    });
    if (res.ok) return 'ok';
    const text = await res.text();
    // A token that's no longer valid should be removed so we stop trying it.
    if (res.status === 404 || /UNREGISTERED|NOT_FOUND/.test(text)) return 'stale';
    console.warn(JSON.stringify({ level: 'warn', msg: 'fcm_send_failed', status: res.status }));
    return 'fail';
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'fcm_send_error', err: String(err) }));
    return 'fail';
  }
}

/** Push to every device token belonging to the given users; prune dead tokens. */
async function pushToUsers(userIds: string[], title: string, body: string): Promise<void> {
  if (userIds.length === 0) return;
  const sa = serviceAccount();
  if (!sa) return;
  const at = await accessToken(sa);
  if (!at) return;

  const svc: SupabaseClient = serviceDb();
  const { data: toks } = await svc.from('device_tokens').select('token').in('user_id', userIds);
  const stale: string[] = [];
  await Promise.allSettled(
    (toks ?? []).map(async (r: { token: string }) => {
      if ((await sendToToken(at, sa.project_id, r.token, title, body)) === 'stale') stale.push(r.token);
    }),
  );
  if (stale.length) await svc.from('device_tokens').delete().in('token', stale);
}

/** Stages at which staff (Director/officers) get alerted. */
const STAFF_ALERT_STAGES: PriStage[] = ['submitted', 'with_chief_director'];

async function usersOfTransporter(svc: SupabaseClient, transporterId: string | null): Promise<string[]> {
  if (!transporterId) return [];
  const { data } = await svc.from('app_users').select('id').eq('transporter_id', transporterId);
  return (data ?? []).map((u: { id: string }) => u.id);
}

/**
 * Notify the relevant parties that an invoice moved to `stage`:
 *  - the transporter's users, on every change;
 *  - staff, when it reaches a staff-alert stage.
 */
export async function notifyStageChange(invoiceId: string, stage: PriStage): Promise<void> {
  const svc = serviceDb();
  const { data: inv } = await svc
    .from('invoices')
    .select('reference_no, transporter_id, transporters(display_name)')
    .eq('id', invoiceId)
    .single();
  if (!inv) return;

  const ref = (inv as { reference_no?: string }).reference_no ?? invoiceId.slice(0, 8).toUpperCase();
  const transporterId = (inv as { transporter_id?: string }).transporter_id ?? null;
  const label = STAGE_LABELS[stage];

  await pushToUsers(await usersOfTransporter(svc, transporterId), `Invoice ${ref}`, `Status updated to "${label}".`);

  if (STAFF_ALERT_STAGES.includes(stage)) {
    const { data: staff } = await svc.from('app_users').select('id').in('role', ['admin', 'officer']);
    const who = (inv as { transporters?: { display_name?: string } }).transporters?.display_name ?? 'a transporter';
    await pushToUsers((staff ?? []).map((u: { id: string }) => u.id), `Invoice ${ref}`, `From ${who} — now "${label}" and needs attention.`);
  }
}

/** Notify the transporter's users that their checklist was returned/disapproved. */
export async function notifyDisapproval(invoiceId: string, note: string): Promise<void> {
  const svc = serviceDb();
  const { data: inv } = await svc.from('invoices').select('reference_no, transporter_id').eq('id', invoiceId).single();
  if (!inv) return;
  const ref = (inv as { reference_no?: string }).reference_no ?? invoiceId.slice(0, 8).toUpperCase();
  const transporterId = (inv as { transporter_id?: string }).transporter_id ?? null;
  await pushToUsers(await usersOfTransporter(svc, transporterId), `Invoice ${ref}`, `Checklist returned — ${note}`);
}
