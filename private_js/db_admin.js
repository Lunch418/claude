// ════════════════════════════════════════════════════════════════
//  db_admin.js — админ-панель: сброс 2FA и снятие блокировок входа.
//  Одно окно: список пользователей, у каждого — статус блокировки
//  (с обратным отсчётом) и кнопки действий. Только для администратора.
// ════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  function isAdmin() {
    try { return typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin(); }
    catch (_) { return false; }
  }

  // ── Стили ──────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('adminStyles')) return;
    const st = document.createElement('style');
    st.id = 'adminStyles';
    st.textContent = `
      #admOverlay { position: fixed; inset: 0; z-index: 10000; background: rgba(20,26,40,.55);
        backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity .25s; }
      #admOverlay.show { opacity: 1; }
      #admCard { width: 580px; max-width: 94vw; max-height: 82vh; overflow: hidden; display: flex; flex-direction: column;
        background: var(--c-surface,#fff); border-radius: var(--r-lg,16px); box-shadow: 0 24px 60px rgba(0,0,0,.28);
        transform: translateY(16px) scale(.97); opacity: 0; transition: transform .3s cubic-bezier(.34,1.4,.5,1), opacity .25s; }
      #admOverlay.show #admCard { transform: none; opacity: 1; }
      .adm-head { padding: 20px 24px 16px; border-bottom: 1px solid var(--c-border,#e5e8ef); display: flex; align-items: center; justify-content: space-between; }
      .adm-title { font-size: 17px; font-weight: 650; color: var(--c-text,#1c2233); margin: 0; }
      .adm-sub { font-size: 12px; color: var(--c-text-3,#8a93a6); margin: 3px 0 0; }
      .adm-close { cursor: pointer; border: none; background: none; font-size: 22px; color: var(--c-text-3,#8a93a6); line-height: 1; padding: 0 4px; transition: color .15s, transform .15s; }
      .adm-close:hover { color: var(--c-text,#1c2233); transform: rotate(90deg); }
      .adm-body { padding: 6px 0; overflow-y: auto; }
      .adm-tabs { display: flex; gap: 2px; padding: 10px 24px 0; border-bottom: 1px solid var(--c-border,#e5e8ef); }
      .adm-tab { position: relative; padding: 9px 16px; font-size: 13px; font-weight: 550; cursor: pointer; border: none; background: none;
        color: var(--c-text-3,#8a93a6); transition: color .2s; }
      .adm-tab:hover { color: var(--c-text-2,#4a5468); }
      .adm-tab.active { color: var(--c-accent,#3b6fd4); }
      .adm-tab::after { content: ''; position: absolute; left: 50%; right: 50%; bottom: -1px; height: 2px;
        background: var(--c-accent,#3b6fd4); border-radius: 2px; transition: left .25s, right .25s; }
      .adm-tab.active::after { left: 8px; right: 8px; }
      .adm-tab .adm-tab-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px;
        padding: 0 5px; margin-left: 6px; font-size: 11px; border-radius: 10px; background: var(--c-red,#dc3545); color: #fff; }
      .adm-row { display: flex; align-items: center; gap: 12px; padding: 12px 24px; border-bottom: 1px solid var(--c-surface-2,#f2f3f6);
        animation: admRowIn .35s ease both; }
      .adm-row:last-child { border-bottom: none; }
      .adm-row:hover { background: var(--c-surface-2,#f6f7f9); }
      @keyframes admRowIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
      .adm-info { flex: 1; min-width: 0; }
      .adm-name { font-size: 14px; font-weight: 550; color: var(--c-text,#1c2233); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 7px; }
      .adm-meta { font-size: 11.5px; color: var(--c-text-3,#8a93a6); margin-top: 3px; display: flex; align-items: center; gap: 6px; }
      .adm-badge { font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 20px; background: var(--c-accent-bg,#eef3fc); color: var(--c-accent,#3b6fd4); }
      .adm-lock { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; color: var(--c-red,#dc3545);
        background: #fff0f0; padding: 2px 9px; border-radius: 20px; animation: admPulse 1.6s ease-in-out infinite; }
      @keyframes admPulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
      .adm-lock-timer { font-variant-numeric: tabular-nums; }
      .adm-free { font-size: 11.5px; color: var(--c-green,#2b9d5b); font-weight: 550; }
      .adm-btns { display: flex; gap: 7px; }
      .adm-btn { border: 1px solid var(--c-border,#e5e8ef); background: var(--c-surface,#fff); border-radius: 8px;
        padding: 6px 11px; font-size: 12px; font-weight: 550; cursor: pointer; color: var(--c-text-2,#4a5468);
        transition: all .15s; white-space: nowrap; }
      .adm-btn:hover { border-color: var(--c-accent,#3b6fd4); color: var(--c-accent,#3b6fd4); transform: translateY(-1px); }
      .adm-btn.danger:hover { border-color: var(--c-red,#dc3545); color: var(--c-red,#dc3545); background: #fff5f5; }
      .adm-btn:disabled { opacity: .5; cursor: default; transform: none; }
      .adm-empty { padding: 44px 24px; text-align: center; color: var(--c-text-3,#8a93a6); font-size: 13px; }
      .adm-spin { width: 26px; height: 26px; border: 3px solid var(--c-border,#e5e8ef); border-top-color: var(--c-accent,#3b6fd4);
        border-radius: 50%; margin: 30px auto; animation: admSpin .7s linear infinite; }
      @keyframes admSpin { to { transform: rotate(360deg); } }
      #admToast { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%) translateY(24px);
        display: flex; align-items: center; gap: 9px; padding: 12px 20px; border-radius: 12px; font-size: 13.5px; font-weight: 550;
        background: var(--c-surface,#fff); color: var(--c-text,#1c2233); box-shadow: 0 12px 34px rgba(0,0,0,.2);
        border: 1px solid var(--c-border,#e5e8ef); opacity: 0; z-index: 10001; transition: opacity .3s, transform .3s cubic-bezier(.34,1.4,.5,1); }
      #admToast.show { opacity: 1; transform: translateX(-50%); }
      #admToast .adm-toast-ico { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
      #admToast.ok .adm-toast-ico { background: var(--c-green,#2b9d5b); }
      #admToast.err .adm-toast-ico { background: var(--c-red,#dc3545); }
      #admToast .adm-toast-ico svg { stroke: #fff; }

      /* Кнопка-шестерёнка в бейдже пользователя */
      .adm-gear { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
        border: none; background: transparent; cursor: pointer; color: var(--c-text-3,#8a93a6);
        border-radius: 8px; padding: 0; margin: 0 2px; transition: color .2s, background .2s; }
      .adm-gear:hover { color: var(--c-accent,#3b6fd4); background: var(--c-accent-bg,#eef3fc); }
      .adm-gear svg { transition: transform .15s; }
      .adm-gear:hover svg { animation: admGearSpin 2.4s linear infinite; }
      .adm-gear:active svg { transform: scale(.9); }
      @keyframes admGearSpin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(st);
  }

  // ── Единый тост ────────────────────────────────────────────────
  function toast(msg, ok = true) {
    document.getElementById('admToast')?.remove();
    const t = document.createElement('div');
    t.id = 'admToast';
    t.className = ok ? 'ok' : 'err';
    const icon = ok
      ? '<polyline points="20 6 9 17 4 12"/>'
      : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';
    t.innerHTML =
      `<span class="adm-toast-ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span>` +
      `<span>${esc(msg)}</span>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 320); }, 2400);
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmt(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  async function api(action, payload) {
    const r = await fetch(`${API}?m=Auth&a=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': getCsrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify(payload || {}),
    });
    return r.json();
  }

  let _tickTimer = null;

  window.openAdmin2fa = function () {
    if (!isAdmin()) return;
    injectStyles();
    close();

    const overlay = document.createElement('div');
    overlay.id = 'admOverlay';
    overlay.innerHTML =
      '<div id="admCard">' +
        '<div class="adm-head"><div>' +
          '<h3 class="adm-title">Управление доступом</h3>' +
          '<p class="adm-sub">2FA и блокировки входа пользователей</p>' +
        '</div><button class="adm-close" id="admClose">&times;</button></div>' +
        '<div class="adm-tabs">' +
          '<button class="adm-tab active" data-tab="tfa">2FA пользователей</button>' +
          '<button class="adm-tab" data-tab="locks">Блокировки <span class="adm-tab-count" id="admLockCount" style="display:none">0</span></button>' +
        '</div>' +
        '<div class="adm-body" id="admBody"><div class="adm-spin"></div></div>' +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    document.getElementById('admClose').addEventListener('click', close);
    document.addEventListener('keydown', escClose);

    overlay.querySelectorAll('.adm-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        overlay.querySelectorAll('.adm-tab').forEach(x => x.classList.remove('active'));
        tab.classList.add('active');
        _curTab = tab.dataset.tab;
        renderTab();
      });
    });

    _curTab = 'tfa';
    renderTab();
    refreshLockCount();   // подтянуть счётчик блокировок на вкладку
  };

  let _curTab = 'tfa';

  function renderTab() {
    if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
    const body = document.getElementById('admBody');
    if (body) body.innerHTML = '<div class="adm-spin"></div>';
    if (_curTab === 'locks') renderLocks();
    else render();
  }

  async function refreshLockCount() {
    try {
      const data = await api('lockList');
      const n = data.ok ? (data.rows?.length || 0) : 0;
      const badge = document.getElementById('admLockCount');
      if (badge) {
        badge.textContent = n;
        badge.style.display = n > 0 ? 'inline-flex' : 'none';
      }
    } catch (_) {}
  }

  function escClose(e) { if (e.key === 'Escape') close(); }

  async function render() {
    const body = document.getElementById('admBody');
    if (!body) return;
    try {
      const data = await api('tfaList');
      if (!data.ok) { body.innerHTML = `<div class="adm-empty">${esc(data.error || 'Ошибка')}</div>`; return; }
      if (!data.rows?.length) { body.innerHTML = '<div class="adm-empty">Пока никто не привязал 2FA</div>'; return; }

      body.innerHTML = data.rows.map((u, i) => {
        const date = u.created_at ? String(u.created_at).slice(0, 10) : '';
        const badge = u.isAdmin ? '<span class="adm-badge">админ</span>' : '';
        const locked = (u.lockedFor || 0) > 0;
        const status = locked
          ? `<span class="adm-lock" data-lock="${u.lockedFor}">заблокирован · <span class="adm-lock-timer">${fmt(u.lockedFor)}</span></span>`
          : `<span class="adm-free">активен</span>`;
        return `<div class="adm-row" data-key="${esc(u.user_key)}" style="animation-delay:${i * 40}ms">
          <div class="adm-info">
            <div class="adm-name">${esc(u.name)} ${badge}</div>
            <div class="adm-meta">${status} <span style="opacity:.6">· привязан ${esc(date) || '—'}</span></div>
          </div>
          <div class="adm-btns">
            <button class="adm-btn" data-act="unlock"${locked ? '' : ' disabled'}>Снять блок</button>
            <button class="adm-btn danger" data-act="reset2fa">Сбросить 2FA</button>
          </div>
        </div>`;
      }).join('');

      bindRows();
      startTick();
    } catch (e) {
      body.innerHTML = '<div class="adm-empty">Ошибка сети</div>';
    }
  }

  function bindRows() {
    document.querySelectorAll('#admBody .adm-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.adm-row');
        const key = row.dataset.key;
        const name = row.querySelector('.adm-name').textContent.trim();

        if (btn.dataset.act === 'reset2fa') {
          if (!confirm(`Сбросить 2FA для «${name}»?\nПри следующем входе пользователю снова покажут QR-код для привязки.`)) return;
          btn.disabled = true;
          const r = await api('tfaReset', { user_key: key });
          if (r.ok) { toast(`2FA сброшен: ${name}`); render(); }
          else { toast(r.error || 'Ошибка', false); btn.disabled = false; }
        } else {
          btn.disabled = true;
          const r = await api('unlockUser', { user_key: key });
          if (r.ok) {
            toast(`Блокировка снята: ${name}`);
            // мгновенно убираем статус блокировки в строке
            const lock = row.querySelector('.adm-lock');
            if (lock) {
              lock.outerHTML = '<span class="adm-free">активен</span>';
            }
          } else {
            toast(r.error || 'Ошибка', false);
            btn.disabled = false;
          }
        }
      });
    });
  }

  // ── Раздел «Блокировки» ────────────────────────────────────────
  async function renderLocks() {
    const body = document.getElementById('admBody');
    if (!body) return;
    try {
      const data = await api('lockList');
      if (!data.ok) { body.innerHTML = `<div class="adm-empty">${esc(data.error || 'Ошибка')}</div>`; return; }
      if (data.apcu) { body.innerHTML = '<div class="adm-empty">Список недоступен (кэш APCu).<br>Снятие блокировки — через раздел 2FA по пользователю.</div>'; return; }
      if (!data.rows?.length) { body.innerHTML = '<div class="adm-empty"> Сейчас никто не заблокирован</div>'; return; }

      body.innerHTML = data.rows.map((row, i) => {
        return `<div class="adm-row" data-file="${esc(row.file)}" style="animation-delay:${i * 40}ms">
          <div class="adm-info">
            <div class="adm-name">${esc(row.name)}</div>
            <div class="adm-meta">
              <span class="adm-lock" data-lock="${row.lockedFor}">осталось <span class="adm-lock-timer">${fmt(row.lockedFor)}</span></span>
              <span style="opacity:.6">· ${row.attempts} неудачных попыток</span>
            </div>
          </div>
          <div class="adm-btns">
            <button class="adm-btn danger" data-act="unlockKey">Снять блокировку</button>
          </div>
        </div>`;
      }).join('');

      body.querySelectorAll('[data-act="unlockKey"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const rowEl = btn.closest('.adm-row');
          const file  = rowEl.dataset.file;
          const name  = rowEl.querySelector('.adm-name').textContent.trim();
          btn.disabled = true;
          const r = await api('unlockKey', { file });
          if (r.ok) {
            toast(`Блокировка снята: ${name}`);
            // плавно убираем строку
            rowEl.style.transition = 'opacity .3s, transform .3s';
            rowEl.style.opacity = '0';
            rowEl.style.transform = 'translateX(12px)';
            setTimeout(() => {
              rowEl.remove();
              refreshLockCount();
              if (!document.querySelector('#admBody .adm-row')) {
                document.getElementById('admBody').innerHTML = '<div class="adm-empty">🎉 Сейчас никто не заблокирован</div>';
              }
            }, 300);
          } else {
            toast(r.error || 'Ошибка', false);
            btn.disabled = false;
          }
        });
      });

      startTick();
      refreshLockCount();
    } catch (e) {
      body.innerHTML = '<div class="adm-empty">Ошибка сети</div>';
    }
  }

  // ── Тикающий обратный отсчёт для заблокированных ────────────────
  function startTick() {
    if (_tickTimer) clearInterval(_tickTimer);
    _tickTimer = setInterval(() => {
      const locks = document.querySelectorAll('#admBody .adm-lock');
      if (!locks.length) { clearInterval(_tickTimer); _tickTimer = null; return; }
      locks.forEach(lock => {
        let left = parseInt(lock.dataset.lock, 10) - 1;
        if (left <= 0) {
          const row = lock.closest('.adm-row');
          if (_curTab === 'locks') {
            // в списке блокировок истёкшую строку убираем
            if (row) {
              row.style.transition = 'opacity .3s';
              row.style.opacity = '0';
              setTimeout(() => {
                row.remove();
                refreshLockCount();
                if (!document.querySelector('#admBody .adm-row')) {
                  const b = document.getElementById('admBody');
                  if (b) b.innerHTML = '<div class="adm-empty">🎉 Сейчас никто не заблокирован</div>';
                }
              }, 300);
            }
          } else {
            lock.outerHTML = '<span class="adm-free">● активен</span>';
            row?.querySelector('[data-act="unlock"]')?.setAttribute('disabled', '');
          }
        } else {
          lock.dataset.lock = left;
          const t = lock.querySelector('.adm-lock-timer');
          if (t) t.textContent = fmt(left);
        }
      });
    }, 1000);
  }

  function close() {
    if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
    document.removeEventListener('keydown', escClose);
    document.getElementById('admOverlay')?.remove();
  }

  // ── Кнопка-шестерёнка в бейдже пользователя (только админ) ──────
  function mountButton() {
    if (!isAdmin()) return;
    const badge = document.getElementById('userBadge');
    if (!badge || document.getElementById('admGearBtn')) return;

    injectStyles();
    const btn = document.createElement('button');
    btn.id = 'admGearBtn';
    btn.className = 'adm-gear';
    btn.title = 'Управление доступом';
    btn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
      '</svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.openAdmin2fa();
    });

    // вставляем перед кнопкой выхода, если она есть, иначе в конец бейджа
    const logout = document.getElementById('btnLogout');
    if (logout) badge.insertBefore(btn, logout);
    else badge.appendChild(btn);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(mountButton, 300);
  } else {
    window.addEventListener('load', () => setTimeout(mountButton, 300));
  }
})();