#!/usr/bin/env python3
"""
pam_daemon.py — Персистентный SSH-демон для СЭД.

Команды:
  python3 pam_daemon.py --start      # запуск в фоне
  python3 pam_daemon.py --stop       # остановка
  python3 pam_daemon.py --restart    # перезапуск
  python3 pam_daemon.py --status     # состояние + ping
  python3 pam_daemon.py --logs       # последние строки лога
  python3 pam_daemon.py --foreground # запуск на переднем плане (для отладки)
"""

import os, sys, json, time, socket, threading, signal, hashlib, re, base64, secrets, logging, queue
from pathlib import Path


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
                    if k and k not in os.environ:
                        os.environ[k] = v
            return path
    return None

_env_file = _load_env()

SOCK_PATH  = '/tmp/sed_query.sock'
PID_FILE   = '/tmp/sed_daemon.pid'
LOG_FILE   = '/tmp/sed_daemon.log'
CACHE_DIR  = '/tmp/sed_cache'

CACHE_TTL        = 20    # секунд — живые данные (было 60)
CACHE_TTL_LONG   = 3600  # секунд — для справочников (1 час)
KEEPALIVE_SEC    = 45
QUERY_TIMEOUT    = 1800
MAX_RECONNECTS   = 5

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

# ── Профиль CHED: тот же хост PAM, но свой вход в портал,
#    своя ВМ и свои креды БД. Совпадает только PAM_HOST/PAM_PORT.
CHED_PAM_USER    = os.environ.get('CHED_PAM_USER',        '')
CHED_PAM_PASS    = os.environ.get('CHED_PAM_PASSWORD',    '')
CHED_TARGET_HOST = os.environ.get('CHED_TARGET_HOST',     '')
CHED_TARGET_USER = os.environ.get('CHED_TARGET_USER',     '')
CHED_TARGET_PASS = os.environ.get('CHED_TARGET_PASSWORD', '')
CHED_DB_HOST = os.environ.get('CHED_DB_HOST', '')
CHED_DB_PORT = os.environ.get('CHED_DB_PORT', '5432')
CHED_DB_NAME = os.environ.get('CHED_DB_NAME', '')
CHED_DB_USER = os.environ.get('CHED_DB_USER', '')
CHED_DB_PASS = os.environ.get('CHED_DB_PASS', '')

# ── Профиль CHED2: та же ВМ/вход/DB-юзер, что у CHED, но другая
#    база. Обычно тот же сервер PostgreSQL, что у CHED, только другое имя БД,
#    поэтому host/port по умолчанию наследуются от CHED (переопределяются
#    только если CHED2 реально на другом сервере). CHED2_DB_NAME обязателен.
CHED2_DB_HOST = os.environ.get('CHED2_DB_HOST', '') or CHED_DB_HOST
CHED2_DB_PORT = os.environ.get('CHED2_DB_PORT', '') or CHED_DB_PORT
CHED2_DB_NAME = os.environ.get('CHED2_DB_NAME', '')

# ── Профиль KSP: тот же PAM-хост/порт, но свой вход в портал,
#    своя ВМ и свои креды БД. Полностью независимая сессия (как CHED,
#    но отдельная — CHED-сессию не переиспользует).
KSP_PAM_USER    = os.environ.get('KSP_PAM_USER',        '')
KSP_PAM_PASS    = os.environ.get('KSP_PAM_PASSWORD',    '')
KSP_TARGET_HOST = os.environ.get('KSP_TARGET_HOST',     '')
KSP_TARGET_USER = os.environ.get('KSP_TARGET_USER',     '')
KSP_TARGET_PASS = os.environ.get('KSP_TARGET_PASSWORD', '')
KSP_DB_HOST = os.environ.get('KSP_DB_HOST', '')
KSP_DB_PORT = os.environ.get('KSP_DB_PORT', '5432')
KSP_DB_NAME = os.environ.get('KSP_DB_NAME', '')
KSP_DB_USER = os.environ.get('KSP_DB_USER', '')
KSP_DB_PASS = os.environ.get('KSP_DB_PASS', '')

# ── Профиль MONITORING (АИС Мониторинг): тот же PAM-хост/порт, но свой
#    вход в портал, своя ВМ и свои креды БД. Полностью независимая сессия
#    (как KSP — ничего не наследует и ни с кем не делит пул).
MONITORING_PAM_USER    = os.environ.get('MONITORING_PAM_USER',        '')
MONITORING_PAM_PASS    = os.environ.get('MONITORING_PAM_PASSWORD',    '')
MONITORING_TARGET_HOST = os.environ.get('MONITORING_TARGET_HOST',     '')
MONITORING_TARGET_USER = os.environ.get('MONITORING_TARGET_USER',     '')
MONITORING_TARGET_PASS = os.environ.get('MONITORING_TARGET_PASSWORD', '')
MONITORING_DB_HOST = os.environ.get('MONITORING_DB_HOST', '')
MONITORING_DB_PORT = os.environ.get('MONITORING_DB_PORT', '5432')
MONITORING_DB_NAME = os.environ.get('MONITORING_DB_NAME', '')
MONITORING_DB_USER = os.environ.get('MONITORING_DB_USER', '')
MONITORING_DB_PASS = os.environ.get('MONITORING_DB_PASS', '')

# ── Размер пула SSH-сессий на профиль ──────────────────────────────
# Параллелизм запросов: до N разных запросов профиля идут одновременно
# (снимает сериализацию через одну сессию). Подбирать под лимиты sshd
# (MaxSessions/MaxStartups) на бастионе/ВМ и допустимые коннекты PostgreSQL.
def _pool_size(name, default):
    try:
        return max(1, int(os.environ.get(name, '') or default))
    except (TypeError, ValueError):
        return default
