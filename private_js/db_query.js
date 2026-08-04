// ════════════════════════════════════════════════════════════════
//  db_query.js — выполнение запросов, рендер таблицы, пагинация
// ════════════════════════════════════════════════════════════════

// ── SQL-бар ───────────────────────────────────────────────────
function toggleSqlBar(collapse) {
  const bar = document.getElementById('sqlBar');
  const btn = document.getElementById('sqlToggleBtn');
  _sqlBarCollapsed = (typeof collapse === 'boolean') ? collapse : !_sqlBarCollapsed;
  bar.classList.toggle('collapsed', _sqlBarCollapsed);
  btn.title = _sqlBarCollapsed ? 'Развернуть SQL' : 'Свернуть SQL';
  if (!_sqlBarCollapsed) {
    setTimeout(() => autoResizeSQL(), 0);
  }
}

function autoResizeSQL() {
  const sqlEditor = document.getElementById('sqlEditor');
  if (!sqlEditor) return;
  sqlEditor.style.height = 'auto';
  let h = sqlEditor.scrollHeight;
  if (h < 50) h = 50;
  if (h > 360) { h = 360; sqlEditor.style.overflowY = 'auto'; }
  else sqlEditor.style.overflowY = 'hidden';
  sqlEditor.style.height = h + 'px';
}

window.addEventListener('load', autoResizeSQL);

// ── Лимит ─────────────────────────────────────────────────────
function onLimitChange(val) {
  const n = parseInt(val);
  if (isNaN(n) || n < 1) return;

  // Если пользователь вручную редактировал SQL — просто перезапускаем его,
  // не трогаем редактор и не переключаемся на шаблон/таблицу
  if (_sqlManuallyEdited) {
    const sql = document.getElementById('sqlEditor').value.trim();
    if (sql) { execQuery(sql); }
    return;
  }

  if (state.selectedTmpl >= 0) {
    const i = state.selectedTmpl;
    if (!state.tmplParams[i]) state.tmplParams[i] = {};
    state.tmplParams[i]['limit'] = String(n);
    saveTmplParams(i, state.tmplParams[i]);
    const t = TEMPLATES[i];
    const vals = getParamValues(t);
    vals['limit'] = String(n);
    const { sql, errors } = compileTemplate(t.sqlTemplate, t.params, vals, true);
    document.getElementById('sqlEditor').value = sql;
    autoResizeSQL();
    if (!errors.length) execQuery(sql);
  } else if (state.currentTable) {
    _sqlManuallyEdited = false;
    buildSQL();
    loadTable();
  }
}

function refreshQuery() {
  if (state.selectedTmpl >= 0) runTemplateQuery();
  else if (state.currentTable) loadTable();
}

function onLimitBadgeChange(val) { onLimitChange(val); }
function onLimitBadgeBlur()      {}

// ── Выполнение запросов ───────────────────────────────────────
async function loadTable() {
  if (!state.currentTable) return;
  await execQuery(buildSQL());
}

async function runSQL() {
  const sql = document.getElementById('sqlEditor').value.trim();
  if (!sql) return;
  // Ручной SQL — выполняем как есть, без лимита.
  // Пользователь сам пишет LIMIT если нужно.
  // limit=0 → Python не оборачивает в SELECT * FROM (...) LIMIT N
  await execQuery(sql, { forceLimitZero: true });
}

// Хранит jobId текущего выполняющегося запроса (для отмены)
let _currentJobId = null;
// Счётчик версий запроса: у каждого execQuery() своя версия, и если
// «осиротевший» (отменённый) запрос завершится ПОЗЖЕ, чем стартовал
// новый — его finally не будет трогать UI уже нового запроса.
let _execVersion = 0;

const CHUNK_SIZE       = 500;    // размер чанка при дозагрузке («Загрузить ещё»)
const INITIAL_LOAD     = 2000;   // первый запрос — грузим больше, чтобы таблицы
                                 // до ~2000 строк открывались одним запросом
const ALL_ROWS_LIMIT   = 999999; // значение select для «Все»

