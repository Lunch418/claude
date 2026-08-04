// ════════════════════════════════════════════════════════════════
//  db_utils.js — буфер обмена, тосты, делегирование событий
// ════════════════════════════════════════════════════════════════

// ── Делегирование событий (CSP: без инлайновых обработчиков, V-06) ──
// Элементы объявляют действие атрибутом data-act (click) или
// data-act-<event> (change/input/mousedown/keydown/mouseover). Значение —
// имя действия в реестре SED_ACTIONS. Обработчик получает (element, event).
// Аргументы читаются из data-* самого элемента. Один набор слушателей на
// document переживает innerHTML-инъекции и покрывает динамический контент.
(function () {
  'use strict';
  window.SED_ACTIONS = window.SED_ACTIONS || {};

  // [тип события, ключ dataset, css-селектор атрибута]
  var BINDINGS = [
    ['click',     'act',          'data-act'],
    ['change',    'actChange',    'data-act-change'],
    ['input',     'actInput',     'data-act-input'],
    ['mousedown', 'actMousedown', 'data-act-mousedown'],
    ['keydown',   'actKeydown',   'data-act-keydown'],
    ['mouseover', 'actMouseover', 'data-act-mouseover'],
  ];

  function makeHandler(dsKey, sel) {
    return function (e) {
      var start = e.target;
      if (!(start instanceof Element)) {
        start = start && start.parentElement ? start.parentElement : null;
      }
      var el = start ? start.closest('[' + sel + ']') : null;
      if (!el) return;
      var fn = window.SED_ACTIONS[el.dataset[dsKey]];
      if (typeof fn === 'function') fn(el, e);
    };
  }

  if (!window.__sedDelegationReady) {
    window.__sedDelegationReady = true;
    BINDINGS.forEach(function (b) {
      document.addEventListener(b[0], makeHandler(b[1], b[2]));
    });
  }

  // Модули регистрируют свои действия: sedRegisterActions({name: fn(el,e)})
  window.sedRegisterActions = function (obj) {
    Object.assign(window.SED_ACTIONS, obj || {});
  };
})();

// ── Копирование в буфер обмена ────────────────────────────────
async function copyToClipboard(text, toastMsg = 'Скопировано!') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(toastMsg);
  } catch (_) {
    // Fallback для браузеров без Clipboard API (http://)
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast(toastMsg); } catch (_) {}
    document.body.removeChild(ta);
  }
}

let _toastTimer = null;

function showToast(msg, durationMs = 2200, type = 'auto') {
  if (type === 'auto') {
    if (msg.startsWith('✓') || msg.includes('Сохранено') || msg.includes('сброшен')) type = 'success';
    else if (msg.startsWith('✗') || msg.toLowerCase().includes('ошибк')) type = 'error';
    else type = 'info';
  }

  let toast = document.getElementById('sed-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sed-toast';
    document.body.appendChild(toast);
  }
  
  const colors = {
    success: { bg:'#10b981', icon:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' },
    error:   { bg:'#ef4444', icon:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' },
    info:    { bg:'#3b82f6', icon:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' },
  };
  const c = colors[type] || colors.info;

  const cleanMsg = msg.replace(/^[✓✗ⓘ]\s*/, '');

  toast.className = 'sed-toast-modern';
  toast.style.cssText = [
    'position:fixed',
    'top:24px',
    'right:24px',
    'background:#fff',
    'border-left:4px solid ' + c.bg,
    'color:#1f2937',
    'font-size:13px',
    'font-weight:500',
    'padding:12px 16px 12px 14px',
    'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,.12), 0 4px 8px rgba(0,0,0,.06)',
    'z-index:9999',
    'pointer-events:none',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'min-width:240px',
    'max-width:380px',
    'opacity:0',
    'transform:translateX(20px) scale(.96)',
    'transition:opacity .25s cubic-bezier(.16,1,.3,1), transform .3s cubic-bezier(.16,1,.3,1)',
  ].join(';');

  toast.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;width:24px;height:24px;background:${c.bg};border-radius:50%;flex-shrink:0">${c.icon}</div>
    <span style="flex:1">${cleanMsg}</span>
  `;

  if (_toastTimer) clearTimeout(_toastTimer);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(0) scale(1)';
  });

  _toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px) scale(.96)';
  }, durationMs);
}

// ── SQL-подсветка синтаксиса (Так и не реализовал, но задумка есть) ──────────────────────────────────
(function initSqlHighlight() {
  const KW = /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|AND|OR|NOT|IN|BETWEEN|LIKE|ILIKE|IS|NULL|AS|DISTINCT|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|WITH|UNION|ALL|INSERT|UPDATE|DELETE|SET|VALUES|CASE|WHEN|THEN|ELSE|END|EXISTS|INTO|BY)\b/gi;
  const FN = /\b(COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|TO_CHAR|TO_DATE|NOW|CURRENT_DATE|CURRENT_TIMESTAMP|DATE_TRUNC|EXTRACT|SUBSTRING|TRIM|LOWER|UPPER|LENGTH|REPLACE|CONCAT|ARRAY_AGG|STRING_AGG|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|OVER|PARTITION)\b/gi;

  function escHtmlHL(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function highlight(sql) {
    return escHtmlHL(sql);
  }

  function sync() {
    const ta  = document.getElementById('sqlEditor');
    const hl  = document.getElementById('sqlHighlight');
    if (!ta || !hl) return;
    hl.innerHTML = highlight(ta.value) + '\n'; 
    hl.scrollTop = ta.scrollTop;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('sqlEditor');
    if (!ta) return;
    ta.addEventListener('input',  sync);
    ta.addEventListener('scroll', () => {
      const hl = document.getElementById('sqlHighlight');
      if (hl) hl.scrollTop = ta.scrollTop;
    });
    sync();
  });
})();

// ── SQL ───
(function() {
  function _patchSqlEditor() {
    const el = document.getElementById('sqlEditor');
    if (!el || el.__hlPatched) return;
    el.__hlPatched = true;
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(el, 'value', {
      get() { return proto.get.call(this); },
      set(v) {
        proto.set.call(this, v);
        if (typeof highlightSQL === 'function') highlightSQL(v);
        if (typeof autoResizeSQL === 'function') autoResizeSQL();
      },
      configurable: true,
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _patchSqlEditor);
  } else {
    _patchSqlEditor();
  }
})();