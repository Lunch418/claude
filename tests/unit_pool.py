#!/usr/bin/env python3
# ── Unit-тесты пула SSH-сессий демона (без SSH/БД) ────────────────
#   SessionPool: сборка до size, параллельная выдача, keepalive, close;
#   Daemon._pool_for: ched/ched2 — общий пул, sed/ksp — отдельные.
import os, sys, queue

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import pam_daemon as D

fail = 0
def ok(cond, name):
    global fail
    print(('  ok   ' if cond else '  FAIL ') + name)
    if not cond:
        fail += 1

class DummySession:
    def __init__(self):
        self.alive = False; self.connected = 0; self.closed = 0; self.pinged = 0
    def connect(self):  self.connected += 1; self.alive = True
    def close(self):    self.closed += 1; self.alive = False
    def ping(self):     self.pinged += 1; return True
    def run(self, *a, **k): return {'ok': True}

print('== SessionPool ==')
pool = D.SessionPool(lambda: DummySession(), size=3)
a = pool.acquire(timeout=1); b = pool.acquire(timeout=1); c = pool.acquire(timeout=1)
ok(len({id(a), id(b), id(c)}) == 3, 'выдаёт 3 разные сессии')
ok(len(pool._all) == 3, 'пул построен до size=3')

# пул исчерпан → четвёртый acquire блокирует (timeout → Empty)
empty = False
try:
    pool.acquire(timeout=0.2)
except queue.Empty:
    empty = True
ok(empty, 'при занятых всех сессиях acquire блокирует (Empty по таймауту)')

# вернули одну — снова доступна
pool.release(b)
got = pool.acquire(timeout=1)
ok(got is b, 'release возвращает сессию в пул')

# keepalive пингует только свободные (сейчас все заняты → 0 пингов)
for s in (a, c, got):
    s.alive = True
pool.keepalive()
ok(a.pinged == 0 and c.pinged == 0, 'keepalive не трогает занятые сессии')

# вернём все, пометим alive, keepalive → каждая пингуется
pool.release(a); pool.release(c); pool.release(got)
for s in pool._all:
    s.alive = True
pool.keepalive()
ok(all(s.pinged >= 1 for s in pool._all), 'keepalive пингует свободные сессии')

ok(pool.any_alive() is True, 'any_alive=True при живых сессиях')
pool.close_all()
ok(all(s.closed >= 1 for s in pool._all), 'close_all закрывает все сессии')

print('== SessionPool: LIFO-переиспользование тёплой сессии ==')
pool2 = D.SessionPool(lambda: DummySession(), size=3)
x = pool2.acquire(timeout=1); pool2.release(x)
y = pool2.acquire(timeout=1); pool2.release(y)
z = pool2.acquire(timeout=1); pool2.release(z)
ok(x is y and y is z, 'под низкой нагрузкой отдаётся та же сессия (нет лишних коннектов)')

print('== Daemon._pool_for ==')
# профили ched/ksp требуют конфиг — включаем для теста маппинга
D.CHED_TARGET_HOST = 'x'
D.KSP_TARGET_HOST  = 'x'
d = D.Daemon()
p_sed   = d._pool_for('sed')
p_ched  = d._pool_for('ched')
p_ched2 = d._pool_for('ched2')
p_ksp   = d._pool_for('ksp')
ok(p_ched is p_ched2, 'ched и ched2 — общий пул')
ok(p_sed is not p_ched, 'sed — отдельный пул')
ok(p_ksp is not p_ched and p_ksp is not p_sed, 'ksp — отдельный пул')
ok(p_sed._size == D.SED_POOL_SIZE, f'размер sed-пула = SED_POOL_SIZE ({D.SED_POOL_SIZE})')

# неконфигурированный профиль → понятная ошибка
D.CHED_TARGET_HOST = ''
d2 = D.Daemon()
raised = False
try:
    d2._pool_for('ched')
except RuntimeError:
    raised = True
ok(raised, 'ched без CHED_TARGET_HOST → RuntimeError')

# ched2 без CHED2_DB_NAME → понятная ошибка (возврат до обращения к SSH)
D.CHED2_DB_NAME = ''
res = D.Daemon()._execute_query('SELECT 1', 'preview', 1, 'ched2')
ok(isinstance(res, dict) and not res.get('ok') and 'CHED2' in res.get('error', ''),
   'ched2 без CHED2_DB_NAME → понятная ошибка, а не чужие схемы')

print(f'\n== Итог: fail={fail} ==')
sys.exit(0 if fail == 0 else 1)