async function execQuery(sql, opts = {}) {
  _currentSql = sql;
  const myVersion = ++_execVersion;
  const forceLimitZero = !!opts.forceLimitZero;

  state.allRows      = [];
  state.filteredRows = [];
  state.columns      = [];
  state.hiddenColumns = new Set();
  state.hasMore      = false;
  state.loadOffset   = 0;
  state.lastSql      = sql;

  setLoading(true);
  const t0 = Date.now();

  try {
    const isTemplate    = state.selectedTmpl >= 0;
    const selectedLimit = parseInt(document.getElementById('limitSelect').value);
    const isAll         = !isTemplate && !forceLimitZero && selectedLimit >= ALL_ROWS_LIMIT;

    const sqlClean    = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    const sqlLimitMatch = sqlClean.match(/\bLIMIT\s+(\d+)/i);
    const sqlHasLimit   = !!sqlLimitMatch;
    const sqlLimitValue = sqlLimitMatch ? parseInt(sqlLimitMatch[1], 10) : null;

    let res;

    // Лимит строк для текущего запроса
    const fetchLimit = isTemplate ? 100000 : selectedLimit;

    // Тяжёлый запрос — идём через polling, чтобы не блокировать HTTP надолго:
    //  - выбрано «Все строки»
    //  - явного LIMIT нет и выбранный лимит большой (> 5000)
    //  - в SQL свой LIMIT, но он большой (> 5000) или не распарсен (LIMIT с переменной/подзапросом)
    //  - принудительный полный экспорт (forceLimitZero)
    const isHeavy = isAll
                 || (!sqlHasLimit && !forceLimitZero && fetchLimit > 5000)
                 || (sqlHasLimit && (sqlLimitValue === null || sqlLimitValue > 5000))
                 || forceLimitZero;

    if (state.currentDb === 'local') {
      // Локальная БД — всегда синхронно
      res = await apiCall(sql, 'preview', 0);
      if (!res) return;
    } else if (state.currentDb === 'ched' || state.currentDb === 'ched2' || state.currentDb === 'ksp') {
      // CHED/CHED2/KSP: фоновый polling-путь (submit) идёт с кредами СЭД и не
      // знает профиль/схему. Поэтому выполняем синхронно через демон —
      // он корректно подставляет креды профиля и search_path для схемы.
      const chedLimit = (isAll || forceLimitZero) ? 0 : fetchLimit;
      res = await apiCall(sql, 'preview', chedLimit);
      if (!res) return;
    } else if (isHeavy) {
      // Тяжёлый или долгий запрос → через polling (не блокирует HTTP)
      const pollLimit = isAll ? INITIAL_LOAD : (forceLimitZero ? 0 : fetchLimit);
      res = await _runWithPolling(sql, pollLimit, 0, t0);
      if (!res) return;
    } else {
      // Лёгкий запрос с небольшим лимитом (≤ 5000) → синхронно, быстро
      res = await apiCall(sql, 'preview', fetchLimit);
      if (!res) return;
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    // Пока мы ждали ответ, пользователь уже запустил более новый запрос —
    // не перезаписываем его результат устаревшими данными.
    if (myVersion !== _execVersion) return;

    if (!res.ok) {
      setError(res.error || 'Ошибка запроса');
      logQueryToServer(sql, { isError: true, errorText: res.error });
      return;
    }

    state.columns      = res.columns || [];
    state.allRows      = res.rows    || [];
    state.filteredRows = [...state.allRows];
    state.loadOffset   = state.allRows.length;
    // Показываем кнопку «Загрузить ещё» только если выбрано «Все»
    // и вернулось ровно INITIAL_LOAD строк (значит есть ещё)
    state.hasMore      = isAll && res.rows?.length >= INITIAL_LOAD
                         && state.currentDb !== 'ched' && state.currentDb !== 'ched2'
                         && state.currentDb !== 'ksp';
    state.page         = 1;

    const detectedDate = detectDateColumn(state.currentTable, state.columns);
    state.dateColumn   = detectedDate;
    updateDateUI(detectedDate);
    applyClientFilter();
    renderTable();
    _renderLoadMoreBar();

    const moreHint = state.hasMore ? ' · ещё есть ↓' : '';
    setStatus('ok', `${res.count} строк · ${elapsed}s${moreHint}`);
    document.getElementById('queryTime').textContent = elapsed + 's';

    const ss = document.getElementById('statusbarSearch');
    if (ss) ss.style.display = state.columns.length ? '' : 'none';
    if (!_sqlBarCollapsed) setTimeout(autoResizeSQL, 0);

    addToHistory(sql);
    logQueryToServer(sql, { rowCount: res.count, durationMs: Math.round(Date.now() - t0) });

  } catch (e) {
    _currentJobId = null;
    if (myVersion === _execVersion) {
      setError(e.message);
      logQueryToServer(sql, { isError: true, errorText: e.message });
    }
  } finally {
    // Если пока мы ждали (poll/fetch), пользователь уже запустил новый
    // запрос — не трогаем его UI своим (уже неактуальным) завершением.
    if (myVersion === _execVersion) setLoading(false);
  }
}

// ── Загрузить ещё CHUNK_SIZE строк (только для «Все») ─────────
async function loadMoreRows() {
  if (!state.hasMore || !state.lastSql) return;
  if (state._loadingMore) return; // уже грузим
  state._loadingMore = true;

  setStatus('loading', `Загрузка следующих ${CHUNK_SIZE} строк...`);

  const t0 = Date.now();

  try {
    const res = await _runWithPolling(state.lastSql, CHUNK_SIZE, state.loadOffset, t0);
    if (res === null) return;

    if (!res.ok) { setError(res.error || 'Ошибка дозагрузки'); return; }

    const newRows = res.rows || [];
    state.allRows      = [...state.allRows, ...newRows];
    state.loadOffset  += newRows.length;
    state.hasMore      = newRows.length >= CHUNK_SIZE;
    state.filteredRows = [...state.allRows];

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    const moreHint = state.hasMore ? ' · ещё есть' : ' · все загружены';
    setStatus('ok', `${state.allRows.length} строк · +${newRows.length} за ${elapsed}s${moreHint}`);

    renderTable();

  } catch (e) {
    setError(e.message);
  } finally {
    state._loadingMore = false;
  }
}

// ── Авто-загрузка при переходе на последнюю страницу ─────────
function _checkAutoLoad() {
  if (!state.hasMore || !state.lastSql) return;
  const totalPages = Math.ceil(state.filteredRows.length / state.pageSize);
  if (state.page >= totalPages) {
    loadMoreRows();
  }
}

function _renderLoadMoreBar() {
  // Кнопки нет — загрузка идёт автоматически при переходе на последнюю страницу
  document.getElementById('loadMoreBar')?.remove();
}

// ── submit/poll для дозагрузки и тяжёлых запросов ────────────
async function _runWithPolling(sql, limit, offset, t0) {
  // Профиль/схема — как в apiCall, иначе тяжёлый запрос уйдёт в базу СЭД
  const _profile = (state.currentDb === 'ched' || state.currentDb === 'ched2' || state.currentDb === 'ksp') ? state.currentDb : 'sed';
  const _schema  = _profile !== 'sed' ? (state.chedSchema || '') : '';
  const submitResp = await fetch(`${API}?m=Remote&a=submit`, {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body:        JSON.stringify({ sql, limit, offset, profile: _profile, schema: _schema }),
  });

  if (submitResp.status === 401) { window._handleUnauthorized?.(); return null; }

  const submitData = await submitResp.json();
  if (!submitData.ok) {
    setError(submitData.error || 'Ошибка запуска');
    return { ok: false, error: submitData.error };
  }

  _currentJobId = submitData.jobId;
  const res = await _pollUntilDone(_currentJobId, t0);
  _currentJobId = null;
  return res;
}

// ── Адаптивный поллинг ────────────────────────────────────────
// Возвращает объект результата или null если запрос отменён.
async function _pollUntilDone(jobId, t0) {
  let pollCount = 0;

  while (true) {
    // Адаптивная задержка: 700мс → 1.5с → 3с
    const delay = pollCount < 7 ? 700 : pollCount < 15 ? 1500 : 3000;
    await new Promise(r => setTimeout(r, delay));
    pollCount++;

    // Пользователь нажал «Отмена» — jobId уже сброшен в cancelQuery()
    if (_currentJobId !== jobId) return null;

    // Обновляем таймер в статусбаре
    const sec = Math.floor((Date.now() - t0) / 1000);
    const mm  = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss  = String(sec % 60).padStart(2, '0');
    setStatus('loading', `Выполняется ${mm}:${ss}...`);
    const gqbT = document.getElementById('gqbTimer');
    if (gqbT) gqbT.textContent = `${mm}:${ss}`;

    // Обновляем текст кнопки «Отмена» если она уже видна
    const cancelBtn = document.getElementById('btnCancelQuery');
    if (cancelBtn && cancelBtn.style.display !== 'none') {
      cancelBtn.textContent = `✕ Остановить (${mm}:${ss})`;
    }

    let data;
    try {
      const r = await fetch(`${API}?m=Remote&a=poll&jobId=${jobId}`, {
        credentials: 'same-origin',
      });
      if (r.status === 401) { window._handleUnauthorized?.(); return null; }
      data = await r.json();
    } catch (_) {
      // Временная сетевая ошибка — попробуем снова
      continue;
    }

    if (data.status === 'done' || (data.ok === false && data.status === 'error')) {
      return data;
    }
    // status === 'running' → продолжаем
  }
}

// ── Отмена запроса ────────────────────────────────────────────
// Вызывается кнопкой «Отмена» в тулбаре (onclick="cancelQuery()")
async function cancelQuery() {
  const jobId = _currentJobId;
  _currentJobId = null; // сигнал _pollUntilDone что надо остановиться
  _execVersion++;       // «осиротевший» execQuery больше не тронет UI

  _hideCancelBtn();
  setLoading(false);
  setStatus('err', 'Отменяется...');

  // Спиннер «Выполняется запрос...» иначе висел бы вечно — его убирает
  // только renderTable() при успехе, а при отмене успеха не будет.
  const area = document.getElementById('tableArea');
  if (area) {
    area.innerHTML = `<div class="placeholder" style="height:100%">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-3)" stroke-width="1.5" opacity=".7"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
      <div style="color:var(--c-text-3);font-size:13px;font-weight:600">Запрос отменён</div>
      <div style="color:var(--c-text-3);font-size:12px">Напишите новый запрос или выберите таблицу</div>
    </div>`;
  }
  document.getElementById('paginationBar').style.display = 'none';

  // Убиваем процесс на сервере (posix_kill)
  if (jobId) {
    try {
      const r = await fetch(`${API}?m=Remote&a=cancel&jobId=${jobId}`, {
        credentials: 'same-origin',
      });
      const data = await r.json().catch(() => ({}));
      if (data.cancelled) {
        setStatus('err', 'Запрос отменён и остановлен на сервере');
        showToast('✕ Запрос остановлен');
      } else {
        setStatus('err', 'Запрос отменён');
      }
    } catch (_) {
      setStatus('err', 'Запрос отменён (нет связи с сервером)');
    }
  } else {
    setStatus('err', 'Запрос отменён');
  }
}

function buildSQL() {
  if (_sqlManuallyEdited) {
    const custom = document.getElementById('sqlEditor').value.trim();
    if (custom) return custom;
  }
  if (!state.currentTable) return '';
  const id    = document.getElementById('filterId').value.trim();
  const df    = document.getElementById('filterDateFrom').value;
  const dt    = document.getElementById('filterDateTo').value;
  const limit = document.getElementById('limitSelect').value;
  const where = [];
  if (id) where.push(`id = ${parseInt(id)}`);
  if (state.dateColumn) {
    if (df) where.push(`${state.dateColumn} >= '${df}'`);
    if (dt) where.push(`${state.dateColumn} <= '${dt} 23:59:59'`);
  }
  let sql = `SELECT * FROM "${state.currentTable}"`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` LIMIT ${limit}`;
  _sqlManuallyEdited = false;
  document.getElementById('sqlEditor').value = sql;
  autoResizeSQL();
  return sql;
}

function clearSQL() {
  document.getElementById('sqlEditor').value = '';
  _sqlManuallyEdited = false;
  if (state.currentTable && state.selectedTmpl < 0) buildSQL();
}

function resetFilters() {
  ['filterId','filterDateFrom','filterDateTo','filterText'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  state.filteredRows = [...state.allRows]; state.page = 1; renderTable();
}

// ── История запросов (последние 100 в localStorage) ──────────────
function addToHistory(sql) {
  try {
    // Определяем тип запроса
    let qtype = 'custom';
    if (state.selectedTmpl >= 0) {
      qtype = 'template';
    } else if (state.currentTable && !_sqlManuallyEdited) {
      qtype = 'table';
    }

    const entry = {
      sql,
      ts:    new Date().toISOString(),
      table: state.currentTable || '',
      tmpl:  state.selectedTmpl >= 0 ? (TEMPLATES[state.selectedTmpl]?.title || '') : '',
      type:  qtype,
    };
    const raw     = localStorage.getItem('sed_query_history');
    const list    = raw ? JSON.parse(raw) : [];
    const deduped = list.filter(q => q.sql !== sql);
    deduped.unshift(entry);
    localStorage.setItem('sed_query_history', JSON.stringify(deduped.slice(0, 100)));
    if (typeof prefsSaveHistory === 'function') prefsSaveHistory();
  } catch (_) {}
}

// ── Лог запросов на сервер ───────────────────────────────────────
function logQueryToServer(sql, opts = {}) {
  try {
    const { rowCount = null, durationMs = null, isError = false, errorText = null } = opts;
    const tmpl      = state.selectedTmpl >= 0 ? TEMPLATES[state.selectedTmpl] : null;
    const queryType = tmpl ? 'template' : (state.currentTable ? 'table' : 'custom');
    const user      = (() => {
      try { return JSON.parse(sessionStorage.getItem('sed_auth_user') || '{}').name || '—'; }
      catch(_) { return '—'; }
    })();
    fetch(`${API}?m=QueryLog&a=add`, {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        sql, user,
        table:        state.currentTable || '',
        queryType,
        templateName: tmpl?.title || null,
        rowCount, durationMs, isError, errorText,
      }),
    }).catch(() => {});
  } catch (_) {}
}

