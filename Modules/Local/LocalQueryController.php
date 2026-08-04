<?php
/** LocalQueryController — прямые запросы к локальной sed_log.*/
class LocalQueryController
{
    private const JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;

    private function json(array $data): void
    {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, self::JSON_FLAGS);
    }

    private function db(): ?PDO
    {
        static $pdo = null;
        if ($pdo) return $pdo;

        $host = Config::get('LOG_DB_HOST', 'localhost');
        $port = Config::get('LOG_DB_PORT', '5432');
        $name = Config::get('LOG_DB_NAME', '');
        $user = Config::get('LOG_DB_USER', '');
        $pass = Config::get('LOG_DB_PASS', '');

        if (!$name) return null;

        try {
            // Если host пустой — Unix socket (без TCP)
            $dsn = $host === ''
                ? "pgsql:dbname={$name}"
                : "pgsql:host={$host};port={$port};dbname={$name}";

            $pdo = new PDO($dsn, $user ?: null, $pass ?: null, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
            return $pdo;
        } catch (\Throwable $e) {
            error_log('[LocalQuery] ' . $e->getMessage());
            return null;
        }
    }

    private function isAdmin(): bool
    {
        global $sessionUser;
        return !empty($sessionUser['isAdmin']);
    }

    private function validateSql(string $sql): void
    {
        $q = preg_replace('/\/\*.*?\*\//s', ' ', $sql);
        $q = preg_replace('/--[^\n]*/', ' ', $q);
        $q = trim($q);

        if (preg_match('/\b(insert|update|delete|drop|alter|create|truncate|copy|grant|revoke)\b/i', $q)) {
            throw new \RuntimeException('Only SELECT allowed');
        }
        if (!preg_match('/^\s*(select|with)\b/i', $q)) {
            throw new \RuntimeException('Only SELECT allowed');
        }
    }

    public function query(): void
    {
        if (!$this->isAdmin()) {
            http_response_code(403);
            $this->json(['ok' => false, 'error' => 'Только для администратора']);
            return;
        }

        $body  = json_decode(file_get_contents('php://input'), true) ?? [];
        $sql   = trim($body['sql'] ?? '');
        $limit = min((int)($body['limit'] ?? 100), 5000);

        if (!$sql) {
            $this->json(['ok' => false, 'error' => 'sql required']);
            return;
        }

        try {
            $this->validateSql($sql);
            $pdo = $this->db();
            if (!$pdo) {
                $this->json(['ok' => false, 'error' => 'Лог-БД недоступна']);
                return;
            }
            $wrapped = "SELECT * FROM ({$sql}) __local__ LIMIT {$limit}";
            $stmt    = $pdo->query($wrapped);
            $rows    = $stmt->fetchAll();
            $cols    = $rows ? array_keys($rows[0]) : [];
            $this->json(['ok' => true, 'columns' => $cols, 'rows' => $rows, 'count' => count($rows)]);
        } catch (\Throwable $e) {
            $this->json(['ok' => false, 'error' => $e->getMessage()]);
        }
    }

    public function stats(): void
    {
        if (!$this->isAdmin()) {
            http_response_code(403);
            $this->json(['ok' => false, 'error' => 'Только для администратора']);
            return;
        }

        $pdo = $this->db();
        if (!$pdo) {
            $this->json(['ok' => false, 'error' => 'Лог-БД недоступна']);
            return;
        }

        try {
            $total  = (int)$pdo->query("SELECT COUNT(*) FROM sed_query_log")->fetchColumn();
            $today  = (int)$pdo->query("SELECT COUNT(*) FROM sed_query_log WHERE ts >= CURRENT_DATE")->fetchColumn();
            $errors = (int)$pdo->query("SELECT COUNT(*) FROM sed_query_log WHERE ts >= CURRENT_DATE AND is_error")->fetchColumn();
            $users  = (int)$pdo->query("SELECT COUNT(DISTINCT user_name) FROM sed_query_log WHERE ts >= CURRENT_DATE")->fetchColumn();
            $avgMs  = $pdo->query("SELECT ROUND(AVG(duration_ms)) FROM sed_query_log WHERE ts >= CURRENT_DATE AND duration_ms IS NOT NULL")->fetchColumn();

            $topTables = $pdo->query("
                SELECT COALESCE(template_name, table_name, 'custom') AS source,
                       COUNT(*) AS total_queries,
                       COUNT(DISTINCT user_name) AS unique_users
                FROM sed_query_log WHERE is_error = false
                GROUP BY 1 ORDER BY 2 DESC LIMIT 10
            ")->fetchAll();

            $topUsers = $pdo->query("
                SELECT user_name,
                       COUNT(*) AS total_queries,
                       COUNT(DISTINCT DATE(ts)) AS active_days,
                       MAX(ts)::text AS last_activity,
                       ROUND(AVG(duration_ms)) AS avg_duration_ms,
                       SUM(CASE WHEN is_error THEN 1 ELSE 0 END) AS error_count
                FROM sed_query_log
                GROUP BY user_name ORDER BY total_queries DESC LIMIT 10
            ")->fetchAll();

            $hourly = $pdo->query("
                SELECT EXTRACT(HOUR FROM ts)::int AS hour, COUNT(*) AS cnt
                FROM sed_query_log WHERE ts >= CURRENT_DATE
                GROUP BY 1 ORDER BY 1
            ")->fetchAll();

            $daily = $pdo->query("
                SELECT DATE(ts)::text AS day, COUNT(*) AS cnt
                FROM sed_query_log WHERE ts >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY 1 ORDER BY 1
            ")->fetchAll();

            $types = $pdo->query("
                SELECT query_type, COUNT(*) AS cnt
                FROM sed_query_log GROUP BY query_type
            ")->fetchAll();

            $slow = $pdo->query("
                SELECT user_name,
                       COALESCE(template_name, table_name, 'custom') AS source,
                       duration_ms,
                       to_char(ts, 'DD.MM HH24:MI') AS ts_short
                FROM sed_query_log
                WHERE duration_ms IS NOT NULL AND is_error = false
                ORDER BY duration_ms DESC LIMIT 10
            ")->fetchAll();

            $this->json([
                'ok'           => true,
                'total'        => $total,
                'today'        => $today,
                'errors_today' => $errors,
                'users_today'  => $users,
                'avg_ms'       => $avgMs ? (int)$avgMs : null,
                'top_tables'   => $topTables,
                'top_users'    => $topUsers,
                'hourly'       => $hourly,
                'daily'        => $daily,
                'types'        => $types,
                'slow'         => $slow,
            ]);
        } catch (\Throwable $e) {
            $this->json(['ok' => false, 'error' => $e->getMessage()]);
        }
    }
}