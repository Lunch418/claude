// ── Браузерный тест CSP + делегирования (Playwright/Chromium) ──────
//   1) Экран логина: нет CSP-violations; клик по опции комбобокса
//      (data-act-mousedown) и тумблер пароля (data-act) работают.
//   2) Оболочка приложения: модули грузятся под строгим CSP, действия
//      зарегистрированы, нет CSP-violations.
// Требует запущенного мок-сервера (tests/run.sh поднимает его).

// Playwright установлен глобально; резолвим через createRequire (учитывает
// NODE_PATH), т.к. ESM import глобальные пакеты не находит.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.SED_TEST_BASE || 'http://127.0.0.1:8099';
let fail = 0;
const ok = (cond, name) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) fail++; };

// Скрипт, ставящий сборщик CSP-violations до загрузки страницы
const CSP_COLLECTOR = `
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    window.__csp.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber });
  });
`;

function scriptViolations(list) {
  return (list || []).filter(v => String(v.directive || '').startsWith('script-src'));
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  // ── Сценарий 1: экран логина ───────────────────────────────────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.addInitScript(CSP_COLLECTOR);
    await page.goto(`${BASE}/db_viewer.html`, { waitUntil: 'networkidle' });

    console.log('== Сценарий 1: экран логина ==');
    // экран логина виден
    const loginVisible = await page.isVisible('#loginOverlay');
    ok(loginVisible, 'экран логина отрисован');

    // комбобокс пользователей заполнился (data-act-mousedown у опций)
    await page.click('#loginComboVal');
    await page.waitForSelector('.org-combo-opt[data-act-mousedown="loginCombo"]', { timeout: 5000 });
    const optCount = await page.locator('.org-combo-opt').count();
    ok(optCount > 0, `опции комбобокса отрисованы (${optCount})`);

    // клик по опции (реальный клик → bubbling mousedown → делегирование)
    await page.locator('.org-combo-opt', { hasText: 'Тест Пользователь' }).first().click();
    await page.waitForTimeout(100);
    const disp = (await page.textContent('#loginComboDisplay') || '').trim();
    ok(disp.includes('Тест Пользователь'), `выбор через data-act-mousedown работает (display="${disp}")`);

    // тумблер пароля (делегированный click, data-act="togglePass")
    await page.fill('#loginPassword', 'secret');
    const before = await page.getAttribute('#loginPassword', 'type');
    await page.click('#btnTogglePass');
    const after = await page.getAttribute('#loginPassword', 'type');
    ok(before === 'password' && after === 'text', `тумблер пароля работает (${before}→${after})`);

    const csp = scriptViolations(await page.evaluate(() => window.__csp));
    ok(csp.length === 0, 'нет script-src CSP-violations на экране логина');
    if (csp.length) console.log('   violations:', JSON.stringify(csp));
    if (pageErrors.length) console.log('   pageerrors:', pageErrors.join(' | '));

    await ctx.close();
  }

  // ── Сценарий 2: оболочка приложения ────────────────────────────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.addInitScript(CSP_COLLECTOR);
    // авто-вход: authInit увидит сохранённого пользователя и вызовет showApp
    await page.addInitScript(() => {
      localStorage.setItem('sed_auth_user', JSON.stringify({ name: 'Тест', isAdmin: true, canRemote: true }));
    });
    await page.goto(`${BASE}/db_viewer.html`, { waitUntil: 'networkidle' });

    console.log('== Сценарий 2: оболочка приложения ==');
    // ждём монтирования шелла и загрузки модулей (регистрации действий)
    await page.waitForSelector('[data-act="switchDb"]', { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => window.SED_ACTIONS && typeof window.SED_ACTIONS.switchDb === 'function', { timeout: 10000 }).catch(() => {});
    const shellLoaded = await page.evaluate(() => !!document.querySelector('[data-act="switchDb"]'));
    ok(shellLoaded, 'app_shell смонтирован (кнопки data-act присутствуют)');

    // модули загрузились под строгим CSP и зарегистрировали действия
    const actions = await page.evaluate(() => Object.keys(window.SED_ACTIONS || {}));
    ok(actions.includes('switchDb') && actions.includes('comboToggle') && actions.includes('togglePass'),
       `SED_ACTIONS зарегистрированы (${actions.length}: ${actions.slice(0, 8).join(',')}…)`);

    // делегированный клик по data-act не даёт CSP-violation и вызывает действие
    await page.evaluate(() => { window.__switchCalled = null; });
    await page.evaluate(() => {
      const orig = window.switchDb;
      window.switchDb = function (db) { window.__switchCalled = db; return orig && orig.apply(this, arguments); };
    });
    // Кнопка в скрытом дропдауне логотипа — проверяем делегирование
    // bubbling-кликом (доходит до слушателя на document независимо от видимости).
    await page.evaluate(() => {
      document.querySelector('[data-act="switchDb"][data-db="local"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(100);
    const called = await page.evaluate(() => window.__switchCalled);
    ok(called === 'local', `делегированный data-act вызывает функцию (switchDb → "${called}")`);

    const csp = scriptViolations(await page.evaluate(() => window.__csp));
    ok(csp.length === 0, 'нет script-src CSP-violations в оболочке приложения');
    if (csp.length) console.log('   violations:', JSON.stringify(csp));
    if (pageErrors.length) console.log('   pageerrors (info):', pageErrors.slice(0, 5).join(' | '));

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n== Браузер: fail=${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