// ── Модальное окно истории ────────────────────────────────────────
function openHistoryModal() {
  const modal = document.getElementById('historyModal');
  if (!modal) return;
  modal.classList.add('open');
  // Сначала синхронизируем с сервером — вдруг в другом браузере очистили
  if (typeof prefsLoad === 'function') {
    prefsLoad().then(() => {
      renderHistoryModal();
      _attachHistoryListeners();
    });
  } else {
    renderHistoryModal();
    _attachHistoryListeners();
  }
  setTimeout(() => document.getElementById('historySearch')?.focus(), 60);
}

function closeHistoryModal() {
  document.getElementById('historyModal')?.classList.remove('open');
}

function renderHistoryModal() {
  const list = document.getElementById('historyList');
  if (!list) return;

  let items = [];
  try { items = JSON.parse(localStorage.getItem('sed_query_history') || '[]'); } catch (_) {}

  document.getElementById('historyCount').textContent = items.length;

  if (!items.length) {
    list.innerHTML = `<div class="hist-empty">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--c-border)">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
      История пуста
    </div>`;
    return;
  }

  list.innerHTML = items.map((e, i) => {
    const ts      = e.ts ? new Date(e.ts).toLocaleString('ru') : '—';
    const sql     = typeof e === 'string' ? e : (e.sql || '');
    const type    = (typeof e === 'object' && e.type) ? e.type : 'custom';
    const label   = typeof e === 'object' ? (e.tmpl || e.table || '') : '';
    const preview = sql.replace(/\s+/g, ' ').trim().slice(0, 72);

    const badgeMap = {
      table:    { style:'color:var(--c-green);background:var(--c-green-bg);border-color:var(--c-green-border)',    text:'Таблица'  },
      template: { style:'color:var(--c-accent);background:var(--c-accent-bg);border-color:var(--c-accent-border)', text:'Шаблон'  },
      custom:   { style:'color:var(--c-text-2);background:var(--c-surface-2);border-color:var(--c-border)',        text:'Запрос'   },
    };
    const badge = badgeMap[type] || badgeMap.custom;

    return `<div class="tmpl-card" data-hist-idx="${i}" title="Нажмите чтобы загрузить">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
        <div style="display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden">
          <span style="font-size:10.5px;padding:1px 7px;border-radius:var(--r-sm);border:1px solid;flex-shrink:0;${badge.style}">${badge.text}</span>
          ${label ? `<span class="tmpl-desc" style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(label)}</span>` : ''}
        </div>
        <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
          <span class="tmpl-desc" style="margin:0;white-space:nowrap">${escHtml(ts)}</span>
          <button class="hist-btn-del" data-idx="${i}"
            style="background:none;border:none;cursor:pointer;color:var(--c-text-3);font-size:12px;padding:0 2px"
            title="Удалить">✕</button>
        </div>
      </div>
      <div class="tmpl-desc" style="font-family:var(--font-mono);font-size:10.5px;margin-top:4px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        ${escHtml(preview)}${sql.length > 72 ? '…' : ''}
      </div>
    </div>`;
  }).join('');
}

