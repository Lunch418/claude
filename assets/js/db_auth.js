// ════════════════════════════════════════════════════════════════
//  AUTH — db_auth.js
//  Авторизация через AuthController (PHP сессии) + 2FA
// ════════════════════════════════════════════════════════════════

// API объявлен здесь — db_auth.js грузится первым, до db_app.js
const API = window.APP_CONFIG?.apiUrl ?? '/index.php';

// ── CSRF-токен ─────────────────────────────────────────────────
function getCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// Перехватывает ВСЕ fetch-вызовы и добавляет X-XSRF-TOKEN
(function () {
  var _origFetch = window.fetch;
  window.fetch = function (url, opts) {
    opts = opts ? Object.assign({}, opts) : {};
    var method = (opts.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      var token = getCsrfToken();
      if (token) {
        var existing = opts.headers || {};
        if (existing instanceof Headers) {
          if (!existing.has('X-XSRF-TOKEN')) existing.set('X-XSRF-TOKEN', token);
          opts.headers = existing;
        } else {
          opts.headers = Object.assign({ 'X-XSRF-TOKEN': token }, existing);
        }
      }
    }
    return _origFetch.apply(this, arguments);
  };
}());

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let _loginUsers      = [];
let _loginComboOpen  = false;
let _loginUsersReady = false;

// ── Инициализация ──────────────────────────────────────────────
async function authInit() {

  const saved = localStorage.getItem('sed_auth_user');
  if (saved) {
    try {
      const u = JSON.parse(saved);
      if (u?.name) {

        showApp(u.name, !!u.isAdmin);
        return;
      }
    } catch (_) {}
    localStorage.removeItem('sed_auth_user');
  }

  document.getElementById('loginOverlay').classList.remove('hidden');
  _setupLoginUi();
  await _loadLoginUsers();
}

// ── UX пароля ─────────────────────────────────────────────────
function _setupLoginUi() {
  const pass = document.getElementById('loginPassword');
  if (!pass) return;
  pass.setAttribute('type', 'password');
  pass.setAttribute('autocomplete', 'current-password');
  pass.setAttribute('autocorrect', 'off');
  pass.setAttribute('autocapitalize', 'off');
  pass.setAttribute('spellcheck', 'false');
  pass.addEventListener('input', () => {
    pass.value = pass.value.replace(/\s+/g, '');
  });
}

// ── Загрузка списка пользователей через сервер ─────────────────
const _USERS_CACHE_KEY = 'sed_login_users_v1';

function _usersFromCache() {
  try {
    const raw = sessionStorage.getItem(_USERS_CACHE_KEY);
    if (!raw) return null;
    const { users, ts } = JSON.parse(raw);
    if (Date.now() - ts > 30 * 60 * 1000) return null;
    return users;
  } catch (_) { return null; }
}

function _usersToCache(users) {
  try {
    sessionStorage.setItem(_USERS_CACHE_KEY, JSON.stringify({ users, ts: Date.now() }));
  } catch (_) {}
}

async function _loadLoginUsers() {
  const list = document.getElementById('loginComboList');
  if (!list) return;

  const cached = _usersFromCache();
  if (cached) {
    _loginUsers = cached;
    _loginUsersReady = true;
    _renderLoginList();
    _fetchLoginUsers(false);
    return;
  }

  list.innerHTML = '<div class="org-combo-msg"> Загрузка...</div>';
  await _fetchLoginUsers(true);
}

