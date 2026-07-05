import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { enablePush, listenForeground, pushConfigured } from '../lib/firebase';

/** Header bell: enables web push on click, and re-registers silently if already granted. */
export function NotificationsButton() {
  const { session } = useAuth();
  const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const [state, setState] = useState<'idle' | 'on' | 'busy'>(granted ? 'on' : 'idle');

  // Already granted → refresh this browser's token for the logged-in user, then listen.
  useEffect(() => {
    if (!session || !pushConfigured()) return;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      enablePush(session.user.id).then(() => listenForeground());
    }
  }, [session]);

  if (!pushConfigured() || !session) return null;

  async function enable() {
    if (!session) return;
    setState('busy');
    const r = await enablePush(session.user.id);
    if (r === 'ok') {
      setState('on');
      listenForeground();
    } else {
      setState('idle');
      if (r === 'denied') alert('Notifications are blocked. Allow them in your browser settings to receive updates.');
      if (r === 'unsupported') alert('Push notifications are not supported in this browser.');
    }
  }

  return (
    <button
      onClick={state === 'on' ? undefined : enable}
      disabled={state === 'busy'}
      title={state === 'on' ? 'Notifications enabled' : 'Enable push notifications'}
      className="text-white/60 hover:text-white disabled:opacity-50"
    >
      <span className="material-symbols-outlined text-base align-text-bottom">
        {state === 'on' ? 'notifications_active' : 'notifications'}
      </span>
    </button>
  );
}
