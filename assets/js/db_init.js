// ════════════════════════════════════════════════════════════════
//  db_init.js — инициализация экрана логина + действия без инлайна.
//  Вынесено из инлайновых <script> в db_viewer.html ради строгого CSP
//  (V-06). Грузится последним среди скриптов логина (после db_auth.js).
// ════════════════════════════════════════════════════════════════

// Тумблер показа пароля (было инлайновым onclick в db_viewer.html)
function togglePass() {
  var inp = document.getElementById('loginPassword');
  var btn = document.getElementById('btnTogglePass');
  if (!inp || !btn) return;
  var show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.innerHTML = show
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}
window.togglePass = togglePass;

// Действия экрана логина (делегирование вместо инлайна)
if (typeof window.sedRegisterActions === 'function') {
  window.sedRegisterActions({
    togglePass: function () { togglePass(); },
    // Выбор пользователя в комбобоксе логина (делегированный mousedown)
    loginCombo: function (el, e) { loginComboSelectEl(e, el); },
  });
}

// Guard-обёртка showApp (было инлайновым скриптом в db_viewer.html)
(function () {
  var _origShowApp = window.showApp;
  window.showApp = function (name, isAdmin) {
    if (window._showAppGuard) return;
    window._showAppGuard = true;
    _origShowApp(name, isAdmin);
  };
})();

document.addEventListener('DOMContentLoaded', function () {
  if (typeof authInit === 'function') authInit();
  document.addEventListener('mousedown', function (e) {
    var m = document.getElementById('historyModal');
    if (m && m.classList.contains('open') && e.target === m && typeof closeHistoryModal === 'function') {
      closeHistoryModal();
    }
  });
});
