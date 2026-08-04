// ════════════════════════════════════════════════════════════════
//  db_fk.js — FK-связи, навигация, история, модальное окно
// ════════════════════════════════════════════════════════════════

// ── Карта FK () ────────────────────────────────────
const FK_MAP = {
  'org_id':'user_group','group_id':'user_group','r_org_id':'user_group',
  'superior_org_id':'user_group','parent_org_id':'user_group','reg_org_id':'user_group',
  'doc_org_id':'user_group','src_org_id':'user_group',
  'user_id':'usr','creator':'usr','creator_id':'usr','author':'usr','author_id':'usr',
  'editor_id':'usr','owner_id':'usr','reg_user_id':'usr','executor_id':'usr',
  'resolution_author_id':'usr','doc_reg_user_id':'usr','performer_id':'usr',
  'signer_id':'usr','approver_id':'usr','sender_id':'usr','receiver_id':'usr',
  'responsible_id':'usr','manager_id':'usr','inspector_id':'usr','deputy_id':'usr',
  'parent_id':'user_group',
  'document_id':'document','doc_id':'document',
  'resolution_id':'resolution',
  'folder_id':'org_folder','parent_folder_id':'org_folder','org_folder_id':'org_folder',
  'user_folder_id':'user_folder','mont_folder_id':'mont_folder',
  'medo_org_id':'medo_org',
  'r_list_id':'r_list','nomenclature_id':'nomenclature','schedule_task_id':'schedule_task',
  'event_id':'event','news_id':'news','tag_id':'tag','survey_id':'survey','course_id':'course',
  'klp_id':'klp','og_appeal_id':'og_appeal','resolution_to_id':'resolution_to',
  'document_a_id':'document_a','document_f_id':'document_f','document_n_id':'document_n',
  'csdr_route_id':'csdr_route','csdr_list_id':'csdr_list_history',
  'nomenclature_rule_id':'nomenclature_rule',
};
const FK_SUFFIX = [
  [/^(.+_)?org_id$/,'user_group'],[/^(.+_)?group_id$/,'user_group'],
  [/_user_id$/,'usr'],[/_author_id$/,'usr'],[/_executor_id$/,'usr'],
  [/_creator_id$/,'usr'],[/_editor_id$/,'usr'],[/_owner_id$/,'usr'],[/_signer_id$/,'usr'],
  [/_document_id$/,'document'],[/_resolution_id$/,'resolution'],
  [/_medo_org_id$/,'medo_org'],[/_folder_id$/,'org_folder'],
];
const FK_TABLE_ALIAS = {
  'user':'usr','users':'usr','doc':'document','org':'user_group',
  'group':'user_group','medo':'medo_org','rlist':'r_list','rl':'r_list','nomencl':'nomenclature',
};

function resolveFk(col, fromTable) {
  if (fromTable && state.fkByTableCol) {
    const dbExact = state.fkByTableCol[fromTable + '.' + col];
    if (dbExact) return dbExact;
  }
  if (state.fkByCol?.[col]) {
    const targets = [...state.fkByCol[col]];
    if (targets.length === 1) return targets[0];
  }
  // Статические эвристики (FK_MAP/FK_SUFFIX/TABLE_WHITELIST) зашиты под
  // конкретные имена таблиц СЭД — на CHED/CHED2 это другая база с другой
  // структурой, поэтому там полагаемся ТОЛЬКО на реально обнаруженные
  // связи выше (через information_schema текущей БД), а не гадаем.
  if (state.currentDb && state.currentDb !== 'sed' && state.currentDb !== 'local') {
    return null;
  }
  if (FK_MAP[col]) return FK_MAP[col];
  for (const [re, tbl] of FK_SUFFIX) { if (re.test(col)) return tbl; }
  if (col.endsWith('_id')) {
    const base = col.slice(0, -3);
    if (TABLE_WHITELIST.includes(base)) return base;
    if (FK_TABLE_ALIAS[base]) return FK_TABLE_ALIAS[base];
    const parts = base.split('_');
    for (let i = parts.length - 1; i >= 1; i--) {
      const seg = parts.slice(i).join('_');
      if (TABLE_WHITELIST.includes(seg)) return seg;
      if (FK_TABLE_ALIAS[seg]) return FK_TABLE_ALIAS[seg];
    }
  }
  return null;
}

