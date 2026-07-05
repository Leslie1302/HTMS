/* Firebase Cloud Messaging service worker — handles background push.
 * Config is passed as query params by enablePush() (see src/lib/firebase.ts),
 * since a service worker can't read the app's build-time env. */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const p = new URL(location).searchParams;
firebase.initializeApp({
  apiKey: p.get('apiKey'),
  authDomain: p.get('authDomain'),
  projectId: p.get('projectId'),
  messagingSenderId: p.get('messagingSenderId'),
  appId: p.get('appId'),
});

firebase.messaging().onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || 'HTMS', {
    body: n.body || '',
    icon: '/ministry-logo.png',
    data: { link: (payload.fcmOptions && payload.fcmOptions.link) || '/' },
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow((event.notification.data && event.notification.data.link) || '/'));
});
