<?php
/**
 * QueryLogController — лог запросов в локальную PostgreSQL.
 */
class QueryLogController
{
    private const JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;

    /**
     * Возвращает реальный IP клиента, учитывая прокси (Nginx → PHP-FPM/Apache).
     * REMOTE_ADDR при проксировании показывает адрес самого прокси (127.0.0.1),
     * поэтому при доверенном прокси читаем X-Real-IP / X-Forwarded-For.
     */
    private static function getClientIp(): string
    {
        $remote = $_SERVER['REMOTE_ADDR'] ?? '';

        // Доверяем заголовкам от прокси только если запрос пришёл с самого сервера
        // (т.е. соединение реально проксировано локальным Nginx).
        $trustedProxies = ['127.0.0.1', '::1'];

        if (in_array($remote, $trustedProxies, true)) {
            if (!empty($_SERVER['HTTP_X_REAL_IP'])) {
                $ip = trim((string) $_SERVER['HTTP_X_REAL_IP']);
                if (filter_var($ip, FILTER_VALIDATE_IP)) {
                    return $ip;
                }
            }
            if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
                // Берём первый адрес в цепочке (исходный клиент)
                $parts = explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR']);
                $ip = trim($parts[0]);
                if (filter_var($ip, FILTER_VALIDATE_IP)) {
                    return $ip;
                }
            }
        }

