'use strict';

const CACHE_NAME = 'gowa-hekaya-v3';
const APP_SHELL = [
  '/',
  '/dashboard',
  '/self-check',
  '/styles.css',
  '/theme.js',
  '/app.js',
  '/dashboard.js',
  '/self-check.js',
  '/manifest.webmanifest',
  '/icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw new Error('This page is unavailable offline.');
    })
  );
});

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: 'وصلتك رسالة جديدة.' };
  }
  const url = new URL(payload.url || '/dashboard', self.location.origin);
  const safeUrl = url.origin === self.location.origin ? url.pathname : '/dashboard';
  event.waitUntil(self.registration.showNotification(payload.title || 'جوة الحكاية', {
    body: payload.body || 'وصلتك رسالة جديدة. افتح لوحة الإدارة لقراءتها.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'gowa-new-message',
    data: { url: safeUrl }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/dashboard', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    const existing = clientList.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});
