<?php
// ── Мок-роутер для браузерных тестов (php -S ... tests/server-router.php) ──
// Отдаёт статику как есть; index.php-маршруты подменяет фикстурами, чтобы
// фронтенд отрабатывал в браузере без реальной БД/SSH и без зависаний.
// НЕ для продакшена — только для тестов.

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$root = dirname(__DIR__);

// Реальные статические файлы отдаёт встроенный сервер
if ($uri !== '/' && $uri !== '/index.php') {
    $path = realpath($root . $uri);
    if ($path && strpos($path, $root) === 0 && is_file($path)) {
        return false;
    }
}

$m = $_GET['m'] ?? '';
$a = $_GET['a'] ?? '';
$key = "$m:$a";

// HTML-оболочка приложения
if ($key === 'Asset:shell') {
    header('Content-Type: text/html; charset=utf-8');
    readfile($root . '/private_js/app_shell.html');
    exit;
}
// JS-модули приложения (как Asset:script)
if ($m === 'Asset' && $a === 'script') {
    $f = preg_replace('/[^a-z0-9_]/i', '', $_GET['f'] ?? '');
    $p = $root . '/private_js/' . $f . '.js';
    header('Content-Type: application/javascript; charset=utf-8');
    if (is_file($p)) readfile($p);
    exit;
}

header('Content-Type: application/json; charset=utf-8');

$fixtures = [
    'Auth:users'    => ['ok' => true, 'rows' => [['id' => 123, 'name' => 'Тест Пользователь']]],
    'Auth:login'    => ['ok' => true, 'name' => 'Тест', 'isAdmin' => true, 'canRemote' => true],
    'UserPrefs:get' => ['ok' => true, 'data' => []],
    'UserPrefs:save'=> ['ok' => true],
    'QueryLog:add'  => ['ok' => true],
    'QueryLog:list' => ['ok' => true, 'rows' => [], 'total' => 0],
    'Local:stats'   => ['ok' => true, 'total' => 0, 'today' => 0],
];

if (isset($fixtures[$key])) {
    echo json_encode($fixtures[$key], JSON_UNESCAPED_UNICODE);
    exit;
}

// Дефолт: пустой успешный ответ (таблицы/preview/schemas и т.п.)
echo json_encode(
    ['ok' => true, 'rows' => [], 'columns' => [], 'count' => 0, 'data' => []],
    JSON_UNESCAPED_UNICODE
);
