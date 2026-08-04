// ════════════════════════════════════════════════════════════════
//  db_columns.js — видимость колонок (Показать / Скрыть)
// ════════════════════════════════════════════════════════════════

let _colDropOpen = false;

function toggleColumnsDropdown() {
  const drop = document.getElementById('columnsDropdown');
  if (!drop) return;
  _colDropOpen = !_colDropOpen;
  drop.classList.toggle('open', _colDropOpen);
  if (_colDropOpen) renderColumnsDropdown();
}

function closeColumnsDropdown() {
  document.getElementById('columnsDropdown')?.classList.remove('open');
  _colDropOpen = false;
}

function renderColumnsDropdown() {
  const drop = document.getElementById('columnsDropdown');
  if (!drop) return;

  if (!state.columns.length) {
    drop.innerHTML = '<div class="col-drop-empty">Нет данных</div>';
    return;
  }

  const hidden = state.hiddenColumns;
  const allHidden = state.columns.every(c => hidden.has(c));

  drop.innerHTML = `
    <div class="col-drop-header">
      <span>Колонки (${state.columns.length - hidden.size} / ${state.columns.length})</span>
      <div class="col-drop-btns">
        <button class="col-drop-btn" id="colBtnAll">Все</button>
        <button class="col-drop-btn" id="colBtnNone">Скрыть все</button>
      </div>
    </div>
    <div class="col-drop-list" id="colDropList">
      ${state.columns.map(c => `
        <label class="col-drop-item">
          <input type="checkbox" class="col-chk" data-col="${escHtml(c)}" ${hidden.has(c) ? '' : 'checked'}>
          <span class="col-drop-name" title="${escHtml(c)}">${escHtml(c)}</span>
        </label>
      `).join('')}
    </div>`;

  // Показать все
  drop.querySelector('#colBtnAll').addEventListener('click', () => {
    state.hiddenColumns = new Set();
    renderColumnsDropdown();
    renderTable();
  });

  // Скрыть все
  drop.querySelector('#colBtnNone').addEventListener('click', () => {
    state.hiddenColumns = new Set(state.columns);
    renderColumnsDropdown();
    renderTable();
  });

  // Чекбоксы
  drop.querySelectorAll('.col-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      const col = chk.dataset.col;
      if (chk.checked) state.hiddenColumns.delete(col);
      else             state.hiddenColumns.add(col);
      const header = drop.querySelector('.col-drop-header span');
      if (header) header.textContent = `Колонки (${state.columns.length - state.hiddenColumns.size} / ${state.columns.length})`;
      renderTable();
    });
  });
}

// Закрытие кликом вне
document.addEventListener('mousedown', e => {
  if (_colDropOpen && !e.target.closest('#columnsDropdownWrap')) {
    closeColumnsDropdown();
  }
});
