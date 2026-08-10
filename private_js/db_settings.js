// ════════════════════════════════════════════════════════════════
//  db_settings.js — личные настройки внешнего вида.
//  Тема, плотность таблицы, размер шрифта данных, моноширинный
//  шрифт, отключение анимаций. Применяется на лету, хранится в
//  sed_user_prefs (+ localStorage для мгновенного применения).
// ════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const KEY = 'sed_view_settings';
  const DEFAULTS = {
    // Внешний вид
    theme:    'light',   // light | dark
    accent:   'classic', // classic | blue | sky | violet | pink | green | orange | teal | red
    density:  'normal',  // compact | normal | comfortable
    dataFont: 13,        // px, 11–16
    dataFontFamily: 'mono', // см. FONT_STACKS
    anim:     true,      // анимации интерфейса
    // Таблица и данные
    freezeHeader: true,  // закрепить шапку при прокрутке
    freezeCol:    false, // закрепить первый столбец
    dateFormat:   'default', // default | date_only | ru | ru_time
    // SQL-редактор
    sqlFont:        13,    // px, 12–18
    sqlAutocomplete: true, // подсказки автодополнения
    noSql:          false, // режим «без SQL» — скрыть SQL-раздел
    // Экспорт
    exportDelimiter: 'semicolon', // semicolon | comma
    exportEncoding:  'utf8',      // utf8 | win1251
    exportHeaders:   true,        // включать строку заголовков
    // Своя палитра — точечная покраска отдельных элементов
    paintMap: {}, // { selector: {c:'#hex', mode:'bg'|'text'} } — живая покраска элементов
  };

  // Акцентные цвета. bg/bd — полупрозрачные, чтобы работать в обеих темах.
  const ACCENTS = {
    classic:{ name: 'Классический', c: '#3d5fa0', h: '#2f4d8a', bg: 'rgba(61,95,160,.10)',   bd: 'rgba(61,95,160,.30)' },
    blue:   { name: 'Синий',      c: '#3b6fd4', h: '#2f5cb8', bg: 'rgba(59,111,212,.12)',  bd: 'rgba(59,111,212,.32)' },
    sky:    { name: 'Голубой',    c: '#0d9bd8', h: '#0a83b8', bg: 'rgba(13,155,216,.13)',  bd: 'rgba(13,155,216,.32)' },
    violet: { name: 'Фиолетовый', c: '#7c5cdb', h: '#674ac0', bg: 'rgba(124,92,219,.13)',  bd: 'rgba(124,92,219,.32)' },
    pink:   { name: 'Розовый',    c: '#db5c93', h: '#c04a7d', bg: 'rgba(219,92,147,.13)',  bd: 'rgba(219,92,147,.32)' },
    green:  { name: 'Зелёный',    c: '#2ba05c', h: '#22864c', bg: 'rgba(43,160,92,.13)',   bd: 'rgba(43,160,92,.32)' },
    teal:   { name: 'Бирюзовый',  c: '#12a594', h: '#0e8a7c', bg: 'rgba(18,165,148,.13)',  bd: 'rgba(18,165,148,.32)' },
    orange: { name: 'Оранжевый',  c: '#e08a2b', h: '#c47522', bg: 'rgba(224,138,43,.13)',  bd: 'rgba(224,138,43,.32)' },
    red:    { name: 'Красный',    c: '#dc4b57', h: '#c03946', bg: 'rgba(220,75,87,.13)',   bd: 'rgba(220,75,87,.32)' },
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
    } catch (_) { return Object.assign({}, DEFAULTS); }
  }

  function persist(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {}
    if (typeof prefsSave === 'function') prefsSave('view_settings', s);
  }

  // ── Применение настроек к документу ────────────────────────────
  const FONT_STACKS = {
    mono:    "var(--font-mono)",
    system:  "var(--font)",
    sans:    "'Segoe UI', 'DejaVu Sans', Arial, sans-serif",
    serif:   "Georgia, 'DejaVu Serif', 'Times New Roman', serif",
    console: "Consolas, 'DejaVu Sans Mono', 'Courier New', monospace",
    tahoma:  "Tahoma, 'Liberation Sans', Verdana, sans-serif",
    verdana: "Verdana, 'Nimbus Sans', 'Liberation Sans', sans-serif",
    courier: "'Courier New', 'Liberation Mono', monospace",
  };
  const FONT_LABELS = {
    mono: 'Моноширинный', system: 'Системный', sans: 'Без засечек', serif: 'С засечками',
    console: 'Consolas', tahoma: 'Tahoma', verdana: 'Verdana', courier: 'Courier',
  };

  function apply(s) {
    const root = document.documentElement;
    root.dataset.theme   = s.theme;
    root.dataset.density = s.density;
    root.dataset.anim    = s.anim ? 'on' : 'off';
    root.dataset.freezeHead = s.freezeHeader ? 'on' : 'off';
    root.dataset.freezeCol  = s.freezeCol ? 'on' : 'off';
    root.style.setProperty('--data-fs', s.dataFont + 'px');
    root.style.setProperty('--data-ff', FONT_STACKS[s.dataFontFamily] || FONT_STACKS.mono);
    root.style.setProperty('--sql-fs', s.sqlFont + 'px');
    root.dataset.nosql = s.noSql ? 'on' : 'off';
    window.sedSqlAutocomplete = s.sqlAutocomplete !== false;
    window.sedExportSettings = { delimiter: s.exportDelimiter, encoding: s.exportEncoding, headers: s.exportHeaders };
    applyAccent(s.accent);
    applyPaintMap(s.paintMap);
  }

  // Акцентный цвет — переопределяем переменные акцента глобально
  function applyAccent(key) {
    const a = ACCENTS[key] || ACCENTS.blue;
    const root = document.documentElement;
    root.style.setProperty('--c-accent', a.c);
    root.style.setProperty('--c-accent-h', a.h);
    root.style.setProperty('--c-accent-bg', a.bg);
    root.style.setProperty('--c-accent-border', a.bd);
    root.style.setProperty('--c-blue', a.c);
    root.style.setProperty('--c-blue-h', a.h);
    root.style.setProperty('--c-blue-bg', a.bg);
    root.style.setProperty('--c-blue-border', a.bd);
  }

  // ── Хелперы форматирования (вызываются из db_query.js) ─────────
  // Форматирование даты по текущей настройке. s — ISO-строка.
  window.sedFmtDate = function (s) {
    const fmt = (_s && _s.dateFormat) || 'default';
    const str = String(s);
    // ожидаем YYYY-MM-DD[ T]HH:MM:SS
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
    if (!m) return str.substring(0, 19);
    const [, y, mo, d, hh, mi, ss] = m;
    const hasTime = hh !== undefined;
    switch (fmt) {
      case 'date_only': return `${y}-${mo}-${d}`;
      case 'ru':        return `${d}.${mo}.${y}`;
      case 'ru_time':   return hasTime ? `${d}.${mo}.${y} ${hh}:${mi}:${ss}` : `${d}.${mo}.${y}`;
      default:          return str.substring(0, 19);
    }
  };

  // ── CSS: тема, плотность, шрифт, анимации ──────────────────────
  function injectCss() {
    if (document.getElementById('viewSettingsCss')) return;
    const st = document.createElement('style');
    st.id = 'viewSettingsCss';
    st.textContent = `
      /* размер и семейство шрифта данных */
      .data-table { font-size: var(--data-fs, 12.5px); font-family: var(--data-ff, var(--font-mono)); }

      /* размер шрифта SQL-редактора (textarea + подсветка синхронно) */
      #sqlEditor, #sqlHighlight { font-size: var(--sql-fs, 13px) !important; }

      /* режим «без SQL» — прячем редактор и вкладку запросов */
      [data-nosql="on"] #sqlBar { display: none !important; }
      [data-nosql="on"] #tab-saved { display: none !important; }

      /* ── Живая покраска: режим наведения/курсор ──────────────── */
      .paint-mode-on { cursor: var(--paint-cursor, crosshair) !important; }
      .paint-mode-on .paint-bar, .paint-mode-on .paint-bar * { cursor: pointer !important; }
      .paint-hover-target { outline: 2px dashed var(--c-accent,#3b6fd4) !important; outline-offset: 2px !important;
        border-radius: 4px; }

      /* плавающая панель кисти сверху экрана */
      .paint-bar { position: fixed; bottom: 16px; top: auto; left: 50%; transform: translateX(-50%) translateY(14px);
        z-index: 10050; display: flex; align-items: center; gap: 12px;
        background: var(--c-surface,#fff); border: 1px solid var(--c-border,#e5e8ef); border-radius: 14px;
        box-shadow: var(--sh-lg,0 12px 32px rgba(0,0,0,.15)); padding: 9px 14px; opacity: 0;
        transition: opacity .25s, transform .25s cubic-bezier(.22,1,.36,1); max-width: 94vw; flex-wrap: wrap; }
      .paint-bar.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      .paint-bar-label { font-size: 12.5px; font-weight: 600; color: var(--c-text,#1c2233); white-space: nowrap; }
      .paint-bar-swatches { display: flex; gap: 6px; }
      .paint-bar .paint-sw { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer;
        padding: 0; background: var(--sw); flex: 0 0 auto; transition: transform .15s cubic-bezier(.34,1.5,.5,1); }
      .paint-bar .paint-sw:hover { transform: scale(1.18); }
      .paint-bar .paint-sw.active { transform: scale(1.18); box-shadow: 0 0 0 2px var(--c-surface,#fff), 0 0 0 4px var(--sw, var(--c-accent)); }
      .paint-sw-custom { background: conic-gradient(red,yellow,lime,cyan,blue,magenta,red); overflow: hidden; display: flex; align-items: center; justify-content: center; }
      .paint-sw-custom input { opacity: 0; width: 100%; height: 100%; cursor: pointer; border: none; padding: 0; }
      .paint-sw-eraser { background: var(--c-surface,#fff); border: 1.5px dashed var(--c-border,#cfd4de) !important;
        font-size: 11px; display: flex; align-items: center; justify-content: center; color: var(--c-text-3,#8a93a6); }
      .paint-bar-btn { border: 1px solid var(--c-border,#e5e8ef); background: var(--c-surface,#fff); border-radius: 8px;
        padding: 6px 12px; font-size: 12px; font-weight: 550; color: var(--c-text-2,#6b7488); cursor: pointer; transition: all .15s; white-space: nowrap; }
      .paint-bar-btn:hover { border-color: var(--c-red,#dc3545); color: var(--c-red,#dc3545); }
      .paint-bar-exit { background: var(--c-accent,#3b6fd4); border-color: var(--c-accent,#3b6fd4); color: #fff; }
      .paint-bar-exit:hover { background: var(--c-accent-h,#2f5cb8); color: #fff; border-color: var(--c-accent-h,#2f5cb8); }
      .paint-toast { position: fixed; bottom: 82px; left: 50%; transform: translateX(-50%) translateY(20px);
        background: var(--c-text,#1c2233); color: var(--c-surface,#fff); padding: 9px 16px; border-radius: 10px;
        font-size: 12.5px; opacity: 0; transition: all .3s; z-index: 10051; }
      .paint-toast.show { opacity: 1; transform: translateX(-50%); }

      /* плотность строк */
      [data-density="compact"] .data-table td { padding: 3px 15px; }
      [data-density="compact"] .data-table th { padding: 5px 15px; }
      [data-density="comfortable"] .data-table td { padding: 12px 15px; }
      [data-density="comfortable"] .data-table th { padding: 13px 15px; }

      /* отключение анимаций */
      [data-anim="off"] *, [data-anim="off"] *::before, [data-anim="off"] *::after {
        transition: none !important; animation: none !important;
        scroll-behavior: auto !important;
      }

      /* закрепление шапки при прокрутке (по умолчанию вкл) */
      /* sticky работает относительно .table-area (overflow:auto);
         .table-card с overflow:hidden ломает sticky — снимаем его,
         когда включено любое закрепление */
      [data-freeze-head="on"] .table-card,
      [data-freeze-col="on"] .table-card { overflow: visible; }
      [data-freeze-head="on"] .data-table thead th {
        position: sticky; top: 0; z-index: 2;
        background: #f7f8fa;
      }
      [data-theme="dark"][data-freeze-head="on"] .data-table thead th { background: #242832; }
      [data-freeze-head="off"] .data-table thead th { position: static; }

      /* закрепление первого столбца */
      [data-freeze-col="on"] .data-table td:first-child,
      [data-freeze-col="on"] .data-table th:first-child {
        position: sticky; left: 0; z-index: 1;
        background: var(--c-surface, #fff);
        box-shadow: 1px 0 0 var(--c-border, #e5e8ef);
      }
      [data-freeze-col="on"] .data-table tbody tr:nth-child(even) td:first-child { background: #fafbfd; }
      [data-freeze-col="on"] .data-table thead th:first-child { z-index: 3; background: #f7f8fa; }
      [data-theme="dark"][data-freeze-col="on"] .data-table td:first-child { background: #1c1f27; }
      [data-theme="dark"][data-freeze-col="on"] .data-table tbody tr:nth-child(even) td:first-child { background: #1f232c; }
      [data-theme="dark"][data-freeze-col="on"] .data-table thead th:first-child { background: #242832; }

      /* ═══ ТЁМНАЯ ТЕМА ═══ */
      [data-theme="dark"] {
        --c-accent:#6d9eff; --c-accent-h:#85afff;
        --c-accent-bg:#1a2438; --c-accent-border:#2e4166;
        --c-accent-soft:rgba(109,158,255,.13);
        --c-blue:var(--c-accent); --c-blue-h:var(--c-accent-h);
        --c-blue-bg:var(--c-accent-bg); --c-blue-border:var(--c-accent-border);

        --c-bg:#14161c;
        --c-surface:#1c1f27;
        --c-surface-2:#242832;
        --c-surface-3:#2c313d;
        --c-border:#333844;
        --c-border-soft:#2a2f39;

        --c-text:#eceef4; --c-text-2:#aab2c5; --c-text-3:#727a8c;

        --c-green:#4ec48a; --c-green-h:#5fd199;
        --c-green-bg:#152a20; --c-green-border:#2a5540;
        --c-red:#f07a7a; --c-red-bg:#2c1a1a; --c-red-border:#5c3232;
        --c-amber:#e0ab52; --c-amber-bg:#2a2413; --c-amber-border:#524526;

        --sh-xs:0 1px 2px rgba(0,0,0,.35);
        --sh-sm:0 1px 4px rgba(0,0,0,.4),0 1px 2px rgba(0,0,0,.35);
        --sh-md:0 4px 14px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.35);
        --sh-lg:0 14px 36px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4);
        --ring:0 0 0 3px rgba(109,158,255,.22);
        color-scheme: dark;
      }
      /* хардкод-цвета в таблице — перекрываем для тёмной темы */
      [data-theme="dark"] .data-table thead { background:#242832; }
      [data-theme="dark"] .data-table th { background:#242832; }
      [data-theme="dark"] .data-table tbody tr:nth-child(even) td { background:#1f232c; }
      [data-theme="dark"] .data-table td { border-bottom-color:#2a2f39; }
      [data-theme="dark"] .data-table tbody tr:hover td { background:var(--c-accent-bg) !important; }
      [data-theme="dark"] #sqlEditorWrap { background:#1f232c !important; }
      [data-theme="dark"] #sqlEditor { color:var(--c-text); }
      [data-theme="dark"] img.qr, [data-theme="dark"] .tfa-qr-wrap img { background:#fff; }

      /* плавный переход при смене темы */
      [data-anim="on"] body, [data-anim="on"] .data-table td, [data-anim="on"] .data-table th {
        transition: background-color .25s, color .25s, border-color .25s;
      }

      /* ── Панель настроек ── */
      #setOverlay { position: fixed; inset: 0; z-index: 10000; background: rgba(10,14,22,.5);
        backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity .3s ease; }
      #setOverlay.show { opacity: 1; }
      #setCard { width: 460px; max-width: 92vw; max-height: 86vh; overflow-y: auto;
        background: var(--c-surface,#fff); border-radius: var(--r-lg,14px); box-shadow: 0 24px 60px rgba(0,0,0,.3);
        transform: translateY(10px); opacity: 0;
        transition: transform .38s cubic-bezier(.22,1,.36,1), opacity .3s ease; }
      #setOverlay.show #setCard { transform: none; opacity: 1; }
      .set-head { padding: 20px 24px 16px; border-bottom: 1px solid var(--c-border,#e5e8ef); display: flex; align-items: center; justify-content: space-between; }
      .set-title { font-size: 17px; font-weight: 650; color: var(--c-text,#1c2233); margin: 0; }
      .set-sub { font-size: 12px; color: var(--c-text-3,#8a93a6); margin: 3px 0 0; }
      .set-close { cursor: pointer; border: none; background: none; font-size: 22px; color: var(--c-text-3,#8a93a6); line-height: 1; padding: 0 4px; transition: color .15s, transform .15s; }
      .set-close:hover { color: var(--c-text,#1c2233); transform: rotate(90deg); }
      .set-body { padding: 8px 24px 20px; }
      .set-tabs { display: flex; gap: 4px; padding: 0 20px; border-bottom: 1px solid var(--c-border,#e5e8ef);
        overflow-x: auto; overflow-y: hidden; scrollbar-width: none; -ms-overflow-style: none; }
      .set-tabs::-webkit-scrollbar { display: none; }
      .set-tab { position: relative; flex: 0 0 auto; padding: 11px 12px; font-size: 13px; font-weight: 550;
        cursor: pointer; border: none; background: none; white-space: nowrap; color: var(--c-text-3,#8a93a6); transition: color .2s; }
      .set-tab:hover { color: var(--tc, var(--c-text-2)); opacity: .75; }
      .set-tab.active { color: var(--tc, var(--c-accent,#3b6fd4)); opacity: 1; }
      .set-tab::after { content: ''; position: absolute; left: 50%; right: 50%; bottom: -1px; height: 2px;
        background: var(--tc, var(--c-accent,#3b6fd4)); border-radius: 2px; transition: left .25s, right .25s; }
      .set-tab.active::after { left: 6px; right: 6px; }
      .set-seg-wrap button { flex: 0 0 auto; }

      /* свотчи акцентного цвета */
      .set-swatches { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
      .set-swatch { width: 30px; height: 30px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0;
        background: var(--sw); position: relative; transition: transform .18s cubic-bezier(.34,1.5,.5,1), box-shadow .2s; }
      .set-swatch:hover { transform: scale(1.15); }
      .set-swatch::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid var(--sw);
        opacity: 0; transform: scale(.8); transition: opacity .2s, transform .2s; }
      .set-swatch.active::after { opacity: 1; transform: scale(1); }
      .set-swatch.active { transform: scale(1.05); }
      .set-swatch.active::before { content: '✓'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        color: #fff; font-size: 15px; font-weight: 700; text-shadow: 0 1px 2px rgba(0,0,0,.3); animation: swPop .3s cubic-bezier(.34,1.6,.5,1); }
      @keyframes swPop { from { transform: scale(0); } to { transform: scale(1); } }

      /* подвал с кнопкой сброса */
      .set-foot { padding: 14px 24px; border-top: 1px solid var(--c-border,#e5e8ef); display: flex; justify-content: center; }
      .set-reset { display: inline-flex; align-items: center; gap: 8px; padding: 9px 16px; border: 1px solid var(--c-border,#e5e8ef);
        background: var(--c-surface,#fff); border-radius: 9px; font-size: 12.5px; font-weight: 550; color: var(--c-text-2,#6b7488);
        cursor: pointer; transition: all .18s; }
      .set-reset:hover { border-color: var(--c-red,#dc3545); color: var(--c-red,#dc3545); background: var(--c-red-bg,#fff5f5); }
      .set-reset svg { transition: transform .5s cubic-bezier(.5,0,.2,1); }
      .set-reset:hover svg { transform: rotate(-180deg); }
      .set-reset.done { border-color: var(--c-green,#2b9d5b); color: var(--c-green,#2b9d5b); background: var(--c-green-bg,#e8f7ee); }
      .set-reset.done svg { transform: rotate(-360deg); }
      .set-item { padding: 15px 0; border-bottom: 1px solid var(--c-surface-2,#f2f3f6); animation: setIn .4s ease both; }
      .set-item:last-child { border-bottom: none; }
      @keyframes setIn { from { opacity: 0; } to { opacity: 1; } }
      .set-label { font-size: 13.5px; font-weight: 550; color: var(--c-text,#1c2233); }
      .set-hint { font-size: 11.5px; color: var(--c-text-3,#8a93a6); margin-top: 2px; }
      .set-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }

      /* сегментированный переключатель */
      .set-seg { display: inline-flex; background: var(--c-surface-2,#f2f3f6); border-radius: 9px; padding: 3px; gap: 2px; }
      .set-seg button { border: none; background: none; padding: 6px 13px; font-size: 12.5px; font-weight: 550; cursor: pointer;
        color: var(--c-text-2,#6b7488); border-radius: 7px; transition: all .18s; white-space: nowrap; }
      .set-seg button.active { background: var(--c-surface,#fff); color: var(--c-accent,#3b6fd4); box-shadow: 0 1px 3px rgba(0,0,0,.1); }

      /* тумблер */
      .set-toggle { position: relative; width: 44px; height: 25px; flex: 0 0 auto; cursor: pointer; }
      .set-toggle input { opacity: 0; width: 0; height: 0; }
      .set-track { position: absolute; inset: 0; background: var(--c-border,#cfd4de); border-radius: 20px; transition: background .22s; }
      .set-track::before { content: ''; position: absolute; left: 3px; top: 3px; width: 19px; height: 19px; background: #fff;
        border-radius: 50%; transition: transform .24s cubic-bezier(.34,1.5,.5,1); box-shadow: 0 1px 3px rgba(0,0,0,.25); }
      .set-toggle input:checked + .set-track { background: var(--c-accent,#3b6fd4); }
      .set-toggle input:checked + .set-track::before { transform: translateX(19px); }

      /* ползунок размера шрифта */
      .set-range { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
      .set-range input[type=range] { flex: 1; accent-color: var(--c-accent,#3b6fd4); height: 4px; }
      .set-range .set-val { font-size: 13px; font-weight: 600; color: var(--c-accent,#3b6fd4); min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
      .set-preview-wrap { margin-top: 10px; border: 1px solid var(--c-border,#e5e8ef); border-radius: 10px; overflow: hidden;
        transition: border-color .25s; }
      .set-preview-wrap table { width: 100%; }
      /* Превью изолируем от случайных глобальных состояний (сортировка, избранное и т.д.) */
      .set-preview-wrap .data-table th { position: static !important; color: var(--c-text-2,#6b7488) !important; background: var(--c-surface-2,#f6f7f9) !important; }
      .set-preview-wrap .data-table td { color: var(--c-text,#1c2233) !important; background: var(--c-surface,#fff) !important; }
      .set-preview-wrap .data-table tbody tr:nth-child(even) td { background: var(--c-surface-2,#f6f7f9) !important; }
      .set-preview-wrap .data-table td.num { color: var(--c-accent,#3b6fd4) !important; }

      /* иконка-кнопка настроек в шапке */
      .set-gear { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
        border: none; background: transparent; cursor: pointer; color: var(--c-text-3,#8a93a6); border-radius: 8px; padding: 0; margin: 0 2px;
        transition: color .2s, background .2s; }
      .set-gear:hover { color: var(--c-accent,#3b6fd4); background: var(--c-accent-bg,#eef3fc); }
      .set-gear svg { transition: transform .25s cubic-bezier(.34,1.4,.5,1); }
      .set-gear:hover svg { transform: scale(1.12); }
      .set-gear:active svg { transform: scale(.92); }

      /* кнопка-действие (перепривязка) */
      .set-action-btn { display: inline-flex; align-items: center; gap: 8px; padding: 9px 16px;
        border: 1px solid var(--c-border,#e5e8ef); background: var(--c-surface,#fff); border-radius: 9px;
        font-size: 13px; font-weight: 550; color: var(--c-text,#1c2233); cursor: pointer; transition: all .15s; }
      .set-action-btn:hover { border-color: var(--c-accent,#3b6fd4); color: var(--c-accent,#3b6fd4); }
      .set-action-btn:disabled { opacity: .5; cursor: default; }
      .re-primary { background: var(--c-red,#dc3545); color: #fff; border-color: var(--c-red,#dc3545); width: 100%; justify-content: center; margin-top: 4px; }
      .re-primary:hover { background: #c32f3e; border-color: #c32f3e; color: #fff; }
      .set-action-btn.re-danger { border-color: var(--c-red,#dc3545); color: var(--c-red,#dc3545); }
      .set-action-btn.re-danger:hover { background: #fff5f5; border-color: var(--c-red,#dc3545); color: var(--c-red,#dc3545); }
      [data-theme="dark"] .set-action-btn.re-danger:hover { background: var(--c-red-bg,#2c1a1a); }

      /* квадратики ввода кода */
      .re-cells { display: flex; gap: 8px; justify-content: center; margin: 4px 0 6px; }
      .re-cell { width: 42px; height: 52px; text-align: center; font-size: 23px; font-weight: 600;
        font-family: var(--font-mono,monospace); color: var(--c-text,#1c2233);
        border: 2px solid var(--c-border,#e5e8ef); border-radius: 12px; outline: none;
        background: var(--c-surface,#fff); transition: border-color .15s, box-shadow .15s, transform .1s;
        caret-color: var(--c-red,#dc3545); }
      .re-cell:focus { border-color: var(--c-red,#dc3545); box-shadow: 0 0 0 4px var(--c-red-bg,rgba(220,53,69,.12)); transform: translateY(-2px); }
      .re-cell.filled { border-color: var(--c-red,#dc3545); background: var(--c-red-bg,#fff5f5); }

      /* модалка перепривязки */
      .re-overlay { position: fixed; inset: 0; z-index: 10002; background: rgba(10,14,22,.55);
        backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .25s; }
      .re-overlay.show { opacity: 1; }
      .re-card { position: relative; width: 380px; max-width: 94vw; background: var(--c-surface,#fff);
        border-radius: var(--r-lg,16px); box-shadow: 0 24px 60px rgba(0,0,0,.3); padding: 28px 26px 24px; text-align: center;
        transform: translateY(12px); opacity: 0; transition: transform .38s cubic-bezier(.22,1,.36,1), opacity .3s; }
      .re-overlay.show .re-card { transform: none; opacity: 1; }
      .re-close { position: absolute; top: 12px; right: 14px; }
      .re-ico { font-size: 40px; margin-bottom: 8px; }
      .re-ico.re-ok { width: 56px; height: 56px; margin: 0 auto 10px; border-radius: 50%; background: var(--c-green,#2b9d5b);
        color: #fff; display: flex; align-items: center; justify-content: center; font-size: 30px; animation: reOkPop .4s cubic-bezier(.34,1.5,.5,1); }
      @keyframes reOkPop { from { transform: scale(0); } to { transform: scale(1); } }
      .re-title { font-size: 17px; font-weight: 650; color: var(--c-text,#1c2233); margin: 0 0 8px; }
      .re-text { font-size: 13px; color: var(--c-text-2,#6b7488); line-height: 1.55; margin: 0 0 16px; }
      .re-qr { display: flex; justify-content: center; margin: 4px 0 12px; }
      .re-qr img { border-radius: 8px; border: 1px solid var(--c-border,#e5e8ef); }
      .re-secret { font-size: 12px; color: var(--c-text-3,#8a93a6); margin-bottom: 14px; }
      .re-secret code { font-family: var(--font-mono,monospace); color: var(--c-text,#1c2233); font-size: 12.5px; letter-spacing: 1px; }
      .re-err { min-height: 18px; font-size: 12.5px; color: var(--c-red,#dc3545); margin: 8px 0; }


    `;
    document.head.appendChild(st);
  }

  let _s = load();

  function update(patch) {
    _s = Object.assign({}, _s, patch);
    apply(_s);
    persist(_s);
  }

  // ── Панель с вкладками ─────────────────────────────────────────
  let _tab = 'view';

  const seg = (field, opts) => `<div class="set-seg" data-seg="${field}">` +
    opts.map(o => `<button data-val="${o.v}" class="${_s[field] === o.v ? 'active' : ''}">${o.l}</button>`).join('') +
    `</div>`;

  const toggle = (field) => `<label class="set-toggle">
    <input type="checkbox" data-toggle="${field}" ${_s[field] ? 'checked' : ''}>
    <span class="set-track"></span></label>`;

  function viewTabHtml() {
    const swatches = Object.keys(ACCENTS).map(k => {
      const a = ACCENTS[k];
      return `<button class="set-swatch ${_s.accent === k ? 'active' : ''}" data-accent="${k}" title="${a.name}" style="--sw:${a.c}"></button>`;
    }).join('');
    const fonts = Object.keys(FONT_LABELS).map(k =>
      `<button data-val="${k}" class="${_s.dataFontFamily === k ? 'active' : ''}">${FONT_LABELS[k]}</button>`
    ).join('');
    return '' +
      '<div class="set-item"><div class="set-row">' +
        '<div><div class="set-label">Тема</div><div class="set-hint">Светлое или тёмное оформление</div></div>' +
        seg('theme', [{v:'light',l:'Светлая'},{v:'dark',l:'Тёмная'}]) +
      '</div></div>' +
      '<div class="set-item">' +
        '<div class="set-label">Цвет акцента</div>' +
        '<div class="set-hint">Цвет кнопок, ссылок и выделений</div>' +
        '<div class="set-swatches">' + swatches + '</div>' +
      '</div>' +
      '<div class="set-item">' +
        '<div class="set-label">Предпросмотр</div>' +
        '<div class="set-hint">Так выглядят данные с текущими настройками</div>' +
        '<div class="set-preview-wrap"><table class="data-table">' +
          '<thead><tr><th>id</th><th>текст</th><th>число</th></tr></thead>' +
          '<tbody><tr><td>42</td><td>пример</td><td>1234.56</td></tr>' +
          '<tr><td>7</td><td>значение</td><td>89.00</td></tr></tbody>' +
        '</table></div>' +
      '</div>' +
      '<div class="set-item"><div class="set-row">' +
        '<div><div class="set-label">Плотность таблицы</div><div class="set-hint">Высота строк с данными</div></div>' +
        seg('density', [{v:'compact',l:'Плотно'},{v:'normal',l:'Обычно'},{v:'comfortable',l:'Просторно'}]) +
      '</div></div>' +
      '<div class="set-item">' +
        '<div class="set-label">Размер шрифта данных</div>' +
        '<div class="set-hint">Кегль текста в таблицах</div>' +
        '<div class="set-range">' +
          `<input type="range" id="setFont" min="11" max="16" step="1" value="${_s.dataFont}">` +
          `<span class="set-val" id="setFontVal">${_s.dataFont}px</span>` +
        '</div>' +
      '</div>' +
      '<div class="set-item">' +
        '<div class="set-label">Шрифт данных</div>' +
        '<div class="set-hint">Начертание текста в таблицах</div>' +
        '<div class="set-seg set-seg-wrap" data-seg="dataFontFamily" style="margin-top:10px;flex-wrap:wrap">' +
          fonts +
        '</div>' +
      '</div>' +
      '<div class="set-item"><div class="set-row">' +
        '<div><div class="set-label">Анимации интерфейса</div><div class="set-hint">Плавные переходы и эффекты</div></div>' +
        toggle('anim') +
      '</div></div>' +
      '<div class="set-item">' +
        '<div class="set-label">Своя палитра</div>' +
        '<div class="set-hint">Покрасьте отдельные кнопки и надписи вручную — кистью по образцу</div>' +
        '<button class="set-action-btn" id="setOpenPaint" style="margin-top:10px">Включить режим покраски</button>' +
      '</div>';
  }

  function tableTabHtml() {
    return '' +
      '<div class="set-item"><div class="set-row">' +
        '<div><div class="set-label">Закрепить шапку</div><div class="set-hint">Заголовки столбцов видны при прокрутке вниз</div></div>' +
        toggle('freezeHeader') +
      '</div></div>' +
      '<div class="set-item"><div class="set-row">' +
        '<div><div class="set-label">Закрепить первый столбец</div><div class="set-hint">Первый столбец виден при прокрутке вправо</div></div>' +
        toggle('freezeCol') +
      '</div></div>' +
      '<div class="set-item">' +
        '<div class="set-label">Формат даты</div>' +
        '<div class="set-hint">Как показывать значения дат</div>' +
        '<div class="set-seg set-seg-wrap" data-seg="dateFormat" style="margin-top:10px;flex-wrap:wrap">' +
          [{v:'default',l:'2026-01-15 12:30'},{v:'date_only',l:'2026-01-15'},{v:'ru',l:'15.01.2026'},{v:'ru_time',l:'15.01.2026 12:30'}]
            .map(o => `<button data-val="${o.v}" class="${_s.dateFormat === o.v ? 'active' : ''}">${o.l}</button>`).join('') +
        '</div>' +
      '</div>';
  }

  function sqlTabHtml() {
    return '' +
      '<div class="set-item">' +
        '<div class="set-label">Размер шрифта редактора</div>' +
        '<div class="set-hint">Кегль текста в поле SQL-запроса</div>' +
        '<div class="set-range">' +
          `<input type="range" id="setSqlFont" min="12" max="18" step="1" value="${_s.sqlFont}">` +
          `<span class="set-val" id="setSqlFontVal">${_s.sqlFont}px</span>` +
        '</div>' +
      '</div>' +
      '<div class="set-item"><div class="set-row">' +
        '<div><div class="set-label">Автодополнение</div><div class="set-hint">Подсказки таблиц, колонок и ключевых слов при вводе</div></div>' +
        toggle('sqlAutocomplete') +
      '</div></div>' +
      '<div class="set-item"><div class="set-row">' +
        '<div><div class="set-label">Режим без SQL</div><div class="set-hint">Скрыть SQL-редактор и раздел «Запросы» — только просмотр таблиц</div></div>' +
        toggle('noSql') +
      '</div></div>';
  }

  function exportTabHtml() {
    return '' +
      '<div class="set-item">' +
        '<div class="set-label">Разделитель CSV</div>' +
        '<div class="set-hint">Точка с запятой — привычнее для русского Excel</div>' +
        seg('exportDelimiter', [{v:'semicolon',l:'Точка с запятой ( ; )'},{v:'comma',l:'Запятая ( , )'}]) +
      '</div>' +
      '<div class="set-item">' +
        '<div class="set-label">Кодировка CSV</div>' +
        '<div class="set-hint">Windows-1251 — для старых версий Excel, которые не понимают UTF-8</div>' +
        seg('exportEncoding', [{v:'utf8',l:'UTF-8'},{v:'win1251',l:'Windows-1251'}]) +
      '</div>' +
      '<div class="set-item"><div class="set-row">' +
        '<div><div class="set-label">Заголовки столбцов</div><div class="set-hint">Включать строку с названиями колонок в файл</div></div>' +
        toggle('exportHeaders') +
      '</div></div>';
  }

  function securityTabHtml() {
    return '' +
      '<div class="set-item">' +
        '<div class="set-label">Двухфакторная аутентификация</div>' +
        '<div class="set-hint">Если вы сменили телефон или переустановили приложение-аутентификатор, ' +
          'привяжите 2FA заново. Понадобится текущий код с привязанного устройства.</div>' +
        '<button class="set-action-btn re-danger" id="setReenroll2fa" style="margin-top:12px">' +
          'Перепривязать 2FA' +
        '</button>' +
      '</div>';
  }

  function renderBody(overlay) {
    const body = overlay.querySelector('#setBody');
    body.innerHTML = _tab === 'table'    ? tableTabHtml()
                   : _tab === 'sql'      ? sqlTabHtml()
                   : _tab === 'export'   ? exportTabHtml()
                   : _tab === 'security' ? securityTabHtml()
                   : viewTabHtml();
    bindBody(overlay);
    if (_tab === 'security') {
      overlay.querySelector('#setReenroll2fa')?.addEventListener('click', openReenroll);
    }
    if (_tab === 'view') {
      overlay.querySelector('#setOpenPaint')?.addEventListener('click', () => {
        _closeSettingsOverlay();
        setTimeout(enterPaintMode, 260);
      });
    }
  }

  function bindBody(overlay) {
    // сегменты
    overlay.querySelectorAll('.set-seg').forEach(segEl => {
      segEl.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          segEl.querySelectorAll('button').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          const field = segEl.dataset.seg;
          update({ [field]: b.dataset.val });
          if (field === 'dateFormat') _rerenderTable();
        });
      });
    });
    // свотчи акцентного цвета
    overlay.querySelectorAll('.set-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        overlay.querySelectorAll('.set-swatch').forEach(x => x.classList.remove('active'));
        sw.classList.add('active');
        update({ accent: sw.dataset.accent });
      });
    });
    // тумблеры
    overlay.querySelectorAll('[data-toggle]').forEach(inp => {
      inp.addEventListener('change', () => update({ [inp.dataset.toggle]: inp.checked }));
    });
    // ползунок шрифта
    const font = overlay.querySelector('#setFont');
    if (font) {
      const fontVal = overlay.querySelector('#setFontVal');
      font.addEventListener('input', () => {
        const px = parseInt(font.value, 10);
        fontVal.textContent = px + 'px';
        update({ dataFont: px });
      });
    }
    // ползунок шрифта SQL-редактора
    const sqlFont = overlay.querySelector('#setSqlFont');
    if (sqlFont) {
      const sqlFontVal = overlay.querySelector('#setSqlFontVal');
      sqlFont.addEventListener('input', () => {
        const px = parseInt(sqlFont.value, 10);
        sqlFontVal.textContent = px + 'px';
        update({ sqlFont: px });
      });
    }
  }

  // безопасно перерисовать текущую таблицу (для применения формата)
  function _rerenderTable() {
    try {
      if (typeof renderTable === 'function' &&
          typeof state !== 'undefined' && state && state.filteredRows && state.filteredRows.length) {
        renderTable();
      }
    } catch (_) {}
  }

  function openSettings() {
    injectCss();
    window.sedMascotState?.('settings', { autoIdleMs: 1800 });
    document.getElementById('setOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'setOverlay';
    overlay.innerHTML =
      '<div id="setCard">' +
        '<div class="set-head"><div>' +
          '<h3 class="set-title">Настройки</h3>' +
          '<p class="set-sub">Применяются сразу и сохраняются за вами</p>' +
        '</div><button class="set-close" id="setClose">&times;</button></div>' +
        '<div class="set-tabs">' +
          `<button class="set-tab ${_tab==='view'?'active':''}" data-tab="view" style="--tc:var(--c-accent)">Вид</button>` +
          `<button class="set-tab ${_tab==='table'?'active':''}" data-tab="table" style="--tc:#12a594">Таблица</button>` +
          `<button class="set-tab ${_tab==='sql'?'active':''}" data-tab="sql" style="--tc:#7c5cdb">SQL</button>` +
          `<button class="set-tab ${_tab==='export'?'active':''}" data-tab="export" style="--tc:#e08a2b">Экспорт</button>` +
          `<button class="set-tab ${_tab==='security'?'active':''}" data-tab="security" style="--tc:#dc4b57">Защита</button>` +
        '</div>' +
        '<div class="set-body" id="setBody"></div>' +
        '<div class="set-foot">' +
          '<button class="set-reset" id="setReset">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M3 2v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>' +
            'Сброс' +
          '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const close = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 250);
      document.removeEventListener('keydown', esc);
    };
    const esc = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    overlay.querySelector('#setClose').addEventListener('click', close);

    // сброс до заводских
    overlay.querySelector('#setReset').addEventListener('click', () => {
      if (!confirm('Сбросить все настройки внешнего вида до значений по умолчанию?')) return;
      _s = Object.assign({}, DEFAULTS);
      apply(_s);
      persist(_s);
      _rerenderTable();
      renderBody(overlay);
      const btn = overlay.querySelector('#setReset');
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 1200);
    });

    overlay.querySelectorAll('.set-tab').forEach(t => {
      t.addEventListener('click', () => {
        overlay.querySelectorAll('.set-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        _tab = t.dataset.tab;
        renderBody(overlay);
      });
    });

    renderBody(overlay);
  }

  // ── Перепривязка 2FA ───────────────────────────────────────────
  // 6 квадратиков ввода кода с навигацией/вставкой/автосабмитом
  function cellsHtml() {
    let s = '<div class="re-cells">';
    for (let i = 0; i < 6; i++) {
      s += `<input class="re-cell" data-i="${i}" inputmode="numeric" maxlength="1" autocomplete="${i===0?'one-time-code':'off'}">`;
    }
    return s + '</div>';
  }

  function bindCells(container, onComplete) {
    const cells = Array.from(container.querySelectorAll('.re-cell'));
    const read = () => cells.map(c => c.value).join('');
    cells.forEach((cell, idx) => {
      cell.addEventListener('input', () => {
        cell.value = cell.value.replace(/\D/g, '').slice(0, 1);
        cell.classList.toggle('filled', cell.value !== '');
        if (cell.value && idx < 5) cells[idx + 1].focus();
        if (read().length === 6) onComplete(read());
      });
      cell.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !cell.value && idx > 0) {
          cells[idx - 1].focus(); cells[idx - 1].value = ''; cells[idx - 1].classList.remove('filled'); e.preventDefault();
        } else if (e.key === 'ArrowLeft' && idx > 0) { cells[idx - 1].focus(); e.preventDefault(); }
        else if (e.key === 'ArrowRight' && idx < 5) { cells[idx + 1].focus(); e.preventDefault(); }
        else if (e.key === 'Enter') { if (read().length === 6) onComplete(read()); }
      });
      cell.addEventListener('paste', e => {
        e.preventDefault();
        const digits = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        if (!digits) return;
        cells.forEach((c, i) => { c.value = digits[i] || ''; c.classList.toggle('filled', !!digits[i]); });
        cells[Math.min(digits.length, 5)].focus();
        if (digits.length === 6) onComplete(digits);
      });
    });
    setTimeout(() => cells[0] && cells[0].focus(), 100);
    return { read, cells };
  }

  function openReenroll() {
    injectCss();
    document.getElementById('reOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'reOverlay';
    overlay.className = 're-overlay';
    overlay.innerHTML =
      '<div class="re-card">' +
        '<button class="set-close re-close">&times;</button>' +
        '<div id="reBody"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 250); document.removeEventListener('keydown', esc); };
    const esc = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    overlay.querySelector('.re-close').addEventListener('click', close);

    stepCurrent(overlay, close);
  }

  // Шаг 1 — ввод текущего кода
  function stepCurrent(overlay, close) {
    const body = overlay.querySelector('#reBody');
    body.innerHTML =
      '<div class="re-ico">🔐</div>' +
      '<h3 class="re-title">Перепривязка 2FA</h3>' +
      '<p class="re-text">Введите <b>текущий</b> код из приложения-аутентификатора, чтобы подтвердить, что это вы.</p>' +
      cellsHtml() +
      '<div class="re-err" id="reErr"></div>' +
      '<button class="set-action-btn re-primary" id="reNext">Продолжить</button>';

    const err = body.querySelector('#reErr');
    const btn = body.querySelector('#reNext');
    const ctl = bindCells(body, () => go());
    btn.addEventListener('click', go);

    let busy = false;
    async function go() {
      const code = ctl.read();
      if (code.length !== 6) { err.textContent = 'Введите 6 цифр'; return; }
      if (busy) return; busy = true;
      btn.disabled = true; err.textContent = '';
      let data = null;
      try {
        const r = await fetch(`${API}?m=Auth&a=reEnroll2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': getCsrfToken() },
          credentials: 'same-origin',
          body: JSON.stringify({ code }),
        });
        data = await r.json();
      } catch (_) {
        err.textContent = 'Ошибка сети'; btn.disabled = false; busy = false; return;
      }
      if (data && data.ok) {
        stepNew(overlay, close, data);
      } else {
        err.textContent = (data && data.error) || 'Ошибка';
        ctl.cells.forEach(c => { c.value = ''; c.classList.remove('filled'); });
        ctl.cells[0].focus(); btn.disabled = false; busy = false;
      }
    }
  }

  // Шаг 2 — новый QR + подтверждение новым кодом
  function stepNew(overlay, close, data) {
    const body = overlay.querySelector('#reBody');
    body.innerHTML =
      '<h3 class="re-title">Новая привязка</h3>' +
      '<p class="re-text">Отсканируйте новый QR-код в приложении, затем введите код из него.</p>' +
      '<div class="re-qr" id="reQr"></div>' +
      '<div class="re-secret">Ключ: <code>' + escHtml(data.secret) + '</code></div>' +
      cellsHtml() +
      '<div class="re-err" id="reErr2"></div>' +
      '<button class="set-action-btn re-primary" id="reConfirm">Подтвердить</button>';

    try {
      if (typeof qrcode !== 'function') throw new Error('qrcode lib missing');
      const qr = qrcode(0, 'M');
      qr.addData(data.otpauth);
      qr.make();
      body.querySelector('#reQr').innerHTML = qr.createImgTag(4, 0);
    } catch (e) {
      body.querySelector('#reQr').innerHTML = '<div class="re-text">Введите ключ вручную в приложении:<br><b>' + escHtml(data.secret) + '</b></div>';
    }

    const err = body.querySelector('#reErr2');
    const btn = body.querySelector('#reConfirm');
    const ctl = bindCells(body, () => go());
    btn.addEventListener('click', go);

    let busy = false;
    async function go() {
      const code = ctl.read();
      if (code.length !== 6) { err.textContent = 'Введите 6 цифр'; return; }
      if (busy) return; busy = true;
      btn.disabled = true; err.textContent = '';
      try {
        const r = await fetch(`${API}?m=Auth&a=verify2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': getCsrfToken() },
          credentials: 'same-origin',
          body: JSON.stringify({ code }),
        });
        const d = await r.json();
        if (d.ok) stepDone(overlay, close);
        else {
          err.textContent = d.error || 'Неверный код';
          ctl.cells.forEach(c => { c.value = ''; c.classList.remove('filled'); });
          ctl.cells[0].focus(); btn.disabled = false; busy = false;
        }
      } catch (_) { err.textContent = 'Ошибка сети'; btn.disabled = false; busy = false; }
    }
  }

  // Шаг 3 — успех
  function stepDone(overlay, close) {
    const body = overlay.querySelector('#reBody');
    body.innerHTML =
      '<div class="re-ico re-ok">✓</div>' +
      '<h3 class="re-title">Готово</h3>' +
      '<p class="re-text">2FA перепривязан. Теперь используйте коды из нового приложения.</p>' +
      '<button class="set-action-btn re-primary" id="reClose2">Закрыть</button>';
    body.querySelector('#reClose2').addEventListener('click', close);
  }

  // ── Живой режим покраски: кликаешь по любому элементу интерфейса,
  // он красится — без окон и макетов, прямо в боевом UI. ──────────
  const PAINT_SWATCHES = [
    '#dc4b57', '#e08a2b', '#e0c22b', '#2ba05c', '#12a594',
    '#0d9bd8', '#3b6fd4', '#7c5cdb', '#db5c93', '#6b7488',
    '#1c2233', '#ffffff',
  ];

  let _brush = null;       // текущий цвет кисти (hex) | 'erase' | null

  // Курсор-кисточка: ворс подсвечен текущим выбранным цветом.
  // Для ластика — отдельная нейтральная иконка.
  function _setCursor(colorOrErase) {
    let svg;
    if (colorOrErase === 'erase') {
      svg = "<svg xmlns='http://www.w3.org/2000/svg' width='30' height='30' viewBox='0 0 30 30'>" +
        "<g transform='rotate(-40 15 15)'>" +
        "<rect x='7' y='11' width='16' height='10' rx='2' fill='%23eceef4' stroke='%236b7488' stroke-width='1.4'/>" +
        "<rect x='7' y='11' width='16' height='5' fill='%23c7cdd8'/>" +
        "</g></svg>";
    } else {
      const c = encodeURIComponent(colorOrErase || '#3b6fd4');
      svg = "<svg xmlns='http://www.w3.org/2000/svg' width='30' height='30' viewBox='0 0 30 30'>" +
        "<g transform='rotate(-45 15 15)'>" +
        "<rect x='13' y='1' width='4' height='13' rx='1.6' fill='%23555a66'/>" +
        "<rect x='12.3' y='11' width='5.4' height='4' fill='%23c7cdd8'/>" +
        `<path d='M11.3 14.6 h7.4 v5 a3.7 3.7 0 0 1 -7.4 0 z' fill='${c}'/>` +
        `<circle cx='15' cy='25.5' r='1.5' fill='${c}'/>` +
        "</g></svg>";
    }
    const url = `url("data:image/svg+xml,${svg.replace(/#/g, '%23')}") 4 27, crosshair`;
    document.documentElement.style.setProperty('--paint-cursor', url);
  }
  let _paintActive = false;
  let _paintStyleTag = null;

  // Применить сохранённую карту покраски (вызывается и при старте страницы)
  function applyPaintMap(map) {
    if (!_paintStyleTag) {
      _paintStyleTag = document.getElementById('paintMapStyle');
      if (!_paintStyleTag) {
        _paintStyleTag = document.createElement('style');
        _paintStyleTag.id = 'paintMapStyle';
        document.head.appendChild(_paintStyleTag);
      }
    }
    const rules = Object.keys(map || {}).map(sel => {
      const rule = map[sel];
      if (!rule || !rule.c) return '';
      try {
        const boosted = sel + ':not(#__sedpaint_never__)';
        if (rule.mode === 'bg') {
          return `${boosted} { background-color: ${rule.c} !important; border-color: ${rule.c} !important; }`;
        }
        return `${boosted} { color: ${rule.c} !important; }`;
      } catch (_) { return ''; }
    }).join('\n');
    _paintStyleTag.textContent = rules;
  }

  // Построить разумно стабильный селектор для элемента:
  // id → приоритет; иначе тег+классы (красит ВСЕ такие элементы разом,
  // это удобно — покрасил одну ссылку, покрасились все похожие).
  function _genSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.classList && el.classList.length) {
      return el.tagName.toLowerCase() + '.' + Array.from(el.classList).map(c => CSS.escape(c)).join('.');
    }
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    const idx = Array.from(parent.children).indexOf(el) + 1;
    const parentSel = parent.id ? '#' + CSS.escape(parent.id) : parent.tagName.toLowerCase();
    return `${parentSel} > ${el.tagName.toLowerCase()}:nth-child(${idx})`;
  }

  // Определить, что красим: если это кнопка — красим фон, иначе текст.
  // Поднимаемся по DOM, если кликнули по иконке/спану без своего id/класса.
  function _resolvePaintTarget(target) {
    const btnEl = target.closest && target.closest('button, .btn');
    if (btnEl) return { el: btnEl, mode: 'bg' };
    // Красим ИМЕННО кликнутый элемент, а не случайного дальнего предка —
    // иначе у самого текста может быть своё правило цвета глубже в CSS,
    // которое не перебивается покраской обёртки снаружи.
    return { el: target, mode: 'text' };
  }

  function _paintToast(msg) {
    document.querySelector('.paint-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'paint-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1600);
  }

  let _lastHoverEl = null;
  function _onPaintHover(e) {
    if (e.target.closest('.paint-bar')) { _clearHover(); return; }
    const { el } = _resolvePaintTarget(e.target);
    if (el === _lastHoverEl) return;
    _clearHover();
    if (el && el !== document.body && el !== document.documentElement) {
      el.classList.add('paint-hover-target');
      _lastHoverEl = el;
    }
  }
  function _clearHover() {
    if (_lastHoverEl) { _lastHoverEl.classList.remove('paint-hover-target'); _lastHoverEl = null; }
  }

  // Многие элементы приложения (комбобоксы, списки) реагируют на
  // mousedown раньше, чем на click — поэтому блокируем ВСЕ три события,
  // а саму покраску делаем один раз, на самом раннем (mousedown).
  function _onPaintIntercept(e) {
    if (e.target.closest('.paint-bar')) return; // по самой панели не перехватываем
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== 'mousedown') return; // логика покраски — только один раз

    if (_brush === null) { _paintToast('Сначала выберите цвет или ластик на панели снизу'); return; }

    const { el, mode } = _resolvePaintTarget(e.target);
    if (!el || el === document.body || el === document.documentElement) return;
    const sel = _genSelector(el);

    if (!_s.paintMap) _s.paintMap = {};
    if (_brush === 'erase') {
      delete _s.paintMap[sel];
      _paintToast('Сброшено');
    } else {
      _s.paintMap[sel] = { c: _brush, mode };
      _paintToast('Покрашено');
    }
    applyPaintMap(_s.paintMap);
    persist(_s);
  }

  function enterPaintMode() {
    if (_paintActive) return;
    _paintActive = true;
    _brush = null;
    injectCss();

    const bar = document.createElement('div');
    bar.className = 'paint-bar';
    bar.id = 'paintBar';
    let sw = PAINT_SWATCHES.map(c => `<button class="paint-sw" data-c="${c}" style="--sw:${c}" title="${c}"></button>`).join('');
    sw += `<label class="paint-sw paint-sw-custom" title="Свой цвет"><input type="color" id="paintCustom" value="#3b6fd4"></label>`;
    sw += `<button class="paint-sw paint-sw-eraser" id="paintEraser" title="Ластик — вернуть по умолчанию">⌫</button>`;
    bar.innerHTML =
      '<span class="paint-bar-label">🖌 Кликните по элементу, чтобы покрасить</span>' +
      '<div class="paint-bar-swatches">' + sw + '</div>' +
      '<button class="paint-bar-btn" id="paintClearAll">Сбросить всё</button>' +
      '<button class="paint-bar-btn paint-bar-exit" id="paintExit">Готово</button>';
    document.body.appendChild(bar);
    requestAnimationFrame(() => bar.classList.add('show'));
    _setCursor('#3b6fd4'); // нейтральный курсор-кисточка до выбора цвета

    // Если сейчас ничего не открыто — покажем данные, чтобы было что красить
    try {
      if (typeof state !== 'undefined' && !state.currentTable && typeof selectTable === 'function') {
        const firstTbl = document.querySelector('.tbl-item[data-table]')?.dataset?.table;
        if (firstTbl) selectTable(firstTbl);
      }
    } catch (_) {}

    const markActive = (btn) => {
      bar.querySelectorAll('.paint-sw').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
    };
    bar.querySelectorAll('.paint-sw[data-c]').forEach(btn => {
      btn.addEventListener('click', () => { _brush = btn.dataset.c; markActive(btn); _setCursor(_brush); });
    });
    const custom = bar.querySelector('#paintCustom');
    custom.addEventListener('input', () => { _brush = custom.value; markActive(custom.closest('.paint-sw')); _setCursor(_brush); });
    bar.querySelector('#paintEraser').addEventListener('click', (e) => { _brush = 'erase'; markActive(e.currentTarget); _setCursor('erase'); });
    bar.querySelector('#paintExit').addEventListener('click', exitPaintMode);
    bar.querySelector('#paintClearAll').addEventListener('click', () => {
      if (!confirm('Сбросить всю покраску интерфейса?')) return;
      _s.paintMap = {};
      applyPaintMap(_s.paintMap);
      persist(_s);
      _paintToast('Вся покраска сброшена');
    });

    document.documentElement.classList.add('paint-mode-on');
    document.addEventListener('mouseover', _onPaintHover, true);
    document.addEventListener('mousedown', _onPaintIntercept, true);
    document.addEventListener('click', _onPaintIntercept, true);
    document.addEventListener('mouseup', _onPaintIntercept, true);
    document.addEventListener('keydown', _onPaintEsc);
  }

  function _onPaintEsc(e) { if (e.key === 'Escape') exitPaintMode(); }

  function exitPaintMode() {
    if (!_paintActive) return;
    _paintActive = false;
    _brush = null;
    _clearHover();
    document.documentElement.classList.remove('paint-mode-on');
    document.removeEventListener('mouseover', _onPaintHover, true);
    document.removeEventListener('mousedown', _onPaintIntercept, true);
    document.removeEventListener('click', _onPaintIntercept, true);
    document.removeEventListener('mouseup', _onPaintIntercept, true);
    document.removeEventListener('keydown', _onPaintEsc);
    const bar = document.getElementById('paintBar');
    if (bar) { bar.classList.remove('show'); setTimeout(() => bar.remove(), 200); }
  }

  function _closeSettingsOverlay() {
    const ov = document.getElementById('setOverlay');
    if (!ov) return;
    ov.classList.remove('show');
    setTimeout(() => ov.remove(), 200);
  }

  window.openViewSettings = openSettings;

  // ── Синхронизация с сервером (между устройствами) ──────────────
  async function syncFromServer() {
    try {
      const r = await fetch(`${API}?m=UserPrefs&a=get`, { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = await r.json();
      const srv = d?.data?.view_settings;
      if (srv && typeof srv === 'object') {
        _s = Object.assign({}, DEFAULTS, srv);
        try { localStorage.setItem(KEY, JSON.stringify(_s)); } catch (_) {}
        apply(_s);
      }
    } catch (_) {}
  }

  // ── Кнопка настроек в шапке (для всех пользователей) ───────────
  function mountButton() {
    const badge = document.getElementById('userBadge');
    if (!badge || document.getElementById('setGearBtn')) return;
    injectCss();
    const btn = document.createElement('button');
    btn.id = 'setGearBtn';
    btn.className = 'set-gear';
    btn.title = 'Настройки внешнего вида';
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>' +
      '<line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>' +
      '<line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>' +
      '<line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>' +
      '</svg>';
    btn.addEventListener('click', e => { e.stopPropagation(); openSettings(); });

    const logout = document.getElementById('btnLogout');
    const gear   = document.getElementById('admGearBtn'); // если есть админская — ставим перед ней
    const before = gear || logout;
    if (before) badge.insertBefore(btn, before);
    else badge.appendChild(btn);
  }

  // ── Инициализация ──────────────────────────────────────────────
  injectCss();
  apply(_s);                 // мгновенно из localStorage — без мигания
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => { mountButton(); syncFromServer(); }, 300);
  } else {
    window.addEventListener('load', () => setTimeout(() => { mountButton(); syncFromServer(); }, 300));
  }
})();