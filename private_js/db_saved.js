// ── Склонение числительных ────────────────────────────────────
function plural(n, one, few, many) {
  const mod10  = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
// plural(1, 'шаблон', 'шаблона', 'шаблонов')
// plural(2, 'шаблон', 'шаблона', 'шаблонов')
// plural(11,'шаблон', 'шаблона', 'шаблонов')

// ════════════════════════════════════════════════════════════════
//  db_saved.js — сохранённые запросы
// ════════════════════════════════════════════════════════════════

const SAVED_KEY = 'sed_saved_queries';

function getSavedQueries() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); }
  catch(_) { return []; }
}
function _setSavedLocal(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch(_) {}
}

// ── Сохранить запрос ─────────────────────────────────────────
function saveQuery(name, sql) {
  const list = getSavedQueries();
  const id   = Date.now();
  list.unshift({ id, name: name.trim(), sql, savedAt: new Date().toLocaleString('ru') });
  _setSavedLocal(list);
  // Синхронизируем с сервером
  if (typeof prefsSaveSaved === 'function') prefsSaveSaved();
  renderSavedList();
  return id;
}

function deleteSavedQuery(id) {
  const list = getSavedQueries().filter(q => q.id !== id);
  _setSavedLocal(list);
  if (typeof prefsSaveSaved === 'function') prefsSaveSaved();
  renderSavedList();
}

function loadSavedQuery(sql) {
  document.getElementById('sqlEditor').value = sql;
  _sqlManuallyEdited = true;
  autoResizeSQL();
  toggleSqlBar(false);
  switchTab('tables');
  setStatus('ok', 'Запрос загружен — нажмите Выполнить или Ctrl+Enter');
}

// ── Рендер списка ─────────────────────────────────────────────
function renderSavedList(filter = '') {
  const container = document.getElementById('savedList');
  if (!container) return;

  const list  = getSavedQueries();
  const q     = filter.trim().toLowerCase();
  const items = q
    ? list.filter(s => s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q))
    : list;

  // Счётчик
  const countEl = document.getElementById('savedCount');
  if (countEl) {
    countEl.textContent = q
      ? `${items.length} из ${list.length} ${plural(list.length,"запроса","запросов","запросов")}`
      : `${list.length} ${plural(list.length,"запрос","запроса","запросов")}`;
  }

  if (!items.length) {
    container.innerHTML = `<div class="placeholder" style="height:120px;font-size:12.5px;flex-direction:column;gap:6px">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--c-border)">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
      </svg>
      <span>${q ? 'Не найдено' : 'Нет сохранённых запросов'}</span>
      ${!q ? '<span style="font-size:11px;color:var(--c-text-3)">Нажмите «Сохранить» в SQL-редакторе</span>' : ''}
    </div>`;
    return;
  }

  container.innerHTML = items.map(s => {
    const preview = (s.sql || '').replace(/\s+/g, ' ').trim().slice(0, 72);
    return `<div class="tmpl-card saved-card" data-saved-id="${s.id}" title="Нажмите чтобы редактировать">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
        <div class="tmpl-title" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${escHtml(s.name)}
        </div>
        <div style="display:flex;gap:3px;flex-shrink:0">
          <button class="saved-btn-load" data-id="${s.id}"
            style="background:none;border:none;cursor:pointer;color:var(--c-accent);font-size:12px;padding:0 3px"
            title="Загрузить в редактор">▶</button>
          <button class="saved-btn-del" data-id="${s.id}"
            style="background:none;border:none;cursor:pointer;color:var(--c-text-3);font-size:12px;padding:0 3px"
            title="Удалить">✕</button>
        </div>
      </div>
      <div class="tmpl-desc" style="font-family:var(--font-mono);font-size:10.5px;margin-top:3px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        ${escHtml(preview)}${(s.sql||'').length > 72 ? '…' : ''}
      </div>
      <div class="tmpl-desc" style="margin-top:2px">${escHtml(s.savedAt || '')}</div>
    </div>`;
  }).join('');

  // Клик на карточку = открыть редактирование
  container.querySelectorAll('.saved-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const item = list.find(s => s.id === parseInt(card.dataset.savedId));
      if (item) openEditSavedModal(item);
    });
  });

  container.querySelectorAll('.saved-btn-load').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = list.find(s => s.id === parseInt(btn.dataset.id));
      if (item) loadSavedQuery(item.sql);
    });
  });
  container.querySelectorAll('.saved-btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Удалить сохранённый запрос?')) deleteSavedQuery(parseInt(btn.dataset.id));
    });
  });
}

