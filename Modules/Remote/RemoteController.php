<?php
class RemoteController {
    private RemoteRunner $runner;

    public function __construct() {
        $this->runner = new RemoteRunner();
    }

    // ── Обычные быстрые запросы ───────────────────────────────────

    public function preview(): void {
        header('Content-Type: application/json; charset=utf-8');

        $body  = json_decode(file_get_contents('php://input'), true) ?? [];
        $sql   = trim($body['sql'] ?? '');
        if ($sql === '') {
            echo json_encode(['ok'=>false,'error'=>'sql is required']);
            return;
        }
        $limit = isset($body['limit']) ? (int)$body['limit'] : 100;
        if ($limit < 0) $limit = 100;
        elseif ($limit > 0) $limit = min($limit, 50000);

        $p = $this->resolveProfile($body);
        if (!empty($p['__denied__'])) {
            http_response_code(403);
            echo json_encode(['ok'=>false,'error'=>'Нет доступа к этому источнику']);
            return;
        }

        $result = $this->runner->runQuery($sql, 'preview', $limit, $p['profile'], $p['schema']);
        echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    /** Извлекает и проверяет профиль источника и схему. CHED/KSP — только админам. */
    private function resolveProfile(array $body): array {
        $req = $body['profile'] ?? 'sed';
        $profile = in_array($req, ['ched', 'ched2', 'ksp'], true) ? $req : 'sed';
        $schema  = trim((string)($body['schema'] ?? ''));
        if ($schema !== '' && !preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $schema)) {
            $schema = '';
        }
        if ($profile !== 'sed') {
            $u = $_SESSION['sed_user'] ?? null;
            // К CHED/CHED2/KSP пускаем админа и пользователей с флагом canRemote
            // (выставляется на сервере при входе по ФИО из .env).
            if (empty($u['isAdmin']) && empty($u['canRemote'])) {
                return ['__denied__' => true];
            }
        }
        return ['profile' => $profile, 'schema' => $schema];
    }

    public function export(): void {
        header('Content-Type: application/json; charset=utf-8');

        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        $sql  = trim($body['sql'] ?? '');
        if ($sql === '') {
            echo json_encode(['ok'=>false,'error'=>'sql is required']);
            return;
        }

        set_time_limit(660);
        ignore_user_abort(true);

        $maxRows = 100_000;
        $p = $this->resolveProfile($body);
        if (!empty($p['__denied__'])) {
            http_response_code(403);
            echo json_encode(['ok'=>false,'error'=>'Нет доступа к этому источнику']);
            return;
        }
        $result  = $this->runner->runQuery($sql, 'export', $maxRows, $p['profile'], $p['schema']);

        if (!($result['ok'] ?? false)) {
            echo json_encode($result, JSON_UNESCAPED_UNICODE);
            return;
        }

        $id      = uniqid('exp_', true);
        $csvPath = dirname(__DIR__, 2) . '/storage/exports/' . $id . '.csv';
        @mkdir(dirname($csvPath), 0755, true);

        $columns = $result['columns'] ?? [];
        $rows    = $result['rows']    ?? [];

        // Дедупликация имён колонок
        $seen      = [];
        $dedupCols = [];
        foreach ($columns as $col) {
            if (!isset($seen[$col])) {
                $seen[$col] = 1;
                $dedupCols[] = $col;
            } else {
                $seen[$col]++;
                $dedupCols[] = $col . '_' . $seen[$col];
            }
        }

        // CSV/formula injection (V-03): значения из БД могут начинаться с
        // =, +, -, @ (или управляющих \t/\r/=) — тогда Excel/LibreOffice
        // трактуют ячейку как формулу/DDE. Префиксуем апострофом —
        // формула нейтрализуется, само значение сохраняется.
        $csvSafe = static function ($v): string {
            $s = (string) ($v ?? '');
            if ($s !== '' && in_array($s[0], ['=', '+', '-', '@', "\t", "\r"], true)) {
                return "'" . $s;
            }
            return $s;
        };

        $fh = fopen($csvPath, 'w');
        // UTF-8 BOM для Excel
        fwrite($fh, "\xEF\xBB\xBF");
        fputcsv($fh, array_map($csvSafe, $dedupCols), ';');
        foreach ($rows as $row) {
            fputcsv($fh, array_map($csvSafe, array_values($row)), ';');
        }
        fclose($fh);


        $this->cleanExportFiles();

        $count    = $result['count'] ?? count($rows);
        $truncated = ($count >= $maxRows);

        echo json_encode([
            'ok'        => true,
            'id'        => $id,
            'count'     => $count,
            'truncated' => $truncated,   
            'download'  => '/index.php?m=Export&a=download&id=' . urlencode($id),
        ], JSON_UNESCAPED_UNICODE);
    }

