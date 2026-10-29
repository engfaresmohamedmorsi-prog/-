'use strict';

const loginForm = document.querySelector('#login-form');
const passwordInput = document.querySelector('#password');
const status = document.querySelector('#dashboard-status');
const inbox = document.querySelector('#inbox');
const messageList = document.querySelector('#message-list');
const messageCount = document.querySelector('#message-count');
const logoutButton = document.querySelector('#logout-button');
const refreshButton = document.querySelector('#refresh-button');
const notificationButton = document.querySelector('#notification-button');
const notificationStatus = document.querySelector('#notification-status');
const archiveSearch = document.querySelector('#archive-search');
const serviceWorkerReady = 'serviceWorker' in navigator
  ? navigator.serviceWorker.register('/sw.js').catch(error => {
    console.error('Could not register the app service worker:', error);
    return null;
  })
  : Promise.resolve(null);
let knownMessageIds = null;
let allMessages = [];
let pollingTimer;

function stopPolling() {
  if (pollingTimer) window.clearInterval(pollingTimer);
  pollingTimer = undefined;
}

function startPolling() {
  stopPolling();
  pollingTimer = window.setInterval(() => loadMessages({ notify: true }), 15_000);
}

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = `form-status ${kind}`.trim();
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ar', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function createMessageCard(message, index) {
  const card = document.createElement('article');
  card.className = 'message-card';

  const header = document.createElement('div');
  header.className = 'message-header';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const number = document.createElement('span');
  number.className = 'message-number';
  number.textContent = `رسالة ${index + 1}`;
  const date = document.createElement('time');
  date.dateTime = message.createdAt;
  date.textContent = formatDate(message.createdAt);

  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const copyButton = document.createElement('button');
  copyButton.className = 'copy-button';
  copyButton.type = 'button';
  copyButton.textContent = 'نسخ';
  copyButton.addEventListener('click', () => copyMessage(message.text));

  const removeButton = document.createElement('button');
  removeButton.className = 'delete-button';
  removeButton.type = 'button';
  removeButton.textContent = 'حذف';
  removeButton.addEventListener('click', () => deleteMessage(message.id));

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;
  meta.append(number, date);
  actions.append(copyButton, removeButton);
  header.append(meta, actions);
  card.append(header, text);
  return card;
}

function renderMessages() {
  const query = archiveSearch.value.trim().toLocaleLowerCase('ar');
  const filteredMessages = allMessages.filter(message =>
    message.text.toLocaleLowerCase('ar').includes(query)
  );
  messageCount.textContent = query
    ? `عرض ${filteredMessages.length} من ${allMessages.length} رسالة`
    : `${allMessages.length} ${allMessages.length === 1 ? 'رسالة' : 'رسائل'}`;
  messageList.replaceChildren();
  if (filteredMessages.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = allMessages.length === 0
      ? 'لا توجد رسائل في الأرشيف بعد.'
      : 'لا توجد رسائل تطابق عبارة البحث.';
    messageList.append(empty);
    return;
  }
  messageList.append(...filteredMessages.map(createMessageCard));
}

async function copyMessage(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus('نُسخت الرسالة.', 'success');
  } catch {
    setStatus('تعذر نسخ الرسالة من هذا المتصفح.', 'error');
  }
}

async function loadMessages({ notify = false } = {}) {
  try {
    const response = await fetch('/api/messages');
    if (response.status === 401) {
      stopPolling();
      knownMessageIds = null;
      inbox.classList.add('hidden');
      logoutButton.classList.add('hidden');
      loginForm.classList.remove('hidden');
      return;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحميل الرسائل.');
    const currentIds = new Set(result.messages.map(message => message.id));
    if (notify && knownMessageIds) {
      const newMessages = result.messages.filter(message => !knownMessageIds.has(message.id));
      if (newMessages.length > 0) {
        setStatus(`وصلت ${newMessages.length} رسالة جديدة.`, 'success');
        if ('Notification' in window && Notification.permission === 'granted') {
          serviceWorkerReady.then(registration => registration?.showNotification('جوة الحكاية: رسالة جديدة', {
            body: `لديك ${newMessages.length} رسالة جديدة. افتح لوحة الإدارة لقراءتها.`
          })).catch(error => console.error('Could not show a dashboard notification:', error));
        }
      }
    }
    knownMessageIds = currentIds;
    allMessages = result.messages;
    loginForm.classList.add('hidden');
    inbox.classList.remove('hidden');
    logoutButton.classList.remove('hidden');
    renderMessages();
    if (!pollingTimer) startPolling();
  } catch (error) {
    setStatus(error.message || 'تعذر الاتصال بالخادم.', 'error');
  }
}

async function deleteMessage(id) {
  const confirmed = window.confirm('هل تريد حذف هذه الرسالة نهائيًا؟');
  if (!confirmed) return;
  try {
    const response = await fetch(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حذف الرسالة.');
    allMessages = allMessages.filter(message => message.id !== id);
    knownMessageIds?.delete(id);
    renderMessages();
    setStatus('حُذفت الرسالة.', 'success');
  } catch (error) {
    setStatus(error.message || 'تعذر الاتصال بالخادم.', 'error');
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  setStatus('');
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تسجيل الدخول.');
    passwordInput.value = '';
    await loadMessages();
  } catch (error) {
    setStatus(error.message || 'تعذر الاتصال بالخادم.', 'error');
  }
});

notificationButton.addEventListener('click', async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    notificationStatus.textContent = 'هذا المتصفح أو الجهاز لا يدعم إشعارات الخلفية. استخدم أحدث إصدار من متصفح يدعم Web Push.';
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      notificationStatus.textContent = 'لم يتم السماح بالإشعارات. يمكنك تفعيلها من إعدادات المتصفح.';
      return;
    }

    const keyResponse = await fetch('/api/push/public-key');
    const keyResult = await keyResponse.json();
    if (!keyResponse.ok) throw new Error(keyResult.error || 'إشعارات الخلفية غير مهيأة على الخادم.');
    const registration = await serviceWorkerReady;
    if (!registration) throw new Error('تعذر تشغيل خدمة إشعارات المتصفح.');
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeApplicationServerKey(keyResult.publicKey)
    });
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ إعداد الإشعارات.');
    notificationStatus.textContent = `${result.message} تصل حتى واللوحة مغلقة ما دام الخادم يعمل.`;
  } catch (error) {
    notificationStatus.textContent = error.message || 'تعذر تفعيل الإشعارات. تحقق من HTTPS وإعداد مفاتيح VAPID على الخادم.';
  }
});

function decodeApplicationServerKey(encodedKey) {
  const padding = '='.repeat((4 - encodedKey.length % 4) % 4);
  const base64 = `${encodedKey}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

logoutButton.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تسجيل الخروج.');
    inbox.classList.add('hidden');
    logoutButton.classList.add('hidden');
    loginForm.classList.remove('hidden');
    stopPolling();
    knownMessageIds = null;
    setStatus('تم تسجيل الخروج.', 'success');
  } catch (error) {
    setStatus(error.message || 'تعذر الاتصال بالخادم.', 'error');
  }
});

refreshButton.addEventListener('click', loadMessages);
archiveSearch.addEventListener('input', renderMessages);
loadMessages();