SED_POOL_SIZE         = _pool_size('SED_POOL_SIZE',         4)
CHED_POOL_SIZE        = _pool_size('CHED_POOL_SIZE',        2)
KSP_POOL_SIZE         = _pool_size('KSP_POOL_SIZE',         2)
MONITORING_POOL_SIZE  = _pool_size('MONITORING_POOL_SIZE',  2)

# Имя схемы: только латиница/цифры/подчёркивание (для search_path)
_SCHEMA_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

_DANGEROUS = re.compile(
    r'\b(insert|update|delete|drop|alter|create|truncate|copy|'
    r'grant|revoke|call|do|execute|vacuum|analyze|'
    r'pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|'
    r'lo_import|lo_export|dblink|'
    r'pg_sleep(?:_for|_until)?)\b', re.I
)
# Сигналы бэкендам (cancel/terminate) — только привилегированным
_SIGNAL_RE = re.compile(r'\bpg_(cancel|terminate)_backend\b', re.I)

def validate_readonly(sql: str, allow_signal: bool = False) -> None:
    q = re.sub(r'/\*.*?\*/', ' ', sql, flags=re.S)
    q = re.sub(r'--[^\n]*', ' ', q).strip()
    if ';' in q:
        raise ValueError("Only single statement (no ';').")
    if not re.match(r'^(with\b[\s\S]+?\bselect\b|select\b)', q, flags=re.I):
        raise ValueError('Only SELECT allowed.')
    # pg_cancel_backend / pg_terminate_backend разрешены только привилегированным
    if not allow_signal and _SIGNAL_RE.search(q):
        raise ValueError('Forbidden keyword detected.')
    if _DANGEROUS.search(q):
        raise ValueError('Forbidden keyword detected.')