        return $remote;
    }

    private function json(array $data): void
    {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, self::JSON_FLAGS);
    }

    private function isAdmin(): bool
    {
        global $sessionUser;
        return !empty($sessionUser['isAdmin']);
    }

    private function db(): ?PDO
    {
        static $pdo = null;
        if ($pdo !== null) return $pdo;

        $host = Config::get('LOG_DB_HOST', 'localhost');
        $port = Config::get('LOG_DB_PORT', '5432');
        $name = Config::get('LOG_DB_NAME', '');
        $user = Config::get('LOG_DB_USER', '');
        $pass = Config::get('LOG_DB_PASS', '');

        if ($name === '') return null;

        try {
            if ($host === '') {
                $dsn = "pgsql:dbname={$name}";
            } else {
                $dsn = "pgsql:host={$host};port={$port};dbname={$name}";
            }
            $pdo = new PDO($dsn, $user ?: null, $pass ?: null, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);

            $pdo->exec("
                CREATE TABLE IF NOT EXISTS sed_query_log (
                    id            BIGSERIAL    PRIMARY KEY,
                    ts            TIMESTAMPTZ  NOT NULL DEFAULT now(),
                    user_name     TEXT         NOT NULL DEFAULT '',
                    user_ip       TEXT         NOT NULL DEFAULT '',
                    sql_text      TEXT         NOT NULL,
                    table_name    TEXT         NOT NULL DEFAULT '',
                    query_type    TEXT         NOT NULL DEFAULT 'table',
                    template_name TEXT,
                    row_count     INTEGER,
                    duration_ms   INTEGER,
                    is_error      BOOLEAN      NOT NULL DEFAULT false,
                    error_text    TEXT
                )
            ");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_sql_log_ts   ON sed_query_log(ts DESC)");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_sql_log_user ON sed_query_log(user_name, ts DESC)");

            return $pdo;
        } catch (\Throwable $e) {
            error_log('[QueryLog] DB connect error: ' . $e->getMessage());
            return null;
        }
    }

    // ── Записать запрос ──────────────────────────────────────────
    public function add(): void
    {
        try {
            $body = json_decode((string) file_get_contents('php://input'), true) ?? [];

            $sql          = trim((string) ($body['sql']          ?? ''));
            // Имя автора берём из серверной сессии, а не из тела запроса —
            // иначе любой может залогировать SQL от чужого имени (CWE-117).
            global $sessionUser;
            $user         = trim((string) ($sessionUser['name'] ?? '—')) ?: '—';
            $tableName    = trim((string) ($body['table']        ?? ''));
            $queryType    = trim((string) ($body['queryType']    ?? 'table'));
            $templateName = trim((string) ($body['templateName'] ?? '')) ?: null;
            $rowCount     = isset($body['rowCount'])   ? (int) $body['rowCount']   : null;
            $durationMs   = isset($body['durationMs']) ? (int) $body['durationMs'] : null;
            $isError      = (bool) ($body['isError']   ?? false);
            $errorText    = trim((string) ($body['errorText'] ?? '')) ?: null;
            $ip           = self::getClientIp();

            if ($sql === '') {
                $this->json(['ok' => false, 'error' => 'sql is required']);
                return;
            }

            // Белый список типов запросов
            if (!in_array($queryType, ['table', 'template', 'custom'], true)) {
                $queryType = 'custom';
            }

            $pdo = $this->db();
            if (!$pdo) {
                $this->json(['ok' => true]); // тихо игнорируем если лог-БД недоступна
                return;
            }

            $stmt = $pdo->prepare("
                INSERT INTO sed_query_log
                    (user_name, user_ip, sql_text, table_name, query_type,
                     template_name, row_count, duration_ms, is_error, error_text)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ");
            $stmt->execute([
                $user, $ip, $sql, $tableName, $queryType,
                $templateName, $rowCount, $durationMs,
                $isError ? 'true' : 'false', $errorText,
            ]);

            $this->json(['ok' => true]);

        } catch (\Throwable $e) {
            error_log('[QueryLog::add] ' . $e->getMessage());
            $this->json(['ok' => true]); // не ломаем интерфейс из-за лога
        }
    }

    // ── Список запросов (только для админа) ──────────────────────
    public function list(): void
    {
        if (!$this->isAdmin()) {
            http_response_code(403);
            $this->json(['ok' => false, 'error' => 'Только для администратора']);
            return;
        }

        try {
            $limit  = min((int) ($_GET['limit'] ?? 200), 1000);
            $search = trim($_GET['q']    ?? '');
            $type   = trim($_GET['type'] ?? '');
            $user   = trim($_GET['user'] ?? '');
            $from   = trim($_GET['from'] ?? '');
            $to     = trim($_GET['to']   ?? '');

            $pdo = $this->db();
            if (!$pdo) {
                $this->json(['ok' => false, 'error' => 'Лог-БД недоступна — проверьте LOG_DB_NAME в .env']);
                return;
            }

            $where  = ['1=1'];
            $params = [];

            if ($search !== '') {
                $where[]  = '(sql_text ILIKE ? OR user_name ILIKE ?)';
                $params[] = '%' . $search . '%';
                $params[] = '%' . $search . '%';
            }

            // Белый список типов — защита от произвольного ввода
            if ($type !== '' && in_array($type, ['table', 'template', 'custom'], true)) {
                $where[]  = 'query_type = ?';
                $params[] = $type;
            }

            if ($user !== '') {
                $where[]  = 'user_name ILIKE ?';
                $params[] = '%' . $user . '%';
            }

            // Фильтр по диапазону дат
            if ($from !== '' && preg_match('/^\d{4}-\d{2}-\d{2}/', $from)) {
                $where[]  = 'ts >= ?';
                $params[] = $from;
            }
            if ($to !== '' && preg_match('/^\d{4}-\d{2}-\d{2}/', $to)) {
                $where[]  = 'ts <= ?';
                $params[] = $to . ' 23:59:59';
            }

            $whereStr = implode(' AND ', $where);
            $params[] = $limit;

            $stmt = $pdo->prepare("
                SELECT
                    id,
                    to_char(ts, 'DD.MM.YYYY HH24:MI:SS') AS ts_formatted,
                    user_name,
                    user_ip,
                    query_type,
                    COALESCE(template_name, NULLIF(table_name,''), 'custom') AS source,
                    LEFT(sql_text, 400)  AS sql_text,
                    row_count,
                    duration_ms,
                    is_error,
                    error_text
                FROM sed_query_log
                WHERE {$whereStr}
                ORDER BY ts DESC
                LIMIT ?
            ");
            $stmt->execute($params);
            $rows = $stmt->fetchAll();

            $cStmt = $pdo->prepare("SELECT COUNT(*) FROM sed_query_log WHERE {$whereStr}");
            $cStmt->execute(array_slice($params, 0, -1));
            $total = (int) $cStmt->fetchColumn();

            $this->json(['ok' => true, 'rows' => $rows, 'total' => $total]);

        } catch (\Throwable $e) {
            error_log('[QueryLog::list] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сервера']);
        }
    }

    // ── Статистика (только для админа) ───────────────────────────
    // Метод вызывается роутером (?m=QueryLog&a=stats).
    // Делегируем LocalQueryController::stats() — там вся логика уже есть.
    public function stats(): void
    {
        if (!$this->isAdmin()) {
            http_response_code(403);
            $this->json(['ok' => false, 'error' => 'Только для администратора']);
            return;
        }

        // Если LocalQueryController доступен — используем его stats().
        if (class_exists('LocalQueryController')) {
            (new LocalQueryController())->stats();
            return;
        }

        // Запасной вариант: возвращаем базовую статистику из QueryLog
        $pdo = $this->db();
        if (!$pdo) {
            $this->json(['ok' => false, 'error' => 'Лог-БД недоступна']);
            return;
        }

        try {
            $total  = (int) $pdo->query("SELECT COUNT(*) FROM sed_query_log")->fetchColumn();
            $today  = (int) $pdo->query("SELECT COUNT(*) FROM sed_query_log WHERE ts >= CURRENT_DATE")->fetchColumn();
            $errors = (int) $pdo->query("SELECT COUNT(*) FROM sed_query_log WHERE ts >= CURRENT_DATE AND is_error")->fetchColumn();
            $users  = (int) $pdo->query("SELECT COUNT(DISTINCT user_name) FROM sed_query_log WHERE ts >= CURRENT_DATE")->fetchColumn();

            $this->json([
                'ok'           => true,
                'total'        => $total,
                'today'        => $today,
                'errors_today' => $errors,
                'users_today'  => $users,
            ]);
        } catch (\Throwable $e) {
            $this->json(['ok' => false, 'error' => $e->getMessage()]);
        }
    }
}