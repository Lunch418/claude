<?php
class RemoteRunner {
    private string $pythonBin;
    private string $scriptPath;
    private array  $env;
    private int    $phpTimeout = 630;
    private string $socketPath = '/tmp/sed_query.sock';
    private bool   $useDaemon  = true;

    public function __construct() {
        $home = Config::get('HOME', '');
        if ($home === '') {
            $home = getenv('HOME') ?: '/tmp';
        }

        $this->pythonBin  = 'python3';
        $this->scriptPath = dirname(__DIR__) . '/scripts/pam_runner.py';

        $this->env = [
            'PATH'            => $home . '/.local/bin:/usr/local/bin:/usr/bin:/bin',
            'HOME'            => $home,
            'PAM_HOST'        => Config::get('PAM_HOST'),
            'PAM_PORT'        => Config::get('PAM_PORT',        '22'),
            'PAM_USER'        => Config::get('PAM_USER'),
            'PAM_PASSWORD'    => Config::get('PAM_PASSWORD'),
            'TARGET_HOST'     => Config::get('TARGET_HOST'),
            'TARGET_USER'     => Config::get('TARGET_USER'),
            'TARGET_PASSWORD' => Config::get('TARGET_PASSWORD'),
            'DB_HOST'         => Config::get('DB_HOST'),
            'DB_PORT'         => Config::get('DB_PORT',         '5432'),
            'DB_NAME'         => Config::get('DB_NAME'),
            'DB_USER'         => Config::get('DB_USER'),
            'SED_DB_PASS'     => Config::get('SED_DB_PASS'),
            'PAM_TIMEOUT'     => '90',
        ];

        $sock = (string) Config::get('SED_DAEMON_SOCK', '/tmp/sed_query.sock');
        if ($sock !== '') {
            $this->socketPath = $sock;
        }

        $this->useDaemon = filter_var(
            Config::get('SED_USE_DAEMON', '1'),
            FILTER_VALIDATE_BOOL,
            FILTER_NULL_ON_FAILURE
        ) ?? true;
    }

    /**
     * Проверяет SQL на безопасность.
     * Удаляет комментарии (-- и /* *\/), затем проверяет:
     *   - только SELECT или WITH разрешены
     *   - запрещены DML/DDL операторы
     *   - запрещены точки с запятой (multi-statement)
     *
     * @throws \InvalidArgumentException если SQL не прошёл валидацию
     */
    /**
     * Единый строгий валидатор read-only SQL — ЕДИНСТВЕННЫЙ источник правды.
     * Используется RemoteRunner, RemoteController::submit и LocalQueryController,
     * чтобы правила не расходились между путями (V-04/V-05).
     *
     * Важно: блэклист по ключевым словам — не граница безопасности, а лишь
     * дополнительный рубеж. Настоящая граница — привилегии роли БД
     * (NOSUPERUSER, read-only, без доступа к pg_authid/pg_read_file).
     *
     * @param bool $allowSignal разрешить сигналы бэкендам —
     *        pg_cancel_backend (отмена запроса) и pg_terminate_backend
     *        (разрыв соединения). Только для привилегированных: админ или
     *        REMOTE_USERS/canRemote.
     * @throws \InvalidArgumentException если SQL не прошёл валидацию
     */
    public static function assertReadOnly(string $sql, bool $allowSignal = false): void
    {
        // Удаляем блочные /* ... */ и строчные -- ... комментарии
        $clean = preg_replace('/\/\*.*?\*\//s', ' ', $sql);
        $clean = preg_replace('/--[^\n]*/', ' ', $clean);
        $clean = trim($clean);

        // Точка с запятой = многострочный запрос — запрещено
        if (str_contains($clean, ';')) {
            throw new \InvalidArgumentException('Многострочные запросы запрещены (;)');
        }

        // Должен начинаться с SELECT или WITH
        if (!preg_match('/^\s*(select|with)\b/i', $clean)) {
            throw new \InvalidArgumentException('Разрешены только SELECT-запросы');
        }

        // pg_sleep + pg_sleep_for/pg_sleep_until — DoS длинным сном.
        // \bpg_sleep\b НЕ ловит pg_sleep_for (после sleep идёт «_»), поэтому
        // отдельное правило на всё семейство.
        if (preg_match('/\bpg_sleep(_for|_until)?\b/i', $clean)) {
            throw new \InvalidArgumentException('Запрос содержит запрещённые операторы');
        }

        // Сигналы бэкендам — pg_cancel_backend (отмена запроса) и
        // pg_terminate_backend (разрыв соединения). По умолчанию закрыты
        // (управление чужими бэкендами), но привилегированным ($allowSignal)
        // разрешены как админ-инструмент «убить зависший запрос по PID».
        // Все запросы идут под одной read-only ролью БД → адресуемы только
        // бэкенды этой же роли. Отмена собственных запросов приложения
        // по-прежнему идёт доверенным каналом RemoteRunner::cancelBackend().
        if (!$allowSignal && preg_match('/\bpg_(cancel|terminate)_backend\b/i', $clean)) {
            throw new \InvalidArgumentException('Запрос содержит запрещённые операторы');
        }

        // Блокируем опасные операторы даже внутри подзапросов
        $forbidden = ['insert', 'update', 'delete', 'drop', 'alter', 'create',
                      'truncate', 'copy', 'grant', 'revoke', 'execute', 'call',
                      'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
                      'lo_import', 'lo_export', 'dblink'];
        $pattern   = '/\b(' . implode('|', $forbidden) . ')\b/i';
        if (preg_match($pattern, $clean)) {
            throw new \InvalidArgumentException('Запрос содержит запрещённые операторы');
        }
    }

