'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const webPush = require('web-push');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_LENGTH = 1000;
const sessions = new Map();
const requestWindows = new Map();
const passwordSalt = crypto.randomBytes(16);

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('Set ADMIN_PASSWORD to a password with at least 12 characters.');
  process.exit(1);
}

const passwordHash = crypto.scryptSync(ADMIN_PASSWORD, passwordSalt, 64);
if (PUSH_ENABLED) {
  webPush.setVapidDetails(process.env.VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else if (VAPID_PUBLIC_KEY || VAPID_PRIVATE_KEY || process.env.VAPID_SUBJECT) {
  console.warn('Push notifications are disabled: configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT.');
}
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      if (tooLarge) return;
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('حجم الطلب أكبر من المسموح.'), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('صيغة البيانات غير صحيحة.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function getClientKey(request) {
  return request.socket.remoteAddress || 'unknown';
}

function isRateLimited(request, bucket, limit, windowMs) {
  const now = Date.now();
  const key = `${bucket}:${getClientKey(request)}`;
  const timestamps = (requestWindows.get(key) || []).filter(time => now - time < windowMs);
  if (timestamps.length >= limit) {
    requestWindows.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  requestWindows.set(key, timestamps);
  if (requestWindows.size > 2000) {
    for (const [entryKey, entryTimes] of requestWindows) {
      if (!entryTimes.some(time => now - time < windowMs)) requestWindows.delete(entryKey);
    }
  }
  return false;
}

function hasSameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    if (new URL(origin).host === request.headers.host) return true;
  } catch {
    // Reject malformed origins below.
  }
  sendJson(response, 403, { error: 'الطلب من مصدر غير مسموح.' });
  return false;
}

function readCookie(request, name) {
  const cookieHeader = request.headers.cookie || '';
  const entry = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : '';
}

function getSession(request) {
  const token = readCookie(request, 'inbox_session');
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function requireSession(request, response) {
  if (getSession(request)) return true;
  sendJson(response, 401, { error: 'سجّل الدخول أولًا.' });
  return false;
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

async function loadMessages() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const contents = await fs.readFile(DATA_FILE, 'utf8');
    const messages = JSON.parse(contents);
    if (!Array.isArray(messages)) throw new Error('Stored messages must be a JSON array.');
    return messages;
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(DATA_FILE, '[]\n', { flag: 'wx' });
      return [];
    }
    throw error;
  }
}

async function loadSubscriptions() {
  try {
    const contents = await fs.readFile(SUBSCRIPTIONS_FILE, 'utf8');
    const stored = JSON.parse(contents);
    if (!Array.isArray(stored)) throw new Error('Stored push subscriptions must be a JSON array.');
    return stored;
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(SUBSCRIPTIONS_FILE, '[]\n', { flag: 'wx', mode: 0o600 });
      return [];
    }
    throw error;
  }
}

let messages;
let subscriptions;
let messagePersistQueue = Promise.resolve();
let subscriptionPersistQueue = Promise.resolve();

function updateMessages(change) {
  const operation = messagePersistQueue.catch(() => {}).then(async () => {
    const previousMessages = messages;
    const result = change(previousMessages);
    if (!result.changed) return result.value;
    messages = result.messages;
    const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporaryFile, `${JSON.stringify(messages, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporaryFile, DATA_FILE);
      return result.value;
    } catch (error) {
      messages = previousMessages;
      throw error;
    }
  });
  messagePersistQueue = operation;
  return operation;
}

function updateSubscriptions(change) {
  const operation = subscriptionPersistQueue.catch(() => {}).then(async () => {
    const next = change(subscriptions);
    const temporaryFile = `${SUBSCRIPTIONS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryFile, SUBSCRIPTIONS_FILE);
    subscriptions = next;
  });
  subscriptionPersistQueue = operation;
  return operation;
}

async function sendPushNotifications() {
  if (!PUSH_ENABLED || subscriptions.length === 0) return;
  const staleEndpoints = [];
  const payload = JSON.stringify({
    title: 'جوة الحكاية',
    body: 'وصلتك رسالة جديدة. افتح لوحة الإدارة لقراءتها.',
    url: '/dashboard'
  });
  const results = await Promise.allSettled(subscriptions.map(async subscription => {
    try {
      await webPush.sendNotification(subscription, payload);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        staleEndpoints.push(subscription.endpoint);
        return;
      }
      throw error;
    }
  }));
  for (const result of results) {
    if (result.status === 'rejected') console.error('Could not send a push notification:', result.reason);
  }
  if (staleEndpoints.length > 0) {
    await updateSubscriptions(current => current.filter(subscription => !staleEndpoints.includes(subscription.endpoint)));
  }
}