_REMOTE_SCRIPT_B64 = "CmltcG9ydCBqc29uLCBzeXMsIG9zLCBpbywgY3N2LCBwc3ljb3BnMgoKZGVmIF9kZWR1cF9jb2xzKGRlc2NyaXB0aW9uKToKICAgIHNlZW4gPSB7fQogICAgY29scyA9IFtdCiAgICBmb3IgZCBpbiBkZXNjcmlwdGlvbjoKICAgICAgICBuYW1lID0gZFswXQogICAgICAgIGlmIG5hbWUgaW4gc2VlbjoKICAgICAgICAgICAgc2VlbltuYW1lXSArPSAxCiAgICAgICAgICAgIGNvbHMuYXBwZW5kKGYie25hbWV9X3tzZWVuW25hbWVdfSIpCiAgICAgICAgZWxzZToKICAgICAgICAgICAgc2VlbltuYW1lXSA9IDEKICAgICAgICAgICAgY29scy5hcHBlbmQobmFtZSkKICAgIHJldHVybiBjb2xzCgpfSlNfTUFYX1NBRkVfSU5UID0gOTAwNzE5OTI1NDc0MDk5MSAgIyAyKio1MyAtIDEKCmRlZiBfanNvbl9zYWZlKHYpOgogICAgIyBKUyDQv9Cw0YDRgdC40YIg0YfQuNGB0LvQsCDQuNC3IEpTT04g0LrQsNC6IGRvdWJsZSAofjE1LTE3INC30L3QsNGH0LDRidC40YUg0YbQuNGE0YApLiBCaWdpbnQKICAgICMgaWQvcGsg0LfQsCDRjdGC0LjQvNC4INC/0YDQtdC00LXQu9Cw0LzQuCBKU09OLnBhcnNlKCkg0LIg0LHRgNCw0YPQt9C10YDQtSDRgtC40YXQviDQvtC60YDRg9Cz0LvRj9C10YIsCiAgICAjINCwINC/0L7RgtC+0Lwg0Y3RgtC+INCy0YvQs9C70Y/QtNC40YIg0LrQsNC6ICI3LjAwRSsxNyIg0LLQvNC10YHRgtC+INGC0L7Rh9C90L7Qs9C+INC30L3QsNGH0LXQvdC40Y8uCiAgICAjINCe0YLQtNCw0ZHQvCDRgdGC0YDQvtC60L7QuSDigJQg0YHRgtGA0L7QutGDIEpTINGF0YDQsNC90LjRgiDQv9C+0LHQsNC50YLQvtCy0L4sINCx0LXQtyDQvtC60YDRg9Cz0LvQtdC90LjRjy4KICAgIGlmIGlzaW5zdGFuY2UodiwgaW50KSBhbmQgKHYgPiBfSlNfTUFYX1NBRkVfSU5UIG9yIHYgPCAtX0pTX01BWF9TQUZFX0lOVCk6CiAgICAgICAgcmV0dXJuIHN0cih2KQogICAgcmV0dXJuIHYKCmRlZiBfcm93c19hc19kaWN0cyhjdXJzb3IsIGNvbHMpOgogICAgcmV0dXJuIFsKICAgICAgICB7Y29sOiBfanNvbl9zYWZlKHYpIGZvciBjb2wsIHYgaW4gemlwKGNvbHMsIHJvdyl9CiAgICAgICAgZm9yIHJvdyBpbiBjdXJzb3IuZmV0Y2hhbGwoKQogICAgXQoKZGVmIF9jc3Zfc2FmZSh2KToKICAgICMgQ1NWL2Zvcm11bGEgaW5qZWN0aW9uOiDQvdC10LnRgtGA0LDQu9C40LfRg9C10Lwg0LLQtdC00YPRidC40LUgPSwrLC0sQCxcdCxccgogICAgcyA9ICcnIGlmIHYgaXMgTm9uZSBlbHNlIHN0cih2KQogICAgaWYgc1s6MV0gaW4gKCc9JywgJysnLCAnLScsICdAJywgJ1x0JywgJ1xyJyk6CiAgICAgICAgcmV0dXJuICInIiArIHMKICAgICMg0JTQu9C40L3QvdGL0LUg0YfQuNGB0LvQsCAoYmlnaW50IGlkLCAxNisg0YbQuNGE0YApOiBFeGNlbCDQv9GA0Lgg0L7RgtC60YDRi9GC0LjQuCBDU1Yg0YHQsNC8CiAgICAjINC+0L/RgNC10LTQtdC70Y/QtdGCINGP0YfQtdC50LrRgyDQutCw0Log0YfQuNGB0LvQviDQuCDQv9C10YDQtdCy0L7QtNC40YIg0LIg0Y3QutGB0L/QvtC90LXQvdGG0LjQsNC70YzQvdGD0Y4g0LfQsNC/0LjRgdGMCiAgICAjINGBINC/0L7RgtC10YDQtdC5INGC0L7Rh9C90L7RgdGC0Lgg4oCUINGF0L7RgtGPINCyINGB0LDQvNC+0LwgQ1NWINGC0LXQutGB0YIg0YLQvtGH0L3Ri9C5LiDQntCx0L7RgNCw0YfQuNCy0LDQtdC8INCyCiAgICAjINGC0LXQutGB0YLQvtCy0YPRjiDRhNC+0YDQvNGD0LvRgywg0YfRgtC+0LHRiyBFeGNlbCDQv9C+0LrQsNC30LDQuyDQt9C90LDRh9C10L3QuNC1INC60LDQuiDQtdGB0YLRjC4KICAgIGlmIHMuaXNkaWdpdCgpIGFuZCBsZW4ocykgPiAxNToKICAgICAgICByZXR1cm4gJz0iJyArIHMgKyAnIicKICAgIHJldHVybiBzCgp0cnk6CiAgICBpbXBvcnQgcHN5Y29wZzIsIHBzeWNvcGcyLmV4dHJhcwogICAgc3FsICAgID0gb3MuZW52aXJvblsnX1NFRF9TUUwnXQogICAgbW9kZSAgID0gb3MuZW52aXJvbi5nZXQoJ19TRURfTU9ERScsICdwcmV2aWV3JykKICAgIGNuID0gcHN5Y29wZzIuY29ubmVjdCgKICAgICAgICBob3N0PW9zLmVudmlyb25bJ19TRURfREJIT1NUJ10sCiAgICAgICAgcG9ydD1vcy5lbnZpcm9uWydfU0VEX0RCUE9SVCddLAogICAgICAgIGRibmFtZT1vcy5lbnZpcm9uWydfU0VEX0RCTkFNRSddLAogICAgICAgIHVzZXI9b3MuZW52aXJvblsnX1NFRF9EQlVTRVInXSwKICAgICAgICBwYXNzd29yZD1vcy5lbnZpcm9uWydfU0VEX0RCUEFTUyddLAogICAgICAgIGNvbm5lY3RfdGltZW91dD0xMCwKICAgICAgICBvcHRpb25zPSctYyBzdGF0ZW1lbnRfdGltZW91dD01OTAwMDAnLAogICAgKQogICAgY24uYXV0b2NvbW1pdCA9IFRydWUKICAgIGN1ID0gY24uY3Vyc29yKCkKICAgICMgU2F2ZSBwZ19iYWNrZW5kX3BpZCBmb3IgcGdfY2FuY2VsX2JhY2tlbmQgc3VwcG9ydAogICAgY3UuZXhlY3V0ZSgiU0VMRUNUIHBnX2JhY2tlbmRfcGlkKCkiKQogICAgX3BnX3BpZCA9IGN1LmZldGNob25lKClbMF0KICAgIF9yZXN1bHRfZmlsZSA9IG9zLmVudmlyb24uZ2V0KCdfU0VEX1JFU1VMVF9GSUxFJywgJycpCiAgICBpZiBfcmVzdWx0X2ZpbGU6CiAgICAgICAgX3BncGlkX2ZpbGUgPSBfcmVzdWx0X2ZpbGUucmVwbGFjZSgnLnJlc3VsdCcsICcucGdwaWQnKQogICAgICAgIHRyeToKICAgICAgICAgICAgd2l0aCBvcGVuKF9wZ3BpZF9maWxlLCAndycpIGFzIF9mOgogICAgICAgICAgICAgICAgX2Yud3JpdGUoc3RyKF9wZ19waWQpKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgICAgIHBhc3MKICAgIGN1LmV4ZWN1dGUoIlNFVCBtYXhfcGFyYWxsZWxfd29ya2Vyc19wZXJfZ2F0aGVyID0gMCIpCiAgICBpZiBtb2RlID09ICdleHBvcnQnOgogICAgICAgIGN1MiA9IGNuLmN1cnNvcignZXhwb3J0X2N1cnNvcicpCiAgICAgICAgY3UyLml0ZXJzaXplID0gMTAwMAogICAgICAgIGN1Mi5leGVjdXRlKHNxbCkKICAgICAgICBjb2xzID0gX2RlZHVwX2NvbHMoY3UyLmRlc2NyaXB0aW9uKQogICAgICAgIGJ1ZiA9IGlvLlN0cmluZ0lPKCkKICAgICAgICB3cml0ZXIgPSBjc3Yud3JpdGVyKGJ1ZiwgZGVsaW1pdGVyPSc7JywgcXVvdGluZz1jc3YuUVVPVEVfTUlOSU1BTCkKICAgICAgICB3cml0ZXIud3JpdGVyb3coW19jc3Zfc2FmZShjKSBmb3IgYyBpbiBjb2xzXSkKICAgICAgICByb3dzX3dyaXR0ZW4gPSAwCiAgICAgICAgZm9yIHJvdyBpbiBjdTI6CiAgICAgICAgICAgIHdyaXRlci53cml0ZXJvdyhbX2Nzdl9zYWZlKHYpIGZvciB2IGluIHJvd10pCiAgICAgICAgICAgIHJvd3Nfd3JpdHRlbiArPSAxCiAgICAgICAgY3UyLmNsb3NlKCkKICAgICAgICBjbi5jbG9zZSgpCiAgICAgICAgc3lzLnN0ZG91dC53cml0ZShqc29uLmR1bXBzKAogICAgICAgICAgICB7J29rJzogVHJ1ZSwgJ2Nzdic6IGJ1Zi5nZXR2YWx1ZSgpLCAnY291bnQnOiByb3dzX3dyaXR0ZW59LAogICAgICAgICAgICBkZWZhdWx0PXN0ciwKICAgICAgICApICsgJ1xuJykKICAgIGVsc2U6CiAgICAgICAgY3UuZXhlY3V0ZShzcWwpCiAgICAgICAgY29scyA9IF9kZWR1cF9jb2xzKGN1LmRlc2NyaXB0aW9uKQogICAgICAgIHJvd3MgPSBfcm93c19hc19kaWN0cyhjdSwgY29scykKICAgICAgICBjbi5jbG9zZSgpCiAgICAgICAgc3lzLnN0ZG91dC53cml0ZShqc29uLmR1bXBzKAogICAgICAgICAgICB7J29rJzogVHJ1ZSwgJ2NvbHVtbnMnOiBjb2xzLCAncm93cyc6IHJvd3MsICdjb3VudCc6IGxlbihyb3dzKX0sCiAgICAgICAgICAgIGRlZmF1bHQ9c3RyLAogICAgICAgICkgKyAnXG4nKQogICAgc3lzLnN0ZG91dC5mbHVzaCgpCmV4Y2VwdCBFeGNlcHRpb24gYXMgZToKICAgIHN5cy5zdGRvdXQud3JpdGUoanNvbi5kdW1wcyh7J29rJzogRmFsc2UsICdlcnJvcic6IHN0cihlKX0pICsgJ1xuJykKICAgIHN5cy5zdGRvdXQuZmx1c2goKQo="



logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('daemon')

def _sq(s: str) -> str:
    return "'" + s.replace("'", "'" + chr(92) + "'" + "'" + "'" + chr(92) + "'" + "'") + "'"


def _b64env(val: str) -> str:
    b64 = base64.b64encode(val.encode()).decode()
    return '"$(printf ' + "'%s'" + ' ' + _sq(b64) + ' | base64 -d)"'


_LONG_CACHE_RE = re.compile(
    r'(db_version|user_group|medo_org|nomenclature|r_list\b|'
    r'information_schema|pg_class|pg_namespace|pg_constraint|'
    r'pg_attribute|c_org|usr\b|org_folder|user_post\b)', re.I
)

class Cache:
    def __init__(self):
        os.makedirs(CACHE_DIR, mode=0o700, exist_ok=True)
        try: os.chmod(CACHE_DIR, 0o700)
        except OSError: pass
        self._lock = threading.Lock()

    def clear_all(self) -> int:
        """Удаляет все файлы кэша, возвращает количество."""
        count = 0
        with self._lock:
            try:
                for f in Path(CACHE_DIR).glob('*.json'):
                    try:
                        f.unlink()
                        count += 1
                    except OSError:
                        pass
            except Exception:
                pass
        return count

    def _path(self, sql, mode, limit):
        h = hashlib.sha256(f'{sql}|{mode}|{limit}'.encode()).hexdigest()
        return os.path.join(CACHE_DIR, h + '.json')

    def _ttl(self, sql):
        return CACHE_TTL_LONG if _LONG_CACHE_RE.search(sql) else CACHE_TTL

    def get(self, sql, mode, limit):
        p = self._path(sql, mode, limit)
        with self._lock:
            try:
                if time.time() - os.path.getmtime(p) > self._ttl(sql):
                    os.unlink(p); return None
                d = json.loads(Path(p).read_text('utf-8'))
                d['_cached'] = True
                return d
            except Exception:
                return None

    def put(self, sql, mode, limit, data):
        p = self._path(sql, mode, limit)
        with self._lock:
            try:
                Path(p).write_text(json.dumps(data, default=str, ensure_ascii=False), 'utf-8')
                try: os.chmod(p, 0o600)   # ПДн в кэше — только uid демона
                except OSError: pass
            except Exception:
                pass

    def clear(self):
        with self._lock:
            for f in Path(CACHE_DIR).glob('*.json'):
                try: f.unlink()
                except: pass