    private function cleanExportFiles(): void
    {
        $lockFile = sys_get_temp_dir() . '/sed_export_clean.lock';
        if (file_exists($lockFile) && (time() - filemtime($lockFile)) < 300) {
            return; 
        }
        touch($lockFile);

        $exportDir = dirname(__DIR__, 2) . '/storage/exports/';
        if (!is_dir($exportDir)) return;

        $ttl = 7200; 
        foreach (glob($exportDir . 'exp_*.csv') as $file) {
            if (file_exists($file) && (time() - filemtime($file)) > $ttl) {
                @unlink($file);
            }
        }
    }

    public function count(): void {
        header('Content-Type: application/json; charset=utf-8');
        $body  = json_decode(file_get_contents('php://input'), true) ?? [];
        $table = preg_replace('/[^a-z0-9_]/i', '', $body['table'] ?? '');
        if (!$table) { echo json_encode(['ok'=>false,'error'=>'no table']); return; }
        $result = $this->runner->runQuery("SELECT COUNT(*) as cnt FROM {$table}", 'preview', 1);
        echo json_encode($result, JSON_UNESCAPED_UNICODE);
    }

    private const JOB_DIR      = '/tmp/sed_jobs';
    private const JOB_TIMEOUT  = 1800;
    private const POLL_TIMEOUT = 1500;

    private const MAX_JOBS_PER_USER = 3;

    // ── Валидация SQL — единый источник правды (RemoteRunner) ──
    private function validateSqlOrFail(string $sql): ?string {
        try {
            RemoteRunner::assertReadOnly($sql);
            return null;
        } catch (\InvalidArgumentException $e) {
            return $e->getMessage();
        }
    }

    private function cleanJob(string $jobId): void {
        $dir = self::JOB_DIR;
        foreach (['.meta','.pid','.pgpid','.sql','.env','.sh','.result','.stderr'] as $ext) {
            @unlink("{$dir}/{$jobId}{$ext}");
        }
    }

    private function cleanStaleJobs(): void {
        $dir = self::JOB_DIR;
        if (!is_dir($dir)) return;

        $lockFile = $dir . '/.last_clean';
        if (file_exists($lockFile) && (time() - filemtime($lockFile)) < 60) {
            return;
        }
        touch($lockFile);

        $now = time();
        foreach (glob("{$dir}/*.meta") as $metaFile) {
            $meta = json_decode(@file_get_contents($metaFile) ?: '{}', true);
            if (!$meta) { @unlink($metaFile); continue; }

            $created   = (int)($meta['created']   ?? 0);
            $lastPoll  = (int)($meta['last_poll']  ?? $created);
            $jobId     = $meta['jobId'] ?? basename($metaFile, '.meta');

            $hardExpired = ($now - $created)  > self::JOB_TIMEOUT;
            $abandoned   = ($now - $lastPoll) > self::POLL_TIMEOUT;

            if ($hardExpired || $abandoned) {
                $pidFile = "{$dir}/{$jobId}.pid";
                if (file_exists($pidFile)) {
                    $pid = (int)trim(@file_get_contents($pidFile));
                    if ($pid > 1) {
                        @posix_kill($pid, SIGTERM);
                        usleep(200000);
                        @posix_kill($pid, SIGKILL);
                    }
                }
                $this->cleanJob($jobId);
            }
        }
    }

    // ── Подсчёт активных джобов пользователя ─────────────────
    private function countActiveJobsForUser(string $userName): int
    {
        $dir = self::JOB_DIR;
        if (!is_dir($dir)) return 0;

        $count = 0;
        $now   = time();

        foreach (glob("{$dir}/*.meta") as $metaFile) {
            $meta = json_decode(@file_get_contents($metaFile) ?: '{}', true);
            if (!$meta) continue;

            // Считаем только свежие джобы (не истёкшие по POLL_TIMEOUT)
            $lastPoll = (int)($meta['last_poll'] ?? $meta['created'] ?? 0);
            if (($now - $lastPoll) > self::POLL_TIMEOUT) continue;

            if (($meta['user'] ?? '') === $userName) {
                $count++;
            }
        }

        return $count;
    }