// ── Загрузка FK из БД ─────────────────────────────────────────
async function loadFkRelations() {
  try {
    const sql = `
      SELECT
        src.relname   AS from_table,
        a_src.attname AS from_col,
        tgt.relname   AS to_table,
        a_tgt.attname AS to_col
      FROM pg_constraint c
      JOIN pg_class src    ON src.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid  = src.relnamespace
      JOIN pg_class tgt    ON tgt.oid = c.confrelid
      JOIN LATERAL UNNEST(c.conkey, c.confkey) AS cols(src_attnum, tgt_attnum) ON true
      JOIN pg_attribute a_src ON a_src.attrelid = c.conrelid  AND a_src.attnum = cols.src_attnum
      JOIN pg_attribute a_tgt ON a_tgt.attrelid = c.confrelid AND a_tgt.attnum = cols.tgt_attnum
      WHERE c.contype = 'f' AND ns.nspname = 'public'
      ORDER BY src.relname, a_src.attname`;
    const res = await apiCall(sql, 'preview', 50000);
    if (res.ok && res.rows.length) {
      state.fkRows = res.rows;
      state.fkByCol = {};
      state.fkByTableCol = {};
      for (const r of res.rows) {
        state.fkByTableCol[r.from_table + '.' + r.from_col] = r.to_table;
        if (!state.fkByCol[r.from_col]) state.fkByCol[r.from_col] = new Set();
        state.fkByCol[r.from_col].add(r.to_table);
      }
      const fkBadge = document.getElementById('fkBadge');
      if (fkBadge) {
        fkBadge.innerHTML = `FK: ${res.rows.length} связей`;
        fkBadge.style.display = '';
        fkBadge.style.visibility = '';
        fkBadge.style.opacity = '1';
      }
    }
  } catch (e) { console.warn('FK load failed:', e.message); }
}

// ── История навигации ─────────────────────────────────────────
let navHistory = [];

function pushNav() {
  const activeTab = document.getElementById('panel-templates').classList.contains('active')
    ? 'templates' : 'tables';
  navHistory.push({
    table: state.currentTable, selectedTmpl: state.selectedTmpl, activeTab,
    columns: [...state.columns], allRows: [...state.allRows], filteredRows: [...state.filteredRows],
    page: state.page, sortCol: state.sortCol, sortAsc: state.sortAsc, dateColumn: state.dateColumn,
    sql: document.getElementById('sqlEditor').value,
    filterId: document.getElementById('filterId').value,
    filterDateFrom: document.getElementById('filterDateFrom').value,
    filterDateTo: document.getElementById('filterDateTo').value,
    filterText: document.getElementById('filterText').value,
    paramPanelOpen: document.getElementById('paramPanel').style.display !== 'none',
    tmplTitle: document.getElementById('currentTable').textContent,
  });
  document.getElementById('btnBack').style.display = '';
}