async function _fetchLoginUsers(showErrors) {
  const list = document.getElementById('loginComboList');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    const r = await fetch(`${API}?m=Auth&a=users`, {
      method:      'GET',
      headers:     { 'Accept': 'application/json' },
      credentials: 'same-origin',
      signal:      controller.signal,
    });
    clearTimeout(timer);

    const res = await r.json();

    if (!r.ok || !res.ok) {
      if (showErrors && list) {
        list.innerHTML = `<div class="org-combo-msg" style="color:var(--c-red)">Ошибка: ${escHtml(res.error || 'неизвестно')}</div>`;
      }
      return;
    }

    const users = [
      { id: '__admin__', login: 'admin', name: 'Администратор', isVirtual: true },
      ...(res.rows || []),
    ];

    _loginUsers = users;
    _loginUsersReady = true;
    _usersToCache(users);
    _renderLoginList();

  } catch (e) {
    if (showErrors && list) {
      const msg = e.name === 'AbortError' ? 'Сервер не отвечает (>60с)' : e.message;
      list.innerHTML = `<div class="org-combo-msg" style="color:var(--c-red)">Ошибка: ${escHtml(msg)}</div>`;
    }
  }
}

// ── Рендер списка ──────────────────────────────────────────────
function _renderLoginList() {
  const list  = document.getElementById('loginComboList');
  const combo = document.getElementById('loginCombo');
  if (!list) return;

  const selVal = combo?.dataset.val ?? '';
  const items  = _loginUsers;

  if (!items.length) {
    list.innerHTML = '<div class="org-combo-msg">Нет пользователей</div>';
    return;
  }

  list.innerHTML = items.map(u => {
    const cls = String(u.id) === String(selVal) ? ' sel' : '';
    return `<div class="org-combo-opt${cls}"
      data-id="${escHtml(String(u.id))}"
      data-name="${escHtml(u.name || u.login || '')}"
      data-act-mousedown="loginCombo">
      ${escHtml(u.name || u.login || '')}
    </div>`;
  }).join('');
}

function loginComboFilter() {
  _renderLoginList();
}

// ── Комбобокс ──────────────────────────────────────────────────
function loginComboToggle() {
  const combo = document.getElementById('loginCombo');
  if (!combo) return;

  if (combo.classList.contains('open')) {
    _closeLoginCombo();
  } else {
    combo.classList.add('open');
    _loginComboOpen = true;
    if (_loginUsersReady) _renderLoginList();
  }
}

function _closeLoginCombo() {
  document.getElementById('loginCombo')?.classList.remove('open');
  _loginComboOpen = false;
}

function loginComboSelectEl(e, el) {
  loginComboSelect(e, el.dataset.id, el.dataset.name || el.textContent.trim());
}

function loginComboSelect(e, id, name) {
  if (e) e.preventDefault();

  const combo = document.getElementById('loginCombo');
  if (combo) combo.dataset.val = String(id);

  const disp = document.getElementById('loginComboDisplay');
  if (disp) {
    disp.textContent = name;
    disp.style.color = '';
  }

  _closeLoginCombo();
  setTimeout(() => document.getElementById('loginPassword')?.focus(), 60);
}

function loginComboHover(el) {
  el.closest('.org-combo-list')
    ?.querySelectorAll('.kb')
    .forEach(x => x.classList.remove('kb'));
  el.classList.add('kb');
}

