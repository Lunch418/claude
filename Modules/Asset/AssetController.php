<?php
/**
 * AssetController — отдаёт JS-модули приложения только авторизованным.
 *
 * Маршрут Asset:script НЕ входит в publicRoutes, поэтому неавторизованный
 * запрос отсекается общим gate в index.php (401) ещё до сюда.
 * Файлы лежат в /private_js (закрыта от прямого HTTP-доступа), читаются
 * через PHP по белому списку имён.
 */
class AssetController
{
    /** Разрешённые к отдаче модули (без расширения). */
    private const ALLOWED = [
        'db_app', 'db_table', 'db_filter', 'db_query', 'db_template',
        'db_fk', 'db_export', 'db_columns', 'db_saved', 'db_prefs', 'db_sqledit', 'db_split', 'db_admin', 'db_settings',
    ];

    private function dir(): string
    {
        return dirname(__DIR__, 2) . '/private_js';
    }

    public function script(): void
    {
        $f = (string) ($_GET['f'] ?? '');

        // Строгая валидация: только буквы/цифры/подчёркивание, только из списка
        if (!preg_match('/^[a-z0-9_]+$/i', $f) || !in_array($f, self::ALLOWED, true)) {
            http_response_code(404);
            header('Content-Type: text/plain; charset=utf-8');
            echo '// not found';
            return;
        }

        $path = $this->dir() . '/' . $f . '.js';
        $real = realpath($path);
        $base = realpath($this->dir());

        if ($real === false || $base === false || !str_starts_with($real, $base) || !is_file($real)) {
            http_response_code(404);
            header('Content-Type: text/plain; charset=utf-8');
            echo '// not found';
            return;
        }

        header('Content-Type: application/javascript; charset=utf-8');
        header('Cache-Control: private, no-store');
        header('X-Content-Type-Options: nosniff');
        readfile($real);
    }

    /** Отдаёт HTML-оболочку приложения (тело страницы) только авторизованным. */
    public function shell(): void
    {
        $path = dirname(__DIR__, 2) . '/private_js/app_shell.html';
        $real = realpath($path);

        if ($real === false || !is_file($real)) {
            http_response_code(404);
            header('Content-Type: text/plain; charset=utf-8');
            echo '<!-- shell not found -->';
            return;
        }

        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: private, no-store');
        header('X-Content-Type-Options: nosniff');
        readfile($real);
    }
}