// Делегирование на historyList — вешается один раз через openHistoryModal
function _attachHistoryListeners() {
  const list = document.getElementById('historyList');
  if (!list || list._histListenerAttached) return;
  list._histListenerAttached = true;

  list.addEventListener('click', e => {
    const card = e.target.closest('.tmpl-card[data-hist-idx]');
    const del  = e.target.closest('.hist-btn-del');

    if (del) {
      const idx = parseInt(del.dataset.idx);
      let arr = [];
      try { arr = JSON.parse(localStorage.getItem('sed_query_history') || '[]'); } catch (_) {}
      arr.splice(idx, 1);
      localStorage.setItem('sed_query_history', JSON.stringify(arr));
      renderHistoryModal();
      return;
    }

    if (card) {
      const idx = parseInt(card.dataset.histIdx);
      let arr = [];
      try { arr = JSON.parse(localStorage.getItem('sed_query_history') || '[]'); } catch (_) {}
      const entry = arr[idx];
      const sql   = typeof entry === 'string' ? entry : (entry?.sql || '');
      if (sql) {
        document.getElementById('sqlEditor').value = sql;
        _sqlManuallyEdited = true;
        autoResizeSQL();
        toggleSqlBar(false);
        closeHistoryModal();
        setStatus('ok', 'SQL загружен из истории');
      }
    }
  });
}