function loginComboKeyDown(e) {
  const list = document.getElementById('loginComboList');
  if (!list) return;

  const items = [...list.querySelectorAll('.org-combo-opt')];
  const focused = list.querySelector('.kb');
  let idx = focused ? items.indexOf(focused) : -1;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = Math.min(idx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = Math.max(idx - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = focused || items[0];
    if (target) {
      loginComboSelect(null, target.dataset.id, target.dataset.name || target.textContent.trim());
    }
    return;
  } else if (e.key === 'Escape') {
    _closeLoginCombo();
    return;
  } else {
    return;
  }

  items.forEach(x => x.classList.remove('kb'));
  if (items[idx]) {
    items[idx].classList.add('kb');
    items[idx].scrollIntoView({ block: 'nearest' });
  }
}

document.addEventListener('mousedown', e => {
  if (_loginComboOpen && !e.target.closest('#loginCombo')) {
    _closeLoginCombo();
  }
});

// ── Вход через сервер ──────────────────────────────────────────
async function doLogin() {
  if (_loginLocked) return;
  const btn    = document.getElementById('loginBtn');
  const passEl = document.getElementById('loginPassword');
  const combo  = document.getElementById('loginCombo');
  const userId = combo?.dataset.val ?? '';
  const pass   = (passEl?.value ?? '').trim();

  _hideLoginError();

  if (!userId) {
    _showLoginError('Выберите пользователя из списка');
    return;
  }

  if (!pass) {
    _showLoginError('Введите пароль');
    passEl?.focus();
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:7px">
    <span class="loading-spinner" style="width:14px;height:14px;border-width:2px"></span>Проверка...
  </span>`;

  try {
    const r = await fetch(`${API}?m=Auth&a=login`, {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': getCsrfToken() },
      credentials: 'same-origin',
      body:        JSON.stringify({ userId, password: pass }),
    });

    let data = null;
    try {
      data = await r.json();
    } catch (_) {
      throw new Error('Сервер вернул не JSON');
    }

    if (data.ok) {
      doLoginSuccess(data.name, !!data.isAdmin, !!data.canRemote);
    } else if (data.stage === 'enroll_2fa' || data.stage === 'verify_2fa') {
      if (typeof open2fa === 'function') open2fa(data);
      else _showLoginError('Модуль 2FA не загружен');
    } else if (data.retryAfter && data.retryAfter > 0) {
      _startLoginCountdown(data.retryAfter, data.error || 'Слишком много попыток');
    } else {
      _showLoginError(data.error || 'Неверный пароль');
      if (passEl) {
        passEl.value = '';
        passEl.focus();
      }
    }
  } catch (e) {
    _showLoginError('Ошибка: ' + e.message);
  } finally {
    if (!_loginLocked) {
      btn.disabled = false;
      btn.innerHTML = `Войти`;
    }
  }
}

// ── Обратный отсчёт при блокировке входа ───────────────────────
let _loginCountdownTimer = null;
let _loginLocked = false;

function _startLoginCountdown(sec, baseMsg) {
  const btn = document.getElementById('loginBtn');
  const el  = document.getElementById('loginError');
  _loginLocked = true;
  if (_loginCountdownTimer) clearInterval(_loginCountdownTimer);

  let left = Math.max(1, parseInt(sec, 10) || 0);

  const render = () => {
    const m = String(Math.floor(left / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    if (el) {
      el.innerHTML = `${_esc(baseMsg)} <span style="white-space:nowrap">· осталось <b style="font-variant-numeric:tabular-nums">${m}:${s}</b></span>`;
      el.classList.add('show');
    }
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `Подождите ${m}:${s}`;
    }
  };

  render();
  _loginCountdownTimer = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(_loginCountdownTimer);
      _loginCountdownTimer = null;
      _loginLocked = false;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Войти'; }
      _hideLoginError();
    } else {
      render();
    }
  }, 1000);
}

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Сессия ─────────────────────────────────────────────────────
function doLoginSuccess(name, isAdmin = false, canRemote = false) {
  // В localStorage храним только отображаемое имя для UI,
  // реальная авторизация — в PHP-сессии (куке).
  localStorage.setItem('sed_auth_user', JSON.stringify({ name, isAdmin, canRemote }));
  showApp(name, isAdmin);
}

function isCurrentUserAdmin() {
  try {
    return !!(JSON.parse(localStorage.getItem('sed_auth_user') || '{}').isAdmin);
  } catch (_) {
    return false;
  }
}

// Доступ к удалённым источникам (CHED/CHED2): админ или разрешённое ФИО.
// Локальная БД сюда НЕ входит — она остаётся только для админа.
function canUseRemote() {
  try {
    const u = JSON.parse(localStorage.getItem('sed_auth_user') || '{}');
    return !!(u.isAdmin || u.canRemote);
  } catch (_) {
    return false;
  }
}

function _loadAppScripts() {
  const mods = [
    'db_mascot','db_app','db_table','db_filter','db_query','db_template',
    'db_fk','db_export','db_columns','db_saved','db_prefs','db_sqledit','db_split','db_admin','db_settings',
  ];
  const base = (window.APP_CONFIG && window.APP_CONFIG.apiUrl) || '/index.php';

  return mods.reduce((promise, name) => {
    return promise.then(() => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${base}?m=Asset&a=script&f=${encodeURIComponent(name)}&v=${Date.now()}`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Не удалось загрузить модуль: ' + name));
      document.body.appendChild(s);
    }));
  }, Promise.resolve());
}

