// Маскот-виджет в шапке: реагирует на действия пользователя короткими
// анимациями (настройки → ключ, запрос → компьютер, переход по FK → карта).
(function () {
  const el = document.getElementById('sedMascot');
  if (!el) return;

  let revertTimer = null;

  function setState(state, opts) {
    opts = opts || {};
    if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
    el.dataset.state = state;
    if (opts.autoIdleMs) {
      revertTimer = setTimeout(() => {
        if (el.dataset.state === state) el.dataset.state = 'idle';
      }, opts.autoIdleMs);
    }
  }

  // Публичный API: другие модули дёргают window.sedMascotState('query'), …
  // а для состояний-«вспышек» (settings/relations/success/error) сами не
  // возвращают в idle — держат таймер сброса здесь же.
  window.sedMascotState = setState;

  window.sedRegisterActions({
    mascotPoke() {
      if (el.dataset.state !== 'idle') return;
      setState('poke', { autoIdleMs: 900 });
    },
  });
})();
