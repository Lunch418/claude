// ════════════════════════════════════════════════════════════════
//  db_split.js — режим разделённого экрана (split view)
//  Вторая панель — ТОЛЬКО просмотр таблицы. Источник общий.
//  Позиция: справа / слева / снизу / сверху.
//  Не трогает глобальный state и основную панель.
// ════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  let active = false;
  let rightTable = null;
  let position = 'right';   // right | left | bottom | top

  const esc = (s) => (typeof escHtml === 'function'
    ? escHtml(s)
    : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  // state объявлен через let (не на window) — берём безопасно
  function getTables() {
    try { if (typeof state !== 'undefined' && Array.isArray(state.tables)) return state.tables; }
    catch (_) {}
    return [];
  }

  function injectStyles() {
    if (document.getElementById('splitStyles')) return;
    const st = document.createElement('style');
    st.id = 'splitStyles';
    st.textContent = `
      #btnSplitView { padding:5px 8px !important; position:relative; }
      #btnSplitView svg { transition: transform .25s cubic-bezier(.34,1.56,.64,1), color .2s; display:block; }
      #btnSplitView:hover svg { transform: scale(1.18) rotate(-3deg); color: var(--c-accent); }
      #btnSplitView:active svg { transform: scale(.9); }
      #btnSplitView.is-active { background: var(--c-accent-bg) !important; }
      #btnSplitView.is-active svg { color: var(--c-accent); animation: splitGlow 1.8s ease-in-out infinite; }
      @keyframes splitGlow { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.55;transform:scale(1.08)} }
      .split-dir-btn { display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;padding:0;
        border:1px solid var(--c-border);border-radius:5px;background:var(--c-surface);cursor:pointer;color:var(--c-text-3);transition:all .15s; }
      .split-dir-btn:hover { color:var(--c-accent);border-color:var(--c-accent); }
      .split-dir-btn.active { background:var(--c-accent-bg);color:var(--c-accent);border-color:var(--c-accent); }
      #splitPane { animation: splitIn .22s ease; }
      @keyframes splitIn { from{opacity:0} to{opacity:1} }
      @keyframes slideFromRight  { from{opacity:0;transform:translateX(28px)}  to{opacity:1;transform:none} }
      @keyframes slideFromLeft   { from{opacity:0;transform:translateX(-28px)} to{opacity:1;transform:none} }
      @keyframes slideFromBottom { from{opacity:0;transform:translateY(28px)}  to{opacity:1;transform:none} }
      @keyframes slideFromTop    { from{opacity:0;transform:translateY(-28px)} to{opacity:1;transform:none} }
      #splitDivider { transition: background .15s; }
      .split-dd {
        position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:600;
        background:var(--c-surface); border:1px solid var(--c-border); border-radius:var(--r);
        box-shadow:var(--sh-lg); max-height:280px; overflow-y:auto; padding:4px; display:none;
      }
      .split-dd.open { display:block; animation: splitIn .12s ease; }
      .split-dd-item {
        display:flex; flex-direction:column; gap:1px; padding:5px 9px; border-radius:var(--r-sm);
        cursor:pointer; font-size:12.5px; color:var(--c-text); line-height:1.3;
      }
      .split-dd-item:hover, .split-dd-item.hl { background:var(--c-accent-bg); color:var(--c-accent); }
      .split-dd-item .sd-cmt { font-size:11px; color:var(--c-text-3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .split-dd-item:hover .sd-cmt, .split-dd-item.hl .sd-cmt { color:var(--c-accent); opacity:.7; }
      .split-dd-empty { padding:9px 11px; font-size:12px; color:var(--c-text-3); }
    `;
    document.head.appendChild(st);
  }

  function ensureButton() {
    const right = document.querySelector('.toolbar-right');
    if (!right || document.getElementById('btnSplitView')) return;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost';
    btn.id = 'btnSplitView';
    btn.title = 'Разделить экран (сравнить таблицы)';
    btn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="12" y1="4" x2="12" y2="20"/></svg>';
    btn.addEventListener('click', toggleSplit);
    right.insertBefore(btn, right.firstChild);
  }

  function toggleSplit() { active ? closeSplit() : openSplit(); }

  function dirIcon(dir) {
    const fills = {
      right:  '<rect x="13" y="4" width="7" height="16" rx="1" fill="currentColor" opacity=".9"/>',
      left:   '<rect x="4" y="4" width="7" height="16" rx="1" fill="currentColor" opacity=".9"/>',
      bottom: '<rect x="4" y="13" width="16" height="7" rx="1" fill="currentColor" opacity=".9"/>',
      top:    '<rect x="4" y="4" width="16" height="7" rx="1" fill="currentColor" opacity=".9"/>',
    };
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/>' + fills[dir] + '</svg>';
  }

  function openSplit() {
    const area = document.getElementById('tableArea');
    if (!area || active) return;
    const parent = area.parentNode;

    const wrap = document.createElement('div');
    wrap.id = 'splitWrap';
    wrap.style.cssText = 'display:flex;flex:1;min-height:0;position:relative';
    parent.insertBefore(wrap, area);

    area.style.minWidth = '0';
    area.style.minHeight = '0';

    const divider = document.createElement('div');
    divider.id = 'splitDivider';
    divider.addEventListener('mouseenter', () => divider.style.background = 'var(--c-accent)');
    divider.addEventListener('mouseleave', () => divider.style.background = 'var(--c-border)');

    const pane = document.createElement('div');
    pane.id = 'splitPane';
    pane.style.cssText = 'min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--c-surface)';
    pane.innerHTML =
      '<div style="flex-shrink:0;display:flex;align-items:center;gap:7px;padding:7px 10px;' +
      'border-bottom:1px solid var(--c-border);background:var(--c-surface-2)">' +
        '<div id="splitTblWrap" style="position:relative;flex:1;min-width:0">' +
        '<input id="splitTableSelect" autocomplete="off" placeholder="Поиск таблицы..." ' +
        'style="width:100%;box-sizing:border-box;height:30px;font-size:12px;padding:0 10px;' +
        'border:1px solid var(--c-border);border-radius:var(--r);background:var(--c-surface);color:var(--c-text)">' +
        '<div id="splitTblDd" class="split-dd"></div>' +
        '</div>' +
        '<select id="splitLimit" style="box-sizing:border-box;height:30px;font-size:12px;padding:0 6px;border:1px solid var(--c-border);' +
        'border-radius:var(--r);background:var(--c-surface);color:var(--c-text-2)">' +
        '<option value="50">50</option><option value="100" selected>100</option>' +
        '<option value="500">500</option><option value="1000">1000</option>' +
        '<option value="5000">5000</option></select>' +
        '<button id="splitReload" class="btn btn-ghost" title="Обновить" style="padding:3px 7px">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">' +
        '<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg></button>' +
        '<span style="width:1px;height:18px;background:var(--c-border)"></span>' +
        '<span id="splitDirs" style="display:inline-flex;gap:3px"></span>' +
        '<button id="splitClose" class="btn btn-ghost" title="Закрыть" style="padding:3px 8px">✕</button>' +
      '</div>' +
      '<div id="splitStatus" style="flex-shrink:0;padding:4px 10px;font-size:11px;' +
      'color:var(--c-text-3);font-family:var(--font-mono);min-height:18px"></div>' +
      '<div id="splitBody" style="flex:1;overflow:auto;min-height:0">' +
        '<div class="placeholder" style="height:100%;color:var(--c-text-3);font-size:12.5px">' +
        'Выберите таблицу для сравнения</div>' +
      '</div>';

    wrap.appendChild(area);
    wrap.appendChild(divider);
    wrap.appendChild(pane);

    const dirs = pane.querySelector('#splitDirs');
    ['left', 'right', 'top', 'bottom'].forEach(d => {
      const b = document.createElement('button');
      b.className = 'split-dir-btn' + (d === position ? ' active' : '');
      b.dataset.dir = d;
      b.title = { left: 'Слева', right: 'Справа', top: 'Сверху', bottom: 'Снизу' }[d];
      b.innerHTML = dirIcon(d);
      b.addEventListener('click', () => setPosition(d));
      dirs.appendChild(b);
    });

    fillTableSelect();
    applyPosition();

    const tblInput = document.getElementById('splitTableSelect');
    tblInput.addEventListener('focus', openDd);
    tblInput.addEventListener('input', () => { renderDd(tblInput.value); document.getElementById('splitTblDd')?.classList.add('open'); });
    tblInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = document.querySelector('#splitTblDd .split-dd-item');
        if (first) { e.preventDefault(); selectTable(first.dataset.name); }
      } else if (e.key === 'Escape') { closeDd(); }
    });
    // клик вне поля — закрыть список
    document.addEventListener('mousedown', (e) => {
      const w = document.getElementById('splitTblWrap');
      if (w && !w.contains(e.target)) closeDd();
    });
    document.getElementById('splitLimit').addEventListener('change', () => { if (rightTable) loadRight(); });
    document.getElementById('splitReload').addEventListener('click', (e) => {
      const b = e.currentTarget;
      b.classList.remove('spinning'); void b.offsetWidth; b.classList.add('spinning');
      setTimeout(() => b.classList.remove('spinning'), 650);
      if (rightTable) loadRight();
    });
    document.getElementById('splitClose').addEventListener('click', closeSplit);
    initDrag(divider, area, pane);

    active = true;
    document.getElementById('btnSplitView')?.classList.add('is-active');
  }

  function setPosition(d) {
    position = d;
    document.querySelectorAll('.split-dir-btn').forEach(b => b.classList.toggle('active', b.dataset.dir === d));
    applyPosition();
  }

  function applyPosition() {
    const wrap = document.getElementById('splitWrap');
    const area = document.getElementById('tableArea');
    const divider = document.getElementById('splitDivider');
    const pane = document.getElementById('splitPane');
    if (!wrap || !area || !pane) return;

    const vertical = (position === 'top' || position === 'bottom');
    wrap.style.flexDirection = vertical
      ? (position === 'top' ? 'column-reverse' : 'column')
      : (position === 'left' ? 'row-reverse' : 'row');

    area.style.flex = '1 1 55%';
    pane.style.flex = '1 1 45%';

    divider.style.cssText = vertical
      ? 'flex:0 0 6px;cursor:row-resize;background:var(--c-border);transition:background .15s;align-self:stretch'
      : 'flex:0 0 6px;cursor:col-resize;background:var(--c-border);transition:background .15s;align-self:stretch';

    // анимация выезда панели со стороны её появления
    const anim = { right: 'slideFromRight', left: 'slideFromLeft', top: 'slideFromTop', bottom: 'slideFromBottom' }[position];
    pane.style.animation = 'none';
    void pane.offsetWidth;                 // рефлоу для перезапуска анимации
    pane.style.animation = `${anim} .28s cubic-bezier(.22,.61,.36,1)`;
  }

  function closeSplit() {
    const wrap = document.getElementById('splitWrap');
    const area = document.getElementById('tableArea');
    if (wrap && area) {
      area.style.flex = ''; area.style.minWidth = ''; area.style.minHeight = '';
      wrap.parentNode.insertBefore(area, wrap);
      wrap.remove();
    }
    active = false;
    rightTable = null;
    document.getElementById('btnSplitView')?.classList.remove('is-active');
  }

  function renderDd(filter) {
    const dd = document.getElementById('splitTblDd');
    if (!dd) return;
    const q = (filter || '').toLowerCase().trim();
    const list = getTables().filter(t => {
      const n = (t.name || t).toLowerCase();
      const c = (t.comment || '').toLowerCase();
      return !q || n.includes(q) || c.includes(q);
    }).slice(0, 200);
    if (!list.length) { dd.innerHTML = '<div class="split-dd-empty">Ничего не найдено</div>'; return; }
    dd.innerHTML = list.map(t => {
      const name = t.name || t;
      const c = (t.comment || '').trim();
      return `<div class="split-dd-item" data-name="${esc(name)}">${ddItemInner(name, c)}</div>`;
    }).join('');
    dd.querySelectorAll('.split-dd-item').forEach(el => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); selectTable(el.dataset.name); });
    });
  }
  function ddItemInner(name, c) {
    return `<span>${esc(name)}</span>` + (c ? `<span class="sd-cmt">${esc(c)}</span>` : '');
  }

  function openDd() {
    const dd = document.getElementById('splitTblDd');
    if (!dd) return;
    renderDd(document.getElementById('splitTableSelect').value);
    dd.classList.add('open');
  }
  function closeDd() {
    document.getElementById('splitTblDd')?.classList.remove('open');
  }
  function selectTable(name) {
    const inp = document.getElementById('splitTableSelect');
    if (inp) inp.value = name;
    closeDd();
    if (name && name !== rightTable) { rightTable = name; loadRight(); }
  }
  function tableExists(name) {
    return getTables().some(t => (t.name || t) === name);
  }
  // совместимость со старым вызовом
  function fillTableSelect() { renderDd(document.getElementById('splitTableSelect')?.value || ''); }

  async function loadRight() {
    const body = document.getElementById('splitBody');
    const status = document.getElementById('splitStatus');
    if (!body || !rightTable) return;
    const limit = parseInt(document.getElementById('splitLimit').value, 10) || 100;
    body.innerHTML = '<div class="placeholder" style="height:120px"><div class="loading-spinner"></div></div>';
    status.textContent = 'Загрузка...';
    try {
      const sql = `SELECT * FROM "${rightTable.replace(/"/g, '""')}" LIMIT ${limit}`;
      const res = await apiCall(sql, 'preview', limit);
      if (!res || !res.ok) {
        body.innerHTML = `<div class="placeholder" style="height:80px;color:var(--c-red);font-size:12px">${esc((res && res.error) || 'Ошибка запроса')}</div>`;
        status.textContent = '';
        return;
      }
      renderRight(res, body);
      status.textContent = `${rightTable} · ${res.rows.length} строк`;
    } catch (e) {
      body.innerHTML = `<div class="placeholder" style="height:80px;color:var(--c-red);font-size:12px">${esc(e.message)}</div>`;
      status.textContent = '';
    }
  }

  function renderRight(data, body) {
    const cols = data.columns || [];
    if (!data.rows || !data.rows.length) {
      body.innerHTML = '<div class="placeholder" style="height:80px;color:var(--c-text-3);font-size:12.5px">Нет данных</div>';
      return;
    }
    const thead = `<thead><tr>${cols.map(c => `<th data-col="${esc(c)}">${esc(c)}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${data.rows.map(row =>
      '<tr>' + cols.map(c => {
        const v = row[c];
        if (v === null || v === undefined || v === '') return '<td class="null" data-val="">—</td>';
        if (v === true)  return '<td class="bool-t" data-val="true">true</td>';
        if (v === false) return '<td class="bool-f" data-val="false">false</td>';
        if (typeof v === 'number') return `<td class="num" data-val="${v}">${v}</td>`;
        const s = String(v);
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return `<td class="date" data-val="${esc(s)}">${esc(s.substring(0, 19))}</td>`;
        const d = s.length > 400 ? s.substring(0, 400) + '…' : s;
        return `<td data-val="${esc(s)}" title="${esc(s)}">${esc(d)}</td>`;
      }).join('') + '</tr>'
    ).join('')}</tbody>`;
    body.innerHTML = `<div class="table-card"><table class="data-table" style="margin:0">${thead}${tbody}</table></div>`;
  }

  function initDrag(divider, area, pane) {
    let dragging = false;
    divider.addEventListener('mousedown', (e) => { dragging = true; document.body.style.userSelect = 'none'; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const wrap = document.getElementById('splitWrap');
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const vertical = (position === 'top' || position === 'bottom');
      let pct;
      if (vertical) { pct = ((e.clientY - r.top) / r.height) * 100; if (position === 'top') pct = 100 - pct; }
      else { pct = ((e.clientX - r.left) / r.width) * 100; if (position === 'left') pct = 100 - pct; }
      pct = Math.max(20, Math.min(80, pct));
      area.style.flex = `1 1 ${pct}%`;
      pane.style.flex = `1 1 ${100 - pct}%`;
    });
    document.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.userSelect = ''; } });
  }

  // ── Пасхалка: 5 кликов по логотипу ────────────────────────────
  function initEasterEgg() {
    const logo = document.getElementById('logoMark') || document.querySelector('.logo-mark');
    if (!logo || logo.__eggBound) return;
    logo.__eggBound = true;
    let clicks = 0, timer = null;
    logo.addEventListener('click', () => {
      clicks++;
      clearTimeout(timer);
      timer = setTimeout(() => { clicks = 0; }, 1500);
      if (clicks >= 5) {
        clicks = 0;
        partyTime(logo);
      }
    });
  }

  function partyTime(logo) {
    logo.classList.remove('logo-party'); void logo.offsetWidth; logo.classList.add('logo-party');
    setTimeout(() => logo.classList.remove('logo-party'), 1200);

    // тост
    let toast = document.getElementById('eggToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'eggToast';
      document.body.appendChild(toast);
    }


    // конфетти
    const emojis = ['🎉', '✨', '⭐', '💫', '🎊', '🟦', '🟪'];
    for (let i = 0; i < 22; i++) {
      const c = document.createElement('div');
      c.className = 'egg-confetti';
      c.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      c.style.left = Math.random() * 100 + 'vw';
      c.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      c.style.animationDelay = (Math.random() * 0.3) + 's';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 3200);
    }
  }

  function boot() {
    injectStyles();
    initEasterEgg();
    if (document.querySelector('.toolbar-right')) { ensureButton(); return; }
    let n = 0;
    const iv = setInterval(() => {
      if (document.querySelector('.toolbar-right')) { clearInterval(iv); ensureButton(); }
      if (!document.getElementById('logoMark')?.__eggBound) initEasterEgg();
      if (++n > 60) clearInterval(iv);
    }, 200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();