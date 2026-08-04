<?php
require_once __DIR__ . '/Totp.php';

class AuthController
{
    private const JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;

    // ── 2FA: доступ к локальной БД (та же, что логи/префы) ─────────
    private function tfaDb(): ?PDO
    {
        static $pdo = null;
        if ($pdo !== null) return $pdo;
        $host = Config::get('LOG_DB_HOST', '');
        $port = Config::get('LOG_DB_PORT', '5432');
        $name = Config::get('LOG_DB_NAME', '');
        $user = Config::get('LOG_DB_USER', '');
        $pass = Config::get('LOG_DB_PASS', '');
        if ($name === '') return null;
        try {
            $dsn = ($host !== '')
                ? "pgsql:host={$host};port={$port};dbname={$name}"
                : "pgsql:dbname={$name}";
            $pdo = new PDO($dsn, $user ?: null, $pass ?: null, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
            $pdo->exec("CREATE TABLE IF NOT EXISTS sed_2fa (
                user_key   TEXT PRIMARY KEY,
                secret     TEXT NOT NULL,
                enabled    BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT now()
            )");
            // ФИО для отображения в админ-панели (для старых таблиц — добавляем)
            $pdo->exec("ALTER TABLE sed_2fa ADD COLUMN IF NOT EXISTS user_name TEXT");
            return $pdo;
        } catch (\Throwable $e) {
            error_log('[Auth::2fa] DB connect error: ' . $e->getMessage());
            return null;
        }
    }

    /** Запись 2FA пользователя или null. */
    private function tfaRow(string $key): ?array
    {
        $db = $this->tfaDb();
        if (!$db) return null;
        $st = $db->prepare("SELECT secret, enabled FROM sed_2fa WHERE user_key = ?");
        $st->execute([$key]);
        $row = $st->fetch();
        return $row ?: null;
    }

    /**
     * Общий финал успешной проверки пароля: либо требуем 2FA,
     * либо (для мобильного клиента) выдаём сессию сразу.
     * Возвращает true, если ответ уже отправлен.
     */
    private function gate2fa(string $key, string $name, bool $isAdmin): void
    {
        // Признак мобильного клиента влияет ТОЛЬКО на способ выдачи сессии
        // (bearer-токен вместо cookie) и НЕ пропускает второй фактор.
        // Заголовок задаётся клиентом, поэтому доверять ему для обхода 2FA
        // нельзя (V-01): мобильное приложение проходит тот же verify_2fa-флоу.
        $isMobile = (!empty($_SERVER['HTTP_X_MOBILE_CLIENT'])
            && $_SERVER['HTTP_X_MOBILE_CLIENT'] === 'SEDAdmin');

        $db = $this->tfaDb();
        if (!$db) {
            // 2FA обязателен для всех — без локальной БД вход невозможен (fail-closed)
            $this->json(['ok' => false, 'error' => '2FA недоступен: лог-БД не отвечает. Обратитесь к администратору.']);
            return;
        }

        $row = $this->tfaRow($key);

        if ($row && $row['enabled']) {
            // 2FA уже настроен — просим код (и web, и mobile идут единым путём)
            $_SESSION['pending_2fa'] = ['key' => $key, 'name' => $name, 'isAdmin' => $isAdmin, 'mode' => 'verify', 'tries' => 0, 'mobile' => $isMobile];
            $this->json(['ok' => false, 'stage' => 'verify_2fa']);
            return;
        }

        // Первый вход / 2FA не настроен → принудительная привязка
        $secret = Totp::generateSecret();
        $issuer  = $this->env('SED_2FA_ISSUER', 'СЭД КСП');
        $account = $name !== '' ? $name : $key;
        $_SESSION['pending_2fa'] = [
            'key' => $key, 'name' => $name, 'isAdmin' => $isAdmin,
            'mode' => 'enroll', 'secret' => $secret, 'tries' => 0, 'mobile' => $isMobile,
        ];
        $this->json([
            'ok' => false, 'stage' => 'enroll_2fa',
            'otpauth' => Totp::otpauthUrl($secret, $account, $issuer),
            'secret'  => $secret,
            'issuer'  => $issuer,
            'account' => $account,
        ]);
    }

    /** ФИО из .env, кому разрешены источники CHED/CHED2 (кроме админа). */
    private function isRemoteUser(string $name): bool
    {
        $raw = $this->env('REMOTE_USERS', '');
        if ($raw === '' || $name === '') return false;
        $name = trim($name);
        foreach (preg_split('/[;\n]+/', $raw) as $fio) {
            if (trim($fio) !== '' && mb_strtolower(trim($fio)) === mb_strtolower($name)) {
                return true;
            }
        }
        return false;
    }

    /** Выдать сессию (после пароля+2FA или мобильному клиенту). */
    private function grantSession(string $key, string $name, bool $isAdmin, bool $mobileToken = false): void
    {
        // Пересоздаём ID только при первом получении привилегий (вход).
        // При перепривязке 2FA пользователь уже в сессии — regenerate не нужен
        // и может мешать корректному ответу.
        if (empty($_SESSION['sed_user'])) {
            session_regenerate_id(true);
        }
        $canRemote = $isAdmin || $this->isRemoteUser($name);
        $_SESSION['sed_user'] = ['name' => $name, 'isAdmin' => $isAdmin, 'canRemote' => $canRemote, 'key' => $key];
        unset($_SESSION['pending_2fa']);
        $resp = ['ok' => true, 'name' => $name, 'isAdmin' => $isAdmin, 'canRemote' => $canRemote];
        if ($mobileToken) {
            $token = bin2hex(random_bytes(32));
            $tokenFile = sys_get_temp_dir() . '/sed_mobile_' . md5($token) . '.tok';
            file_put_contents($tokenFile, json_encode(['user' => ['name' => $name, 'isAdmin' => $isAdmin], 'expires' => time() + 86400]));
            $resp['token'] = $token;
        }
        $this->json($resp);
    }

    /** Эндпоинт: проверка кода 2FA (привязка или вход). */
    public function verify2fa(): void
    {
        try {
            $body = json_decode((string) file_get_contents('php://input'), true);
            $code = preg_replace('/\D/', '', (string) ($body['code'] ?? ''));
            $pending = $_SESSION['pending_2fa'] ?? null;

            if (!is_array($pending)) {
                $this->json(['ok' => false, 'error' => 'Сессия привязки истекла, войдите снова']);
                return;
            }
            // защита от перебора кода
            $pending['tries'] = (int) ($pending['tries'] ?? 0) + 1;
            $_SESSION['pending_2fa'] = $pending;
            if ($pending['tries'] > 6) {
                unset($_SESSION['pending_2fa']);
                $this->json(['ok' => false, 'error' => 'Слишком много попыток. Войдите заново.']);
                return;
            }

            $key = (string) $pending['key'];

            if ($pending['mode'] === 'enroll') {
                $secret = (string) $pending['secret'];
                if (!Totp::verify($secret, $code)) {
                    $this->json(['ok' => false, 'error' => 'Неверный код']);
                    return;
                }
                $db = $this->tfaDb();
                if (!$db) { $this->json(['ok' => false, 'error' => 'Лог-БД недоступна']); return; }
                $st = $db->prepare("INSERT INTO sed_2fa (user_key, secret, enabled, user_name)
                    VALUES (?, ?, TRUE, ?)
                    ON CONFLICT (user_key) DO UPDATE SET secret = EXCLUDED.secret, enabled = TRUE, user_name = EXCLUDED.user_name");
                $st->execute([$key, $secret, (string) $pending['name']]);
                $this->grantSession($key, (string) $pending['name'], (bool) $pending['isAdmin'], !empty($pending['mobile']));
                return;
            }

            // mode = verify
            $row = $this->tfaRow($key);
            if (!$row || !$row['enabled']) {
                $this->json(['ok' => false, 'error' => '2FA не настроен']);
                return;
            }
            if (!Totp::verify((string) $row['secret'], $code)) {
                $this->json(['ok' => false, 'error' => 'Неверный код']);
                return;
            }
            $this->grantSession($key, (string) $pending['name'], (bool) $pending['isAdmin'], !empty($pending['mobile']));

        } catch (\Throwable $e) {
            error_log('[Auth::verify2fa] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    /**
     * Перепривязка 2FA пользователем самостоятельно.
     * Требует ТЕКУЩИЙ код с привязанного устройства — защита от того,
     * чтобы кто-то за чужим незаблокированным ПК не сменил 2FA.
     * При успехе кладёт новый секрет в pending_2fa (mode=enroll),
     * а подтверждение нового кода идёт через обычный verify2fa.
     */
    public function reEnroll2fa(): void
    {
        try {
            $u = $_SESSION['sed_user'] ?? null;
            if (empty($u['name'])) {
                http_response_code(401);
                $this->json(['ok' => false, 'error' => 'Не авторизован']);
                return;
            }
            $key = (string) ($u['key'] ?? '');
            if ($key === '') { $this->json(['ok' => false, 'error' => 'Не удалось определить пользователя']); return; }

            $body = json_decode((string) file_get_contents('php://input'), true);
            $code = preg_replace('/\D/', '', (string) ($body['code'] ?? ''));

            $row = $this->tfaRow($key);
            if (!$row || !$row['enabled']) { $this->json(['ok' => false, 'error' => '2FA ещё не настроен']); return; }

            // проверяем текущий код с привязанного устройства
            if (!Totp::verify((string) $row['secret'], $code)) {
                $this->json(['ok' => false, 'error' => 'Неверный текущий код']);
                return;
            }

            // код верный → генерируем новый секрет для новой привязки
            $secret  = Totp::generateSecret();
            $issuer  = $this->env('SED_2FA_ISSUER', 'СЭД КСП');
            $account = $u['name'] !== '' ? $u['name'] : $key;
            $_SESSION['pending_2fa'] = [
                'key' => $key, 'name' => (string) $u['name'], 'isAdmin' => (bool) ($u['isAdmin'] ?? false),
                'mode' => 'enroll', 'secret' => $secret, 'tries' => 0,
            ];
            $this->json([
                'ok' => true,
                'otpauth' => Totp::otpauthUrl($secret, $account, $issuer),
                'secret'  => $secret,
                'issuer'  => $issuer,
                'account' => $account,
            ]);
        } catch (\Throwable $e) {
            error_log('[Auth::reEnroll2fa] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  АДМИН-ПАНЕЛЬ 2FA: список, сброс 2FA, снятие блокировки
    // ══════════════════════════════════════════════════════════════

    /** Только админ; иначе отдаёт 403 и завершает. */
    private function requireAdmin(): void
    {
        $u = $_SESSION['sed_user'] ?? null;
        if (empty($u['isAdmin'])) {
            http_response_code(403);
            $this->json(['ok' => false, 'error' => 'Доступ только для администратора']);
            exit;
        }
    }

    /** Список пользователей с настроенным 2FA. */
    public function tfaList(): void
    {
        try {
            $this->requireAdmin();
            $db = $this->tfaDb();
            if (!$db) { $this->json(['ok' => false, 'error' => 'Лог-БД недоступна']); return; }
            $rows = $db->query("SELECT user_key, user_name, enabled, created_at
                                FROM sed_2fa ORDER BY user_name NULLS LAST, user_key")->fetchAll();
            $list = array_map(function (array $r): array {
                $isAdminKey = ($r['user_key'] === '__admin__');
                // Сколько осталось блокировки: max из блока по аккаунту и по IP
                $lockUser = $this->rlExpires($this->rlKeyUser($r['user_key']));
                $lockIp   = $this->maxIpLockFor($r['user_key']);
                $lockedFor = max($lockUser, $lockIp);
                return [
                    'user_key'   => $r['user_key'],
                    'name'       => $r['user_name'] ?: ($isAdminKey ? 'Администратор' : ('ID ' . $r['user_key'])),
                    'enabled'    => (bool) $r['enabled'],
                    'created_at' => $r['created_at'],
                    'isAdmin'    => $isAdminKey,
                    'lockedFor'  => $lockedFor,   // секунд до конца блокировки (0 = не заблокирован)
                ];
            }, $rows ?: []);
            $this->json(['ok' => true, 'rows' => $list]);
        } catch (\Throwable $e) {
            error_log('[Auth::tfaList] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    /** Сброс 2FA пользователю — при следующем входе снова привязка (QR). */
    public function tfaReset(): void
    {
        try {
            $this->requireAdmin();
            $body = json_decode((string) file_get_contents('php://input'), true);
            $key  = trim((string) ($body['user_key'] ?? ''));
            if ($key === '') { $this->json(['ok' => false, 'error' => 'Не указан пользователь']); return; }

            $db = $this->tfaDb();
            if (!$db) { $this->json(['ok' => false, 'error' => 'Лог-БД недоступна']); return; }
            $st = $db->prepare("DELETE FROM sed_2fa WHERE user_key = ?");
            $st->execute([$key]);

            $admin = $_SESSION['sed_user']['name'] ?? '?';
            error_log("[Auth] 2FA reset for user_key={$key} by admin={$admin}");
            $this->json(['ok' => true]);
        } catch (\Throwable $e) {
            error_log('[Auth::tfaReset] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    /** Снять блокировку входа (rate-limit) с пользователя. */
    public function unlockUser(): void
    {
        try {
            $this->requireAdmin();
            $body   = json_decode((string) file_get_contents('php://input'), true);
            $userId = trim((string) ($body['user_key'] ?? $body['userId'] ?? ''));
            if ($userId === '') { $this->json(['ok' => false, 'error' => 'Не указан пользователь']); return; }

            // Сброс лимита по userId (блок 20-по-аккаунту)
            $this->rlReset($this->rlKeyUser($userId));
            // Сброс всех IP-блоков этого пользователя (файлы помечены uid)
            $this->rlResetIpFor($userId);

            $admin = $_SESSION['sed_user']['name'] ?? '?';
            error_log("[Auth] rate-limit unlocked for user={$userId} by admin={$admin}");
            $this->json(['ok' => true]);
        } catch (\Throwable $e) {
            error_log('[Auth::unlockUser] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    /** Список активных блокировок входа (по IP-файлам rate-limit). */
    public function lockList(): void
    {
        try {
            $this->requireAdmin();
            $out = [];
            if (function_exists('apcu_fetch')) {
                // apcu не перечисляет ключи — список недоступен
                $this->json(['ok' => true, 'rows' => [], 'apcu' => true]);
                return;
            }
            foreach (glob(sys_get_temp_dir() . '/sed_rl_ip_*.rl') ?: [] as $f) {
                $data = json_decode(@file_get_contents($f), true);
                if (!is_array($data)) continue;
                $count   = (int) ($data['count'] ?? 0);
                $expires = (int) ($data['expires'] ?? 0);
                $left    = $expires - time();
                // показываем только реально заблокированных и не истёкших
                if ($count >= 5 && $left > 0) {
                    $uid = (string) ($data['uid'] ?? '');
                    $out[] = [
                        'file'      => basename($f),        // ключ для снятия
                        'uid'       => $uid,
                        'name'      => $this->nameForUid($uid),
                        'attempts'  => $count,
                        'lockedFor' => $left,
                    ];
                }
            }
            // по убыванию оставшегося времени
            usort($out, static fn($a, $b) => $b['lockedFor'] <=> $a['lockedFor']);
            $this->json(['ok' => true, 'rows' => $out]);
        } catch (\Throwable $e) {
            error_log('[Auth::lockList] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    /** Снять одну конкретную блокировку по имени файла. */
    public function unlockKey(): void
    {
        try {
            $this->requireAdmin();
            $body = json_decode((string) file_get_contents('php://input'), true);
            $file = basename((string) ($body['file'] ?? '')); // basename — защита от path traversal
            // разрешаем снимать только rate-limit файлы
            if ($file === '' || !preg_match('/^sed_rl_(ip|usr)_[a-f0-9]+\.rl$/', $file)) {
                $this->json(['ok' => false, 'error' => 'Неверный ключ']); return;
            }
            $path = sys_get_temp_dir() . '/' . $file;
            if (is_file($path)) @unlink($path);

            $admin = $_SESSION['sed_user']['name'] ?? '?';
            error_log("[Auth] lock {$file} removed by admin={$admin}");
            $this->json(['ok' => true]);
        } catch (\Throwable $e) {
            error_log('[Auth::unlockKey] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    /** Резолв имени по uid (для отображения в списке блокировок). */
    private function nameForUid(string $uid): string
    {
        if ($uid === '') return 'неизвестно';
        if ($uid === '__admin__') return 'Администратор';
        // пробуем взять ФИО из таблицы 2FA (если пользователь там есть)
        try {
            $db = $this->tfaDb();
            if ($db) {
                $st = $db->prepare("SELECT user_name FROM sed_2fa WHERE user_key = ?");
                $st->execute([$uid]);
                $n = $st->fetchColumn();
                if ($n) return (string) $n;
            }
        } catch (\Throwable $_) {}
        return 'ID ' . $uid;
    }

    private function env(string $key, string $default = ''): string
    {
        try {
            $v = Config::get($key, '');
            if ($v !== '' && $v !== null) return (string)$v;
        } catch (\Throwable $_) {}
        $v = getenv($key);
        if ($v !== false && $v !== '') return $v;
        if (isset($_ENV[$key]) && $_ENV[$key] !== '') return (string)$_ENV[$key];
        return $default;
    }

    private function json(array $data): void
    {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, self::JSON_FLAGS);
    }

    private function rlKeyIp(string $userId): string
    {
        $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
        return 'sed_rl_ip_' . md5($userId . '_' . $ip);
    }

    private function rlKeyUser(string $userId): string
    {
        return 'sed_rl_usr_' . md5($userId);
    }

    private function rlFile(string $key): string
    {
        return sys_get_temp_dir() . '/' . $key . '.rl';
    }

    private function rlGet(string $key): int
    {
        if (function_exists('apcu_fetch')) {
            $v = apcu_fetch($key);
            return $v === false ? 0 : (int)$v;
        }
        $f = $this->rlFile($key);
        if (!file_exists($f)) return 0;
        $data = json_decode(file_get_contents($f), true);
        if (!$data || ($data['expires'] ?? 0) < time()) return 0;
        return (int)($data['count'] ?? 0);
    }

    private function rlIncrement(string $key, int $ttl = 300, string $uid = ''): void
    {
        if (function_exists('apcu_fetch')) {
            $cur = apcu_fetch($key);
            if ($cur === false) apcu_store($key, 1, $ttl);
            else apcu_store($key, $cur + 1, $ttl);
            return;
        }
        $f    = $this->rlFile($key);
        $data = ['count' => $this->rlGet($key) + 1, 'expires' => time() + $ttl, 'uid' => $uid];
        file_put_contents($f, json_encode($data), LOCK_EX);
    }

    /** Сколько секунд осталось до снятия ограничения по ключу. */
    private function rlExpires(string $key): int
    {
        if (function_exists('apcu_fetch')) {
            if (function_exists('apcu_key_info')) {
                $info = @apcu_key_info($key);
                if ($info && isset($info['ttl'], $info['creation_time'])) {
                    return max(0, ($info['creation_time'] + (int)$info['ttl']) - time());
                }
            }
            return 300; // не смогли узнать точно — отдаём полный интервал
        }
        $f = $this->rlFile($key);
        if (!file_exists($f)) return 0;
        $data = json_decode(file_get_contents($f), true);
        return max(0, (int)($data['expires'] ?? 0) - time());
    }

    private function rlReset(string $key): void
    {
        if (function_exists('apcu_delete')) { apcu_delete($key); return; }
        @unlink($this->rlFile($key));
    }

    /** Удалить все IP-файлы лимита, помеченные данным userId. */
    private function rlResetIpFor(string $userId): void
    {
        if (function_exists('apcu_fetch')) return; // apcu: точечно по ip не адресуемо
        foreach (glob(sys_get_temp_dir() . '/sed_rl_ip_*.rl') ?: [] as $f) {
            $data = json_decode(@file_get_contents($f), true);
            if (is_array($data) && ($data['uid'] ?? '') === $userId) {
                @unlink($f);
            }
        }
    }

    /** Максимальный остаток блокировки среди IP-файлов пользователя (0 = нет). */
    private function maxIpLockFor(string $userId): int
    {
        if (function_exists('apcu_fetch')) return 0; // apcu: по ip не перечислить
        $max = 0;
        foreach (glob(sys_get_temp_dir() . '/sed_rl_ip_*.rl') ?: [] as $f) {
            $data = json_decode(@file_get_contents($f), true);
            if (is_array($data) && ($data['uid'] ?? '') === $userId) {
                // блокировка активна только если попыток >= 5
                if ((int)($data['count'] ?? 0) >= 5) {
                    $left = max(0, (int)($data['expires'] ?? 0) - time());
                    if ($left > $max) $max = $left;
                }
            }
        }
        return $max;
    }

    private function checkRateLimit(string $userId): void
    {
        $ip  = $_SERVER['REMOTE_ADDR'] ?? 'unknown';

        // По паре userId+IP: 5 попыток за 5 минут
        $keyIp   = $this->rlKeyIp($userId);
        $byIp    = $this->rlGet($keyIp);
        if ($byIp >= 5) {
            http_response_code(429);
            $this->json(['ok' => false, 'error' => 'Слишком много попыток. Попробуйте позже.', 'retryAfter' => $this->rlExpires($keyIp)]);
            exit;
        }

        // По userId: 20 попыток за 5 минут (с любых IP)
        $keyUser = $this->rlKeyUser($userId);
        $byUser  = $this->rlGet($keyUser);
        if ($byUser >= 20) {
            http_response_code(429);
            error_log("[Auth] ACCOUNT LOCKOUT: user#{$userId} from {$ip} ({$byUser} attempts across IPs)");
            $this->json(['ok' => false, 'error' => 'Аккаунт временно заблокирован.', 'retryAfter' => $this->rlExpires($keyUser)]);
            exit;
        }
    }

    private function incrementRateLimit(string $userId): void
    {
        $this->rlIncrement($this->rlKeyIp($userId),   300, $userId);
        $this->rlIncrement($this->rlKeyUser($userId), 300, $userId);
    }

    private function resetRateLimit(string $userId): void
    {
        $this->rlReset($this->rlKeyIp($userId));
        $this->rlReset($this->rlKeyUser($userId));
    }

    public function users(): void
    {
        try {
            $orgId = (int) $this->env('AUTH_ORG_ID');
            if ($orgId <= 0) {
                $this->json(['ok' => false, 'error' => 'AUTH_ORG_ID не задан в .env']);
                return;
            }
            // login не отдаём публично — снижаем разведку для таргетированного
            // брутфорса/DoS. Вход идёт по id, отображается name (всегда непустой).
            $sql   = "SELECT id, name
                      FROM usr
                      WHERE group_id = {$orgId}
                        AND fired = 0
                        AND password <> ''
                        AND name <> ''
                      ORDER BY name
                      LIMIT 1000";

            $res = (new RemoteRunner())->runQuery($sql, 'preview', 1000);

            if (!($res['ok'] ?? false)) {
                $this->json(['ok' => false, 'error' => $res['error'] ?? 'Ошибка загрузки']);
                return;
            }

            $safe = array_map(static function (array $row): array {
                unset($row['password'], $row['token'], $row['secret'], $row['hash']);
                return $row;
            }, $res['rows'] ?? []);

            $this->json(['ok' => true, 'rows' => $safe]);

        } catch (\Throwable $e) {
            error_log('[Auth::users] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    public function login(): void
    {
        try {
            $body = json_decode((string) file_get_contents('php://input'), true);
            if (!is_array($body)) {
                $this->json(['ok' => false, 'error' => 'Неверный формат запроса']);
                return;
            }

            $userId   = trim((string) ($body['userId']   ?? ''));
            $password = (string) ($body['password'] ?? '');

            if ($userId === '' || $password === '') {
                $this->json(['ok' => false, 'error' => 'Заполните все поля']);
                return;
            }

            // ── Проверка rate limit ────────────────────────────────
            $this->checkRateLimit($userId);

            if ($userId === '__admin__') {
                $adminHash = $this->env('SED_ADMIN_PASS');
                $adminName = $this->env('SED_ADMIN_NAME', 'Администратор');
                if ($adminHash === '') {
                    $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
                    return;
                }
                if (password_verify($password, $adminHash)) {
                    $this->resetRateLimit($userId);
                    $this->gate2fa('__admin__', $adminName, true);
                } else {
                    $this->incrementRateLimit($userId);
                    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
                    error_log("[Auth] FAILED admin login from {$ip}");
                    $this->json(['ok' => false, 'error' => 'Неверный пароль']);
                }
                return;
            }

            $numId = (int) $userId;
            if ($numId <= 0) {
                $this->json(['ok' => false, 'error' => 'Неверный идентификатор']);
                return;
            }

            $safeId = (int) $numId;
            $res = (new RemoteRunner())->runQuery(
                "SELECT id, login, name, password FROM usr WHERE id = {$safeId} AND fired = 0 LIMIT 1",
                'preview', 1
            );

            if (!($res['ok'] ?? false) || empty($res['rows'])) {
                $this->json(['ok' => false, 'error' => 'Пользователь не найден']);
                return;
            }

            $user = $res['rows'][0];
            $hash = (string) ($user['password'] ?? '');

            if ($hash === '') {
                $this->json(['ok' => false, 'error' => 'У пользователя не задан пароль']);
                return;
            }

            if (password_verify($password, $hash)) {
                $name        = trim((string) ($user['name'] ?: $user['login'] ?: ''));
                $displayName = $name ?: "User #{$numId}";
                $this->resetRateLimit($userId);
                $this->gate2fa((string) $numId, $displayName, false);
            } else {
                $this->incrementRateLimit($userId);
                $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
                error_log("[Auth] FAILED login: user#{$numId} from {$ip}");
                $this->json(['ok' => false, 'error' => 'Неверный пароль']);
            }

        } catch (\Throwable $e) {
            error_log('[Auth::login] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    public function logout(): void
    {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000,
                $params['path'], $params['domain'],
                $params['secure'], $params['httponly']);
        }
        session_destroy();
        $this->json(['ok' => true]);
    }
}