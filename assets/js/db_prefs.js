// ════════════════════════════════════════════════════════════════
//  db_prefs.js 
// ════════════════════════════════════════════════════════════════

// ── Сохранить ключ на сервер ──────────────────────────────────
async function prefsSave(key, value) {
  try {
    const r = await fetch(`${API}?m=UserPrefs&a=save`, {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body:        JSON.stringify({ key, value }),
    });
    if (!r.ok) {
      console.warn('[prefs] save failed:', r.status, key);
    }
  } catch(e) {
    console.debug('[prefs] save error:', e.message, key);
  }
}

function prefsSaveFavs()    { prefsSave('tmpl_favs',  [...getTmplFavs()]); }
function prefsSaveTblFavs() { prefsSave('tbl_favs',   [...getTblFavs()]); }

function prefsSaveHistory() {
  try {
    const h = JSON.parse(localStorage.getItem('sed_query_history') || '[]');
    prefsSave('query_history', h.slice(0, 100));
  } catch(_) {}
}

function prefsSaveSaved() {
  try {
    prefsSave('saved_queries', JSON.parse(localStorage.getItem('sed_saved_queries') || '[]'));
  } catch(_) {}
}

// ── Загрузить с сервера ─────────────
async function prefsLoad() {
  try {
    const r = await fetch(`${API}?m=UserPrefs&a=get`, { credentials: 'same-origin' });
    if (!r.ok) {
      console.warn('[prefs] load failed:', r.status);
      return;
    }

    const d = await r.json();
    if (!d.ok || !d.data) return;

    let changed = false;

    // ── Избранные шаблоны ──────────────────────────────────────
    if (Array.isArray(d.data.tmpl_favs) && d.data.tmpl_favs.length > 0) {
      const server = new Set(d.data.tmpl_favs);
      const local  = getTmplFavs();
      const merged = new Set([...server, ...local]);
      if (merged.size !== local.size) {
        saveTmplFavs(merged);
        changed = true;
      }
    }

    // ── Избранные таблицы ──────────────────────────────────────
    if (Array.isArray(d.data.tbl_favs) && d.data.tbl_favs.length > 0) {
      const server = new Set(d.data.tbl_favs);
      const local  = getTblFavs();
      const merged = new Set([...server, ...local]);
      if (merged.size !== local.size) {
        saveTblFavs(merged);
        changed = true;
      }
    }

    // ── История запросов ───────────────────────────────────────
    if (Array.isArray(d.data.query_history)) {
      const local = (() => {
        try { return JSON.parse(localStorage.getItem('sed_query_history') || '[]'); }
        catch(_){ return []; }
      })();
      if (d.data.query_history.length === 0) {
        // Сервер вернул пустую историю — значит её очистили в другом браузере
        if (local.length > 0) {
          localStorage.removeItem('sed_query_history');
          changed = true;
        }
      } else {
        const seen = new Set(local.map(e => e.sql));
        const fromServer = d.data.query_history.filter(e => e?.sql && !seen.has(e.sql));
        if (fromServer.length > 0) {
          const merged = [...local, ...fromServer].slice(0, 100);
          localStorage.setItem('sed_query_history', JSON.stringify(merged));
          changed = true;
        } else if (local.length === 0) {
          localStorage.setItem('sed_query_history', JSON.stringify(d.data.query_history.slice(0, 100)));
          changed = true;
        }
      }
    }

    // ── Сохранённые запросы ────────────────────────────────────
    if (Array.isArray(d.data.saved_queries) && d.data.saved_queries.length > 0) {
      const local = (() => {
        try { return JSON.parse(localStorage.getItem('sed_saved_queries') || '[]'); }
        catch(_){ return []; }
      })();
      if (local.length === 0) {
        localStorage.setItem('sed_saved_queries', JSON.stringify(d.data.saved_queries));
        if (typeof renderSavedList === 'function') renderSavedList();
        changed = true;
      }
    }

    // Обновляем UI если что-то изменилось
    if (changed) {
      const qtmpl = document.getElementById('tmplSearch')?.value || '';
      if (typeof renderTemplates === 'function') renderTemplates(qtmpl);
      const qtbl  = document.getElementById('tableSearch')?.value || '';
      if (typeof renderTableList === 'function') renderTableList(qtbl);
    }

    console.debug('[prefs] loaded ok, changed:', changed);

  } catch(e) {
    console.debug('[prefs] load error:', e.message);
  }
}