function loadSqlIntoEditor(sql) {
  document.getElementById('sqlEditor').value = sql;
  _sqlManuallyEdited = true;
  autoResizeSQL();
  toggleSqlBar(false);
  closeHistoryModal();
  setStatus('ok', 'Запрос загружен из истории');
}

function openSqlPopup(sql, idx) {
  // Удаляем старый попап если был
  const old = document.getElementById('sqlPopup'); if (old) old.remove();

  const popup = document.createElement('div');
  popup.id = 'sqlPopup';
  popup.style.cssText = [
    'position:fixed','inset:0','z-index:1100',
    'display:flex','align-items:center','justify-content:center',
    'background:rgba(0,0,0,.45)',
  ].join(';');

  popup.innerHTML = `
    <div style="background:var(--c-surface);border:1px solid var(--c-border);
      border-radius:var(--r);box-shadow:var(--sh-lg);width:660px;max-width:94vw;
      padding:18px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:13px;font-weight:500;color:var(--c-text)">SQL-запрос</span>
        <button id="sqlPopupClose" style="background:none;border:none;cursor:pointer;
          color:var(--c-text-3);font-size:16px;line-height:1">✕</button>
      </div>
      <textarea id="sqlPopupText" style="font-family:var(--font-mono);font-size:12.5px;
        padding:10px;border:1px solid var(--c-border);border-radius:var(--r-sm);
        background:var(--c-surface-2);color:var(--c-text);resize:vertical;
        min-height:160px;width:100%;line-height:1.6">${escHtml(sql)}</textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button id="sqlPopupLoad" class="btn btn-primary">▶ Загрузить в редактор</button>
        <button id="sqlPopupClose2" class="btn btn-outline">Закрыть</button>
      </div>
    </div>`;

  document.body.appendChild(popup);

  const close = () => popup.remove();
  popup.querySelector('#sqlPopupClose').addEventListener('click', close);
  popup.querySelector('#sqlPopupClose2').addEventListener('click', close);
  popup.addEventListener('mousedown', e => { if (e.target === popup) close(); });

  popup.querySelector('#sqlPopupLoad').addEventListener('click', () => {
    const edited = document.getElementById('sqlPopupText').value.trim();
    if (edited) loadSqlIntoEditor(edited);
    close();
  });
}