let _showAppCalled = false;
function showApp(name, isAdmin = false) {
  if (_showAppCalled) return;
  _showAppCalled = true;

  const base = (window.APP_CONFIG && window.APP_CONFIG.apiUrl) || '/index.php';

  fetch(`${base}?m=Asset&a=shell`, { credentials: 'same-origin' })
    .then(r => {
      if (r.status === 401) { _showAppCalled = false; _forceLogin(); return null; }
      if (!r.ok) throw new Error('shell HTTP ' + r.status);
      return r.text();
    })
    .then(html => {
      if (html === null) return;
      const root = document.getElementById('appRoot');
      if (root) root.innerHTML = html;

      document.getElementById('loginOverlay')?.classList.add('hidden');
      const ub = document.getElementById('userBadgeName');
      if (ub) ub.textContent = name;
      document.getElementById('userBadge')?.classList.add('show');

      return _loadAppScripts().then(() => {
        document.getElementById('btnPrevPage')?.addEventListener('click', () => prevPage());
        document.getElementById('btnNextPage')?.addEventListener('click', () => nextPage());
        document.getElementById('btnCloseFk2')?.addEventListener('click', () => closeFkModal());
        init();
        setTimeout(() => prefsLoad(), 800);
      });
    })
    .catch(err => {
      _showAppCalled = false;
      console.error('Ошибка загрузки приложения:', err);
      alert('Ошибка загрузки приложения. Обновите страницу.');
    });
}

// Принудительный возврат к экрану логина (истёкшая/невалидная сессия)
function _forceLogin() {
  try { localStorage.removeItem('sed_auth_user'); } catch (_) {}
  window._showAppGuard = false;
  const ov = document.getElementById('loginOverlay');
  if (ov) ov.classList.remove('hidden');
  if (typeof _setupLoginUi === 'function') _setupLoginUi();
  if (typeof _loadLoginUsers === 'function') _loadLoginUsers();
}

async function doLogout() {
  try {
    await fetch(`${API}?m=Auth&a=logout`, {
      method:      'POST',
      headers:     { 'X-XSRF-TOKEN': getCsrfToken() },
      credentials: 'same-origin',
    });
  } catch (_) { /* игнорируем сетевую ошибку — всё равно выходим */ }

  localStorage.removeItem('sed_auth_user');
  location.reload();
}

window._handleUnauthorized = function () {
  localStorage.removeItem('sed_auth_user');
  location.reload();
};

// ── Ошибки ─────────────────────────────────────────────────────
function _showLoginError(msg) {
  const el = document.getElementById('loginError');
  if (el) {
    el.textContent = msg;
    el.classList.add('show');
  }
}

function _hideLoginError() {
  document.getElementById('loginError')?.classList.remove('show');
}

function showLoginError(msg) {
  _showLoginError(msg);
}

// ── Слушатели формы логина ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginComboVal')
    ?.addEventListener('click', () => loginComboToggle());

  const passEl = document.getElementById('loginPassword');
  const capsWarn = document.getElementById('capsWarning');

  function updateCaps(e) {
    if (!capsWarn) return;
    const on = e.getModifierState('CapsLock');
    capsWarn.style.display = on ? 'flex' : 'none';
  }

  passEl?.addEventListener('keydown', e => {
    if (typeof e.getModifierState === 'function') updateCaps(e);
    if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
  });

  passEl?.addEventListener('keyup', e => {
    if (typeof e.getModifierState === 'function') updateCaps(e);
  });

  passEl?.addEventListener('blur', () => {
    if (capsWarn) capsWarn.style.display = 'none';
  });

  document.getElementById('loginBtn')
    ?.addEventListener('click', () => doLogin());
});