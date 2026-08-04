
// ── Склонение числительных ────────────────────────────────────
function plural(n, one, few, many) {
  const mod10  = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
// plural(1, 'шаблон', 'шаблона', 'шаблонов') - 'шаблон'
// plural(2, 'шаблон', 'шаблона', 'шаблонов') - 'шаблона'
// plural(11,'шаблон', 'шаблона', 'шаблонов') - 'шаблонов'

// ════════════════════════════════════════════════════════════════
//  db_template.js — шаблоны, панель параметров, org-комбобокс
// ════════════════════════════════════════════════════════════════

// ── Избранные шаблоны (localStorage) ─────────────────────────
const TMPL_FAV_KEY = 'sed_tmpl_favs';

function getTmplFavs()        { try { return new Set(JSON.parse(localStorage.getItem(TMPL_FAV_KEY) || '[]')); } catch(_){ return new Set(); } }
function saveTmplFavs(s)      { try { localStorage.setItem(TMPL_FAV_KEY, JSON.stringify([...s])); } catch(_){} }
function isTmplFav(i)         { return getTmplFavs().has(i); }
function toggleTmplFav(i, e)  {
  e.stopPropagation();
  const favs = getTmplFavs();
  const adding = !favs.has(i);
  adding ? favs.add(i) : favs.delete(i);
  saveTmplFavs(favs);

  const btn = document.querySelector(`.tmpl-fav-btn[data-fav-idx="${i}"]`);
  if (btn) {
    btn.classList.toggle('active', adding);
    // Убираем предыдущие анимации
    btn.classList.remove('animating-on', 'animating-off', 'pop');
    void btn.offsetWidth; // reflow
    btn.classList.add(adding ? 'animating-on' : 'animating-off');
    btn.addEventListener('animationend', () => {
      btn.classList.remove('animating-on', 'animating-off');
    }, { once: true });

    if (adding) _burstParticles(btn);
  }

  // Синхронизируем с сервером
  if (typeof prefsSaveFavs === 'function') prefsSaveFavs();

  if (!adding) {
    // При удалении — анимируем исчезновение из группы «Избранное»
    const cards = document.querySelectorAll(`.tmpl-card[id="tmplcard_${i}"]`);
    if (cards.length > 1) {
      cards[0].classList.add('removing');
      setTimeout(() => {
        const q2 = document.getElementById('tmplSearch')?.value || '';
        renderTemplates(q2);
      }, 280);
      return;
    }
  }

  const q = document.getElementById('tmplSearch')?.value || '';
  renderTemplates(q);
}

function _burstParticles(btn) {
  const rect = btn.getBoundingClientRect();
  const cx   = rect.left + rect.width  / 2;
  const cy   = rect.top  + rect.height / 2;

  // 8 частиц: чередуем звёздочки и кружки
  const shapes = ['★','✦','•','★','✦','•','★','✦'];
  const count  = shapes.length;

  for (let i = 0; i < count; i++) {
    const el   = document.createElement('span');
    const angle = (i / count) * 360 - 90; // начинаем сверху
    const rad  = (angle * Math.PI) / 180;
    const dist = 22 + Math.random() * 14;
    const dx   = Math.cos(rad) * dist;
    const dy   = Math.sin(rad) * dist;
    const size = i % 2 === 0 ? 11 : 7;
    const delay = i * 18;

    el.className = 'star-burst-particle';
    el.textContent = shapes[i];
    el.style.cssText = [
      `left:${cx}px`, `top:${cy}px`,
      `font-size:${size}px`, `color:#f59e0b`,
      `transform:translate(-50%,-50%)`,
    ].join(';');

    document.body.appendChild(el);

    el.animate([
      {
        transform: `translate(-50%,-50%) scale(0)`,
        opacity: 0, offset: 0,
      },
      {
        transform: `translate(-50%,-50%) scale(1.3)`,
        opacity: 1, offset: 0.15,
      },
      {
        transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.7)`,
        opacity: 0.9, offset: 0.5,
      },
      {
        transform: `translate(calc(-50% + ${dx * 1.5}px), calc(-50% + ${dy * 1.5}px)) scale(0)`,
        opacity: 0, offset: 1,
      },
    ], {
      duration: 520,
      delay,
      easing: 'cubic-bezier(0,.5,.5,1)',
      fill: 'forwards',
    }).onfinish = () => el.remove();
  }
}

// ── Рендер списка шаблонов ────────────────────────────────────
function renderTemplates(filter = '') {
  const tmplList = document.getElementById('templateList');
  const q        = filter.trim();
  const isAdmin  = isCurrentUserAdmin();
  const favs     = getTmplFavs();

  let list = TEMPLATES.map((t, i) => ({ ...t, _i: i }));
  list = list.filter(t => !t.adminOnly || isAdmin);
  if (q) list = list.filter(t => matchSearch(t.cat + ' ' + t.title + ' ' + t.desc, q));

  if (!list.length) {
    const countEl = document.getElementById('tmplCount');
    if (countEl) countEl.textContent = q ? `0 из ${TEMPLATES.length} ${plural(TEMPLATES.length,"шаблона","шаблонов","шаблонов")}` : `${TEMPLATES.length} ${plural(TEMPLATES.length,"шаблон","шаблона","шаблонов")}`;
    tmplList.innerHTML = '<div class="placeholder" style="height:80px;font-size:12px">Не найдено</div>';
    return;
  }

  function cardHtml(t) {
    const isFav = favs.has(t._i);
    const dangerBadge = t.danger ? `<span class="tmpl-danger-badge">⚠ Тяжёлый запрос</span>` : '';
    return `<div class="tmpl-card${t.danger?' tmpl-card-danger':''}" id="tmplcard_${t._i}" data-tmpl-idx="${t._i}">
      <button class="tmpl-fav-btn${isFav?' active':''}" data-fav-idx="${t._i}" title="${isFav?'Убрать из избранного':'В избранное'}">★</button>
      <div class="tmpl-title">${escHtml(t.title)}${dangerBadge}</div>
      <div class="tmpl-desc">${escHtml(t.desc)}</div>
    </div>`;
  }

  let html = '';

  // ── Группа «Избранное» (только если есть и нет поискового фильтра) ──
  if (!q) {
    const favItems = list.filter(t => favs.has(t._i));
    if (favItems.length) {
      html += `<div class="section-lbl" style="color:var(--c-accent);background:var(--c-accent-bg);border-bottom:1px solid var(--c-accent-border);padding-bottom:8px">⭐ Избранное</div>`;
      favItems.forEach(t => { html += cardHtml(t); });
    }
  }

  // ── Остальные категории (без избранных) ─────────────────────
  const cats = {};
  list.filter(t => !favs.has(t._i)).forEach(t => { if (!cats[t.cat]) cats[t.cat] = []; cats[t.cat].push(t); });
  for (const [cat, items] of Object.entries(cats)) {
    html += `<div class="tmpl-section-hdr">${escHtml(cat)}</div>`;
    items.forEach(t => { html += cardHtml(t); });
  }

  // Обновляем счётчик
  const countEl = document.getElementById('tmplCount');
  if (countEl) {
    const visibleCount = list.length;
    const totalCount   = TEMPLATES.filter(t => !t.adminOnly || isCurrentUserAdmin()).length;
    countEl.textContent = q
      ? `${visibleCount} из ${totalCount} ${plural(totalCount,"шаблона","шаблонов","шаблонов")}`
      : `${totalCount} ${plural(totalCount,"шаблон","шаблона","шаблонов")}`;
  }

  tmplList.innerHTML = html;

  // Event delegation: клик по карточке (не по звезде)
  tmplList.querySelectorAll('.tmpl-card[data-tmpl-idx]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.tmpl-fav-btn')) return;
      selectTemplate(parseInt(el.dataset.tmplIdx));
    });
  });

  // Клик по звезде
  tmplList.querySelectorAll('.tmpl-fav-btn').forEach(btn => {
    btn.addEventListener('click', e => toggleTmplFav(parseInt(btn.dataset.favIdx), e));
  });
}

function selectTemplate(i) {
  // Сохраняем черновик SQL если пользователь его редактировал
  const curSql = document.getElementById('sqlEditor')?.value?.trim();
  if (curSql && _sqlManuallyEdited) {
    try { sessionStorage.setItem('sed_sql_draft', JSON.stringify({ sql: curSql, ts: Date.now() })); } catch (_) {}
  }

  const t = TEMPLATES[i];
  if (t.adminOnly && !isCurrentUserAdmin()) {
    alert('Этот шаблон доступен только администраторам.'); return;
  }
  state.selectedTmpl = i;
  state.currentTable = null;
  state.hiddenColumns = new Set();
  document.querySelectorAll('.tmpl-card').forEach(el => el.classList.remove('active-tmpl'));
  document.getElementById('tmplcard_' + i)?.classList.add('active-tmpl');

  document.getElementById('currentTable').textContent     = t.title;
  document.getElementById('paramTemplateName').textContent = '— ' + t.title;
  document.getElementById('paramPanel').style.display     = '';
  document.getElementById('paramErrors').style.display    = 'none';
  document.getElementById('toolbarFilters').classList.add('hidden');

  const saved = loadTmplParams(i);
  const values = {};
  t.params.forEach(p => {
    values[p.key] = saved[p.key] ?? (p.key === 'limit' ? '50' : p.default ?? '');
  });
  state.tmplParams[i] = { ...values };

  const limitP = t.params.find(p => p.key === 'limit');
  if (limitP) {
    const savedLimit = values['limit'] || limitP.default || '100';
    const sel  = document.getElementById('limitSelect');
    const opts = [...sel.options].map(o => o.value);
    sel.value  = opts.includes(savedLimit) ? savedLimit : '100';
  }

  const visibleParams = t.params.filter(p => p.key !== 'limit');
  if (visibleParams.length === 0) {
    document.getElementById('paramPanel').style.display = 'none';
    const { sql: autoSql } = compileTemplate(t.sqlTemplate, t.params, values, true);
    document.getElementById('sqlEditor').value = autoSql;
    autoResizeSQL(); toggleSqlBar(true); execQuery(autoSql);
    return;
  }

  renderParamFields(t, values);
  if (t.params.some(p => p.type === 'org') && state.orgList === null) loadOrgList();
  const { sql } = compileTemplate(t.sqlTemplate, t.params, values, false);
  document.getElementById('sqlEditor').value = sql;
  toggleSqlBar(true);
  state.dateColumn = detectDateColumn(t.baseTable, null);
  updateDateUI(state.dateColumn);
  document.getElementById('toolbarFilters').classList.add('hidden');
}

function renderParamFields(t, values) {
  const fieldsDiv     = document.getElementById('paramFields');
  const displayParams = t.params.filter(p => p.key !== 'limit');
  fieldsDiv.innerHTML = displayParams.map(p => {
    const val      = values[p.key] ?? '';
    const reqClass = p.required ? ' req' : '';
    const w        = p.width ? `style="width:${p.width}"` : '';
    let input = '';
    switch (p.type) {
      case 'org':
        input = buildOrgComboHTML(p, val); break;
      case 'date':
        input = `<input type="date" id="param_${p.key}" value="${escHtml(val)}" oninput="onParamInput('${p.key}',this.value)">`; break;
      case 'int':
        input = `<input type="number" id="param_${p.key}" value="${escHtml(val)}" placeholder="${p.default||''}" ${w} oninput="onParamInput('${p.key}',this.value)">`; break;
      case 'like':
      case 'text':
        input = `<input type="text" id="param_${p.key}" value="${escHtml(val)}" placeholder="${p.hint||''}" ${w||'style="width:180px"'} oninput="onParamInput('${p.key}',this.value)">`; break;
      case 'ids':
        input = `<textarea id="param_${p.key}" placeholder="1,2,3 или по одному на строку" rows="2"
          style="height:52px;resize:vertical;font-family:var(--font-mono);font-size:12px;padding:6px 10px;border:1px solid var(--c-border);border-radius:var(--r-sm);outline:none;transition:border-color .15s;width:${p.width||'220px'}"
          oninput="onParamInput('${p.key}',this.value)">${escHtml(val)}</textarea>`; break;
      default:
        input = `<input type="text" id="param_${p.key}" value="${escHtml(val)}" ${w} oninput="onParamInput('${p.key}',this.value)">`;
    }
    const hint = p.hint ? `<div class="param-hint">${escHtml(p.hint)}</div>` : '';
    return `<div class="param-field${reqClass}" id="pfield_${p.key}">
      <label for="param_${p.key}">${escHtml(p.label)}</label>
      ${input}${hint}
    </div>`;
  }).join('');
}

// ── ORG COMBOBOX ──────────────────────────────────────────────
let _comboOpen = null;

function orgLabel(val) {
  if (!val) return '';
  const o = state.orgList?.find(x => String(x.id) === String(val));
  return o ? ((o.short_name || o.name).substring(0, 48) + ' (' + o.id + ')') : String(val);
}

function buildComboItems(key, q, selectedVal) {
  if (!state.orgList) return '<div class="org-combo-msg">⟳ Загрузка...</div>';
  if (!state.orgList.length) return '<div class="org-combo-msg">Нет данных</div>';
  const lq = q.toLowerCase().trim();
  let items = lq
    ? state.orgList.filter(o => matchSearch((o.short_name || '') + ' ' + (o.name || ''), lq) || String(o.id).includes(lq))
    : state.orgList;
  let manualOpt = '';
  if (lq && /^\d+$/.test(lq) && !items.find(o => String(o.id) === lq)) {
    manualOpt = `<div class="org-combo-opt" data-val="${lq}" onmousedown="comboSelect(event,'${key}','${lq}')" onmouseenter="comboHover(this)" style="font-style:italic;color:var(--c-accent)">Применить ID: <strong>${lq}</strong></div>`;
  }
  if (!items.length && !manualOpt) return '<div class="org-combo-msg">Не найдено · введите ID вручную</div>';
  const shown = items.slice(0, 120);
  const more  = items.length > 120 ? `<div class="org-combo-msg">+ ещё ${items.length - 120} — уточните поиск</div>` : '';
  return manualOpt + shown.map(o => {
    const lbl = escHtml(((o.short_name || o.name) || '').substring(0, 52));
    const cls = String(o.id) === String(selectedVal) ? ' sel' : '';
    return `<div class="org-combo-opt${cls}" data-val="${o.id}" onmousedown="comboSelect(event,'${key}','${o.id}')" onmouseenter="comboHover(this)">${lbl} <span style="color:var(--c-text-3);font-size:11px">(${o.id})</span></div>`;
  }).join('') + more;
}

function buildOrgComboHTML(p, val) {
  const displayVal = val ? orgLabel(val) : '— выберите —';
  return `<div class="org-combo" id="combo_${p.key}" data-val="${escHtml(val || '')}">
    <div class="org-combo-val" onclick="comboToggle('${p.key}')">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${escHtml(displayVal)}</span>
      <span class="org-combo-arrow">▾</span>
    </div>
    <div class="org-combo-drop">
      <input class="org-combo-search" type="text" placeholder="Поиск или введите ID..."
        id="combosearch_${p.key}"
        oninput="comboFilter('${p.key}',this.value)"
        onkeydown="comboKeyDown('${p.key}',event)">
      <div class="org-combo-list" id="combolist_${p.key}"></div>
    </div>
  </div>`;
}
function buildOrgSelectHTML(p, val) { return buildOrgComboHTML(p, val); }

function comboToggle(key) {
  const combo = document.getElementById('combo_' + key);
  if (!combo) return;
  const wasOpen = combo.classList.contains('open');
  comboCloseAll();
  if (!wasOpen) {
    combo.classList.add('open'); _comboOpen = key;
    const si = document.getElementById('combosearch_' + key);
    if (si) { si.value = ''; si.focus(); }
    comboFilter(key, '');
  }
}

function comboCloseAll() {
  document.querySelectorAll('.org-combo.open').forEach(el => el.classList.remove('open'));
  _comboOpen = null;
}

function comboFilter(key, q) {
  const combo = document.getElementById('combo_' + key);
  const val   = combo ? combo.dataset.val : '';
  const list  = document.getElementById('combolist_' + key);
  if (list) list.innerHTML = buildComboItems(key, q, val);
}

function comboSelect(e, key, val) {
  if (e) e.preventDefault();
  const combo = document.getElementById('combo_' + key);
  if (combo) combo.dataset.val = val;
  const display = combo?.querySelector('.org-combo-val');
  if (display) {
    const span = display.querySelector('span:first-child');
    if (span) span.textContent = orgLabel(val) || '— выберите —';
  }
  comboCloseAll();
  onParamInput(key, val);
}

function comboHover(el) {
  el.closest('.org-combo-list')?.querySelectorAll('.kb').forEach(x => x.classList.remove('kb'));
  el.classList.add('kb');
}

function comboKeyDown(key, e) {
  const list  = document.getElementById('combolist_' + key);
  if (!list) return;
  const items   = [...list.querySelectorAll('.org-combo-opt')];
  const focused = list.querySelector('.kb');
  let idx = focused ? items.indexOf(focused) : -1;
  if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (focused) comboSelect(null, key, focused.dataset.val);
    else {
      const si = document.getElementById('combosearch_' + key);
      const mv = si ? si.value.trim() : '';
      if (mv && /^\d+$/.test(mv)) comboSelect(null, key, mv);
      else if (items[0]) comboSelect(null, key, items[0].dataset.val);
    }
    return;
  } else if (e.key === 'Escape') { comboCloseAll(); return; }
  else return;
  items.forEach(x => x.classList.remove('kb'));
  if (items[idx]) { items[idx].classList.add('kb'); items[idx].scrollIntoView({ block: 'nearest' }); }
}

document.addEventListener('mousedown', e => {
  if (_comboOpen && !e.target.closest('.org-combo')) comboCloseAll();
});

// ── Панель параметров ─────────────────────────────────────────
function onParamInput(key, value) {
  if (state.selectedTmpl < 0) return;
  const i = state.selectedTmpl;
  if (!state.tmplParams[i]) state.tmplParams[i] = {};
  state.tmplParams[i][key] = value;
  saveTmplParams(i, state.tmplParams[i]);
  document.getElementById('pfield_' + key)?.classList.remove('err');
  document.getElementById('paramErrors').style.display = 'none';
  const t = TEMPLATES[i];
  const allVals = getParamValues(t);
  const { sql } = compileTemplate(t.sqlTemplate, t.params, allVals, false);
  document.getElementById('sqlEditor').value = sql;
  autoResizeSQL();
  if (key === 'limit') {
    const sel = document.getElementById('limitSelect');
    if (sel) {
      const opts = [...sel.options].map(o => o.value);
      if (opts.includes(value)) sel.value = value;
    }
  }
}

function getParamValues(t) {
  const saved = state.tmplParams[state.selectedTmpl] || {};
  const vals  = {};
  t.params.forEach(p => {
    if (p.type === 'org') {
      const combo = document.getElementById('combo_' + p.key);
      vals[p.key] = combo ? combo.dataset.val : (saved[p.key] ?? p.default ?? '');
    } else {
      const el     = document.getElementById('param_' + p.key);
      const domVal = el ? el.value : null;
      vals[p.key]  = (domVal !== null && domVal !== '') ? domVal : (saved[p.key] ?? p.default ?? '');
    }
  });
  return vals;
}

function compileTemplate(sqlTemplate, params, values, strict = true) {
  let sql = sqlTemplate;
  const errors = [];

  // Обрабатываем условные блоки {{#key}}...{{/key}}
  // Если значение есть — оставляем содержимое блока (без тегов)
  // Если значения нет — убираем весь блок
  for (const p of params) {
    const val = String(values[p.key] ?? '').trim();
    const blockRe = new RegExp(`\\{\\{#${p.key}\\}\\}([\\s\\S]*?)\\{\\{/${p.key}\\}\\}`, 'g');
    if (val) {
      sql = sql.replace(blockRe, '$1'); // есть значение — оставляем содержимое
    } else {
      sql = sql.replace(blockRe, '');   // нет значения — убираем весь блок
    }
  }

  for (const p of params) {
    const val = String(values[p.key] ?? '').trim();
    const ph  = `{{${p.key}}}`;
    if (!val) {
      if (p.required && strict) { errors.push(`Заполните «${p.label}»`); continue; }
      sql = replaceAll(sql, ph, 'NULL'); continue;
    }
    switch (p.type) {
      case 'int': case 'org': {
        const n = parseInt(val);
        if (isNaN(n)) { errors.push(`«${p.label}» должно быть числом`); continue; }
        sql = replaceAll(sql, ph, String(n)); break;
      }
      case 'date': {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) { errors.push(`«${p.label}» неверный формат (YYYY-MM-DD)`); continue; }
        sql = replaceAll(sql, ph, `'${val}'`); break;
      }
      case 'ids': {
        const ids = val.split(/[,\n]+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
        sql = replaceAll(sql, ph, ids.length ? ids.join(',') : 'NULL'); break;
      }
      case 'like': {
        const esc     = val.replace(/'/g, "''");
        const pattern = val.includes('%') ? esc : `%${esc}%`;
        sql = replaceAll(sql, ph, `'${pattern}'`); break;
      }
      default: {
        sql = replaceAll(sql, ph, `'${val.replace(/'/g, "''")}'`);
      }
    }
  }
  return { sql, errors };
}

function buildAndShowSQL() {
  if (state.selectedTmpl < 0) return;
  const t    = TEMPLATES[state.selectedTmpl];
  const vals = getParamValues(t);
  const { sql } = compileTemplate(t.sqlTemplate, t.params, vals, false);
  document.getElementById('sqlEditor').value = sql;
  autoResizeSQL();
}

function runTemplateQuery() {
  if (state.selectedTmpl < 0) return;

  // Если пользователь вручную редактировал SQL в редакторе — выполняем именно его версию, не перекомпилируем из параметров.
  if (_sqlManuallyEdited) {
    const editedSql = document.getElementById('sqlEditor').value.trim();
    if (editedSql) {
      document.getElementById('paramErrors').style.display = 'none';
      execQuery(editedSql);
      return;
    }
  }

  const t    = TEMPLATES[state.selectedTmpl];
  const vals = getParamValues(t);
  const { sql, errors } = compileTemplate(t.sqlTemplate, t.params, vals, true);
  t.params.forEach(p => document.getElementById('pfield_' + p.key)?.classList.remove('err'));
  if (errors.length) {
    t.params.filter(p => p.required).forEach(p => {
      if (!String(vals[p.key] ?? '').trim())
        document.getElementById('pfield_' + p.key)?.classList.add('err');
    });
    const errDiv = document.getElementById('paramErrors');
    errDiv.style.display = '';
    errDiv.innerHTML = '<strong>Ошибки:</strong> ' + errors.map(e => escHtml(e)).join(' &nbsp;·&nbsp; ');
    return;
  }
  document.getElementById('paramErrors').style.display = 'none';
  document.getElementById('sqlEditor').value = sql;
  autoResizeSQL();
  execQuery(sql);
}

function resetTemplateParams() {
  if (state.selectedTmpl < 0) return;
  const i = state.selectedTmpl;
  delete state.tmplParams[i];
  try { sessionStorage.removeItem(`sed_tp_${i}`); } catch (_) {}
  selectTemplate(i);
}

function closeParamPanel() {
  document.getElementById('paramPanel').style.display = 'none';
  document.getElementById('toolbarFilters').classList.remove('hidden');
  toggleSqlBar(false);
  document.querySelectorAll('.tmpl-card').forEach(el => el.classList.remove('active-tmpl'));
  comboCloseAll();
  state.selectedTmpl = -1;
}

// ── Сохранение параметров шаблона (sessionStorage(Это в сесси а не в бд)) ────────────
function saveTmplParams(i, vals) {
  try { sessionStorage.setItem(`sed_tp_${i}`, JSON.stringify(vals)); } catch (_) {}
}
function loadTmplParams(i) {
  try { const s = sessionStorage.getItem(`sed_tp_${i}`); return s ? JSON.parse(s) : {}; } catch (_) { return {}; }
}