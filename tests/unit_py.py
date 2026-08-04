#!/usr/bin/env python3
# ── Python unit-тесты (без БД/SSH) ─────────────────────────────────
#   validate_readonly в pam_runner и pam_daemon (V-04),
#   _csv_safe, извлечённый из встроенных remote-скриптов (V-03).
import os, re, sys, base64

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

fail = 0
def ok(cond, name):
    global fail
    print(('  ok   ' if cond else '  FAIL ') + name)
    if not cond:
        fail += 1

import pam_runner, pam_daemon

def blocks(mod, sql):
    try:
        mod.validate_readonly(sql)
        return False
    except ValueError:
        return True

for name, mod in [('pam_runner', pam_runner), ('pam_daemon', pam_daemon)]:
    print(f'== {name}.validate_readonly ==')
    ok(not blocks(mod, 'SELECT 1'),                       f'{name}: SELECT 1 разрешён')
    ok(not blocks(mod, 'select id from usr'),             f'{name}: select from usr разрешён')
    ok(blocks(mod, 'SELECT pg_sleep(5)'),                 f'{name}: pg_sleep блок')
    ok(blocks(mod, "SELECT pg_sleep_for('1h')"),          f'{name}: pg_sleep_for блок (V-04)')
    ok(blocks(mod, 'SELECT pg_sleep_until(now())'),       f'{name}: pg_sleep_until блок (V-04)')
    ok(blocks(mod, 'SELECT pg_cancel_backend(1)'),        f'{name}: pg_cancel_backend блок (V-04)')
    ok(blocks(mod, 'DELETE FROM t'),                      f'{name}: DELETE блок')
    ok(blocks(mod, 'SELECT 1; DROP TABLE t'),             f'{name}: multi-statement блок')

def extract_csv_safe(source, label):
    m = re.search(r'def _csv_safe\(v\):.*?\n    return s', source, re.S)
    if not m:
        ok(False, f'{label}: _csv_safe найден в remote-скрипте')
        return None
    ns = {}
    exec(m.group(0), ns)
    return ns['_csv_safe']

print('== _csv_safe в встроенных remote-скриптах (V-03) ==')
runner_src = pam_runner._REMOTE_SCRIPT.decode()
daemon_src = base64.b64decode(pam_daemon._REMOTE_SCRIPT_B64).decode()
for label, src in [('pam_runner', runner_src), ('pam_daemon', daemon_src)]:
    fn = extract_csv_safe(src, label)
    if not fn:
        continue
    ok(fn('=1+2') == "'=1+2",  f'{label}: ведущий =')
    ok(fn('+A1')  == "'+A1",   f'{label}: ведущий +')
    ok(fn('-5')   == "'-5",    f'{label}: ведущий -')
    ok(fn('@x')   == "'@x",    f'{label}: ведущий @')
    ok(fn('\tT')  == "'\tT",   f'{label}: ведущий TAB')
    ok(fn('abc')  == 'abc',    f'{label}: обычный текст без изменений')
    ok(fn(None)   == '',       f'{label}: None → пустая строка')

print(f'\n== Итог: fail={fail} ==')
sys.exit(0 if fail == 0 else 1)
