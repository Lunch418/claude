// ════════════════════════════════════════════════════════════════
//  db_export.js — экспорт в CSV и Excel
//    Загруженные строки — из state.filteredRows (с учётом поиска)
//    Все данные из БД   — новый запрос без лимита
// ════════════════════════════════════════════════════════════════

let _exportFmt = 'csv';

function _safeText(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function _csvEsc(v) {
  const s = _safeText(v);
  return (s.includes(';') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}
function _xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _blob2dl(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function _ts() {
  return new Date().toISOString().slice(0,16).replace(/[T:]/g,'-');
}

// ── Открыть модал — всегда показываем оба варианта ───────────
function openExport(fmt) {
  if (!state.columns.length) { alert('Нет данных для экспорта'); return; }
  _exportFmt = fmt;

  // Описание загруженных строк с учётом фильтра
  const totalLoaded  = state.allRows.length;
  const totalFiltered = state.filteredRows.length;
  const hasFilter    = document.getElementById('filterText')?.value?.trim();
  const descEl       = document.getElementById('exportCurrentDesc');

  if (descEl) {
    if (hasFilter && totalFiltered !== totalLoaded) {
      descEl.textContent = `${totalFiltered} строк (отфильтровано из ${totalLoaded} загруженных)`;
    } else {
      descEl.textContent = `${totalLoaded} строк`;
    }
  }

  // По умолчанию — загруженные строки
  const optCurrent = document.getElementById('exportOptCurrent');
  if (optCurrent) optCurrent.checked = true;

  // Кнопка подтверждения
  const btn = document.getElementById('exportConfirmBtn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = fmt === 'csv' ? 'Скачать CSV' : 'Скачать Excel';
  }

  document.getElementById('exportAllProgress').style.display = 'none';
  document.getElementById('exportModal').classList.add('open');
}

function exportCSV()   { openExport('csv');   }
function exportExcel() { openExport('excel'); }

function closeModal() {
  document.getElementById('exportModal').classList.remove('open');
}

// ── Выполнить экспорт по выбранному варианту ─────────────────
async function doExport() {
  const scope = document.querySelector('input[name="exportScope"]:checked')?.value || 'current';
  if (scope === 'all') {
    await _exportAllFromDB(_exportFmt);
  } else {
    closeModal();
    _exportFmt === 'csv' ? _downloadCSV() : _downloadExcel();
  }
}

// ── Экспорт загруженных строк (из памяти) ────────────────────
function _downloadCSV() {
  const visIdx = state.columns.map((_,i)=>i).filter(i=>!state.hiddenColumns.has(state.columns[i]));
  const cols   = visIdx.map(i => state.columns[i]);
  const lines  = [cols.map(c => _csvEsc(c)).join(';')];
  for (const row of state.filteredRows)
    lines.push(cols.map(c => _csvEsc(row[c])).join(';'));
  _blob2dl(
    new Blob(['\uFEFF' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' }),
    `${state.currentTable || 'export'}_${_ts()}.csv`
  );
}

function _downloadExcel() {
  const visIdx = state.columns.map((_,i)=>i).filter(i=>!state.hiddenColumns.has(state.columns[i]));
  const cols   = visIdx.map(i => state.columns[i]);
  let h = `<html xmlns:o="urn:schemas-microsoft-com:office:office" `
        + `xmlns:x="urn:schemas-microsoft-com:office:excel" `
        + `xmlns="http://www.w3.org/TR/REC-html40">`
        + `<head><meta charset="UTF-8"><style>td{mso-number-format:"@"}</style></head>`
        + `<body><table>`
        + `<thead><tr>${cols.map(c=>`<th>${_xmlEsc(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>`;
  for (const row of state.filteredRows)
    h += `<tr>${cols.map(c=>`<td>${_xmlEsc(_safeText(row[c]))}</td>`).join('')}</tr>`;
  h += `</tbody></table></body></html>`;
  _blob2dl(
    new Blob([h], { type:'application/vnd.ms-excel;charset=utf-8' }),
    `${state.currentTable || 'export'}_${_ts()}.xls`
  );
}

// ── Экспортировать все данные из БД ───────────────
async function _exportAllFromDB(fmt) {
  const sql = state.lastSql;
  if (!sql) { alert('Нет SQL-запроса для экспорта'); return; }

  const progress   = document.getElementById('exportAllProgress');
  const confirmBtn = document.getElementById('exportConfirmBtn');

  progress.style.display = 'block';
  progress.textContent   = 'Запрос отправлен...';
  if (confirmBtn) confirmBtn.disabled = true;

  const t0 = Date.now();

  try {
    const submitResp = await fetch(`${API}?m=Remote&a=submit`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      credentials: 'same-origin',
      body: JSON.stringify({ sql, limit: 0, offset: 0, mode: 'export' }),
    });
    if (submitResp.status === 401) { window._handleUnauthorized?.(); return; }

    const sd = await submitResp.json();
    if (!sd.ok) { progress.textContent = '' + (sd.error || 'Ошибка'); if (confirmBtn) confirmBtn.disabled = false; return; }

    const jobId = sd.jobId;
    let pollCount = 0;

    while (true) {
      const delay = pollCount < 7 ? 800 : pollCount < 15 ? 1500 : 3000;
      await new Promise(r => setTimeout(r, delay));
      pollCount++;

      const sec = Math.floor((Date.now() - t0) / 1000);
      const mm  = String(Math.floor(sec/60)).padStart(2,'0');
      const ss2 = String(sec%60).padStart(2,'0');
      progress.textContent = `Выполняется ${mm}:${ss2}...`;

      const pr = await fetch(`${API}?m=Remote&a=poll&jobId=${jobId}`, { credentials:'same-origin' });
      const pd = await pr.json();

      if (pd.status === 'done' || (!pd.ok && pd.status === 'error')) {
        if (!pd.ok) {
          progress.textContent = '✗ ' + (pd.error || 'Ошибка');
          if (confirmBtn) confirmBtn.disabled = false;
          return;
        }

        const elapsed = ((Date.now()-t0)/1000).toFixed(1);
        progress.textContent = ` ${pd.count} строк · ${elapsed}s`;

        const name = `${state.currentTable || 'export_all'}_${_ts()}`;

        if (pd.csv) {
          _blob2dl(
            new Blob(['\uFEFF' + pd.csv], { type:'text/csv;charset=utf-8' }),
            name + '.csv'
          );
        } else if (pd.rows) {
          const cols  = pd.columns || [];
          const lines = [cols.map(c=>_csvEsc(c)).join(';')];
          for (const row of pd.rows) lines.push(cols.map(c=>_csvEsc(row[c])).join(';'));
          _blob2dl(
            new Blob(['\uFEFF' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' }),
            name + '.csv'
          );
        }

        showToast(`Экспортировано ${pd.count} строк за ${elapsed}s`);
        setTimeout(closeModal, 2000);
        return;
      }
    }

  } catch (e) {
    progress.textContent = '✗ ' + e.message;
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

// Закрытие по клику на overlay
document.addEventListener('mousedown', e => {
  const m = document.getElementById('exportModal');
  if (m?.classList.contains('open') && e.target === m) closeModal();
});