async function goBack() {
  if (!navHistory.length) return;
  const prev = navHistory.pop();
  if (!navHistory.length) document.getElementById('btnBack').style.display = 'none';

  comboCloseAll();
  document.getElementById('filterText').value = prev.filterText || '';

  if (prev.selectedTmpl >= 0) {
    state.selectedTmpl = prev.selectedTmpl; state.currentTable = prev.table;
    state.columns = prev.columns || []; state.allRows = prev.allRows || [];
    state.filteredRows = prev.filteredRows || []; state.page = prev.page || 1;
    state.sortCol = prev.sortCol || null; state.sortAsc = prev.sortAsc !== undefined ? prev.sortAsc : true;
    state.dateColumn = prev.dateColumn || null;

    document.querySelectorAll('.tmpl-card').forEach(el => el.classList.remove('active-tmpl'));
    document.getElementById('tmplcard_' + prev.selectedTmpl)?.classList.add('active-tmpl');
    document.getElementById('currentTable').textContent = prev.tmplTitle || TEMPLATES[prev.selectedTmpl]?.title || '';

    if (prev.paramPanelOpen) {
      const t    = TEMPLATES[prev.selectedTmpl];
      const vals = state.tmplParams[prev.selectedTmpl] || {};
      renderParamFields(t, vals);
      document.getElementById('paramTemplateName').textContent = '— ' + t.title;
      document.getElementById('paramPanel').style.display      = '';
      document.getElementById('paramErrors').style.display     = 'none';
      document.getElementById('toolbarFilters').classList.add('hidden');
    } else {
      document.getElementById('paramPanel').style.display = 'none';
      document.getElementById('toolbarFilters').classList.add('hidden');
    }
    if (prev.sql) { document.getElementById('sqlEditor').value = prev.sql; toggleSqlBar(true); autoResizeSQL(); }
    updateDateUI(prev.dateColumn || null);
    switchTab('templates');
    applyClientFilter(); renderTable();
    const ss = document.getElementById('statusbarSearch');
    if (ss) ss.style.display = state.columns.length ? '' : 'none';
    return;
  }

  if (!prev.table) return;
  state.currentTable = prev.table; state.columns = prev.columns || [];
  state.allRows = prev.allRows || []; state.filteredRows = prev.filteredRows || [];
  state.page = prev.page || 1; state.sortCol = prev.sortCol || null;
  state.sortAsc = prev.sortAsc !== undefined ? prev.sortAsc : true;
  state.dateColumn = prev.dateColumn || null; state.selectedTmpl = -1;
  _sqlManuallyEdited = false;

  document.getElementById('paramPanel').style.display = 'none';
  document.getElementById('toolbarFilters').classList.remove('hidden');
  document.querySelectorAll('.tmpl-card').forEach(el => el.classList.remove('active-tmpl'));
  document.getElementById('currentTable').textContent    = prev.table;
  document.getElementById('filterId').value              = prev.filterId || '';
  document.getElementById('filterDateFrom').value        = prev.filterDateFrom || '';
  document.getElementById('filterDateTo').value          = prev.filterDateTo || '';

  updateDateUI(prev.dateColumn || null);
  switchTab('tables'); renderTableList('');
  if (prev.sql) { document.getElementById('sqlEditor').value = prev.sql; toggleSqlBar(false); autoResizeSQL(); }
  applyClientFilter(); renderTable();
  const ss = document.getElementById('statusbarSearch');
  if (ss) ss.style.display = state.columns.length ? '' : 'none';
}

function navigateToFK(table, id, evt) {
  if (evt) evt.stopPropagation();
  pushNav();
  const wasTemplate = state.selectedTmpl >= 0;
  if (wasTemplate) {
    document.getElementById('paramPanel').style.display = 'none';
    document.getElementById('toolbarFilters').classList.remove('hidden');
    document.querySelectorAll('.tmpl-card').forEach(el => el.classList.remove('active-tmpl'));
  }
  state.currentTable = table; state.page = 1; state.sortCol = null; state.columns = [];
  state.selectedTmpl = -1; _sqlManuallyEdited = false;
  document.getElementById('currentTable').textContent = table;
  document.getElementById('filterId').value           = id;
  document.getElementById('filterDateFrom').value     = '';
  document.getElementById('filterDateTo').value       = '';
  document.getElementById('filterText').value         = '';
  const preDate = detectDateColumn(table, null);
  state.dateColumn = preDate; updateDateUI(preDate);
  switchTab('tables'); renderTableList('');
  const sql = `SELECT * FROM "${table}" WHERE id = ${parseInt(id)}`;
  document.getElementById('sqlEditor').value = sql;
  toggleSqlBar(false); autoResizeSQL();
  execQuery(sql);
}

// ── FK Модальное окно ─────────────────────────────────────────
function openFkModal() {
  const m = document.getElementById('fkModal');
  if (!m) return;
  m.classList.add('open');
  const inp = document.getElementById('fkSearch');
  if (inp) { inp.value = ''; inp.focus(); }
  renderFkList('');
}

function closeFkModal() {
  document.getElementById('fkModal')?.classList.remove('open');
}

function renderFkList(q) {
  const tbody = document.getElementById('fkTbody');
  const badge = document.getElementById('fkCountBadge');
  if (!tbody || !badge) return;
  const rows = state.fkRows || [];
  const s    = (q || '').trim().toLowerCase();
  const filtered = !s ? rows : rows.filter(r =>
    `${r.from_table} ${r.from_col} ${r.to_table} ${r.to_col}`.toLowerCase().includes(s)
  );
  badge.textContent = filtered.length;
  tbody.innerHTML = filtered.slice(0, 5000).map(r => `
    <tr>
      <td>${escHtml(r.from_table)}</td><td>${escHtml(r.from_col)}</td>
      <td>${escHtml(r.to_table)}</td><td>${escHtml(r.to_col)}</td>
    </tr>`).join('');
}

// Закрытие FK-модала кликом на overlay
document.addEventListener('mousedown', e => {
  const modal = document.getElementById('fkModal');
  if (modal?.classList.contains('open') && e.target === modal) closeFkModal();
});