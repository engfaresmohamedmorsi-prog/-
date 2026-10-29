'use strict';

const form = document.querySelector('#self-check-form');
const reflection = document.querySelector('#reflection');
const reflectionText = document.querySelector('#reflection-text');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(error => {
    console.error('Could not register the app service worker:', error);
  });
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const answers = [...new FormData(form).values()].map(Number);
  const recurringAnswers = answers.filter(answer => answer >= 2).length;
  reflectionText.textContent = recurringAnswers > 0
    ? 'تُظهر إجاباتك أن بعض هذه التجارب تكررت في الفترة الأخيرة. هذا لا يعني تشخيصًا، لكنه قد يكون فرصة للحديث مع شخص ترتاح إليه أو مختص إذا رغبت، خاصة إذا استمر الأمر أو أثّر في يومك.'
    : 'شكرًا لملاحظتك لمشاعرك. هذه الإجابات لا تحدد حالتك النفسية؛ واصل الاهتمام باحتياجاتك، واطلب الدعم من شخص تثق به متى احتجت.';
  reflection.classList.remove('hidden');
  reflection.focus();
});

form.addEventListener('reset', () => {
  reflection.classList.add('hidden');
  reflectionText.textContent = '';
});