    // ── submit() ─────────────────────────────────────────────
    public function submit(): void {
        header('Content-Type: application/json; charset=utf-8');

        $body   = json_decode(file_get_contents('php://input'), true) ?? [];
        $sql    = trim($body['sql']    ?? '');
        $limit  = isset($body['limit'])  ? min((int)$body['limit'],  100000) : 200;
        $offset = isset($body['offset']) ? max((int)$body['offset'], 0)      : 0;

        if ($sql === '') {
            echo json_encode(['ok'=>false,'error'=>'sql is required']); return;
        }
        $err = $this->validateSqlOrFail($sql);
        if ($err !== null) {
            echo json_encode(['ok'=>false,'error'=>$err]); return;
        }

        // Создаём директорию и чистим старьё (throttled)
        if (!is_dir(self::JOB_DIR)) mkdir(self::JOB_DIR, 0700, true);
        $this->cleanStaleJobs();

        global $sessionUser;
        $currentUser = (string)($sessionUser['name'] ?? 'unknown');
        $activeJobs  = $this->countActiveJobsForUser($currentUser);

        if ($activeJobs >= self::MAX_JOBS_PER_USER) {
            http_response_code(429);
            echo json_encode([
                'ok'    => false,
                'error' => "У вас уже запущено {$activeJobs} запрос(ов). Дождитесь завершения или отмените один из них.",
            ], JSON_UNESCAPED_UNICODE);
            return;
        }

        $jobId      = bin2hex(random_bytes(16));
        $dir        = self::JOB_DIR;
        $metaFile   = "{$dir}/{$jobId}.meta";
        $resultFile = "{$dir}/{$jobId}.result";
        $pidFile    = "{$dir}/{$jobId}.pid";
        $envFile    = "{$dir}/{$jobId}.env";
        $sqlFile    = "{$dir}/{$jobId}.sql";
        $wrapFile   = "{$dir}/{$jobId}.sh";

        // Мета — добавлено поле user для подсчёта джобов
        file_put_contents($metaFile, json_encode([
            'jobId'     => $jobId,
            'created'   => time(),
            'last_poll' => time(),
            'limit'     => $limit,
            'offset'    => $offset,
            'user'      => $currentUser,     
            'sql'       => substr($sql, 0, 300),
        ]), LOCK_EX);

        $home       = Config::get('HOME', getenv('HOME') ?: '/tmp');
        $scriptPath = dirname(__DIR__, 2) . '/scripts/pam_runner.py';
        $envLines   = [
            "HOME={$home}",
            "PATH={$home}/.local/bin:/usr/local/bin:/usr/bin:/bin",
            'PAM_HOST='        . Config::get('PAM_HOST'),
            'PAM_PORT='        . Config::get('PAM_PORT', '22'),
            'PAM_USER='        . Config::get('PAM_USER'),
            'PAM_PASSWORD='    . Config::get('PAM_PASSWORD'),
            'TARGET_HOST='     . Config::get('TARGET_HOST'),
            'TARGET_USER='     . Config::get('TARGET_USER'),
            'TARGET_PASSWORD=' . Config::get('TARGET_PASSWORD'),
            'DB_HOST='         . Config::get('DB_HOST'),
            'DB_PORT='         . Config::get('DB_PORT', '5432'),
            'DB_NAME='         . Config::get('DB_NAME'),
            'DB_USER='         . Config::get('DB_USER'),
            'SED_DB_PASS='     . Config::get('SED_DB_PASS'),
            'PAM_TIMEOUT=1800',
        ];
        file_put_contents($envFile, implode("\n", $envLines) . "\n", LOCK_EX);
        chmod($envFile, 0600);

        // SQL в отдельный файл
        file_put_contents($sqlFile, $sql, LOCK_EX);
        chmod($sqlFile, 0600);

        $sq = escapeshellarg($scriptPath);
        $sr = escapeshellarg($resultFile);
        $sp = escapeshellarg($pidFile);
        $se = escapeshellarg($envFile);
        $ss = escapeshellarg($sqlFile);
        $sw = escapeshellarg($wrapFile);

        $stderrFile = "{$dir}/{$jobId}.stderr";
        $se2 = escapeshellarg($stderrFile);
        $sr2 = escapeshellarg($resultFile);

        $wrapper = "#!/bin/sh\n"
            . "echo \$\$ > {$sp}\n"
            . "set -a\n"
            . ". {$se}\n"
            . "set +a\n"
            . "export _SED_INLINE_SQL=\"\$(cat {$ss})\"\n"
            . "export _SED_RESULT_FILE={$sr2}\n"
            . "rm -f {$se} {$ss} {$sw}\n"
            . "exec python3 {$sq} --mode preview --limit {$limit} --offset {$offset} --sql-from-env 1>/dev/null 2>{$se2}\n";

        file_put_contents($wrapFile, $wrapper, LOCK_EX);
        chmod($wrapFile, 0700);

        exec('nohup ' . escapeshellarg($wrapFile) . ' > /dev/null 2>&1 &');

        echo json_encode(['ok'=>true, 'jobId'=>$jobId], JSON_UNESCAPED_UNICODE);
    }