class Session:
    def __init__(self, pam_user, pam_pass, target_host, target_user, target_pass,
                 db_host, db_port, db_name, db_user, db_pass):
        try:
            import pexpect as px
            self.px = px
        except ImportError:
            raise RuntimeError('No pexpect: pip3 install pexpect')
        self.pam_user     = pam_user
        self.pam_pass     = pam_pass
        self.target_host  = target_host
        self.target_user  = target_user
        self.target_pass  = target_pass
        self.db_host      = db_host
        self.db_port      = db_port
        self.db_name      = db_name
        self.db_user      = db_user
        self.db_pass      = db_pass
        self.child        = None
        self.alive        = False
        self._lock        = threading.Lock()
        self._script_path = None

    def connect(self):
        px = self.px
        log.info('Connecting to PAM %s:%s (.env: %s)', PAM_HOST, PAM_PORT, _env_file or 'not found')
        cmd = (
            f'ssh -tt -p {PAM_PORT} -F /dev/null'
            f' -o StrictHostKeyChecking=no'
            f' -o UserKnownHostsFile=/dev/null'
            f' -o ServerAliveInterval=20'
            f' -o ServerAliveCountMax=3'
            f' -o ConnectTimeout=20'
            f' -o KexAlgorithms=+diffie-hellman-group14-sha1'
            f' -o HostKeyAlgorithms=+ssh-rsa'
            f' -o PubkeyAcceptedAlgorithms=+ssh-rsa'
            f' {self.pam_user}@{PAM_HOST}'
        )
        c = px.spawn(cmd, timeout=130, maxread=1048576, searchwindowsize=65536)
        c.setwinsize(150, 65535)

        def ex(pats, name, t=30):
            i = c.expect(pats + [px.TIMEOUT, px.EOF], timeout=t)
            if i >= len(pats):
                ctx = (c.before or b'')[-300:]
                raise RuntimeError(f'{name}: {"TIMEOUT" if i==len(pats) else "EOF"} | {ctx!r}')
            return i

        def s(d):
            c.send((d.encode() if isinstance(d, str) else d) + b'\r')

        ex([b'[Pp]assword:'],    'PAM password',    t=25); s(self.pam_pass)
        ex([b'select one:'],     'PAM menu',         t=30); s(self.target_host)
        ex([b'[Uu]sername'],     'Username',         t=40); s(self.target_user)
        ex([b'[Pp]assword:'],    'Server password', t=25); s(self.target_pass)
        ex([b'\\$ ', b'# '], 'Shell prompt',    t=70)

        self.child = c

        script_path = f'/tmp/.sed_{secrets.token_hex(8)}.py'
        c.send(f"printf '%s' {_sq(_REMOTE_SCRIPT_B64)} | base64 -d > {script_path}\r".encode())
        ex([b'\\$ ', b'# '], 'Script write', t=15)
        self._script_path = script_path

        self.alive = True
        log.info('SSH connected, script: %s', script_path)

    def run(self, sql, mode, limit, schema='', db_override=None):
        if not self.alive:
            raise RuntimeError('Session not active')
        with self._lock:
            if not self.alive:
                raise RuntimeError('Session not active')
            return self._exec(sql, mode, limit, schema, db_override)

    def _exec(self, sql, mode, limit, schema='', db_override=None):
        px, c = self.px, self.child
        wrapped = f'SELECT * FROM ({sql}) __w__ LIMIT {limit}' if mode == 'preview' and limit > 0 else sql
        # Для выбранной схемы выставляем search_path перед запросом
        # (schema уже провалидирована регуляркой выше по стеку).
        # Если схема не задана или сама равна public — не дублируем
        # (иначе получалось 'SET search_path TO "public", public;').
        if schema and schema.lower() != 'public':
            wrapped = f'SET search_path TO "{schema}", "public"; ' + wrapped
        # db_override позволяет на той же ВМ-сессии ходить в другую базу
        # (профиль CHED2: те же креды/ВМ, другой host/name).
        if db_override:
            db_host, db_port, db_name, db_user, db_pass = db_override
        else:
            db_host, db_port, db_name = self.db_host, self.db_port, self.db_name
            db_user, db_pass = self.db_user, self.db_pass

        token   = secrets.token_hex(10)
        d_start = f'SEDQBEGIN{token}'.encode()
        d_end   = f'SEDQEND{token}'.encode()

        run_cmd = (
            f'_SED_SQL={_b64env(wrapped)} '
            f'_SED_MODE={_sq(mode)} '
            f'_SED_LIMIT={_sq(str(limit))} '
            f'_SED_DBHOST={_sq(db_host)} '
            f'_SED_DBPORT={_sq(db_port)} '
            f'_SED_DBNAME={_sq(db_name)} '
            f'_SED_DBUSER={_sq(db_user)} '
            f'_SED_DBPASS={_b64env(db_pass)} '
            f'python3 {self._script_path}'
        )
        inner     = f'echo {d_start.decode()} ; {run_cmd} ; echo {d_end.decode()}'
        inner_b64 = base64.b64encode(inner.encode()).decode()
        outer     = f'eval "$(printf \'%s\' {_sq(inner_b64)} | base64 -d)"'
        c.send((outer + '\r').encode())

        idx = c.expect([d_start, px.TIMEOUT, px.EOF], timeout=20)
        if idx != 0:
            self.alive = False
            raise RuntimeError(f'Start marker: {"TIMEOUT" if idx==1 else "EOF"}')

        idx = c.expect([d_end, px.TIMEOUT, px.EOF], timeout=QUERY_TIMEOUT)
        if idx != 0:
            self.alive = False
            raise RuntimeError(f'Query {"TIMEOUT" if idx==1 else "EOF"}')

        raw   = c.before
        lines = [ln.strip() for ln in raw.replace(b'\r', b'\n').split(b'\n') if ln.strip()]
        json_line = None
        for ln in reversed(lines):
            decoded = ln.decode(errors='replace')
            if decoded.startswith('{'):
                json_line = decoded
                break

        if not json_line:
            self.alive = False
            raise RuntimeError(f'JSON not found. Output: {raw[-300:]!r}')

        return json.loads(json_line)

    def ping(self):
        with self._lock:
            if not self.alive or not self.child:
                return False
            try:
                self.child.send(b'\r')
                self.child.expect([b'\\$ ', b'# ', self.px.TIMEOUT], timeout=5)
                return True
            except Exception:
                self.alive = False
                return False

    def close(self):
        self.alive = False
        if self.child:
            if self._script_path:
                try: self.child.send(f'rm -f {self._script_path}\r'.encode())
                except Exception: pass
                self._script_path = None
            try: self.child.send(b'exit\r'); self.child.close(force=True)
            except: pass
            self.child = None

