<?php
// ── PHP unit-тесты чистой логики (без БД/SSH) ──────────────────────
//   RemoteRunner::assertReadOnly, RemoteRunner::csvSafeCell, Totp.
// Запуск: php tests/unit.php  (ненулевой код при падении)

require_once __DIR__ . '/../Core/RemoteRunner.php';
require_once __DIR__ . '/../Modules/Auth/Totp.php';

$fail = 0; $pass = 0;
function ok(bool $cond, string $name) {
    global $fail, $pass;
    if ($cond) { $pass++; echo "  ok   $name\n"; }
    else       { $fail++; echo "  FAIL $name\n"; }
}
function blocks(string $sql): bool {
    try { RemoteRunner::assertReadOnly($sql); return false; }
    catch (\InvalidArgumentException $e) { return true; }
}
function allows(string $sql): bool { return !blocks($sql); }

echo "== assertReadOnly: разрешено ==\n";
ok(allows('SELECT 1'),                                  'SELECT 1');
ok(allows('select id, name from usr where id = 5'),     'select ... from usr');
ok(allows('WITH x AS (SELECT 1 AS a) SELECT * FROM x'), 'WITH ... SELECT');

echo "== assertReadOnly: заблокировано ==\n";
ok(blocks('SELECT pg_sleep(5)'),                'pg_sleep');
ok(blocks("SELECT pg_sleep_for('1 hour')"),     'pg_sleep_for (V-04)');
ok(blocks('SELECT pg_sleep_until(now())'),       'pg_sleep_until (V-04)');
ok(blocks('SELECT pg_cancel_backend(123)'),      'pg_cancel_backend блок по умолчанию');
ok(blocks('SELECT pg_terminate_backend(123)'),   'pg_terminate_backend');

echo "== pg_cancel_backend для привилегированных ==\n";
function allowsPriv(string $sql): bool {
    try { RemoteRunner::assertReadOnly($sql, true); return true; }
    catch (\InvalidArgumentException $e) { return false; }
}
ok(allowsPriv('SELECT pg_cancel_backend(123)'),  'pg_cancel_backend разрешён привилегированному');
ok(!allowsPriv('SELECT pg_terminate_backend(1)'),'pg_terminate_backend закрыт даже привилегированному');
ok(!allowsPriv('DELETE FROM t'),                 'DELETE закрыт даже привилегированному');
ok(!allowsPriv("SELECT pg_read_file('/x')"),     'pg_read_file закрыт даже привилегированному');
ok(blocks('DELETE FROM t'),                      'DELETE');
ok(blocks('UPDATE t SET x = 1'),                 'UPDATE');
ok(blocks('SELECT 1; DROP TABLE t'),             'multi-statement (;)');
ok(blocks("SELECT pg_read_file('/etc/passwd')"), 'pg_read_file');
ok(blocks("SELECT lo_import('/x')"),             'lo_import');
ok(blocks("SELECT * FROM dblink('h','q') AS t(x int)"), 'dblink');
ok(blocks('INSERT INTO t VALUES (1)'),           'INSERT');

echo "== csvSafeCell (V-03) ==\n";
ok(RemoteRunner::csvSafeCell('=1+2')  === "'=1+2",  'ведущий =');
ok(RemoteRunner::csvSafeCell('+A1')   === "'+A1",   'ведущий +');
ok(RemoteRunner::csvSafeCell('-5')    === "'-5",    'ведущий -');
ok(RemoteRunner::csvSafeCell('@cmd')  === "'@cmd",  'ведущий @');
ok(RemoteRunner::csvSafeCell("\tTAB") === "'\tTAB", 'ведущий TAB');
ok(RemoteRunner::csvSafeCell('обычный текст') === 'обычный текст', 'обычный текст без изменений');
ok(RemoteRunner::csvSafeCell(null)    === '',       'null → пустая строка');
ok(RemoteRunner::csvSafeCell('a=b')   === 'a=b',    '= не в начале — без изменений');

echo "== Totp anti-replay (V-09) ==\n";
// код текущего интервала
$secret = Totp::generateSecret();
$ref = new ReflectionMethod('Totp', 'codeAt');
$ref->setAccessible(true);
$t = (int) floor(time() / 30);
$code = $ref->invoke(null, $secret, $t);

ok(strlen(Totp::generateSecret()) === 16,            'secret 16 символов');
ok(Totp::verify($secret, $code) === true,            'verify текущего кода');
ok(Totp::matchCounter($secret, $code) === $t,        'matchCounter возвращает счётчик t');
ok(Totp::matchCounter($secret, '000000') !== $t,     'неверный код ≠ t');
// код за пределами окна (t-2) не принимается
$old = $ref->invoke(null, $secret, $t - 2);
ok(Totp::matchCounter($secret, $old) === null,       'код t-2 вне окна ±1 → null');
// anti-replay: сохранённый last_totp_ctr >= matched ⇒ повтор отклоняется
$matched = Totp::matchCounter($secret, $code);
ok($matched !== null && $matched <= $t && $t <= $matched, 'matched == t (для проверки last_totp_ctr)');

echo "\n== Итог: {$pass} ok, {$fail} fail ==\n";
exit($fail === 0 ? 0 : 1);
