#!/usr/bin/env python3
"""
pam_runner.py — Клиент запросов к БД через SSH/PAM.
"""

import os, sys, json, time, socket, re, base64, argparse, secrets
from pathlib import Path


# ── Загрузка .env ─────────────────────────────────────────────────────────
def _load_env():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for candidate in [
        os.path.join(script_dir, '.env'),
        os.path.join(script_dir, '..', '.env'),
        os.path.join(script_dir, '..', '..', '.env'),
    ]:
        path = os.path.normpath(candidate)
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    k, v = k.strip(), v.strip()
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
                        v = v[1:-1]
                    if k and k not in os.environ:
                        os.environ[k] = v
            return

_load_env()

SOCK_PATH      = '/tmp/sed_query.sock'
PID_FILE       = '/tmp/sed_daemon.pid'
QUERY_TIMEOUT  = 600
SOCK_WAIT_SECS = 300

# ── Конфигурация — только из окружения, дефолты пустые ───────────────────
PAM_HOST    = os.environ.get('PAM_HOST',        '')
PAM_PORT    = os.environ.get('PAM_PORT',        '22')
PAM_USER    = os.environ.get('PAM_USER',        '')
PAM_PASS    = os.environ.get('PAM_PASSWORD',    '')
TARGET_HOST = os.environ.get('TARGET_HOST',     '')
TARGET_USER = os.environ.get('TARGET_USER',     '')
TARGET_PASS = os.environ.get('TARGET_PASSWORD', '')
DB_HOST     = os.environ.get('DB_HOST',         '')
DB_PORT     = os.environ.get('DB_PORT',         '5432')
DB_NAME     = os.environ.get('DB_NAME',         '')
DB_USER     = os.environ.get('DB_USER',         '')
DB_PASS     = os.environ.get('SED_DB_PASS',     '')


def _check_config():
    missing = [k for k, v in [
        ('PAM_HOST', PAM_HOST), ('PAM_USER', PAM_USER),
        ('TARGET_HOST', TARGET_HOST), ('TARGET_USER', TARGET_USER),
        ('DB_HOST', DB_HOST), ('DB_NAME', DB_NAME), ('DB_USER', DB_USER),
    ] if not v]
    if missing:
        raise RuntimeError(f'Не заданы переменные окружения: {", ".join(missing)}')


D_START = b'QRESULT_BEGIN_7f3a'
D_END   = b'QRESULT_END_7f3a'

# ── Валидация ─────────────────────────────────────────────────────────────
_DANGEROUS = re.compile(
    r'\b(insert|update|delete|drop|alter|create|truncate|copy|'
    r'grant|revoke|call|do|execute|vacuum|analyze|'
    r'pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|'
    r'lo_import|lo_export|dblink|pg_terminate_backend|'
    r'pg_cancel_backend|pg_sleep(?:_for|_until)?)\b', re.I
)

def validate_readonly(sql):
    q = re.sub(r'/\*.*?\*/', ' ', sql, flags=re.S)
    q = re.sub(r'--[^\n]*', ' ', q).strip()
    if ';' in q:
        raise ValueError("Only single statement (no ';').")
    if not re.match(r'^(with\b[\s\S]+?\bselect\b|select\b)', q, flags=re.I):
        raise ValueError('Only SELECT allowed.')
    if _DANGEROUS.search(q):
        raise ValueError('Forbidden keyword detected.')


# ══════════════════════════════════════════════════════════════════════════
#  ПУТЬ 1: Unix-сокет (демон уже работает)
# ══════════════════════════════════════════════════════════════════════════

def _pid():
    try:   return int(Path(PID_FILE).read_text().strip())
    except: return None

def _daemon_alive():
    p = _pid()
    if not p: return False
    try:   os.kill(p, 0); return True
    except: return False

def _sock_send(sql, mode, limit, offset=0):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(QUERY_TIMEOUT)
    try:
        s.connect(SOCK_PATH)
        # Не передаём offset демону — он его не поддерживает.
        # Для запросов с offset используется SSH-путь (query_direct_ssh).
        s.sendall((json.dumps({'sql': sql, 'mode': mode, 'limit': limit}) + '\n').encode())
        buf = b''
        while True:
            chunk = s.recv(131072)
            if not chunk: break
            buf += chunk
            if buf.endswith(b'\n'): break
        return json.loads(buf.strip())
    finally:
        try: s.close()
        except: pass

