// ════════════════════════════════════════════════════════════════
//  db_sqledit.js — улучшенный SQL-редактор
//  • живая подсветка синтаксиса (KW / FN / строки / числа / коммент.)
//  • автодополнение по Tab (ключевые слова + таблицы + колонки)
//  • авто-отступы при Enter, автозакрытие скобок
//  • форматирование запроса (кнопка «Формат» / Shift+Alt+F)
//
//  Модуль самодостаточный, грузится последним — его обработчики
//  перекрывают старые заглушки подсветки, ничего не ломая.
// ════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── Словари ────────────────────────────────────────────────────
  const KEYWORDS = [
    'SELECT','FROM','WHERE','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS',
    'ON','AND','OR','NOT','IN','BETWEEN','LIKE','ILIKE','SIMILAR','IS','NULL',
    'AS','DISTINCT','GROUP','ORDER','BY','HAVING','LIMIT','OFFSET','FETCH','FIRST',
    'WITH','RECURSIVE','UNION','INTERSECT','EXCEPT','ALL','ANY','SOME','CASE',
    'WHEN','THEN','ELSE','END','EXISTS','INTO','VALUES','USING','LATERAL','RETURNING',
    'ASC','DESC','NULLS','OVER','PARTITION','WINDOW','FILTER','TRUE','FALSE',
    'INTERVAL','DATE','TIME','TIMESTAMP','BOOLEAN','INTEGER','BIGINT','TEXT','NUMERIC',
  ];
  const FUNCS = [
    'COUNT','SUM','AVG','MIN','MAX','COALESCE','NULLIF','GREATEST','LEAST','CAST',
    'TO_CHAR','TO_DATE','TO_TIMESTAMP','TO_NUMBER','NOW','CURRENT_DATE','AGE',
    'CURRENT_TIMESTAMP','LOCALTIMESTAMP','DATE_TRUNC','DATE_PART','EXTRACT','MAKE_DATE',
    'SUBSTRING','SUBSTR','TRIM','BTRIM','LTRIM','RTRIM','LOWER','UPPER','INITCAP',
    'LENGTH','CHAR_LENGTH','REPLACE','SPLIT_PART','POSITION','LPAD','RPAD','LEFT','RIGHT',
    'CONCAT','CONCAT_WS','FORMAT','ARRAY_AGG','STRING_AGG','JSONB_AGG','JSON_AGG',
    'ROW_NUMBER','RANK','DENSE_RANK','NTILE','LAG','LEAD','FIRST_VALUE','LAST_VALUE',
    'ABS','ROUND','CEIL','FLOOR','MOD','POWER','SQRT','RANDOM','GENERATE_SERIES','UNNEST',
  ];
  const KW_SET = new Set(KEYWORDS);
  const FN_SET = new Set(FUNCS);

  // Ключевые слова, после которых форматтер начинает новую строку
  const NEWLINE_KW = [
    'SELECT','FROM','WHERE','GROUP BY','ORDER BY','HAVING','LIMIT','OFFSET',
    'UNION ALL','UNION','INTERSECT','EXCEPT','LEFT JOIN','RIGHT JOIN','INNER JOIN',
    'FULL JOIN','CROSS JOIN','JOIN','ON','AND','OR','WITH','RETURNING','WINDOW',
  ];

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Токенизатор подсветки ──────────────────────────────────────
  const TOK = new RegExp([
    '(\\/\\*[\\s\\S]*?\\*\\/|--[^\\n]*)',           // 1 комментарий
    "('(?:[^']|'')*'?)",                           // 2 строка '...'
    '("(?:[^"]|"")*"?)',                           // 3 идентификатор "..."
    '(\\b\\d+(?:\\.\\d+)?\\b)',                     // 4 число
    '([A-Za-z_\\u0400-\\u04FF][A-Za-z0-9_\\u0400-\\u04FF]*)', // 5 слово
    '([=<>!+\\-*\\/%|~^&]+)',                       // 6 оператор
  ].join('|'), 'g');

  function highlight(sql) {
    let out = '', last = 0, m;
    TOK.lastIndex = 0;
    while ((m = TOK.exec(sql))) {
      out += esc(sql.slice(last, m.index));
      const t = m[0];
      if (m[1])      out += `<span class="sql-cm">${esc(t)}</span>`;
      else if (m[2] || m[3]) out += `<span class="sql-str">${esc(t)}</span>`;
      else if (m[4]) out += `<span class="sql-num">${esc(t)}</span>`;
      else if (m[5]) {
        const up = t.toUpperCase();
        if (KW_SET.has(up))      out += `<span class="sql-kw">${esc(t)}</span>`;
        else if (FN_SET.has(up)) out += `<span class="sql-fn">${esc(t)}</span>`;
        else                     out += esc(t);
      }
      else if (m[6]) out += `<span class="sql-op">${esc(t)}</span>`;
      else           out += esc(t);
      last = m.index + t.length;
    }
    out += esc(sql.slice(last));
    return out;
  }
  window.__sqlHighlight = highlight; // на случай переиспользования

  // ── Форматтер ──────────────────────────────────────────────────
  // Лёгкий, не идеальный SQL-formatter: переносы перед ключевыми
  // словами + отступы для AND/OR и тела SELECT. Строки и комментарии
  // не трогаются (заменяются плейсхолдерами на время обработки).
  function formatSQL(sql) {
    if (!sql.trim()) return sql;

    // 1. Прячем строки и комментарии
    const stash = [];
    let s = sql.replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|--[^\n]*/g, (x) => {
      stash.push(x);
      return `\u0000${stash.length - 1}\u0000`;
    });

    // 2. Схлопываем пробелы
    s = s.replace(/\s+/g, ' ').trim();

    // 3. Аплифт ключевых слов (двусловные раньше односложных)
    const twoWord = ['GROUP BY','ORDER BY','UNION ALL','LEFT JOIN','RIGHT JOIN',
      'INNER JOIN','FULL JOIN','CROSS JOIN'];
    twoWord.forEach(kw => {
      s = s.replace(new RegExp('\\b' + kw.replace(' ', '\\s+') + '\\b', 'gi'), kw);
    });

    // 4. Переносы. JOIN — отдельным проходом (ловим префикс целиком,
    //    чтобы LEFT JOIN не разрывался на две строки).
    s = s.replace(
      /\s*\b((?:LEFT|RIGHT|INNER|FULL|CROSS)(?:\s+OUTER)?\s+)?JOIN\b/gi,
      (m) => '\n' + m.trim().replace(/\s+/g, ' ').toUpperCase()
    );
    const breakKw = ['SELECT','FROM','WHERE','GROUP BY','ORDER BY','HAVING','LIMIT',
      'OFFSET','UNION ALL','UNION','INTERSECT','EXCEPT','RETURNING'];
    breakKw.forEach(kw => {
      s = s.replace(new RegExp('\\s*\\b' + kw + '\\b', 'gi'), '\n' + kw.toUpperCase());
    });
    // ON / AND / OR — с отступом
    s = s.replace(/\s*\bON\b/gi, '\n  ON');
    s = s.replace(/\s*\bAND\b/gi, '\n  AND');
    s = s.replace(/\s*\bOR\b/gi, '\n  OR');

    // 5. Колонки в SELECT: перенос после запятых верхнего уровня
    const lines = s.split('\n').map(line => {
      const head = line.match(/^(SELECT|GROUP BY|ORDER BY)\b/i);
      if (!head) return line;
      const kw = head[0];
      let rest = line.slice(kw.length).trim();
      if (kw.toUpperCase() === 'SELECT' && /^DISTINCT\b/i.test(rest)) {
        return splitCols('SELECT DISTINCT', rest.replace(/^DISTINCT\s*/i, ''));
      }
      return splitCols(kw.toUpperCase(), rest);
    });

    let out = lines.join('\n').replace(/^\n+/, '').trim();

    // 6. Возврат строк/комментариев
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
    return out;
  }

  // Разбивает список колонок по запятым верхнего уровня (учёт скобок)
  function splitCols(kw, rest) {
    if (!rest) return kw;
    const parts = [];
    let depth = 0, buf = '';
    for (const ch of rest) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; }
      else buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    if (parts.length <= 1) return kw + ' ' + rest.trim();
    return kw + '\n  ' + parts.join(',\n  ');
  }
  window.__sqlFormat = formatSQL;

  // ════════════════════════════════════════════════════════════════
  //  Схема БД для автодополнения (таблицы + их колонки)
  // ════════════════════════════════════════════════════════════════
  // schemaCols = { "document": ["id","cdate",...], ... }
  let schemaCols = {};
  let allCols = [];          // плоский уникальный список всех колонок
  let schemaLoaded = false;
  let schemaLoading = false;

  // Сброс кэша схемы — вызывается при смене источника БД или схемы CHED
  window.__resetSqlSchema = function () {
    schemaCols = {};
    allCols = [];
    schemaLoaded = false;
    schemaLoading = false;
  };

  function apiUrl() {
    return (window.APP_CONFIG && window.APP_CONFIG.apiUrl) || '/index.php';
  }

  async function loadSchema() {
    if (schemaLoaded || schemaLoading) return;
    schemaLoading = true;
    const schema = (window.state && (state.currentDb === 'ched' || state.currentDb === 'ched2' || state.currentDb === 'ksp') && state.chedSchema)
      ? state.chedSchema : 'public';
    const sql =
      "SELECT table_name, column_name " +
      "FROM information_schema.columns " +
      "WHERE table_schema = '" + schema.replace(/'/g, "''") + "' " +
      "ORDER BY table_name, ordinal_position";
    try {
      const resp = await fetch(apiUrl() + '?m=Remote&a=preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sql, mode: 'preview', limit: 50000 }),
      });
      if (!resp.ok) { schemaLoading = false; return; }
      const data = JSON.parse(await resp.text());
      if (!data || !data.ok || !Array.isArray(data.rows)) { schemaLoading = false; return; }
      const map = {};
      const colSet = new Set();
      for (const r of data.rows) {
        const t = r.table_name, c = r.column_name;
        if (!t || !c) continue;
        (map[t] = map[t] || []).push(c);
        colSet.add(c);
      }
      schemaCols = map;
      allCols = Array.from(colSet);
      schemaLoaded = true;
    } catch (_) { /* тихо — автокомплит просто будет без колонок */ }
    schemaLoading = false;
  }

  // Резолвит алиас/имя таблицы перед точкой в реальное имя таблицы.
  function resolveAlias(sqlText, alias) {
    const a = alias.toLowerCase();
    // FROM document d   |   JOIN usr AS u   |   FROM document
    const re = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)\s*(?:(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
    let m;
    while ((m = re.exec(sqlText))) {
      const table = m[1], al = m[2];
      // ключевые слова, которые не являются алиасами
      if (al && ['on','where','left','right','inner','full','cross','join','group',
        'order','limit','using','and','or'].includes(al.toLowerCase())) {
        if (table.toLowerCase() === a && schemaCols[table]) return table;
        continue;
      }
      if (al && al.toLowerCase() === a && schemaCols[table]) return table;
      if (!al && table.toLowerCase() === a && schemaCols[table]) return table;
    }
    // прямое совпадение с именем таблицы
    for (const t in schemaCols) if (t.toLowerCase() === a) return t;
    return null;
  }

  // ════════════════════════════════════════════════════════════════
  //  DOM-логика (выполняется когда редактор уже на странице)
  // ════════════════════════════════════════════════════════════════
  function init() {
    const ta = document.getElementById('sqlEditor');
    const hl = document.getElementById('sqlHighlight');
    const wrap = document.getElementById('sqlEditorWrap');
    if (!ta || !hl || ta.__sqleditReady) return;
    ta.__sqleditReady = true;

    // ── Рендер подсветки ───────────────────────────────────────
    // Идемпотентный рендер: ставит цветную разметку, только если
    // текущее содержимое отличается (защита от циклов).
    function render() {
      const want = highlight(ta.value) + '\n';
      if (hl.innerHTML !== want) hl.innerHTML = want;
      hl.scrollTop = ta.scrollTop;
    }
    ta.addEventListener('input', render);
    ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; });

    // Другие модули (db_app/db_utils) навешивают свой плоский рендер
    try {
      const obs = new MutationObserver(render);
      obs.observe(hl, { childList: true, characterData: true, subtree: true });
    } catch (_) {}

    // Перехват программной установки value (шаблоны, история и т.п.)
    try {
      const proto = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(ta), 'value'
      ) || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      Object.defineProperty(ta, 'value', {
        get() { return proto.get.call(this); },
        set(v) { proto.set.call(this, v); render(); },
        configurable: true,
      });
    } catch (_) {}

    render();

    // ── Автокомплит-попап ──────────────────────────────────────
    const pop = document.createElement('div');
    pop.id = 'sqlAutocomplete';
    pop.style.display = 'none';
    document.body.appendChild(pop);
    let acItems = [], acIndex = 0, acStart = 0;

    // Зеркало для вычисления координат каретки
    const mirror = document.createElement('div');
    mirror.id = 'sqlCaretMirror';
    document.body.appendChild(mirror);

    function caretXY() {
      const cs = getComputedStyle(ta);
      ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
       'paddingTop','paddingRight','paddingBottom','paddingLeft',
       'borderTopWidth','borderLeftWidth','whiteSpace','wordWrap','width']
        .forEach(p => { mirror.style[p] = cs[p]; });
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.wordWrap = 'break-word';
      mirror.style.width = ta.clientWidth + 'px';

      const pos = ta.selectionStart;
      const before = ta.value.slice(0, pos);
      mirror.textContent = before;
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      mirror.appendChild(marker);

      const tr = ta.getBoundingClientRect();
      const mr = marker.getBoundingClientRect();
      const mb = mirror.getBoundingClientRect();
      return {
        x: tr.left + (mr.left - mb.left),
        y: tr.top + (mr.top - mb.top) - ta.scrollTop,
        lh: parseFloat(cs.lineHeight) || 18,
      };
    }

    function currentWord() {
      const pos = ta.selectionStart;
      const left = ta.value.slice(0, pos);
      // dotted: alias.col  → ловим часть после точки
      const dot = left.match(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);
      if (dot) {
        return {
          word: dot[2], start: pos - dot[2].length,
          dotted: true, owner: dot[1],
        };
      }
      const m = left.match(/[A-Za-z_][A-Za-z0-9_]*$/);
      return m ? { word: m[0], start: pos - m[0].length } : null;
    }

    function currentWord() {
      const pos = ta.selectionStart;
      const left = ta.value.slice(0, pos);
      // dotted: alias.col  → ловим часть после точки
      const dot = left.match(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);
      if (dot) {
        return {
          word: dot[2], start: pos - dot[2].length,
          dotted: true, owner: dot[1],
        };
      }
      const m = left.match(/[A-Za-z_][A-Za-z0-9_]*$/);
      if (m) return { word: m[0], start: pos - m[0].length };
      // нет слова под курсором — но контекст может предложить следующий шаг
      return { word: '', start: pos, empty: true };
    }

    // Определяет «секцию» запроса по тексту слева от курсора
    function sqlContext(left) {
      const re = /\b(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|ON|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|JOIN|LIMIT|OFFSET|WITH|AND|OR|UNION(?:\s+ALL)?|VALUES|SET|USING)\b/gi;
      let m, kw = null, end = 0;
      while ((m = re.exec(left))) { kw = m[1].toUpperCase().replace(/\s+/g, ' '); end = m.index + m[0].length; }
      return { kw, tail: left.slice(end) };
    }

    function suggestions(cw) {
      // автодополнение можно отключить в настройках
      if (window.sedSqlAutocomplete === false) return [];
      const p = cw.word.toUpperCase();

      // После «алиас.» — только колонки соответствующей таблицы
      if (cw.dotted) {
        const table = resolveAlias(ta.value, cw.owner);
        const cols = table ? (schemaCols[table] || []) : allCols;
        return cols
          .filter(c => c.toUpperCase().startsWith(p) && c.toUpperCase() !== p)
          .slice(0, 14)
          .map(c => ({ v: c, k: 'col' }));
      }

      const tables = (window.state && Array.isArray(state.tables) && state.tables.length)
        ? state.tables.map(t => t.name) : Object.keys(schemaCols);
      const cols = allCols.length ? allCols
        : ((window.state && Array.isArray(state.columns)) ? state.columns : []);

      // Контекст по тексту до начала текущего слова
      const left = ta.value.slice(0, cw.start);
      const ctx = sqlContext(left);
      const isJoin = ctx.kw && /JOIN$/.test(ctx.kw);

      let order, nextKw = [];
      if (!ctx.kw) {
        order = ['next']; nextKw = ['SELECT', 'WITH'];
      } else if (ctx.kw === 'SELECT') {
        order = ['cols', 'funcs', 'next', 'kw']; nextKw = ['DISTINCT', 'FROM'];
      } else if (ctx.kw === 'FROM' || isJoin) {
        const tableTyped = /[A-Za-z_]\w*\s+\S/.test(ctx.tail) || /[A-Za-z_]\w*\s*,/.test(ctx.tail);
        if (cw.empty && /[A-Za-z_]\w*\s+$/.test(ctx.tail)) {
          order = ['next', 'tables']; nextKw = ['LEFT JOIN', 'JOIN', 'WHERE', 'ON', 'GROUP BY', 'ORDER BY', 'LIMIT'];
        } else {
          // ожидается имя таблицы
          order = ['tables', 'next', 'kw']; nextKw = tableTyped ? ['WHERE', 'JOIN', 'LEFT JOIN', 'ORDER BY'] : [];
        }
      } else if (['ON', 'WHERE', 'AND', 'OR', 'HAVING', 'USING'].includes(ctx.kw)) {
        order = ['cols', 'funcs', 'next', 'kw'];
        nextKw = ['AND', 'OR', 'IN', 'NOT', 'LIKE', 'ILIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'EXISTS'];
      } else if (ctx.kw === 'GROUP BY' || ctx.kw === 'ORDER BY') {
        order = ['cols', 'next']; nextKw = ['ASC', 'DESC', 'LIMIT', 'NULLS LAST'];
      } else {
        order = ['kw', 'cols', 'tables', 'funcs']; nextKw = [];
      }

      const cat = {
        tables: tables.map(w => ({ v: w, k: 'tbl' })),
        cols:   cols.map(w => ({ v: w, k: 'col' })),
        funcs:  FUNCS.map(w => ({ v: w + '()', k: 'fn', raw: w })),
        kw:     KEYWORDS.map(w => ({ v: w, k: 'kw' })),
        next:   nextKw.map(w => ({ v: w, k: 'kw' })),
      };

      // Пустой префикс (после пробела): показываем только следующий
      // логичный шаг — next-слова, либо таблицы если их ждём.
      if (cw.empty) {
        let head = [];
        if (order[0] === 'tables') head = cat.tables.slice(0, 8).concat(cat.next);
        else head = cat.next.concat(order.includes('cols') ? [] : []);
        return head.slice(0, 10);
      }

      let pool = [];
      order.forEach(o => { pool = pool.concat(cat[o] || []); });
      // добор остальными категориями для полноты поиска
      ['tables', 'cols', 'kw', 'funcs'].forEach(o => {
        if (!order.includes(o)) pool = pool.concat(cat[o]);
      });

      const seen = new Set();
      const starts = [], contains = [];
      for (const it of pool) {
        const cmp = (it.raw || it.v).toUpperCase();
        if (cmp === p) continue;
        const key = it.k + ':' + it.v;
        if (seen.has(key)) continue;
        if (cmp.startsWith(p)) { seen.add(key); starts.push(it); }
        else if (p.length >= 2 && cmp.includes(p)) { seen.add(key); contains.push(it); }
      }
      return starts.concat(contains).slice(0, 14);
    }

    function showAC() {
      const cw = currentWord();
      if (!cw) return hideAC();
      const list = suggestions(cw);
      if (!list.length) return hideAC();
      acItems = list; acIndex = 0; acStart = cw.start;
      const icon = { kw: 'KW', fn: 'ƒ', tbl: '▦', col: '·' };
      pop.innerHTML = list.map((it, i) =>
        `<div class="ac-item${i === 0 ? ' sel' : ''}" data-i="${i}">
           <span class="ac-ic ac-${it.k}">${icon[it.k]}</span>
           <span class="ac-v">${esc(it.v)}</span>
         </div>`).join('');
      const xy = caretXY();
      pop.style.left = Math.round(xy.x) + 'px';
      pop.style.top = Math.round(xy.y + xy.lh + 2) + 'px';
      pop.style.display = 'block';
      pop.querySelectorAll('.ac-item').forEach(el => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          acIndex = +el.dataset.i; acceptAC();
        });
      });
    }
    function hideAC() { pop.style.display = 'none'; acItems = []; }
    function acOpen() { return pop.style.display === 'block'; }

    function moveAC(d) {
      acIndex = (acIndex + d + acItems.length) % acItems.length;
      pop.querySelectorAll('.ac-item').forEach((el, i) =>
        el.classList.toggle('sel', i === acIndex));
      const sel = pop.querySelector('.ac-item.sel');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }

    function acceptAC() {
      const it = acItems[acIndex];
      if (!it) return hideAC();
      const pos = ta.selectionStart;
      let insert = it.v, caret;
      if (it.k === 'fn') { caret = acStart + (it.raw.length + 1); } // курсор внутри ()
      else { caret = acStart + insert.length; }
      const v = ta.value;
      const proto = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value');
      proto.set.call(ta, v.slice(0, acStart) + insert + v.slice(pos));
      ta.selectionStart = ta.selectionEnd = caret;
      render();
      hideAC();
    }

    // ── Вставка текста с сохранением undo по возможности ────────
    function insertAt(text, selStart, selEnd, caretOffset) {
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
      if (!document.execCommand || !document.execCommand('insertText', false, text)) {
        const v = ta.value;
        const proto = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, 'value');
        proto.set.call(ta, v.slice(0, selStart) + text + v.slice(selEnd));
        const c = selStart + (caretOffset != null ? caretOffset : text.length);
        ta.selectionStart = ta.selectionEnd = c;
      } else if (caretOffset != null) {
        const c = selStart + caretOffset;
        ta.selectionStart = ta.selectionEnd = c;
      }
      render();
    }

    // ── Клавиатура ─────────────────────────────────────────────
    ta.addEventListener('keydown', (e) => {
      // Ctrl+Space / Cmd+Space — вызвать подсказки вручную (как в VS Code)
      if ((e.ctrlKey || e.metaKey) && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        showAC();
        return;
      }

      // Навигация по автокомплиту
      if (acOpen()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveAC(1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); moveAC(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAC(); return; }
        if (e.key === 'Escape')    { e.preventDefault(); hideAC(); return; }
      }

      // Форматирование: Shift+Alt+F
      if (e.altKey && e.shiftKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF')) {
        e.preventDefault();
        doFormat();
        return;
      }

      // Tab — автодополнение или отступ
      if (e.key === 'Tab' && !e.shiftKey) {
        const cw = currentWord();
        if (cw) {
          const list = suggestions(cw);
          if (list.length) {
            e.preventDefault();
            acItems = list; acIndex = 0; acStart = cw.start;
            acceptAC();
            return;
          }
        }
        // нечего предложить → вставляем 2 пробела
        e.preventDefault();
        insertAt('  ', ta.selectionStart, ta.selectionEnd);
        return;
      }

      // Enter — авто-отступ
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const pos = ta.selectionStart;
        const v = ta.value;
        const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
        const line = v.slice(lineStart, pos);
        const indent = (line.match(/^[ \t]*/) || [''])[0];
        const extra = /[(,]\s*$/.test(line.trimEnd() === '' ? line : line) &&
          /[(]\s*$/.test(line) ? '  ' : '';
        e.preventDefault();
        insertAt('\n' + indent + extra, pos, ta.selectionEnd);
        return;
      }

      // Автозакрытие скобок
      if (e.key === '(') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        const sel = ta.value.slice(s, en);
        insertAt('(' + sel + ')', s, en, 1 + sel.length);
        if (sel === '') { ta.selectionStart = ta.selectionEnd = s + 1; }
        return;
      }
      // Пропуск ) поверх автозакрытой
      if (e.key === ')') {
        const pos = ta.selectionStart;
        if (ta.value[pos] === ')' && ta.selectionStart === ta.selectionEnd) {
          e.preventDefault();
          ta.selectionStart = ta.selectionEnd = pos + 1;
          return;
        }
      }
    });

    // Автопоказ — только когда печатаешь слово или после точки.
    // На пустом месте / после пробела сам не лезет (как в VS Code).
    ta.addEventListener('input', () => {
      const cw = currentWord();
      if (cw && (cw.dotted || (!cw.empty && cw.word.length >= 1))) showAC();
      else hideAC();
    });
    ta.addEventListener('blur', () => setTimeout(hideAC, 120));
    ta.addEventListener('scroll', () => { if (acOpen()) showAC(); });

    // Подтягиваем схему БД (таблицы + колонки) при первом фокусе
    ta.addEventListener('focus', () => { loadSchema(); });
    if (window.state && Array.isArray(state.tables) && state.tables.length) loadSchema();

    // ── Кнопка «Формат» ────────────────────────────────────────
    function doFormat() {
      const formatted = formatSQL(ta.value);
      if (formatted === ta.value) return;
      const proto = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value');
      proto.set.call(ta, formatted);
      ta.selectionStart = ta.selectionEnd = formatted.length;
      render();
      if (typeof autoResizeSQL === 'function') autoResizeSQL();
      if (typeof window._sqlManuallyEdited !== 'undefined') window._sqlManuallyEdited = true;
    }

    // (кнопка «Формат» убрана — форматирование доступно по Shift+Alt+F)
  }

  // Редактор может появиться после логина → ждём его
  function boot() {
    if (document.getElementById('sqlEditor')) { init(); return; }
    let tries = 0;
    const iv = setInterval(() => {
      if (document.getElementById('sqlEditor')) { clearInterval(iv); init(); }
      else if (++tries > 60) clearInterval(iv);
    }, 200);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();