function clearHistory() {
  if (!confirm('Очистить всю историю?')) return;
  localStorage.removeItem('sed_query_history');
  // Очищаем и на сервере — иначе при перезагрузке prefsLoad восстановит
  if (typeof prefsSave === 'function') prefsSave('query_history', []);
  renderHistoryModal();
  showToast('История очищена');
}

// Закрытие по клику на overlay
document.addEventListener('mousedown', e => {
  const modal = document.getElementById('historyModal');
  if (modal?.classList.contains('open') && e.target === modal) closeHistoryModal();
});

// ── Рендер таблицы ────────────────────────────────────────────
function renderTable() {
  const area = document.getElementById('tableArea');
  const { columns, filteredRows, page, pageSize, sortCol, sortAsc, hiddenColumns } = state;

  // Видимые колонки с учётом скрытых
  const visibleCols = columns.filter(c => !hiddenColumns.has(c));

  if (!visibleCols.length && !columns.length) {
    area.innerHTML = `<div class="placeholder" style="height:100%">
      <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
      <div>Нет данных для отображения</div>
    </div>`;
    renderPagination(1, 1, 0);
    return;
  }

  if (!visibleCols.length) {
    area.innerHTML = `<div class="placeholder" style="height:100%">
      <div style="color:var(--c-text-2)">Все колонки скрыты</div>
      <div style="font-size:12px;color:var(--c-text-3)">Нажмите «Колонки» в тулбаре чтобы показать</div>
    </div>`;
    return;
  }

  const total    = filteredRows.length;
  const pageRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);

  const thead = `<thead><tr>${visibleCols.map(c => {
    const s = c === sortCol;
    return `<th class="${s ? 'sorted' : ''}" data-col="${escHtml(c)}">${escHtml(c)}&nbsp;<span style="opacity:${s ? 1 : .25};font-size:10px">${s ? (sortAsc ? '↑' : '↓') : '⇅'}</span></th>`;
  }).join('')}</tr></thead>`;

  const tbody = `<tbody>${pageRows.map((row, rowIdx) => {
    const cells = visibleCols.map(c => {
      const v = row[c];
      if (v === null || v === undefined || v === '') return `<td class="null" data-val="">—</td>`;
      if (v === true)  return `<td class="bool-t" data-val="true">true</td>`;
      if (v === false) return `<td class="bool-f" data-val="false">false</td>`;
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) {
        const fkTable = c !== 'id' ? resolveFk(c, state.currentTable) : null;
        if (fkTable) return `<td class="num fk-cell" data-fk-table="${escHtml(fkTable)}" data-fk-id="${v}" data-val="${v}" title="→ ${escHtml(fkTable)}[${v}]"><span class="fk-val">${v}</span><span class="fk-arrow">↗</span></td>`;
        return `<td class="num" data-val="${v}">${v}</td>`;
      }
      if (typeof v === 'number') return `<td class="num" data-val="${v}">${v}</td>`;
      const s = String(v);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return `<td class="date" data-val="${escHtml(s)}">${escHtml(window.sedFmtDate ? window.sedFmtDate(s) : s.substring(0, 19))}</td>`;
      if (/^\d+$/.test(s) && s.length < 12 && c !== 'id') {
        const fkTable = resolveFk(c, state.currentTable);
        if (fkTable) return `<td class="num fk-cell" data-fk-table="${escHtml(fkTable)}" data-fk-id="${parseInt(s)}" data-val="${escHtml(s)}" title="→ ${escHtml(fkTable)}[${s}]"><span class="fk-val">${s}</span><span class="fk-arrow">↗</span></td>`;
      }
      const d = s.length > 400 ? s.substring(0, 400) + '…' : s;
      return `<td data-val="${escHtml(s)}" title="${escHtml(s)}">${escHtml(d)}</td>`;
    }).join('');
    return `<tr data-row-idx="${rowIdx}">${cells}</tr>`;
  }).join('')}</tbody>`;

  area.innerHTML = `<div class="table-card"><table class="data-table" id="dataTable">${thead}${tbody}</table></div>`;
  // Анимация появления новых данных
  area.classList.remove('table-area-loaded');
  void area.offsetWidth;
  area.classList.add('table-area-loaded');

  renderPagination(page, Math.ceil(total / pageSize), total);
  document.getElementById('rowCount').textContent = `${total} строк`;

  // Навешиваем события после того как браузер отрисует таблицу
  requestAnimationFrame(() => {
    const table = document.getElementById('dataTable');
    if (!table) return;

    // Сортировка по клику на заголовок
    table.querySelector('thead').addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (th) sortBy(th.dataset.col);
    });

    // FK-переход — левый клик только на FK-ячейках
    table.querySelector('tbody').addEventListener('click', e => {
      const td = e.target.closest('td');
      if (!td) return;
      if (td.classList.contains('fk-cell') && td.dataset.fkTable && td.dataset.fkId) {
        navigateToFK(td.dataset.fkTable, td.dataset.fkId, e);
      }
    });

    // Правая кнопка = скопировать значение ячейки
    // Shift + правая кнопка = скопировать строку как JSON
    table.querySelector('tbody').addEventListener('contextmenu', e => {
      const td = e.target.closest('td');
      const tr = e.target.closest('tr');
      if (!td || !tr) return;
      e.preventDefault();

      if (e.shiftKey) {
        const rowIdx = parseInt(tr.dataset.rowIdx);
        const pageRows = state.filteredRows.slice(
          (state.page - 1) * state.pageSize,
           state.page      * state.pageSize
        );
        if (!isNaN(rowIdx) && pageRows[rowIdx]) {
          copyToClipboard(JSON.stringify(pageRows[rowIdx], null, 2), 'Строка скопирована как JSON');
        }
        return;
      }

      const val = td.dataset.val ?? td.textContent.trim();
      if (val && val !== '—') {
        copyToClipboard(val, 'Скопировано!');
      }
    });
  });
}

