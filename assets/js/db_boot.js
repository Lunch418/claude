// ════════════════════════════════════════════════════════════════
//  db_boot.js — раннее применение темы/акцента (до отрисовки).
//  Вынесено из инлайнового <script> ради строгого CSP (V-06).
//  Грузится первым в <head> без defer, чтобы экран логина сразу был
//  в нужной теме и без мигания.
// ════════════════════════════════════════════════════════════════
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('sed_view_settings') || '{}');
    var r = document.documentElement;
    if (s.theme) r.dataset.theme = s.theme;
    if (s.anim === false) r.dataset.anim = 'off';
    var AC = {
      classic:['#3d5fa0','#2f4d8a'], blue:['#3b6fd4','#2f5cb8'], sky:['#0d9bd8','#0a83b8'], violet:['#7c5cdb','#674ac0'],
      pink:['#db5c93','#c04a7d'], green:['#2ba05c','#22864c'], teal:['#12a594','#0e8a7c'],
      orange:['#e08a2b','#c47522'], red:['#dc4b57','#c03946']
    };
    var a = AC[s.accent || 'classic'];
    if (a) {
      r.style.setProperty('--c-accent', a[0]);
      r.style.setProperty('--c-accent-h', a[1]);
      r.style.setProperty('--c-blue', a[0]);
      r.style.setProperty('--c-blue-h', a[1]);
    }
  } catch (e) {}
})();
