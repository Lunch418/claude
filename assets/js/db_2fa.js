// ════════════════════════════════════════════════════════════════
//  db_2fa.js — двухфакторная аутентификация (TOTP)
//  Привязка (QR) при первом входе + проверка кода при последующих.
//  Зависит от: qrcode (глобальная функция из qrcode.js),
//              doLoginSuccess / getCsrfToken (db_auth.js).
// ════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── Стили + анимации ───────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('tfaStyles')) return;
    const st = document.createElement('style');
    st.id = 'tfaStyles';
    st.textContent = `
      #tfaOverlay {
        position: fixed; inset: 0; z-index: 10000;
        background: rgba(20, 26, 40, .55); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity .25s ease;
      }
      #tfaOverlay.show { opacity: 1; }
      #tfaCard {
        width: 380px; max-width: 92vw; background: var(--c-surface, #fff);
        border-radius: var(--r-lg, 16px); box-shadow: 0 24px 60px rgba(0,0,0,.28);
        padding: 26px 26px 22px; transform: translateY(16px) scale(.96);
        opacity: 0; transition: transform .3s cubic-bezier(.34,1.4,.5,1), opacity .25s;
      }
      #tfaOverlay.show #tfaCard { transform: none; opacity: 1; }
      .tfa-title { font-size: 17px; font-weight: 650; color: var(--c-text, #1c2233); margin: 0 0 4px; }
      .tfa-sub   { font-size: 12.5px; color: var(--c-text-3, #8a93a6); margin: 0 0 18px; line-height: 1.5; }
      .tfa-qr-wrap {
        display: flex; justify-content: center; margin: 0 0 16px;
        animation: tfaQrIn .5s cubic-bezier(.34,1.2,.5,1) both;
      }
      .tfa-qr-wrap img, .tfa-qr-wrap canvas, .tfa-qr-wrap table {
        border-radius: 10px; padding: 10px; background: #fff;
        box-shadow: 0 4px 16px rgba(0,0,0,.1); border: 1px solid var(--c-border, #e5e8ef);
      }
      @keyframes tfaQrIn { from { opacity: 0; transform: scale(.85) rotate(-3deg); } to { opacity: 1; transform: none; } }
      .tfa-secret {
        text-align: center; font-family: var(--font-mono, monospace); font-size: 13px;
        letter-spacing: 2px; color: var(--c-text-2, #4a5468); background: var(--c-surface-2, #f6f7f9);
        border-radius: 8px; padding: 7px; margin: 0 0 16px; user-select: all; cursor: copy;
      }
      .tfa-steps { font-size: 12px; color: var(--c-text-3, #8a93a6); margin: 0 0 16px; padding-left: 18px; line-height: 1.7; }
      .tfa-code-row { display: flex; gap: 8px; margin: 0 0 8px; justify-content: center; }
      .tfa-cell {
        width: 44px; height: 54px; text-align: center; font-size: 24px; font-weight: 600;
        font-family: var(--font-mono, monospace); color: var(--c-text, #1c2233);
        border: 2px solid var(--c-border, #e5e8ef); border-radius: 12px; outline: none;
        background: var(--c-surface, #fff); transition: border-color .15s, box-shadow .15s, transform .1s;
        caret-color: var(--c-accent, #3b6fd4);
      }
      .tfa-cell:focus {
        border-color: var(--c-accent, #3b6fd4); box-shadow: 0 0 0 4px var(--c-accent-bg, #eef3fc);
        transform: translateY(-2px);
      }
      .tfa-cell.filled { border-color: var(--c-accent, #3b6fd4); background: var(--c-accent-bg, #eef3fc); }
      #tfaCard.shake { animation: tfaShake .4s; }
      @keyframes tfaShake { 0%,100%{transform:none} 20%,60%{transform:translateX(-8px)} 40%,80%{transform:translateX(8px)} }
      .tfa-btn {
        width: 100%; padding: 11px; border: none; border-radius: 10px; font-size: 14px; font-weight: 600;
        background: var(--c-accent, #3b6fd4); color: #fff; cursor: pointer; transition: filter .15s, transform .1s;
      }
      .tfa-btn:hover { filter: brightness(1.07); }
      .tfa-btn:active { transform: scale(.98); }
      .tfa-btn:disabled { opacity: .6; cursor: default; }
      .tfa-err { color: var(--c-red, #dc3545); font-size: 12.5px; min-height: 17px; margin: 4px 0 10px; text-align: center; }
      .tfa-ok-check {
        width: 64px; height: 64px; margin: 10px auto 18px; border-radius: 50%;
        background: var(--c-green, #2b9d5b); display: flex; align-items: center; justify-content: center;
        animation: tfaPop .45s cubic-bezier(.34,1.56,.64,1) both;
      }
      @keyframes tfaPop { from { transform: scale(0); } to { transform: scale(1); } }
      .tfa-ok-check svg { stroke-dasharray: 30; stroke-dashoffset: 30; animation: tfaDraw .4s .2s ease forwards; }
      @keyframes tfaDraw { to { stroke-dashoffset: 0; } }
    `;
    document.head.appendChild(st);
  }

  let stage = null;
  let _escHandler = null;

  window.open2fa = function (data) {
    injectStyles();
    stage = data.stage;
    close2fa();

    const overlay = document.createElement('div');
    overlay.id = 'tfaOverlay';

    let inner;
    if (data.stage === 'enroll_2fa') {
      inner =
        '<h3 class="tfa-title">Настройка входа по коду</h3>' +
        '<p class="tfa-sub">Для входа теперь нужен 6-значный код из приложения-аутентификатора ' +
        '(Google Authenticator, Authy и т.п.). Отсканируйте QR-код один раз:</p>' +
        '<div class="tfa-qr-wrap" id="tfaQr"></div>' +
        '<div class="tfa-secret" id="tfaSecret" title="Нажмите, чтобы скопировать">' + esc(data.secret) + '</div>' +
        '<ol class="tfa-steps">' +
          '<li>Откройте приложение-аутентификатор</li>' +
          '<li>Отсканируйте QR (или введите ключ вручную)</li>' +
          '<li>Введите 6-значный код ниже</li>' +
        '</ol>' +
        codeBlock('Подтвердить и войти');
    } else {
      inner =
        '<h3 class="tfa-title">Подтверждение входа</h3>' +
        '<p class="tfa-sub">Введите 6-значный код из приложения-аутентификатора.</p>' +
        codeBlock('Войти');
    }

    overlay.innerHTML = '<div id="tfaCard">' + inner + '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    // Клик по затемнённому фону (мимо карточки) — закрыть и вернуться на логин
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) cancel2fa();
    });
    // Escape — тоже закрыть
    _escHandler = (e) => { if (e.key === 'Escape') cancel2fa(); };
    document.addEventListener('keydown', _escHandler);

    // QR
    if (data.stage === 'enroll_2fa') {
      drawQr(data.otpauth);
      const sec = document.getElementById('tfaSecret');
      sec?.addEventListener('click', () => {
        navigator.clipboard?.writeText(data.secret).then(() => {
          const old = sec.textContent; sec.textContent = 'Скопировано ✓';
          setTimeout(() => sec.textContent = old, 1200);
        });
      });
    }

    const input = document.getElementById('tfaCodeInput');
    bindCells();
    document.getElementById('tfaSubmit')?.addEventListener('click', submit2fa);
  };

  function codeBlock(btnText) {
    let cells = '';
    for (let i = 0; i < 6; i++) {
      cells += `<input class="tfa-cell" data-i="${i}" inputmode="numeric" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" maxlength="1">`;
    }
    return '<div class="tfa-code-row" id="tfaCells">' + cells + '</div>' +
      '<div class="tfa-err" id="tfaErr"></div>' +
      '<button class="tfa-btn" id="tfaSubmit">' + esc(btnText) + '</button>';
  }

  // собрать код из ячеек
  function readCells() {
    return Array.from(document.querySelectorAll('.tfa-cell')).map(c => c.value).join('');
  }

  function bindCells() {
    const cells = Array.from(document.querySelectorAll('.tfa-cell'));
    if (!cells.length) return;

    cells.forEach((cell, idx) => {
      cell.addEventListener('input', () => {
        cell.value = cell.value.replace(/\D/g, '').slice(0, 1);
        cell.classList.toggle('filled', cell.value !== '');
        if (cell.value && idx < 5) cells[idx + 1].focus();
        if (readCells().length === 6) submit2fa();
      });

      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !cell.value && idx > 0) {
          cells[idx - 1].focus();
          cells[idx - 1].value = '';
          cells[idx - 1].classList.remove('filled');
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' && idx > 0) {
          cells[idx - 1].focus(); e.preventDefault();
        } else if (e.key === 'ArrowRight' && idx < 5) {
          cells[idx + 1].focus(); e.preventDefault();
        } else if (e.key === 'Enter') {
          submit2fa();
        }
      });

      // вставка кода целиком в любую ячейку
      cell.addEventListener('paste', (e) => {
        e.preventDefault();
        const digits = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        if (!digits) return;
        cells.forEach((c, i) => {
          c.value = digits[i] || '';
          c.classList.toggle('filled', !!digits[i]);
        });
        const next = Math.min(digits.length, 5);
        cells[next].focus();
        if (digits.length === 6) submit2fa();
      });
    });

    cells[0].focus();
  }

  function drawQr(text) {
    const wrap = document.getElementById('tfaQr');
    if (!wrap) return;
    try {
      if (typeof qrcode !== 'function') { wrap.textContent = 'QR недоступен'; return; }
      const qr = qrcode(0, 'M');      // авторазмер, коррекция M
      qr.addData(text);
      qr.make();
      wrap.innerHTML = qr.createImgTag(4, 0);  // 4px на модуль
    } catch (e) {
      wrap.textContent = 'Не удалось построить QR';
    }
  }

  let _submitting = false;
  async function submit2fa() {
    const err   = document.getElementById('tfaErr');
    const btn   = document.getElementById('tfaSubmit');
    const card  = document.getElementById('tfaCard');
    const cells = Array.from(document.querySelectorAll('.tfa-cell'));
    const code  = readCells().replace(/\D/g, '');
    if (code.length !== 6) { err.textContent = 'Введите 6 цифр'; return; }
    if (_submitting) return;
    _submitting = true;

    btn.disabled = true; err.textContent = '';
    try {
      const r = await fetch(`${API}?m=Auth&a=verify2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': getCsrfToken() },
        credentials: 'same-origin',
        body: JSON.stringify({ code }),
      });
      const data = await r.json();
      if (data.ok) {
        showSuccess(() => {
          if (typeof doLoginSuccess === 'function') doLoginSuccess(data.name, !!data.isAdmin, !!data.canRemote);
        });
      } else {
        err.textContent = data.error || 'Неверный код';
        card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
        cells.forEach(c => { c.value = ''; c.classList.remove('filled'); });
        cells[0]?.focus();
        btn.disabled = false;
        _submitting = false;
      }
    } catch (e) {
      err.textContent = 'Ошибка сети';
      btn.disabled = false;
      _submitting = false;
    }
  }

  function showSuccess(then) {
    const card = document.getElementById('tfaCard');
    if (!card) { then(); return; }
    card.innerHTML =
      '<div class="tfa-ok-check"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="20 6 9 17 4 12"/></svg></div>' +
      '<h3 class="tfa-title" style="text-align:center">Готово!</h3>' +
      '<p class="tfa-sub" style="text-align:center">Вход выполнен</p>';
    setTimeout(() => { close2fa(); then(); }, 850);
  }

  function cancel2fa() {
    close2fa();
    // вернуться на экран логина (он под модалкой)
    const lo = document.getElementById('loginOverlay');
    if (lo) lo.classList.remove('hidden');
    const pass = document.getElementById('loginPassword');
    if (pass) { pass.value = ''; pass.focus(); }
  }

  function close2fa() {
    document.getElementById('tfaOverlay')?.remove();
    if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