function sortBy(col) {
  state.sortCol === col ? (state.sortAsc = !state.sortAsc) : (state.sortCol = col, state.sortAsc = true);
  state.filteredRows.sort((a, b) => {
    const va = a[col], vb = b[col];
    if (va === null || va === '') return 1; if (vb === null || vb === '') return -1;
    return state.sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });
  state.page = 1; renderTable();
}

// ── Пагинация ─────────────────────────────────────────────────
function renderPagination(page, total, rowCount) {
  const bar = document.getElementById('paginationBar');
  if (total <= 1) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';

  const pages = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(total, page + 2); i++) pages.push(i);

  const pb = document.getElementById('pageButtons');
  pb.innerHTML = pages.map(p =>
    `<button class="page-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`
  ).join('');

  document.getElementById('pageInfo').textContent = `стр. ${page} / ${total} · ${rowCount} строк`;

  const fresh = pb.cloneNode(true);
  pb.parentNode.replaceChild(fresh, pb);
  fresh.addEventListener('click', e => {
    const btn = e.target.closest('[data-page]');
    if (btn) goPage(parseInt(btn.dataset.page));
  });
}

function goPage(p)  { state.page = p; renderTable(); _checkAutoLoad(); }
function prevPage() { if (state.page > 1) { state.page--; renderTable(); } }
function nextPage() {
  const m = Math.ceil(state.filteredRows.length / state.pageSize);
  if (state.page < m) { state.page++; renderTable(); _checkAutoLoad(); }
  else if (state.hasMore) { loadMoreRows(); } // уже на последней — грузим ещё
}

// ── Статус / загрузка / ошибки ────────────────────────────────
// Таймер показа кнопки «Отмена» через минуту
let _cancelBtnTimer = null;

function _showCancelBtn() {
  const btn = document.getElementById('btnCancelQuery');
  if (!btn) return;
  btn.style.display = '';
  btn.style.opacity = '0';
  btn.style.transition = 'opacity .4s';
  requestAnimationFrame(() => { btn.style.opacity = '1'; });
}

