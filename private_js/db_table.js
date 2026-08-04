// ── Склонение числительных ────────────────────────────────────
function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// ════════════════════════════════════════════════════════════════
//  db_table.js — боковая панель таблиц, org list, вкладки
// ════════════════════════════════════════════════════════════════

// ── Список таблиц ─────────────────────────────────────────────
async function loadTableList() {
  try {
    const isChed = (state.currentDb === 'ched' || state.currentDb === 'ched2' || state.currentDb === 'ksp');
    let sql;
    if (isChed) {
      // На CHED/CHED2 схема выбирается отдельно (переключатель схем) —
      // показываем таблицы именно из неё, без привязки к списку СЭД.
      const schema = (state.chedSchema || 'public').replace(/'/g, "''");
      sql = `SELECT c.relname AS table_name, COALESCE(d.description,'') AS table_comment
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_description d ON d.objoid=c.oid AND d.objsubid=0
        WHERE n.nspname='${schema}' AND c.relkind='r'
        ORDER BY c.relname`;
    } else {
      const inList = TABLE_WHITELIST.map(t => `'${t.replace(/'/g,"''")}'`).join(',');
      sql = `SELECT c.relname AS table_name, COALESCE(d.description,'') AS table_comment
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_description d ON d.objoid=c.oid AND d.objsubid=0
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN (${inList})
        ORDER BY c.relname`;
    }
    // Таймаут 20 секунд — если нет ответа, показываем ошибку вместо вечного спиннера
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Превышено время ожидания (20с)')), 20000));
    const res = await Promise.race([apiCall(sql), timeout]);
    if (res.ok && res.rows.length) {
      state.tables = res.rows.map(r => ({
        name:    r.table_name,
        comment: (r.table_comment || '').trim() || (TABLE_LABELS_FALLBACK[r.table_name] || '')
      }));
      setStatus('ok', `Загружено ${state.tables.length} ${plural(state.tables.length,"таблица","таблицы","таблиц")}`);
    } else {
      state.tables = [];
      setStatus('err', res.error || 'Не удалось загрузить таблицы');
    }
  } catch (e) { state.tables = []; setStatus('err', 'Ошибка: ' + e.message); }

  document.getElementById('tblCountBadge').textContent = `${state.tables.length} ${plural(state.tables.length,'таблица','таблицы','таблиц')}`;
  document.getElementById('tblCount').textContent      = `${state.tables.length} ${plural(state.tables.length,'таблица','таблицы','таблиц')}`;
  renderTableList(document.getElementById('tableSearch').value);
}

async function loadOrgList() {
  if (state.orgList !== null) return;
  state.orgList = [];
  try {
    const res = await apiCall(`SELECT ug.id, ug.short_name, ug.name
      FROM user_group ug JOIN c_org co ON co.org_id=ug.id AND co.dis_date IS NULL
      ORDER BY ug.id LIMIT 2000`);
    if (res.ok) { state.orgList = res.rows; refreshOrgSelects(); }
    else state.orgList = null;
  } catch (_) { state.orgList = null; }
}

function refreshOrgSelects() {
  if (!state.orgList?.length) return;
  const tmpl = state.selectedTmpl >= 0 ? TEMPLATES[state.selectedTmpl] : null;
  if (!tmpl) return;
  tmpl.params.filter(p => p.type === 'org').forEach(p => {
    const combo = document.getElementById('combo_' + p.key);
    if (combo) comboFilter(p.key, '');
  });
}

// ── Рендер списка таблиц ──────────────────────────────────────
// ── Избранные таблицы ─────────────────────────────────────────
const TBL_FAV_KEY = 'sed_tbl_favs';
function getTblFavs()       { try { return new Set(JSON.parse(localStorage.getItem(TBL_FAV_KEY)||'[]')); } catch(_){ return new Set(); } }
function saveTblFavs(s)     { try { localStorage.setItem(TBL_FAV_KEY, JSON.stringify([...s])); } catch(_){} }

function toggleTblFav(name, e) {
  e.stopPropagation();
  const favs = getTblFavs();
  const adding = !favs.has(name);
  adding ? favs.add(name) : favs.delete(name);
  saveTblFavs(favs);

  const btn = document.querySelector(`.tbl-fav-btn[data-fav-tbl="${CSS.escape(name)}"]`);
  if (btn) {
    btn.classList.toggle('active', adding);
    btn.classList.remove('animating-on','animating-off');
    void btn.offsetWidth;
    btn.classList.add(adding ? 'animating-on' : 'animating-off');
    btn.addEventListener('animationend', () => btn.classList.remove('animating-on','animating-off'), { once:true });
    if (adding) _burstParticles(btn);
  }

  if (typeof prefsSaveTblFavs === 'function') prefsSaveTblFavs();

  // Сбрасываем кэш fast-path — нужно перерисовать список с новым избранным
  const _tblList = document.getElementById('tableList');
  if (_tblList) _tblList.dataset.renderedFilter = '__reset__';

  if (!adding) {
    // При удалении из избранного — анимируем исчезновение из группы «Избранное»
    const items = document.querySelectorAll(`#panel-tables .tbl-item[data-table="${CSS.escape(name)}"]`);
    if (items.length > 1) {
      items[0].classList.add('removing');
      setTimeout(() => {
        const q2 = document.getElementById('tableSearch')?.value || '';
        renderTableList(q2);
      }, 280);
      return;
    }
  }

  const q = document.getElementById('tableSearch')?.value || '';
  renderTableList(q);
}

function renderTableList(filter = '') {
  const list   = document.getElementById('tableList');
  const q      = filter.trim();
  const favs   = getTblFavs();
  const tables = q
    ? state.tables.filter(t => matchSearch(t.name + ' ' + (t.comment || ''), q))
    : state.tables;

  document.getElementById('tblCount').textContent = q
    ? `${tables.length} из ${state.tables.length} ${plural(state.tables.length,'таблицы','таблиц','таблиц')}`
    : `${state.tables.length} ${plural(state.tables.length,'таблица','таблицы','таблиц')}`;

  if (!tables.length) {
    const msg = state.tables.length === 0 && !q
      ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" opacity=".6"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg><div style="color:var(--c-red);font-size:12px;font-weight:500;margin-top:4px">Не удалось загрузить таблицы</div><div style="font-size:11px;color:var(--c-text-3);margin-top:2px">Проверьте подключение к БД</div>'
      : '<div style="font-size:12px;color:var(--c-text-3)">Не найдено</div>';
    list.innerHTML = `<div class="placeholder" style="height:100px">${msg}</div>`;
    return;
  }

  // Если список уже отрисован с тем же фильтром — только обновляем active-класс,
  // не пересоздаём DOM (избегаем повторных CSS-анимаций)
  const existingItems = list.querySelectorAll('.tbl-item[data-table]');
  if (existingItems.length && list.dataset.renderedFilter === q) {
    existingItems.forEach(el => {
      el.classList.toggle('active', el.dataset.table === state.currentTable);
    });
    return;
  }
  list.dataset.renderedFilter = q;

  function itemHtml(t) {
    const active  = t.name === state.currentTable;
    const isFav   = favs.has(t.name);
    const label   = t.comment ? escHtml(t.comment) : escHtml(t.name);
    const sub     = t.comment ? `<div class="tbl-name sub">${escHtml(t.name)}</div>` : '';
    return `<div class="tbl-item ${active ? 'active' : ''}" data-table="${escHtml(t.name)}"
      title="${escHtml(t.comment ? t.comment + ' · ' + t.name : t.name)}">
      <div class="tbl-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg></div>
      <div class="tbl-names"><div class="tbl-name">${label}</div>${sub}</div>
      <button class="tbl-fav-btn${isFav?' active':''}" data-fav-tbl="${escHtml(t.name)}" title="${isFav?'Убрать из избранного':'В избранное'}">★</button>
    </div>`;
  }

  let html = '';

  // Группа «Избранное» (только без поиска)
  if (!q) {
    const favTables = tables.filter(t => favs.has(t.name));
    if (favTables.length) {
      html += `<div class="section-lbl" style="color:var(--c-accent);background:var(--c-accent-bg);border-bottom:1px solid var(--c-accent-border);padding-bottom:8px">⭐ Избранное</div>`;
      favTables.forEach(t => { html += itemHtml(t); });
      html += `<div class="section-lbl">Все таблицы</div>`;
    }
  }

  // Все таблицы (без избранных если они уже сверху)
  const rest = (!q && favs.size > 0) ? tables.filter(t => !favs.has(t.name)) : tables;
  rest.forEach(t => { html += itemHtml(t); });

  list.innerHTML = html;

  // Клик по строке таблицы
  list.querySelectorAll('.tbl-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.tbl-fav-btn')) return;
      selectTable(el.dataset.table);
    });
  });

  // Клик по звезде
  list.querySelectorAll('.tbl-fav-btn').forEach(btn => {
    btn.addEventListener('click', e => toggleTblFav(btn.dataset.favTbl, e));
  });
}