def _wait_sock(timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(SOCK_PATH):
            try:
                r = _sock_send('__ping__', 'preview', 1)
                if r.get('pong'):
                    return True
            except Exception:
                pass
        time.sleep(1.5)
    return False

def _launch_daemon():
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pam_daemon.py')
    if not os.path.exists(script):
        return False
    import subprocess
    try:
        subprocess.Popen(
            [sys.executable, script, '--start'],
            env=os.environ.copy(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True
    except Exception:
        return False

def query_via_daemon(sql, mode, limit, offset=0):
    # Для тяжёлых запросов (вызов из submit/poll job) — пропускаем демон.
    # Демон возвращает большие результаты через Unix-сокет и может упасть
    # по таймауту. SSH-путь надёжнее для тяжёлых запросов.
    if os.environ.get('_SED_RESULT_FILE', ''):
        return None  # идём в query_direct_ssh

    # Демон не поддерживает offset — для дозагрузки используем SSH-путь
    if offset > 0:
        return None

    # Шаг 1: сокет уже есть — пробуем сразу
    if os.path.exists(SOCK_PATH):
        try:
            return _sock_send(sql, mode, limit)
        except Exception:
            pass
        # Сокет был, но не ответил — демон перезапускается или завис.
        # Ждём не более 5 секунд, затем возвращаем None → SSH fallback.
        if _wait_sock(5):
            try:
                return _sock_send(sql, mode, limit)
            except Exception:
                pass
        return None

    # Шаг 2: сокета нет — запускаем демон однократно
    if not _daemon_alive():
        _launch_daemon()

    # Ждём сокет не более SOCK_WAIT_SECS (90 сек при первом запуске)
    if _wait_sock(SOCK_WAIT_SECS):
        try:
            return _sock_send(sql, mode, limit)
        except Exception as e:
            return {'ok': False, 'error': f'Демон запущен, но не отвечает: {e}'}

    return None


# ══════════════════════════════════════════════════════════════════════════
#  ПУТЬ 2: Прямой SSH через PAM (медленно, резервный)
# ══════════════════════════════════════════════════════════════════════════
_REMOTE_SCRIPT = b"""
import json, sys, os, io, csv, psycopg2

def _dedup_cols(description):
    \"\"\"Return unique column names. Duplicates get _2, _3 suffix.\"\"\"
    seen = {}
    cols = []
    for d in description:
        name = d[0]
        if name in seen:
            seen[name] += 1
            cols.append(f"{name}_{seen[name]}")
        else:
            seen[name] = 1
            cols.append(name)
    return cols

def _rows_as_dicts(cursor, cols):
    \"\"\"Fetch all rows as dicts using index (safe with duplicate col names).\"\"\"
    return [dict(zip(cols, row)) for row in cursor.fetchall()]

def _csv_safe(v):
    # CSV/formula injection: neutralize leading =,+,-,@,\\t,\\r
    s = '' if v is None else str(v)
    if s[:1] in ('=', '+', '-', '@', '\\t', '\\r'):
        return \"'\" + s
    return s

try:
    import psycopg2, psycopg2.extras
    sql    = os.environ['_SED_SQL']
    mode   = os.environ.get('_SED_MODE', 'preview')
    cn = psycopg2.connect(
        host=os.environ['_SED_DBHOST'],
        port=os.environ['_SED_DBPORT'],
        dbname=os.environ['_SED_DBNAME'],
        user=os.environ['_SED_DBUSER'],
        password=os.environ['_SED_DBPASS'],
        connect_timeout=10,
        options='-c statement_timeout=590000',
    )
    cn.autocommit = True
    cu = cn.cursor()
    cu.execute("SELECT pg_backend_pid()")
    _pg_pid = cu.fetchone()[0]
    _result_file = os.environ.get('_SED_RESULT_FILE', '')
    if _result_file:
        _pgpid_file = _result_file.replace('.result', '.pgpid')
        try:
            with open(_pgpid_file, 'w') as _f:
                _f.write(str(_pg_pid))
        except Exception:
            pass

    cu.execute("SET max_parallel_workers_per_gather = 0")

    if mode == 'export':
        # Streaming export via server-side cursor, O(1) memory
        cu2 = cn.cursor('export_cursor')
        cu2.itersize = 1000
        cu2.execute(sql)
        cols = _dedup_cols(cu2.description)
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter=';', quoting=csv.QUOTE_MINIMAL)
        writer.writerow([_csv_safe(c) for c in cols])
        rows_written = 0
        for row in cu2:
            writer.writerow([_csv_safe(v) for v in row])
            rows_written += 1
        cu2.close()
        cn.close()
        sys.stdout.write(json.dumps(
            {'ok': True, 'csv': buf.getvalue(), 'count': rows_written},
            default=str,
        ) + '\\n')
    else:
        # preview: sql already has LIMIT/OFFSET from query_direct_ssh
        # do NOT re-wrap
        cu.execute(sql)
        cols = _dedup_cols(cu.description)
        rows = _rows_as_dicts(cu, cols)
        cn.close()
        sys.stdout.write(json.dumps(
            {'ok': True, 'columns': cols, 'rows': rows, 'count': len(rows)},
            default=str,
        ) + '\\n')
    sys.stdout.flush()
except Exception as e:
    sys.stdout.write(json.dumps({'ok': False, 'error': str(e)}) + '\\n')
    sys.stdout.flush()
"""
_REMOTE_SCRIPT_B64 = base64.b64encode(_REMOTE_SCRIPT).decode()


def _sq(s: str) -> str:
    """Обернуть строку в одинарные кавычки для shell."""
    return "'" + s.replace("'", "'\\''") + "'"


def _b64env(val: str) -> str:
    """Передать значение через base64 — безопасно для $, !, \\ и других символов."""
    return '"$(printf \'%s\' ' + _sq(base64.b64encode(val.encode()).decode()) + ' | base64 -d)"'


def query_direct_ssh(sql, mode, limit, offset=0):
    try:
        import pexpect
    except ImportError:
        return {'ok': False, 'error': 'pip3 install pexpect'}

    try:
        _check_config()
    except RuntimeError as e:
        return {'ok': False, 'error': str(e)}

    # Оборачиваем запрос с LIMIT + OFFSET для пагинации
    if mode == 'preview' and limit > 0:
        if offset > 0:
            wrapped = f'SELECT * FROM ({sql}) __w__ LIMIT {limit} OFFSET {offset}'
        else:
            wrapped = f'SELECT * FROM ({sql}) __w__ LIMIT {limit}'
    else:
        wrapped = sql

    # Уникальные маркеры и имя файла на каждый запрос
    token      = secrets.token_hex(10)
    d_start    = f'SEDQBEGIN{token}'.encode()
    d_end      = f'SEDQEND{token}'.encode()
    tmp_script = f'/tmp/.sed_{secrets.token_hex(8)}'

    cmd = (
        f'ssh -tt -p {PAM_PORT} -F /dev/null'
        f' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
        f' -o ServerAliveInterval=15 -o ConnectTimeout=20'
        f' -o KexAlgorithms=+diffie-hellman-group14-sha1'
        f' -o HostKeyAlgorithms=+ssh-rsa'
        f' -o PubkeyAcceptedAlgorithms=+ssh-rsa'
        f' {PAM_USER}@{PAM_HOST}'
    )

    c = pexpect.spawn(cmd, timeout=300, maxread=1048576, searchwindowsize=65536)
    c.setwinsize(150, 65535)

    def ex(pats, name, t=30):
        i = c.expect(pats + [pexpect.TIMEOUT, pexpect.EOF], timeout=t)
        if i >= len(pats):
            raise RuntimeError(f'{name}: {"TIMEOUT" if i==len(pats) else "EOF"}')
        return i

    def s(d):
        c.send((d.encode() if isinstance(d, str) else d) + b'\r')

    try:
        ex([b'[Pp]assword:'], 'PAM password', t=25); s(PAM_PASS)
        ex([b'select one:'],  'PAM menu',     t=30); s(TARGET_HOST)
        ex([b'[Uu]sername'],  'Target user',  t=40); s(TARGET_USER)
        ex([b'[Pp]assword:'], 'Target pass',  t=25); s(TARGET_PASS)
        ex([b'\\$ ', b'# '], 'Shell',         t=70)

        # Шаг 1: записываем статический скрипт и ждём промпт
        c.send(f"printf '%s' {_sq(_REMOTE_SCRIPT_B64)} | base64 -d > {tmp_script}\r".encode())
        ex([b'\\$ ', b'# '], 'Script write', t=15)

        run_cmd = (
            f'_SED_SQL={_b64env(wrapped)} '
            f'_SED_MODE={_sq(mode)} '
            f'_SED_LIMIT={_sq(str(limit))} '
            f'_SED_OFFSET={_sq(str(offset))} '
            f'_SED_DBHOST={_sq(DB_HOST)} '
            f'_SED_DBPORT={_sq(DB_PORT)} '
            f'_SED_DBNAME={_sq(DB_NAME)} '
            f'_SED_DBUSER={_sq(DB_USER)} '
            f'_SED_DBPASS={_b64env(DB_PASS)} '
            f'python3 {tmp_script}'
        )
        inner = f'echo {d_start.decode()} ; {run_cmd} ; echo {d_end.decode()}'
        inner_b64 = base64.b64encode(inner.encode()).decode()
        outer = f'eval "$(printf \'%s\' {_sq(inner_b64)} | base64 -d)"'
        c.send((outer + '\r').encode())

        i = c.expect([d_start, pexpect.TIMEOUT, pexpect.EOF], timeout=20)
        if i != 0:
            raise RuntimeError(f'Start marker: {"TIMEOUT" if i==1 else "EOF"}')

        i = c.expect([d_end, pexpect.TIMEOUT, pexpect.EOF], timeout=1800)
        if i != 0:
            raise RuntimeError(f'Query {"TIMEOUT" if i==1 else "EOF"}')

        raw = c.before
        lines = [ln.strip() for ln in raw.replace(b'\r', b'\n').split(b'\n') if ln.strip()]
        json_line = None
        for ln in reversed(lines):
            decoded = ln.decode(errors='replace')
            if decoded.startswith('{'):
                json_line = decoded
                break

        if not json_line:
            raise RuntimeError(f'JSON не найден. Вывод: {raw[-300:]!r}')

        return json.loads(json_line)

    except Exception as err:
        return {'ok': False, 'error': str(err)}
    finally:
        try: c.send(f'rm -f {tmp_script}\r'.encode()); time.sleep(0.1)
        except Exception: pass
        try: c.send(b'exit\r'); c.close(force=True)
        except Exception: pass


# ══════════════════════════════════════════════════════════════════════════
#  ГЛАВНАЯ ФУНКЦИЯ
# ══════════════════════════════════════════════════════════════════════════

def run_query(sql, mode='preview', limit=200, offset=0):
    result = query_via_daemon(sql, mode, limit, offset)
    if result is not None:
        return result
    return query_direct_ssh(sql, mode, limit, offset)


def _write_result(result: dict) -> None:
    """Write result atomically.

    If _SED_RESULT_FILE is set - write via .tmp + rename (atomic).
    If rename fails - write to stdout (which goes to stderr log file).
    If _SED_RESULT_FILE not set (CLI/test) - write to stdout.
    """
    result_file = os.environ.get('_SED_RESULT_FILE', '').strip()
    data = json.dumps(result, ensure_ascii=False, default=str)

    if result_file:
        tmp = result_file + '.tmp'
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.rename(tmp, result_file)
        except Exception as e:
            sys.stderr.write(f'_write_result atomic failed: {e}, writing result to result_file directly\n')
            try:
                with open(result_file, 'w', encoding='utf-8') as f:
                    f.write(data)
                    f.flush()
            except Exception as e2:
                sys.stderr.write(f'_write_result direct write also failed: {e2}\n')
                print(data)
                sys.stdout.flush()
    else:
        print(data)
        sys.stdout.flush()


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='pam_runner — запрос к БД')
    ap.add_argument('--sql',          default=None)
    ap.add_argument('--sql-from-env', action='store_true',
                    help='Читать SQL из переменной окружения _SED_INLINE_SQL (скрывает SQL из ps aux)')
    ap.add_argument('--mode',   default='preview', choices=['preview', 'export'])
    ap.add_argument('--limit',  type=int, default=200)
    ap.add_argument('--offset', type=int, default=0)
    ap.add_argument('--direct', action='store_true', help='Принудительно прямой SSH')
    args = ap.parse_args()

    # Получаем SQL: либо из env-переменной (вызов из PHP), либо из --sql (CLI)
    if args.sql_from_env:
        sql = os.environ.get('_SED_INLINE_SQL', '').strip()
        if not sql:
            _write_result({'ok': False, 'error': '_SED_INLINE_SQL не задана или пуста'})
            sys.exit(1)
    elif args.sql:
        sql = args.sql.strip()
    else:
        _write_result({'ok': False, 'error': 'Укажите --sql или --sql-from-env'})
        sys.exit(1)

    try:
        validate_readonly(sql)
    except ValueError as e:
        _write_result({'ok': False, 'error': str(e)})
        sys.exit(1)

    try:
        result = (query_direct_ssh if args.direct else run_query)(sql, args.mode, args.limit, args.offset)
    except Exception as e:
        result = {'ok': False, 'error': f'pam_runner: {e}'}

    _write_result(result)