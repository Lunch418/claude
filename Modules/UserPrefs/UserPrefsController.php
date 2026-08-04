<?php
class UserPrefsController
{
    private const ALLOWED = ['tmpl_favs', 'tbl_favs', 'query_history', 'saved_queries'];

    private function db(): ?PDO
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
            // Если хост пустой — подключаемся через Unix-сокет (как QueryLog)
            $dsn = ($host !== '')
                ? "pgsql:host={$host};port={$port};dbname={$name}"
                : "pgsql:dbname={$name}";

            $pdo = new PDO($dsn, $user ?: null, $pass ?: null, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);

            return $pdo;
        } catch (\Throwable $e) {
            error_log('[UserPrefs] DB connect error: ' . $e->getMessage());
            return null;
        }
    }

    private function user(): string
    {
        global $sessionUser;
        return trim((string)($sessionUser['name'] ?? ''));
    }

    private function json(array $data): void
    {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_UNICODE);
    }

    public function get(): void
    {
        $user = $this->user();
        if ($user === '') { $this->json(['ok' => true, 'data' => []]); return; }

        $pdo = $this->db();
        if (!$pdo) { $this->json(['ok' => true, 'data' => []]); return; }

        try {
            $stmt = $pdo->prepare(
                'SELECT pref_key, pref_value FROM sed_user_prefs WHERE user_name = ?'
            );
            $stmt->execute([$user]);

            $data = [];
            foreach ($stmt->fetchAll() as $row) {
                $v = json_decode($row['pref_value'], true);
                if ($v !== null) $data[$row['pref_key']] = $v;
            }

            $this->json(['ok' => true, 'data' => $data]);
        } catch (\Throwable $e) {
            error_log('[UserPrefs::get] ' . $e->getMessage());
            $this->json(['ok' => true, 'data' => []]);
        }
    }

    public function save(): void
    {
        $user = $this->user();
        if ($user === '') { $this->json(['ok' => false, 'error' => 'no session']); return; }

        $body = json_decode((string) file_get_contents('php://input'), true) ?? [];
        $key  = trim((string) ($body['key']   ?? ''));
        $val  = $body['value'] ?? null;

        if ($key === '' || $val === null) {
            $this->json(['ok' => false, 'error' => 'key and value required']); return;
        }

        if (!in_array($key, self::ALLOWED, true)) {
            $this->json(['ok' => false, 'error' => 'unknown key']); return;
        }

        $pdo = $this->db();
        if (!$pdo) { $this->json(['ok' => true]); return; } // тихо игнорируем

        try {
            $pdo->prepare("
                INSERT INTO sed_user_prefs (user_name, pref_key, pref_value, updated_at)
                VALUES (?, ?, ?, now())
                ON CONFLICT (user_name, pref_key)
                DO UPDATE SET pref_value = EXCLUDED.pref_value,
                              updated_at = now()
            ")->execute([$user, $key, json_encode($val, JSON_UNESCAPED_UNICODE)]);

            $this->json(['ok' => true]);
        } catch (\Throwable $e) {
            error_log('[UserPrefs::save] ' . $e->getMessage());
            $this->json(['ok' => false, 'error' => 'Ошибка сохранения']);
        }
    }
}