class SessionPool:
    """Пул SSH-сессий одного профиля: до `size` параллельных запросов.
    Сессии создаются лениво и подключаются при первом использовании.

    LIFO (стек): под низкой нагрузкой раз за разом отдаётся одна и та же
    уже подключённая («тёплая») сессия — не платим за дорогой PAM/SSH-коннект
    на каждый запрос. Дополнительные сессии поднимаются только при реальной
    одновременности (когда верхняя занята другим запросом)."""
    def __init__(self, factory, size):
        self._factory = factory
        self._size = max(1, int(size))
        self._all = []
        self._free = queue.LifoQueue()
        self._build_lock = threading.Lock()

    def _ensure_built(self):
        with self._build_lock:
            while len(self._all) < self._size:
                s = self._factory()
                self._all.append(s)
                self._free.put(s)

    def acquire(self, timeout):
        """Взять свободную сессию (блокирует до timeout секунд)."""
        self._ensure_built()
        return self._free.get(timeout=timeout)

    def release(self, sess):
        self._free.put(sess)

    def keepalive(self):
        """Пингуем только СЕЙЧАС свободные сессии, не мешая занятым."""
        drained = []
        while True:
            try:
                drained.append(self._free.get_nowait())
            except queue.Empty:
                break
        for s in drained:
            try:
                if s.alive:
                    s.ping()
            except Exception:
                pass
        # Возвращаем так, чтобы «тёплые» (alive) оказались наверху стека и
        # переиспользовались первыми: живые кладём последними.
        for s in sorted(drained, key=lambda x: 1 if getattr(x, 'alive', False) else 0):
            self._free.put(s)

    def close_all(self):
        for s in self._all:
            try:
                s.close()
            except Exception:
                pass

    def any_alive(self):
        return any(getattr(s, 'alive', False) for s in self._all)