function selectTable(name) {
  // Сохраняем черновик SQL если пользователь его редактировал
  const curSql = document.getElementById('sqlEditor')?.value?.trim();
  if (curSql && _sqlManuallyEdited) {
    try { sessionStorage.setItem('sed_sql_draft', JSON.stringify({ sql: curSql, ts: Date.now() })); } catch (_) {}
  }

  state.currentTable = name; state.page = 1; state.sortCol = null; state.columns = [];
  state.selectedTmpl = -1;
  // Pulse-анимация на выбранном элементе (как у шаблонов)
  setTimeout(() => {
    const el = document.querySelector(`.tbl-item[data-table="${CSS.escape(name)}"]`);
    if (el) {
      el.classList.remove('active-flash');
      void el.offsetWidth; // reflow для перезапуска анимации
      el.classList.add('active-flash');
    }
  }, 0);
  state.hiddenColumns = new Set();
  _sqlManuallyEdited = false;
  document.getElementById('paramPanel').style.display = 'none';
  document.getElementById('toolbarFilters').classList.remove('hidden');
  comboCloseAll();
  document.querySelectorAll('.tmpl-card').forEach(el => el.classList.remove('active-tmpl'));
  const preDate = detectDateColumn(name, null);
  state.dateColumn = preDate; updateDateUI(preDate);
  document.getElementById('currentTable').textContent = name;
  document.getElementById('filterId').value           = '';
  document.getElementById('filterDateFrom').value     = '';
  document.getElementById('filterDateTo').value       = '';
  document.getElementById('filterText').value         = '';
  renderTableList(document.getElementById('tableSearch').value);
  const limit = document.getElementById('limitSelect').value;
  document.getElementById('sqlEditor').value = `SELECT * FROM "${name}" LIMIT ${limit}`;
  toggleSqlBar(true);
  loadTable();
}

