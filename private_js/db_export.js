// ════════════════════════════════════════════════════════════════
//  db_export.js — экспорт в CSV и Excel
//    Загруженные строки — из state.filteredRows (с учётом поиска)
//    Все данные из БД   — новый запрос без лимита
// ════════════════════════════════════════════════════════════════

let _exportFmt = 'csv';

// ── Настройки экспорта (из db_settings.js, с безопасным дефолтом) ──
function _expSettings() {
  const s = window.sedExportSettings || {};
  return {
    delim:   s.delimiter === 'comma' ? ',' : ';',
    headers: s.headers !== false,
    enc:     s.encoding === 'win1251' ? 'win1251' : 'utf8',
  };
}

// ── Кодировщик Windows-1251 (для старого русского Excel) ───────
// Браузеры умеют кодировать только UTF-8 нативно, поэтому таблицу
// соответствий строим сами: ASCII как есть, кириллица А-я/Ё/ё —
// в диапазон 0xC0-0xFF по стандарту cp1251, остальное — «?».
const _CP1251_MAP = (() => {
  const m = {};
  for (let i = 0; i < 128; i++) m[i] = i;
  m[0x0401] = 0xA8; m[0x0451] = 0xB8; // Ё ё
  for (let i = 0; i < 32; i++) { m[0x0410 + i] = 0xC0 + i; m[0x0430 + i] = 0xE0 + i; } // А-Я, а-я
  Object.assign(m, {
    0x00A0:0xA0, 0x00A9:0xA9, 0x00AE:0xAE, 0x00AB:0xAB, 0x00BB:0xBB,
    0x2013:0x96, 0x2014:0x97, 0x2018:0x91, 0x2019:0x92, 0x201C:0x93, 0x201D:0x94, 0x2026:0x85,
  });
  return m;
})();
function _encodeCp1251(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i);
    bytes[i] = (cp in _CP1251_MAP) ? _CP1251_MAP[cp] : 0x3F; // '?' для неизвестных символов
  }
  return bytes;
}
// Собрать Blob из готовых строк CSV с учётом выбранной кодировки
function _csvBlobFromLines(lines) {
  const { enc } = _expSettings();
  const text = lines.join('\r\n');
  return enc === 'win1251'
    ? new Blob([_encodeCp1251(text)], { type: 'text/csv;charset=windows-1251' })
    : new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' }); // BOM — чтобы Excel сразу видел UTF-8
}

function _safeText(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function _csvEsc(v, delim) {
  let s = _safeText(v);
  // Длинные числа (bigint id, 16+ цифр): при открытии CSV Excel сам
  // определяет ячейку как число и переводит в экспоненциальную запись
  // с потерей точности. Оборачиваем в текстовую формулу — Excel
  // показывает значение как есть. (В HTML-варианте «Excel» этого не
  // нужно — там текстовый формат уже форсирован через mso-number-format.)
  if (/^\d{16,}$/.test(s)) s = '="' + s + '"';
  return (s.includes(delim) || s.includes('"') || s.includes('\n'))
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
  const { delim, headers } = _expSettings();
  const visIdx = state.columns.map((_,i)=>i).filter(i=>!state.hiddenColumns.has(state.columns[i]));
  const cols   = visIdx.map(i => state.columns[i]);
  const lines  = [];
  if (headers) lines.push(cols.map(c => _csvEsc(c, delim)).join(delim));
  for (const row of state.filteredRows)
    lines.push(cols.map(c => _csvEsc(row[c], delim)).join(delim));
  _blob2dl(_csvBlobFromLines(lines), `${state.currentTable || 'export'}_${_ts()}.csv`);
}

function _downloadExcel() {
  const { headers } = _expSettings();
  const visIdx = state.columns.map((_,i)=>i).filter(i=>!state.hiddenColumns.has(state.columns[i]));
  const cols   = visIdx.map(i => state.columns[i]);
  let h = `<html xmlns:o="urn:schemas-microsoft-com:office:office" `
        + `xmlns:x="urn:schemas-microsoft-com:office:excel" `
        + `xmlns="http://www.w3.org/TR/REC-html40">`
        + `<head><meta charset="UTF-8"><style>td{mso-number-format:"@"}</style></head>`
        + `<body><table>`
        + (headers ? `<thead><tr>${cols.map(c=>`<th>${_xmlEsc(c)}</th>`).join('')}</tr></thead>` : '')
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
          // Готовая CSV-строка от сервера — разделитель/заголовки уже внутри,
          // но кодировку применяем всегда (это безопасно поверх готового текста)
          _blob2dl(_csvBlobFromLines([pd.csv.replace(/\r\n$/, '')]), name + '.csv');
        } else if (pd.rows) {
          const { delim, headers } = _expSettings();
          const cols  = pd.columns || [];
          const lines = [];
          if (headers) lines.push(cols.map(c=>_csvEsc(c, delim)).join(delim));
          for (const row of pd.rows) lines.push(cols.map(c=>_csvEsc(row[c], delim)).join(delim));
          _blob2dl(_csvBlobFromLines(lines), name + '.csv');
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