class Daemon:
    def __init__(self):
        # Пулы SSH-сессий по профилям: 'sed', 'ched' (общий для ched/ched2), 'ksp', 'monitoring'
        self._pools      = {}
        self._pools_lock = threading.Lock()
        self.cache = Cache()
        self._stop = threading.Event()
        self._inflight      = {}
        self._inflight_lock = threading.Lock()

    def _pool_for(self, profile):
        """Пул для профиля. CHED и CHED2 живут на одной ВМ → общий пул
        (в CHED2 отличается только БД через db_override). KSP — свой."""
        key = 'ched' if profile in ('ched', 'ched2') else profile
        with self._pools_lock:
            pool = self._pools.get(key)
            if pool is not None:
                return pool
            if key == 'sed':
                factory = lambda: Session(PAM_USER, PAM_PASS, TARGET_HOST, TARGET_USER, TARGET_PASS,
                                          DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS)
                size = SED_POOL_SIZE
            elif key == 'ched':
                if not CHED_TARGET_HOST:
                    raise RuntimeError('CHED не настроен: нет CHED_TARGET_HOST в .env')
                factory = lambda: Session(CHED_PAM_USER, CHED_PAM_PASS, CHED_TARGET_HOST, CHED_TARGET_USER, CHED_TARGET_PASS,
                                          CHED_DB_HOST, CHED_DB_PORT, CHED_DB_NAME, CHED_DB_USER, CHED_DB_PASS)
                size = CHED_POOL_SIZE
            elif key == 'ksp':
                if not KSP_TARGET_HOST:
                    raise RuntimeError('KSP не настроен: нет KSP_TARGET_HOST в .env')
                factory = lambda: Session(KSP_PAM_USER, KSP_PAM_PASS, KSP_TARGET_HOST, KSP_TARGET_USER, KSP_TARGET_PASS,
                                          KSP_DB_HOST, KSP_DB_PORT, KSP_DB_NAME, KSP_DB_USER, KSP_DB_PASS)
                size = KSP_POOL_SIZE
            elif key == 'monitoring':
                if not MONITORING_TARGET_HOST:
                    raise RuntimeError('MONITORING не настроен: нет MONITORING_TARGET_HOST в .env')
                factory = lambda: Session(MONITORING_PAM_USER, MONITORING_PAM_PASS, MONITORING_TARGET_HOST, MONITORING_TARGET_USER, MONITORING_TARGET_PASS,
                                          MONITORING_DB_HOST, MONITORING_DB_PORT, MONITORING_DB_NAME, MONITORING_DB_USER, MONITORING_DB_PASS)
                size = MONITORING_POOL_SIZE
            else:
                raise RuntimeError(f'Неизвестный профиль: {profile}')
            pool = SessionPool(factory, size)
            self._pools[key] = pool
            return pool

    def _ensure_connected(self, sess):
        """Подключает сессию (с ретраями), если она не живая."""
        if sess.alive:
            return
        last = None
        for n in range(1, MAX_RECONNECTS + 1):
            try:
                sess.close()
                sess.connect()
                return
            except Exception as e:
                last = e
                log.error('Подключение %d/%d: %s', n, MAX_RECONNECTS, e)
                if n < MAX_RECONNECTS:
                    time.sleep(5 * n)
        raise RuntimeError(f'не удалось подключиться: {last}')

    def _execute_query(self, sql, mode, limit, profile='sed', schema=''):
        # CHED2 ходит в другую базу на той же CHED-ВМ
        db_override = None
        if profile == 'ched2':
            # Без CHED2_DB_NAME подключение ушло бы в БД по умолчанию и
            # показало бы «чужие» (например CHED) схемы — явная ошибка вместо
            # тихой путаницы.
            if not CHED2_DB_NAME:
                return {'ok': False, 'error': 'CHED2 не настроен: задайте CHED2_DB_NAME в .env'}
            db_override = (CHED2_DB_HOST, CHED2_DB_PORT, CHED2_DB_NAME,
                           CHED_DB_USER, CHED_DB_PASS)
        pool = self._pool_for(profile)
        try:
            sess = pool.acquire(timeout=QUERY_TIMEOUT + 60)
        except queue.Empty:
            return {'ok': False, 'error': 'Все сессии заняты, попробуйте позже'}
        try:
            for attempt in range(2):
                try:
                    self._ensure_connected(sess)
                    return sess.run(sql, mode, limit, schema, db_override)
                except RuntimeError as e:
                    if attempt == 0:
                        log.warning('Сессия (%s) упала: %s — реконнект', profile, e)
                        try:
                            sess.close()
                        except Exception:
                            pass
                        sess.alive = False
                        continue
                    return {'ok': False, 'error': str(e)}
        finally:
            pool.release(sess)

    def _handle(self, conn):
        try:
            data = b''
            while True:
                chunk = conn.recv(65536)
                if not chunk: break
                data += chunk
                if b'\n' in data: break

            req   = json.loads(data.strip())
            sql   = req.get('sql', '').strip()
            mode  = req.get('mode', 'preview')
            limit = int(req.get('limit', 100))
            profile = req.get('profile', 'sed')
            if profile not in ('sed', 'ched', 'ched2', 'ksp', 'monitoring'):
                profile = 'sed'
            schema = (req.get('schema') or '').strip()
            if schema and not _SCHEMA_RE.match(schema):
                conn.sendall(json.dumps({'ok': False, 'error': 'Недопустимая схема'}).encode() + b'\n')
                return

            if sql == '__ping__':
                try:
                    ssh_ok = self._pool_for('sed').any_alive()
                except Exception:
                    ssh_ok = False
                conn.sendall(json.dumps({'ok': True, 'pong': True, 'ssh': ssh_ok}).encode() + b'\n')
                return

            # Принудительный сброс кэша
            if sql == '__clear_cache__':
                cleared = self.cache.clear_all()
                conn.sendall(json.dumps({'ok': True, 'cleared': cleared}).encode() + b'\n')
                return

            # Доверенная внутренняя отмена бэкенда PostgreSQL по pid.
            # Идёт мимо validate_readonly: pg_cancel_backend запрещён в
            # пользовательском SQL, но приложению нужно отменять свои же
            # тяжёлые запросы (RemoteRunner::cancelBackend).
            if sql.startswith('__cancel__:'):
                try:
                    _pid = int(sql.split(':', 1)[1])
                except (ValueError, IndexError):
                    conn.sendall(json.dumps({'ok': False, 'error': 'bad pid'}).encode() + b'\n')
                    return
                res = self._execute_query(f'SELECT pg_cancel_backend({_pid})', 'preview', 1, profile, '')
                conn.sendall(json.dumps(res, default=str).encode() + b'\n')
                log.info('CANCEL backend pid=%d profile=%s ok=%s', _pid, profile, res.get('ok'))
                return

            if not sql:
                conn.sendall(json.dumps({'ok': False, 'error': 'SQL пустой'}).encode() + b'\n')
                return

            try:
                validate_readonly(sql, allow_signal=bool(req.get('privileged', False)))
            except ValueError as ve:
                conn.sendall(json.dumps({'ok': False, 'error': str(ve)}).encode() + b'\n')
                log.warning('REJECTED sql=%.70s reason=%s', sql, ve)
                return

            # Ключ кэша/дедупликации учитывает профиль и схему,
            # иначе CHED и СЭД получат перекрёстные результаты.
            ckey = f'{profile}\x1f{schema}\x1f{sql}'

            hit = self.cache.get(ckey, mode, limit)
            if hit:
                conn.sendall(json.dumps(hit, default=str).encode() + b'\n')
                log.info('CACHE sql=%.70s', sql)
                return

            inflight_key = f'{ckey}|{mode}|{limit}'
            with self._inflight_lock:
                if inflight_key in self._inflight:
                    entry    = self._inflight[inflight_key]
                    is_first = False
                    log.info('DEDUP ожидаем sql=%.70s', sql)
                else:
                    entry    = {'event': threading.Event(), 'result': None}
                    self._inflight[inflight_key] = entry
                    is_first = True

            if not is_first:
                entry['event'].wait(timeout=1820)
                res = entry['result'] or {'ok': False, 'error': 'Таймаут ожидания'}
                conn.sendall(json.dumps(res, default=str).encode() + b'\n')
                return

            res = {'ok': False, 'error': 'Неизвестная ошибка'}
            try:
                res = self._execute_query(sql, mode, limit, profile, schema)
                if res.get('ok'):
                    self.cache.put(ckey, mode, limit, res)
                    log.info('OK rows=%d sql=%.70s', res.get('count', 0), sql)
                else:
                    log.warning('ERR %s', res.get('error', '?'))
            finally:
                with self._inflight_lock:
                    entry['result'] = res
                    entry['event'].set()
                    self._inflight.pop(inflight_key, None)

            conn.sendall(json.dumps(res, default=str).encode() + b'\n')

        except Exception as e:
            log.exception('Клиент: %s', e)
            try:
                conn.sendall(json.dumps({'ok': False, 'error': str(e)}).encode() + b'\n')
            except: pass
        finally:
            try: conn.close()
            except: pass

    def _keepalive(self):
        while not self._stop.wait(KEEPALIVE_SEC):
            for pool in list(self._pools.values()):
                try:
                    pool.keepalive()
                except Exception as e:
                    log.error('KA: %s', e)

    def run(self):
        # Прогреваем sed-пул: одну сессию подключаем сразу — fail-fast по кредам.
        try:
            pool = self._pool_for('sed')
            sess = pool.acquire(timeout=130)
            try:
                self._ensure_connected(sess)
            finally:
                pool.release(sess)
        except Exception as e:
            log.critical('Первое подключение: %s', e)
            sys.exit(1)

        try: os.unlink(SOCK_PATH)
        except: pass

        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        _old_umask = os.umask(0o077)
        try:
            srv.bind(SOCK_PATH)
        finally:
            os.umask(_old_umask)
        os.chmod(SOCK_PATH, 0o600)   # только uid веб-сервера (php-fpm/apache)
        srv.listen(16)
        srv.settimeout(1.0)

        threading.Thread(target=self._keepalive, daemon=True).start()

        def _sig(s, f):
            log.info('Сигнал %d', s)
            self._stop.set()
        signal.signal(signal.SIGTERM, _sig)
        signal.signal(signal.SIGINT, _sig)

        log.info('Демон слушает %s (persistent worker)', SOCK_PATH)

        while not self._stop.is_set():
            try:
                conn, _ = srv.accept()
                threading.Thread(target=self._handle, args=(conn,), daemon=True).start()
            except socket.timeout:
                continue
            except Exception as e:
                if not self._stop.is_set():
                    log.error('accept: %s', e)

        srv.close()
        try: os.unlink(SOCK_PATH)
        except: pass
        for pool in list(self._pools.values()):
            try: pool.close_all()
            except Exception: pass
        log.info('Остановлен')