// ── Определение колонки дат ───────────────────────────────────
function detectDateColumn(tableName, columns) {
  if (tableName && DATE_COL_MAP[tableName]) {
    const col = DATE_COL_MAP[tableName];
    if (!columns || columns.includes(col)) return col;
  }
  if (columns?.length) {
    for (const prio of DATE_AUTODETECT_PRIORITY) {
      if (columns.includes(prio)) return prio;
    }
  }
  return null;
}

function updateDateUI(dateCol) {
  const hint = document.getElementById('dateHint');
  const fi   = document.getElementById('filterDateFrom');
  const ti   = document.getElementById('filterDateTo');
  if (dateCol) {
    hint.classList.remove('show');
    fi.disabled = false; ti.disabled = false;
    fi.title = `Фильтр по полю: ${dateCol}`;
    ti.title = `Фильтр по полю: ${dateCol}`;
  } else {
    hint.classList.add('show'); hint.textContent = 'нет даты';
    fi.disabled = true; ti.disabled = true; fi.value = ''; ti.value = '';
  }
}

// ── Вкладки боковой панели ────────────────────────────────────
function switchTab(tab) {
  const tabs  = ['tables', 'templates', 'saved'];
  const tabEls = document.querySelectorAll('.sidebar-tab');
  tabEls.forEach((el, i) => el.classList.toggle('active', tabs[i] === tab));
  document.querySelectorAll('.sidebar-panel').forEach(el => el.classList.remove('active'));
  document.getElementById('panel-' + tab)?.classList.add('active');
}
// ════════════════════════════════════════════════════════════════
//  МОДАЛЬНОЕ ОКНО «ВСЕ ТАБЛИЦЫ»
// ════════════════════════════════════════════════════════════════

