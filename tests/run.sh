#!/usr/bin/env bash
# ── Оркестратор тестов СЭД-вьювера ─────────────────────────────────
#   static  — php -l, компиляция Python, парсинг встроенных remote-скриптов
#   unit    — PHP (валидатор/CSV/TOTP) + Python (validate_readonly/_csv_safe)
#   browser — Playwright/Chromium: CSP-violations + делегирование (V-06)
# Ненулевой код при любом падении. Интеграция SSH/PAM/PostgreSQL здесь
# не запускается (нет .env/бастиона/сервера БД).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RC=0
step() { echo ""; echo "############ $* ############"; }

step "STATIC: php -l"
while IFS= read -r f; do
  out="$(php -l "$f" 2>&1)" || { echo "$out"; RC=1; }
done < <(find . -name '*.php' -not -path './.git/*')
echo "php -l: done"

step "STATIC: python compile + встроенные remote-скрипты"
python3 - <<'PY' || RC=1
import py_compile, re, base64, ast, sys
for f in ('scripts/pam_runner.py', 'scripts/pam_daemon.py'):
    py_compile.compile(f, doraise=True)
runner = open('scripts/pam_runner.py').read()
m = re.search(r'_REMOTE_SCRIPT = b"""(.*?)"""', runner, re.S)
ast.parse(m.group(1).replace('\\"', '"'))
daemon = open('scripts/pam_daemon.py').read()
b64 = re.search(r'_REMOTE_SCRIPT_B64 = "([^"]+)"', daemon).group(1)
ast.parse(base64.b64decode(b64).decode())
print("python compile + embedded parse: ok")
PY

step "STATIC: JS syntax (node --check)"
JS_OK=1
for f in assets/js/*.js private_js/*.js tests/browser.mjs; do
  node --check "$f" 2>/dev/null || { echo "  FAIL $f"; JS_OK=0; RC=1; }
done
[ "$JS_OK" = 1 ] && echo "node --check: all ok"

step "STATIC: инлайн-обработчики на живых путях (V-06) — должно быть пусто"
HITS="$(grep -rnoE 'on(click|change|input|mousedown|mouseover|mouseout|mouseenter|keydown|keyup|focus|blur|submit|error)=' \
  db_viewer.html private_js/app_shell.html \
  assets/js/db_utils.js assets/js/db_2fa.js assets/js/db_auth.js assets/js/db_boot.js assets/js/db_init.js \
  private_js/db_app.js private_js/db_query.js private_js/db_template.js private_js/db_saved.js \
  private_js/db_table.js private_js/db_filter.js private_js/db_fk.js private_js/db_export.js \
  private_js/db_columns.js private_js/db_prefs.js private_js/db_sqledit.js private_js/db_split.js \
  private_js/db_admin.js private_js/db_settings.js 2>/dev/null)"
if [ -n "$HITS" ]; then echo "$HITS"; echo "  FAIL: остались инлайн-обработчики"; RC=1; else echo "  ok: инлайн-обработчиков нет"; fi

step "STATIC: CSP без script-src 'unsafe-inline'"
grep -q "script-src 'self'; " index.php && ! grep -q "script-src 'self' 'unsafe-inline'" index.php \
  && echo "  ok: index.php" || { echo "  FAIL: index.php CSP"; RC=1; }
grep -q "http-equiv=\"Content-Security-Policy\"" db_viewer.html \
  && ! grep -q "script-src 'self' 'unsafe-inline'" db_viewer.html \
  && echo "  ok: db_viewer.html meta" || { echo "  FAIL: db_viewer.html meta CSP"; RC=1; }

step "STATIC: assets/js — только живые файлы (без мёртвых дубликатов)"
EXPECTED="$(printf '%s\n' db_2fa.js db_auth.js db_boot.js db_init.js db_utils.js qrcode.js | sort | tr '\n' ' ')"
ACTUAL="$(ls assets/js | sort | tr '\n' ' ')"
if [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "  ok: ровно 6 живых файлов"
else
  echo "  FAIL: ожидалось [$EXPECTED], найдено [$ACTUAL]"; RC=1
fi

step "UNIT: PHP"
php tests/unit.php || RC=1

step "UNIT: Python"
python3 tests/unit_py.py || RC=1

step "BROWSER: Playwright (CSP + делегирование)"
if [ ! -d /opt/pw-browsers ]; then
  echo "  SKIP: Chromium недоступен"
else
  PORT=8099
  php -S 127.0.0.1:$PORT tests/server-router.php >/tmp/sed_test_srv.log 2>&1 &
  SRV=$!
  # ждём подъёма сервера
  for i in $(seq 1 20); do
    curl -s "http://127.0.0.1:$PORT/db_viewer.html" >/dev/null 2>&1 && break
    sleep 0.3
  done
  NODE_PATH="$(npm root -g)" SED_TEST_BASE="http://127.0.0.1:$PORT" node tests/browser.mjs || RC=1
  kill "$SRV" 2>/dev/null
fi

echo ""
if [ "$RC" = 0 ]; then echo "==================  ВСЕ ТЕСТЫ ЗЕЛЁНЫЕ  =================="; else echo "==================  ЕСТЬ ПАДЕНИЯ (RC=$RC)  =================="; fi
exit $RC
