<?php
class SystemController
{
    public function daemonLog(): void
    {
        header('Content-Type: application/json; charset=utf-8');

        global $sessionUser;
        if (empty($sessionUser['isAdmin'])) {
            http_response_code(403);
            echo json_encode(['ok' => false, 'error' => 'Только для администратора'], JSON_UNESCAPED_UNICODE);
            return;
        }

        $path = '/tmp/sed_daemon.log';
        if (!file_exists($path) || !is_readable($path)) {
            echo json_encode(['ok' => false, 'error' => "Файл {$path} не найден"], JSON_UNESCAPED_UNICODE);
            return;
        }

        $lines = array_slice(file($path, FILE_IGNORE_NEW_LINES) ?: [], -500);
        $rows  = array_values(array_map(
            fn($l) => ['line' => rtrim($l)],
            array_filter($lines, fn($l) => trim($l) !== '')
        ));

        echo json_encode(['ok' => true, 'rows' => $rows], JSON_UNESCAPED_UNICODE);
    }

    public function clearCache(): void
    {
        header('Content-Type: application/json; charset=utf-8');

        $cleared = 0;
        $method  = 'direct';

        // Способ 1: через сокет демона
        $sock = Config::get('SED_DAEMON_SOCK', '/tmp/sed_query.sock');
        if (file_exists($sock)) {
            $s = @socket_create(AF_UNIX, SOCK_STREAM, 0);
            if ($s && @socket_connect($s, $sock)) {
                @socket_write($s, json_encode(['sql' => '__clear_cache__']) . "\n");
                $resp = @socket_read($s, 1024);
                @socket_close($s);
                $d = json_decode((string)$resp, true);
                if (!empty($d['ok'])) {
                    $cleared = (int)($d['cleared'] ?? 0);
                    $method  = 'daemon';
                }
            }
        }

        // Способ 2: напрямую удалить файлы кэша
        if ($method === 'direct') {
            $cacheDir = '/tmp/sed_cache';
            if (is_dir($cacheDir)) {
                foreach (glob($cacheDir . '/*.json') ?: [] as $f) {
                    if (@unlink($f)) $cleared++;
                }
            }
        }

        echo json_encode(['ok' => true, 'cleared' => $cleared, 'method' => $method], JSON_UNESCAPED_UNICODE);
    }
}
