/**
 * smsMode SMS sending — server-side only (the API key is a Netlify secret).
 * https://dev.smsmode.com/sms  →  POST https://rest.smsmode.com/sms/v1/messages
 *
 * Every send is best-effort: failures are logged and swallowed so an SMS problem
 * can never break an invoice-stage transition. If SMSMODE_API_KEY is unset the
 * helpers no-op, so the app runs fine before the account is wired up.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceDb } from './_lib';
import { STAGE_LABELS, type PriStage } from '../../shared/lifecycle';

const ENDPOINT = 'https://rest.smsmode.com/sms/v1/messages';

/**
 * Normalise a local/international number to smsMode's `to` format: digits only,
 * country code first, no leading `+` or `0`. Ghana (233) is the default country.
 * Returns null if there aren't enough digits to be a real number.
 */
export function toE164Digits(raw: string | null | undefined, defaultCc = '233'): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = defaultCc + d.slice(1); // local 024… → 23324…
  else if (d.length <= 9) d = defaultCc + d; // bare subscriber number
  return d.length >= 11 ? d : null;
}

/** Send one SMS. Resolves true on apparent success, false otherwise (never throws). */
export async function sendSms(to: string | null | undefined, text: string): Promise<boolean> {
  const key = process.env.SMSMODE_API_KEY;
  const num = toE164Digits(to);
  if (!key || !num) return false;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ recipient: { to: num }, body: { text } }),
    });
    if (!res.ok) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'sms_send_failed', status: res.status }));
      return false;
    }
    return true;
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'sms_send_error', err: String(err) }));
    return false;
  }
}

/** Stages at which the Director/officers get alerted (invoice arriving at CD). */
const STAFF_ALERT_STAGES: PriStage[] = ['submitted', 'with_chief_director'];

/**
 * Notify the relevant parties that an invoice moved to `stage`:
 *  - the transporter, on every change;
 *  - staff (admin/officer) with a phone, when it reaches a staff-alert stage.
 * Uses the service role to read phones the caller may not see under RLS.
 */
export async function notifyStageChange(invoiceId: string, stage: PriStage): Promise<void> {
  const svc: SupabaseClient = serviceDb();
  const { data: inv } = await svc
    .from('invoices')
    .select('reference_no, transporters(display_name, phone)')
    .eq('id', invoiceId)
    .single();
  if (!inv) return;

  const t = (inv as { transporters?: { display_name?: string; phone?: string } }).transporters ?? {};
  const ref = (inv as { reference_no?: string }).reference_no ?? invoiceId.slice(0, 8).toUpperCase();
  const label = STAGE_LABELS[stage];

  const sends: Promise<boolean>[] = [
    sendSms(t.phone, `HTMS: Invoice ${ref} is now "${label}".`),
  ];

  if (STAFF_ALERT_STAGES.includes(stage)) {
    const { data: staff } = await svc
      .from('app_users')
      .select('phone')
      .in('role', ['admin', 'officer'])
      .not('phone', 'is', null);
    const who = t.display_name ?? 'a transporter';
    for (const s of staff ?? []) {
      sends.push(sendSms((s as { phone?: string }).phone, `HTMS: Invoice ${ref} from ${who} is now "${label}" and needs attention.`));
    }
  }
  await Promise.allSettled(sends);
}

/** Notify the transporter that their checklist was returned/disapproved. */
export async function notifyDisapproval(invoiceId: string, note: string): Promise<void> {
  const svc = serviceDb();
  const { data: inv } = await svc
    .from('invoices')
    .select('reference_no, transporters(phone)')
    .eq('id', invoiceId)
    .single();
  if (!inv) return;
  const t = (inv as { transporters?: { phone?: string } }).transporters ?? {};
  const ref = (inv as { reference_no?: string }).reference_no ?? invoiceId.slice(0, 8).toUpperCase();
  await sendSms(t.phone, `HTMS: Invoice ${ref} checklist was returned — ${note}`);
}