def _pid():
    try: return int(Path(PID_FILE).read_text().strip())
    except: return None

def _alive(pid=None):
    p = pid or _pid()
    if not p: return False
    try: os.kill(p, 0); return True
    except: return False

def cmd_start():
    if _alive():
        print(f'Демон уже запущен (PID {_pid()})')
        return
    pid = os.fork()
    if pid > 0:
        print(f'Демон запускается… Лог: {LOG_FILE}')
        print(f'Проверить: python3 {sys.argv[0]} --status')
        return
    os.setsid()
    if os.fork() > 0: sys.exit(0)
    sys.stdout = open(os.devnull, 'w')
    sys.stderr = open(os.devnull, 'w')
    sys.stdin  = open(os.devnull, 'r')
    Path(PID_FILE).write_text(str(os.getpid()))
    try:
        Daemon().run()
    finally:
        try: os.unlink(PID_FILE)
        except: pass

def cmd_stop():
    pid = _pid()
    if not _alive(pid):
        print('Демон не запущен')
        try: os.unlink(PID_FILE)
        except: pass
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        time.sleep(0.5)
        if not _alive(pid):
            print(f'Демон (PID {pid}) остановлен')
            try: os.unlink(PID_FILE)
            except: pass
            return
    print(f'Не остановился, принудительно: kill -9 {pid}')

def cmd_status():
    pid = _pid()
    if not _alive(pid):
        print('✗ Демон не запущен')
        if os.path.exists(LOG_FILE):
            print(f'\nПоследние строки лога ({LOG_FILE}):')
            lines = Path(LOG_FILE).read_text().splitlines()
            for l in lines[-10:]: print(' ', l)
        return
    print(f'• Демон запущен (PID {pid})')
    if os.path.exists(SOCK_PATH):
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(5)
            s.connect(SOCK_PATH)
            s.sendall(b'{"sql":"__ping__","mode":"preview","limit":1}\n')
            r = json.loads(s.recv(1024).strip())
            s.close()
            ssh_ok = r.get('ssh', '?')
            print(f'✓ Сокет отвечает | SSH: {"активен" if ssh_ok else "не активен"}')
        except Exception as e:
            print(f'✗ Сокет не отвечает: {e}')
    else:
        print('⏳ Сокет ещё не создан (SSH подключается…)')
        print(f'   Лог: tail -f {LOG_FILE}')

def cmd_logs(n=30):
    if not os.path.exists(LOG_FILE):
        print('Лог пуст')
        return
    lines = Path(LOG_FILE).read_text().splitlines()
    print(f'--- последние {n} строк {LOG_FILE} ---')
    for l in lines[-n:]: print(l)

def cmd_restart():
    cmd_stop()
    time.sleep(2)
    cmd_start()

def cmd_foreground():
    Path(PID_FILE).write_text(str(os.getpid()))
    try:
        Daemon().run()
    finally:
        try: os.unlink(PID_FILE)
        except: pass


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description='pam_daemon — SSH-демон для СЭД')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--start',      action='store_true')
    g.add_argument('--stop',       action='store_true')
    g.add_argument('--restart',    action='store_true')
    g.add_argument('--status',     action='store_true')
    g.add_argument('--logs',       action='store_true')
    g.add_argument('--foreground', action='store_true', help='Запуск в терминале (отладка)')
    args = ap.parse_args()

    if args.start:        cmd_start()
    elif args.stop:       cmd_stop()
    elif args.restart:    cmd_restart()
    elif args.status:     cmd_status()
    elif args.logs:       cmd_logs()
    elif args.foreground: cmd_foreground()