async function handleApi(request, response, pathname) {
  if (pathname === '/api/messages' && request.method === 'POST') {
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      sendJson(response, 415, { error: 'نوع البيانات غير مدعوم.' });
      return;
    }
    if (isRateLimited(request, 'message', 5, 60_000)) {
      sendJson(response, 429, { error: 'أرسلت رسائل كثيرة مؤخرًا. حاول بعد قليل.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      if (!response.destroyed) sendJson(response, error.statusCode || 400, { error: error.message || 'تعذر قراءة الطلب.' });
      return;
    }
    const text = typeof body.message === 'string' ? body.message.trim() : '';
    if (body.consent !== true || !text || text.length > MAX_MESSAGE_LENGTH) {
      sendJson(response, 400, { error: `وافق على الإشعار وأدخل رسالة بين 1 و${MAX_MESSAGE_LENGTH} حرف.` });
      return;
    }
    const message = {
      id: crypto.randomUUID(),
      text,
      createdAt: new Date().toISOString()
    };
    try {
      await updateMessages(current => ({
        messages: [message, ...current],
        value: message,
        changed: true
      }));
      sendJson(response, 201, { message: 'وصلت رسالتك بنجاح.' });
      sendPushNotifications().catch(error => {
        console.error('Could not send push notifications:', error);
      });
    } catch (error) {
      console.error('Could not save an incoming message:', error);
      sendJson(response, 500, { error: 'تعذر حفظ الرسالة. حاول لاحقًا.' });
    }
    return;
  }

  if (pathname === '/api/push/public-key' && request.method === 'GET') {
    if (!PUSH_ENABLED) {
      sendJson(response, 503, { error: 'إشعارات الخلفية غير مهيأة على الخادم بعد.' });
      return;
    }
    sendJson(response, 200, { publicKey: VAPID_PUBLIC_KEY });
    return;
  }

  if (pathname === '/api/push/subscribe' && request.method === 'POST') {
    if (!PUSH_ENABLED) {
      sendJson(response, 503, { error: 'إشعارات الخلفية غير مهيأة على الخادم بعد.' });
      return;
    }
    if (!hasSameOrigin(request, response) || !requireSession(request, response)) return;
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message || 'تعذر قراءة الطلب.' });
      return;
    }
    const subscription = body && typeof body === 'object' ? body.subscription : null;
    let endpoint;
    try {
      endpoint = new URL(subscription?.endpoint);
    } catch {
      sendJson(response, 400, { error: 'بيانات اشتراك الإشعارات غير صحيحة.' });
      return;
    }
    if (endpoint.protocol !== 'https:' || typeof subscription.keys?.p256dh !== 'string' || typeof subscription.keys?.auth !== 'string') {
      sendJson(response, 400, { error: 'بيانات اشتراك الإشعارات غير صحيحة.' });
      return;
    }
    try {
      await updateSubscriptions(current => [
        ...current.filter(item => item.endpoint !== subscription.endpoint),
        subscription
      ]);
      sendJson(response, 201, { message: 'تم تفعيل إشعارات الرسائل على هذا الجهاز.' });
    } catch (error) {
      console.error('Could not save a push subscription:', error);
      sendJson(response, 500, { error: 'تعذر حفظ إعداد الإشعارات.' });
    }
    return;
  }

  if (pathname === '/api/push/subscribe' && request.method === 'DELETE') {
    if (!hasSameOrigin(request, response) || !requireSession(request, response)) return;
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message || 'تعذر قراءة الطلب.' });
      return;
    }
    if (typeof body.endpoint !== 'string') {
      sendJson(response, 400, { error: 'عنوان اشتراك الإشعارات غير صحيح.' });
      return;
    }
    try {
      await updateSubscriptions(current => current.filter(subscription => subscription.endpoint !== body.endpoint));
      sendJson(response, 200, { message: 'تم إلغاء اشتراك الإشعارات.' });
    } catch (error) {
      console.error('Could not remove a push subscription:', error);
      sendJson(response, 500, { error: 'تعذر إلغاء اشتراك الإشعارات.' });
    }
    return;
  }

  if (pathname === '/api/login' && request.method === 'POST') {
    if (!hasSameOrigin(request, response)) return;
    if (isRateLimited(request, 'login', 5, 15 * 60_000)) {
      sendJson(response, 429, { error: 'محاولات دخول كثيرة. حاول بعد 15 دقيقة.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message || 'تعذر قراءة الطلب.' });
      return;
    }
    const providedPassword = typeof body.password === 'string' ? body.password : '';
    const providedHash = crypto.scryptSync(providedPassword, passwordSalt, 64);
    if (!crypto.timingSafeEqual(passwordHash, providedHash)) {
      sendJson(response, 401, { error: 'كلمة المرور غير صحيحة.' });
      return;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    response.setHeader('Set-Cookie', `inbox_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
    sendJson(response, 200, { message: 'تم تسجيل الدخول.' });
    return;
  }

  if (pathname === '/api/logout' && request.method === 'POST') {
    if (!hasSameOrigin(request, response)) return;
    sessions.delete(readCookie(request, 'inbox_session'));
    response.setHeader('Set-Cookie', 'inbox_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    sendJson(response, 200, { message: 'تم تسجيل الخروج.' });
    return;
  }

  if (pathname === '/api/messages' && request.method === 'GET') {
    if (!requireSession(request, response)) return;
    sendJson(response, 200, { messages });
    return;
  }

  const deleteMatch = pathname.match(/^\/api\/messages\/([0-9a-f-]{36})$/i);
  if (deleteMatch && request.method === 'DELETE') {
    if (!hasSameOrigin(request, response) || !requireSession(request, response)) return;
    let removed;
    try {
      removed = await updateMessages(current => {
        const index = current.findIndex(message => message.id === deleteMatch[1]);
        if (index === -1) return { messages: current, value: null, changed: false };
        const next = [...current];
        const [message] = next.splice(index, 1);
        return { messages: next, value: message, changed: true };
      });
      if (!removed) {
        sendJson(response, 404, { error: 'الرسالة غير موجودة.' });
        return;
      }
      sendJson(response, 200, { message: 'حُذفت الرسالة.' });
    } catch (error) {
      console.error('Could not delete a message:', error);
      sendJson(response, 500, { error: 'تعذر حذف الرسالة.' });
    }
    return;
  }

  sendJson(response, 404, { error: 'المسار غير موجود.' });
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }
  const files = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/dashboard': 'dashboard.html',
    '/dashboard.html': 'dashboard.html',
    '/self-check': 'self-check.html',
    '/self-check.html': 'self-check.html',
    '/manifest.webmanifest': 'manifest.webmanifest',
    '/sw.js': 'sw.js',
    '/icon.svg': 'icon.svg',
    '/styles.css': 'styles.css',
    '/theme.js': 'theme.js',
    '/app.js': 'app.js',
    '/dashboard.js': 'dashboard.js',
    '/self-check.js': 'self-check.js'
  };
  const file = files[pathname];
  if (!file) {
    response.writeHead(404);
    response.end('Not Found');
    return;
  }
  const filePath = path.join(ROOT, file);
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(file).toLowerCase()],
      'Cache-Control': 'no-store'
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    console.error(`Could not serve ${file}:`, error);
    response.writeHead(500);
    response.end('Internal Server Error');
  }
}

async function start() {
  messages = await loadMessages();
  subscriptions = await loadSubscriptions();
  const server = http.createServer((request, response) => {
    setSecurityHeaders(response);
    let pathname;
    try {
      pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
    } catch {
      response.writeHead(400);
      response.end('Bad Request');
      return;
    }
    const operation = pathname.startsWith('/api/')
      ? handleApi(request, response, pathname)
      : serveStatic(request, response, pathname);
    operation.catch(error => {
      console.error('Request failed:', error);
      if (!response.headersSent) sendJson(response, 500, { error: 'حدث خطأ داخلي.' });
      else if (!response.destroyed) response.end();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`Message inbox listening at http://${HOST}:${PORT}`);
  });
}

start().catch(error => {
  console.error('Could not start the message inbox:', error);
  process.exitCode = 1;
});
