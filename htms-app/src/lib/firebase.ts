/**
 * Firebase Cloud Messaging (web push) — client side.
 * Registration token per browser is stored in `device_tokens`; the server
 * (netlify/functions/_fcm.ts) sends to those tokens on invoice updates.
 *
 * All VITE_FIREBASE_* values are public web config (safe to ship). If they're
 * unset, every export no-ops so the app runs without push configured.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getMessaging, getToken, onMessage, isSupported, type Messaging } from 'firebase/messaging';
import { supabase } from './supabase';

const env = import.meta.env as unknown as Record<string, string | undefined>;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: env.VITE_FIREBASE_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};
const VAPID_KEY = env.VITE_FIREBASE_VAPID_KEY;

export function pushConfigured(): boolean {
  return Boolean(config.apiKey && config.projectId && config.messagingSenderId && config.appId && VAPID_KEY);
}

let app: FirebaseApp | null = null;
let messaging: Messaging | null = null;
async function getMsg(): Promise<Messaging | null> {
  if (!pushConfigured() || !(await isSupported())) return null;
  if (!app) app = initializeApp(config);
  if (!messaging) messaging = getMessaging(app);
  return messaging;
}

export type EnableResult = 'ok' | 'denied' | 'unsupported' | 'unconfigured';

/**
 * Register this browser for push and store its token for `userId`.
 * Prompts for permission, so call it from a user gesture on first enable.
 */
export async function enablePush(userId: string): Promise<EnableResult> {
  if (!pushConfigured()) return 'unconfigured';
  const msg = await getMsg();
  if (!msg || typeof Notification === 'undefined') return 'unsupported';

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';

  // Pass the config to the service worker via query string so it can init
  // without a bundler (SWs can't read import.meta.env).
  const sw = await navigator.serviceWorker.register(
    `/firebase-messaging-sw.js?${new URLSearchParams(config as Record<string, string>).toString()}`,
  );
  const token = await getToken(msg, { vapidKey: VAPID_KEY, serviceWorkerRegistration: sw });
  if (!token) return 'denied';

  await supabase
    .from('device_tokens')
    .upsert({ user_id: userId, token, platform: 'web', last_seen_at: new Date().toISOString() }, { onConflict: 'token' });
  return 'ok';
}

/** Show foreground pushes as a native notification (background is handled by the SW). */
export async function listenForeground(): Promise<void> {
  const msg = await getMsg();
  if (!msg) return;
  onMessage(msg, (payload) => {
    const n = payload.notification;
    if (n && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(n.title ?? 'HTMS', { body: n.body, icon: '/ministry-logo.png' });
    }
  });
}