// ── Модал «Сохранить запрос» ─────────────────────────────────
function openSaveQueryModal() {
  const sql = document.getElementById('sqlEditor').value.trim();
  if (!sql) { alert('SQL-редактор пуст — нечего сохранять'); return; }

  const modal   = document.getElementById('saveQueryModal');
  const inp     = document.getElementById('saveQueryName');
  const preview = document.getElementById('saveQueryPreview');
  if (!modal) return;

  if (inp) inp.value = '';
  if (preview) preview.textContent = sql.length > 200 ? sql.slice(0, 200) + '...' : sql;

  modal.classList.add('open');
  setTimeout(() => inp?.focus(), 60);
}

function closeSaveQueryModal() {
  document.getElementById('saveQueryModal')?.classList.remove('open');
}

function confirmSaveQuery() {
  const nameEl = document.getElementById('saveQueryName');
  const name   = (nameEl?.value || '').trim();
  if (!name) { nameEl?.focus(); return; }
  const sql = document.getElementById('sqlEditor').value.trim();
  if (!sql) return;
  saveQuery(name, sql);
  closeSaveQueryModal();
  showToast('Запрос сохранён');
  // Переходим на вкладку «Запросы» чтобы увидеть результат
  switchTab('saved');
}

// Клавиатура в модале
document.addEventListener('keydown', e => {
  const modal = document.getElementById('saveQueryModal');
  if (!modal?.classList.contains('open')) return;
  if (e.key === 'Enter')  { e.preventDefault(); confirmSaveQuery(); }
  if (e.key === 'Escape') { e.preventDefault(); closeSaveQueryModal(); }
});

document.addEventListener('mousedown', e => {
  const modal = document.getElementById('saveQueryModal');
  if (modal?.classList.contains('open') && e.target === modal) closeSaveQueryModal();
});

// ── Модал редактирования сохранённого запроса ─────────────────
function openEditSavedModal(item) {
  document.getElementById('editSavedId').value   = item.id;
  document.getElementById('editSavedName').value = item.name;
  document.getElementById('editSavedSql').value  = item.sql;
  document.getElementById('editSavedModal').classList.add('open');
  setTimeout(() => document.getElementById('editSavedName')?.focus(), 60);
}

function closeEditSavedModal() {
  document.getElementById('editSavedModal')?.classList.remove('open');
}

function confirmEditSaved() {
  const id   = parseInt(document.getElementById('editSavedId').value);
  const name = document.getElementById('editSavedName').value.trim();
  const sql  = document.getElementById('editSavedSql').value.trim();

  if (!name) { document.getElementById('editSavedName')?.focus(); return; }
  if (!sql)  { document.getElementById('editSavedSql')?.focus();  return; }

  const list = getSavedQueries().map(s =>
    s.id === id
      ? { ...s, name, sql, savedAt: new Date().toLocaleString('ru') }
      : s
  );
  _setSavedLocal(list);
  if (typeof prefsSaveSaved === 'function') prefsSaveSaved();
  closeEditSavedModal();
  renderSavedList();
  showToast('Запрос обновлён');
}

// Клавиатура в модале редактирования
document.addEventListener('keydown', e => {
  const modal = document.getElementById('editSavedModal');
  if (!modal?.classList.contains('open')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeEditSavedModal(); }
  // Ctrl+Enter — сохранить
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); confirmEditSaved(); }
});

document.addEventListener('mousedown', e => {
  const modal = document.getElementById('editSavedModal');
  if (modal?.classList.contains('open') && e.target === modal) closeEditSavedModal();
});