    // ── poll() ────────────────────────────────────────────────
    public function poll(): void {
        header('Content-Type: application/json; charset=utf-8');

        $jobId = preg_replace('/[^a-f0-9]/', '', $_GET['jobId'] ?? '');
        if (strlen($jobId) !== 32) {
            echo json_encode(['ok'=>false,'error'=>'Invalid jobId']); return;
        }

        $dir        = self::JOB_DIR;
        $metaFile   = "{$dir}/{$jobId}.meta";
        $resultFile = "{$dir}/{$jobId}.result";

        if (!file_exists($metaFile)) {
            echo json_encode(['ok'=>false,'status'=>'error',
                'error'=>'Job not found or already cleaned up']); return;
        }

        $meta    = json_decode(file_get_contents($metaFile), true) ?? [];
        $elapsed = time() - (int)($meta['created'] ?? time());

        if ($elapsed > self::JOB_TIMEOUT) {
            $this->cleanJob($jobId);
            echo json_encode(['ok'=>false,'status'=>'error',
                'error'=>"Превышено время ожидания ({$elapsed}s)"]); return;
        }

        $meta['last_poll'] = time();
        file_put_contents($metaFile, json_encode($meta), LOCK_EX);

        if (!file_exists($resultFile)) {
            echo json_encode(['ok'=>true,'status'=>'running','elapsed'=>$elapsed]); return;
        }

        $raw  = file_get_contents($resultFile);
        $data = json_decode($raw, true);
        if ($data === null || !array_key_exists('ok', $data)) {
            $stderrFile = "{$dir}/{$jobId}.stderr";
            $stderrText = file_exists($stderrFile)
                ? trim(@file_get_contents($stderrFile))
                : '';
            $this->cleanJob($jobId);
            echo json_encode([
                'ok'     => false,
                'status' => 'error',
                'error'  => $stderrText ?: 'Внутренняя ошибка: невалидный результат',
            ], JSON_UNESCAPED_UNICODE);
            return;
        }

        $this->cleanJob($jobId);
        $data['status']  = 'done';
        $data['elapsed'] = $elapsed;
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    // ── cancel() ──────────────────────────────────────────────
    public function cancel(): void {
        header('Content-Type: application/json; charset=utf-8');

        $jobId = preg_replace('/[^a-f0-9]/', '', $_GET['jobId'] ?? '');
        if (strlen($jobId) !== 32) {
            echo json_encode(['ok'=>false,'error'=>'Invalid jobId']); return;
        }

        $dir     = self::JOB_DIR;
        $pidFile  = "{$dir}/{$jobId}.pid";
        $pgPidFile = "{$dir}/{$jobId}.pgpid";

        // 1. Убиваем локальный python3/sh процесс (всю группу процессов)
        if (file_exists($pidFile)) {
            $pid = (int)trim(@file_get_contents($pidFile));
            if ($pid > 1) {
                // Сначала пробуем убить всю группу (pgid = pid у nohup)
                @posix_kill(-$pid, SIGTERM);
                @posix_kill($pid,  SIGTERM);
                usleep(200000); // 200ms
                if (@posix_kill($pid, 0)) {
                    @posix_kill(-$pid, SIGKILL);
                    @posix_kill($pid,  SIGKILL);
                }
            }
        }

        // 2. Отправляем pg_cancel_backend на удалённый PostgreSQL через SSH
        if (file_exists($pgPidFile)) {
            $pgPid = (int)trim(@file_get_contents($pgPidFile));
            if ($pgPid > 1) {
                $this->cancelRemoteQuery($pgPid);
            }
        }

        $this->cleanJob($jobId);
        echo json_encode(['ok'=>true,'cancelled'=>true]);
    }

    // ── Отмена запроса на стороне PostgreSQL ──────────────────
    private function cancelRemoteQuery(int $pgPid): void {
        try {
            // Доверенный канал: pg_cancel_backend закрыт для пользовательского
            // SQL (V-04), поэтому отменяем собственный бэкенд спец-командой
            // демону мимо валидатора.
            (new \RemoteRunner())->cancelBackend($pgPid);
        } catch (\Throwable $e) {
            error_log('[cancel] pg_cancel_backend failed: ' . $e->getMessage());
        }
    }
}