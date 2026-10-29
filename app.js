'use strict';

const form = document.querySelector('#message-form');
const messageInput = document.querySelector('#message');
const consentInput = document.querySelector('#consent');
const charCount = document.querySelector('#char-count');
const status = document.querySelector('#form-status');
const submitButton = form.querySelector('button[type="submit"]');
const shareButton = document.querySelector('#share-button');
const installButton = document.querySelector('#install-button');
const installStatus = document.querySelector('#install-status');
let installPrompt;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(error => {
    console.error('Could not register the app service worker:', error);
    installStatus.textContent = 'تعذر تجهيز التطبيق للاستخدام دون اتصال.';
  });
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installStatus.textContent = 'تمت إضافة جوة الحكاية إلى جهازك.';
});

messageInput.addEventListener('input', () => {
  charCount.textContent = `${messageInput.value.length} / 1000`;
});

shareButton.addEventListener('click', async () => {
  const shareUrl = window.location.origin;
  try {
    if (navigator.share) {
      await navigator.share({
        title: 'جوة الحكاية | مساحة آمنة للكلام',
        text: 'اكتب رسالتك أو تواصل مع جوة الحكاية.',
        url: shareUrl
      });
    } else {
      await navigator.clipboard.writeText(shareUrl);
      status.textContent = 'نُسخ رابط الموقع. شارك الرابط العام بعد النشر؛ رابط المعاينة المحلية لا يعمل للآخرين.';
      status.className = 'form-status success';
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    status.textContent = 'تعذرت مشاركة الرابط من هذا المتصفح.';
    status.className = 'form-status error';
  }
});

installButton.addEventListener('click', async () => {
  if (installPrompt) {
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    installStatus.textContent = choice.outcome === 'accepted'
      ? 'تمت إضافة الموقع إلى قائمة التثبيت.'
      : 'يمكنك تثبيت الموقع لاحقًا من قائمة المتصفح.';
    installPrompt = null;
    return;
  }
  installStatus.textContent = 'من قائمة المتصفح اختر «إضافة إلى الشاشة الرئيسية» أو «تثبيت التطبيق». بعد النشر افتح رابط HTTPS العام.';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = '';
  status.className = 'form-status';
  submitButton.disabled = true;
  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageInput.value, consent: consentInput.checked })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر إرسال الرسالة.');
    form.reset();
    charCount.textContent = '0 / 1000';
    status.textContent = result.message;
    status.classList.add('success');
  } catch (error) {
    status.textContent = error.message || 'تعذر الاتصال بالخادم.';
    status.classList.add('error');
  } finally {
    submitButton.disabled = false;
  }
});