function _hideCancelBtn() {
  clearTimeout(_cancelBtnTimer);
  _cancelBtnTimer = null;
  const btn = document.getElementById('btnCancelQuery');
  if (btn) { btn.style.display = 'none'; btn.style.opacity = ''; }
}

function _updateGlobalBar(visible, sql) {
  const bar = document.getElementById('globalQueryBar');
  if (!bar) return;
  if (visible) {
    bar.style.display = 'block';
    document.body.classList.add('query-running');
    const sqlEl = document.getElementById('gqbSql');
    if (sqlEl && sql) {
      const short = sql.replace(/\s+/g, ' ').trim().substring(0, 80);
      sqlEl.textContent = short.length < sql.replace(/\s+/g,' ').trim().length ? short + '…' : short;
    }
  } else {
    bar.style.display = 'none';
    document.body.classList.remove('query-running');
    const t = document.getElementById('gqbTimer');
    if (t) t.textContent = '00:00';
  }
}

function setLoading(v) {
  // Не блокируем кнопку «Загрузить» — пользователь может запустить
  // новый запрос пока старый ещё идёт (auto-cancel в runSQL)
  if (v) {
    document.getElementById('tableArea').innerHTML = `<div class="placeholder" style="height:100%">
      <div class="loading-spinner"></div>
      <div style="font-size:13px;color:var(--c-text-3);margin-top:4px">Выполняется запрос...</div>
    </div>`;
    setStatus('loading', 'Запрос...');
    document.getElementById('paginationBar').style.display = 'none';
    _hideCancelBtn();
    _cancelBtnTimer = setTimeout(_showCancelBtn, 3_000);
  } else {
    _hideCancelBtn();
    _updateGlobalBar(false);
  }
}

function setStatus(type, msg) {
  const tag = document.getElementById('statusTag');
  tag.style.display = 'inline';
  // Перезапуск анимации
  tag.className = '';
  void tag.offsetWidth;
  tag.className = `tag tag-${type}`;
  tag.textContent = type === 'ok' ? '✓ OK' : type === 'err' ? '✗ Ошибка' : '⟳';
  document.getElementById('statusText').textContent = msg;
}

function setError(msg) {
  document.getElementById('tableArea').innerHTML = `<div class="placeholder" style="height:100%">
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" opacity=".7"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
    <div style="color:var(--c-red);font-size:13px;font-weight:600">Ошибка запроса</div>
    <div style="color:var(--c-text-3);font-size:12px;max-width:500px;text-align:center;line-height:1.6">${escHtml(msg)}</div>
  </div>`;
  setStatus('err', msg.substring(0, 120));
}
// ── Черновик SQL — восстановление после смены вкладки ─────────────
function checkSqlDraft() {
  try {
    const raw = sessionStorage.getItem('sed_sql_draft');
    if (!raw) return;
    const { sql, ts } = JSON.parse(raw);
    if (!sql || Date.now() - ts > 3600000) { sessionStorage.removeItem('sed_sql_draft'); return; }

    const preview = sql.replace(/\s+/g, ' ').slice(0, 60) + (sql.length > 60 ? '…' : '');
    const banner  = document.createElement('div');
    banner.id = 'sqlDraftBanner';
    banner.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px;' +
      'background:var(--c-accent-bg);border:1px solid var(--c-accent-border);' +
      'border-radius:var(--r);font-size:12px;color:var(--c-accent);margin:0 0 4px;flex-shrink:0';
    banner.innerHTML = `
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ↩ Несохранённый запрос: <strong>${escHtml(preview)}</strong>
      </span>
      <button onclick="restoreSqlDraft()" style="padding:2px 10px;border-radius:var(--r-sm);
        border:1px solid var(--c-accent-border);background:var(--c-accent-bg);
        color:var(--c-accent);cursor:pointer;font-size:11.5px;font-weight:500">
        Восстановить
      </button>
      <button onclick="document.getElementById('sqlDraftBanner').remove();sessionStorage.removeItem('sed_sql_draft')"
        style="padding:2px 6px;border-radius:var(--r-sm);border:1px solid var(--c-border);
        background:transparent;color:var(--c-text-3);cursor:pointer;font-size:11px">✕</button>
    `;
    const sqlBar = document.getElementById('sqlBar');
    if (sqlBar) sqlBar.parentNode.insertBefore(banner, sqlBar);
  } catch (_) {}
}

function restoreSqlDraft() {
  try {
    const { sql } = JSON.parse(sessionStorage.getItem('sed_sql_draft') || '{}');
    if (!sql) return;
    document.getElementById('sqlEditor').value = sql;
    _sqlManuallyEdited = true;
    autoResizeSQL();
    toggleSqlBar(false);
    sessionStorage.removeItem('sed_sql_draft');
    document.getElementById('sqlDraftBanner')?.remove();
    showToast('Запрос восстановлен');
  } catch (_) {}
}