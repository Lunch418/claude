// ════════════════════════════════════════════════════════════════
//  db_filter.js — фильтр строк
// ════════════════════════════════════════════════════════════════

const ALL_FILTER_LIMIT = 999999;

function _isAllFilter() {
  return parseInt(document.getElementById('limitSelect')?.value || '0') >= ALL_FILTER_LIMIT;
}

// ── Клиентский поиск ──────────────────────────────────────────
function applyClientFilter() {
  const text = (document.getElementById('filterText')?.value || '').toLowerCase().trim();
  state.filteredRows = text
    ? state.allRows.filter(row =>
        Object.values(row).some(v => v !== null && v !== '' && String(v).toLowerCase().includes(text))
      )
    : [...state.allRows];
}

// ── Серверный поиск ───────────────────────────────────────────
let _searchTimer  = null;
let _lastSearchQ  = '';

async function _serverSearch(q) {
  if (!state.lastSql || !state.columns.length) return;

  if (!q) {
    // Пустая строка — сбрасываем к оригинальному запросу
    state.filteredRows = [...state.allRows];
    state.page = 1;
    renderTable();
    setStatus('ok', `${state.allRows.length} строк`);
    return;
  }

  // Строим ILIKE по всем колонкам
  const conditions = state.columns
    .map(c => `${_pgQuoteIdent(c)}::TEXT ILIKE '%' || ${_pgEscapeLiteral(q)} || '%'`)
    .join(' OR ');

  const searchSql = `SELECT * FROM (${state.lastSql}) __search__ WHERE (${conditions}) LIMIT 500`;

  setStatus('loading', `Поиск по БД: "${q}"...`);

  try {
    const res = await apiCall(searchSql, 'preview', 0);
    if (!res || !res.ok) {
      setStatus('err', res?.error || 'Ошибка поиска');
      return;
    }

    state.filteredRows = res.rows || [];
    state.page = 1;
    renderTable();

    const hint = res.rows?.length >= CHUNK_SIZE ? ` · показаны первые ${CHUNK_SIZE}` : '';
    setStatus('ok', `Найдено: ${res.count} строк${hint}`);

  } catch (e) {
    setStatus('err', 'Ошибка поиска: ' + e.message);
  }
}

// ── Цитирование для PostgreSQL ────────────────────────────────
function _pgQuoteIdent(name) {
  // Оборачиваем имя колонки в двойные кавычки
  return '"' + name.replace(/"/g, '""') + '"';
}

function _pgEscapeLiteral(str) {
  return "'" + String(str).replace(/'/g, "''") + "'";
}

// ── Обработчик поля поиска ────────────────────────────────────
function initFilterInput() {
  const input = document.getElementById('filterText');
  if (!input) return;

  input.addEventListener('input', () => {
    const q = input.value.trim();

    if (_isAllFilter() && state.lastSql && state.columns.length) {
      clearTimeout(_searchTimer);

      input.placeholder = 'Поиск по всей БД...';

      if (q === _lastSearchQ) return;
      _lastSearchQ = q;

      _searchTimer = setTimeout(() => _serverSearch(q), 500);

    } else {

      input.placeholder = 'Поиск по строкам...';
      applyClientFilter();
      state.page = 1;
      renderTable();
    }
  });

  // При смене режима лимита — сбрасываем поиск
  document.getElementById('limitSelect')?.addEventListener('change', () => {
    input.value = '';
    _lastSearchQ = '';
    clearTimeout(_searchTimer);
    input.placeholder = _isAllFilter() ? 'Поиск по всей БД...' : 'Поиск по строкам...';
  });
}