let _tblModalSort = 'name_asc';

function openTablesModal() {
  const modal  = document.getElementById('tablesModal');
  const search = document.getElementById('tblModalSearch');
  const sort   = document.getElementById('tblModalSort');
  if (!modal) return;

  if (search) search.value = '';
  if (sort)   sort.value   = 'name_asc';
  _tblModalSort = 'name_asc';

  // Вешаем слушатели только один раз
  if (!modal._listenersAttached) {
    modal._listenersAttached = true;

    search?.addEventListener('input', e => _renderTblModal(e.target.value));

    sort?.addEventListener('change', e => {
      _tblModalSort = e.target.value;
      _renderTblModal(search?.value || '');
    });

    document.querySelectorAll('#tablesModal th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const s = th.dataset.sort;
        _tblModalSort = (_tblModalSort === s + '_asc') ? s + '_desc' : s + '_asc';
        if (sort) sort.value = _tblModalSort;
        _renderTblModal(search?.value || '');
      });
    });
  }

  _renderTblModal('');
  modal.classList.add('open');
  setTimeout(() => search?.focus(), 60);
}

function closeTablesModal() {
  document.getElementById('tablesModal')?.classList.remove('open');
}

function _renderTblModal(q) {
  const tbody  = document.getElementById('tblModalTbody');
  const countEl = document.getElementById('tblModalCount');
  if (!tbody) return;

  let list = [...state.tables];

  // Фильтр
  if (q.trim()) {
    const ql = q.toLowerCase();
    list = list.filter(t =>
      t.name.toLowerCase().includes(ql) ||
      (t.comment || '').toLowerCase().includes(ql)
    );
  }

  // Сортировка
  const favs = getTblFavs();
  if (_tblModalSort === 'name_asc')   list.sort((a,b) => a.name.localeCompare(b.name));
  if (_tblModalSort === 'name_desc')  list.sort((a,b) => b.name.localeCompare(a.name));
  if (_tblModalSort === 'label_asc')  list.sort((a,b) => (a.comment||a.name).localeCompare(b.comment||b.name));

  if (countEl) countEl.textContent = list.length;

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="2" style="text-align:center;color:var(--c-text-3);padding:20px">Не найдено</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(t => {
    const isFav = favs.has(t.name);
    const label = t.comment ? escHtml(t.comment) : '—';
    return `<tr style="cursor:pointer" data-tbl="${escHtml(t.name)}">
      <td>
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--c-text)">${escHtml(t.name)}</span>
        <button class="tbl-modal-fav${isFav?' active':''}" data-fav-tbl="${escHtml(t.name)}"
          style="background:none;border:none;cursor:pointer;font-size:13px;
                 color:${isFav?'#f59e0b':'#d1d5db'};margin-left:6px;padding:0 2px;vertical-align:middle"
          title="${isFav?'Убрать из избранного':'В избранное'}">★</button>
      </td>
      <td style="color:var(--c-text-3);font-size:12.5px">${label}</td>
    </tr>`;
  }).join('');

  // Клик по строке — выбрать таблицу и закрыть модал
  tbody.querySelectorAll('tr[data-tbl]').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.tbl-modal-fav')) return;
      const tbl = row.dataset.tbl;
      closeTablesModal();
      switchTab('tables');
      selectTable(tbl);
    });
  });

  // Звезда в модале
  tbody.querySelectorAll('.tbl-modal-fav').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleTblFav(btn.dataset.favTbl, e);
      const favs2 = getTblFavs();
      const on    = favs2.has(btn.dataset.favTbl);
      btn.classList.toggle('active', on);
      btn.style.color = on ? '#f59e0b' : '#d1d5db';
    });
  });
}