    private function validateSql(string $sql, bool $allowSignal = false): void
    {
        self::assertReadOnly($sql, $allowSignal);
    }

    /**
     * Нейтрализация CSV/formula injection (V-03): значение, начинающееся с
     * =,+,-,@,\t,\r, префиксуем апострофом — Excel/LibreOffice не вычислят
     * формулу, само значение сохраняется. Единый источник правды для
     * серверного CSV (используется RemoteController::export).
     */
    public static function csvSafeCell($v): string
    {
        $s = (string) ($v ?? '');
        if ($s !== '' && in_array($s[0], ['=', '+', '-', '@', "\t", "\r"], true)) {
            return "'" . $s;
        }
        return $s;
    }

    /**
     * @return array{ok: bool, columns?: array, rows?: array, count?: int, error?: string}
     */
    public function runQuery(string $sql, string $mode = 'preview', int $limit = 100, string $profile = 'sed', string $schema = '', bool $allowSignal = false): array {
        try {
            $this->validateSql($sql, $allowSignal);
        } catch (\InvalidArgumentException $e) {
            return ['ok' => false, 'error' => $e->getMessage()];
        }

        if ($this->useDaemon) {
            $daemonResult = $this->runViaDaemon($sql, $mode, $limit, $profile, $schema, $allowSignal);
            if ($daemonResult !== null) {
                return $daemonResult;
            }
            error_log('[RemoteRunner] Daemon unavailable, falling back to runViaProcess. '
                . 'Consider restarting pam_daemon.py.');
        }

        // CHED/CHED2/KSP ходят через PAM-ВМ — это умеет только демон.
        // Процессный fallback работает лишь с основной (СЭД) ВМ.
        if ($profile !== 'sed') {
            return ['ok' => false, 'error' => 'Источник недоступен: демон не запущен'];
        }

        return $this->runViaProcess($sql, $mode, $limit, $allowSignal);
    }

    private function runViaDaemon(string $sql, string $mode, int $limit, string $profile = 'sed', string $schema = '', bool $allowSignal = false): ?array {
        $errno  = 0;
        $errstr = '';
        $fp = @stream_socket_client(
            'unix://' . $this->socketPath,
            $errno,
            $errstr,
            3,
            STREAM_CLIENT_CONNECT
        );

        if (!$fp) {
            return null;
        }

        stream_set_timeout($fp, min($this->phpTimeout, 620));

        $payload = json_encode([
            'sql'        => $sql,
            'mode'       => $mode,
            'limit'      => $limit,
            'profile'    => $profile,
            'schema'     => $schema,
            'privileged' => $allowSignal,   // разрешить pg_cancel/terminate_backend
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if ($payload === false) {
            fclose($fp);
            return ['ok' => false, 'error' => 'JSON encode failed'];
        }

        $written = @fwrite($fp, $payload . "\n");
        if ($written === false) {
            fclose($fp);
            return null;
        }

        $response = '';
        while (!feof($fp)) {
            $chunk = fgets($fp, 65536);
            if ($chunk === false) {
                $meta = stream_get_meta_data($fp);
                fclose($fp);
                if (!empty($meta['timed_out'])) {
                    return ['ok' => false, 'error' => 'Daemon socket timeout'];
                }
                break;
            }
            $response .= $chunk;
            if (str_contains($response, "\n")) {
                break;
            }
        }
        fclose($fp);

        $response = trim($response);
        if ($response === '') {
            return ['ok' => false, 'error' => 'Empty response from daemon'];
        }

        $result = json_decode($response, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            return ['ok' => false, 'error' => 'Daemon JSON decode error'];
        }

        return is_array($result)
            ? $result
            : ['ok' => false, 'error' => 'Invalid daemon response'];
    }

    /**
     * Доверенная отмена бэкенда PostgreSQL по pid — только для самого
     * приложения (отмена собственных тяжёлых запросов). Идёт мимо
     * пользовательского SELECT-валидатора спец-командой демону
     * (`__cancel__:<pid>`), т.к. pg_cancel_backend для пользовательского
     * SQL запрещён. Работает через демон; при его отсутствии — no-op.
     */
    public function cancelBackend(int $pid, string $profile = 'sed'): bool
    {
        if ($pid <= 1) return false;

        $errno = 0; $errstr = '';
        $fp = @stream_socket_client(
            'unix://' . $this->socketPath, $errno, $errstr, 3, STREAM_CLIENT_CONNECT
        );
        if (!$fp) return false;

        stream_set_timeout($fp, 10);
        $payload = json_encode([
            'sql'     => '__cancel__:' . $pid,
            'mode'    => 'preview',
            'limit'   => 1,
            'profile' => $profile,
        ], JSON_UNESCAPED_UNICODE);

        @fwrite($fp, $payload . "\n");

        $resp = '';
        while (!feof($fp)) {
            $chunk = fgets($fp, 8192);
            if ($chunk === false) break;
            $resp .= $chunk;
            if (str_contains($resp, "\n")) break;
        }
        fclose($fp);

        $d = json_decode(trim($resp), true);
        return is_array($d) && !empty($d['ok']);
    }

    private function runViaProcess(string $sql, string $mode, int $limit, bool $allowSignal = false): array {
        $prevTimeLimit = (int) ini_get('max_execution_time');
        set_time_limit($this->phpTimeout + 30);
        ignore_user_abort(true);

        $env = $this->env;
        $env['_SED_INLINE_SQL']  = $sql;
        $env['_SED_ALLOW_SIGNAL'] = $allowSignal ? '1' : '0';

        $cmd = [
            $this->pythonBin,
            $this->scriptPath,
            '--mode',  $mode,
            '--limit', (string)$limit,
            '--sql-from-env',
        ];

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        $process = proc_open($cmd, $descriptors, $pipes, null, $env);
        if (!is_resource($process)) {
            set_time_limit($prevTimeLimit);
            return ['ok' => false, 'error' => 'Cannot start pam_runner.py'];
        }

        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout = '';
        $stderr = '';
        $start  = microtime(true);

        while (true) {
            $read    = [$pipes[1], $pipes[2]];
            $w = $e  = null;
            $changed = stream_select($read, $w, $e, 1);

            if ($changed) {
                foreach ($read as $fp) {
                    $chunk = fread($fp, 65536);
                    if ($chunk === false || $chunk === '') continue;
                    if ($fp === $pipes[1]) $stdout .= $chunk;
                    else                   $stderr .= $chunk;
                }
            }

            if (feof($pipes[1])) break;

            if (microtime(true) - $start > $this->phpTimeout) {
                proc_terminate($process, 9);
                set_time_limit($prevTimeLimit);
                return ['ok' => false, 'error' => "Timeout ({$this->phpTimeout}s)"];
            }
        }

        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);

        // Восстанавливаем исходный лимит времени после завершения
        set_time_limit($prevTimeLimit);

        $stdout = trim($stdout);
        if ($stdout === '') {
            $stderrTrim = trim($stderr);
            error_log('[RemoteRunner] Empty stdout. stderr: ' . substr($stderrTrim, 0, 500));
            return ['ok' => false, 'error' => 'Пустой ответ от скрипта'];
        }

        $result = json_decode($stdout, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            return ['ok' => false, 'error' => 'JSON decode error'];
        }

        return $result;
    }

    public function run(string $sql, string $mode = 'preview', int $limit = 100): array {
        return $this->runQuery($sql, $mode, $limit);
    }
}