<?php
require_once __DIR__ . '/Config/Config.php';
Config::load();

// Прод-гигиена (V-12): это JSON-API — стектрейсы с путями/SQL не должны
// уходить клиенту. Ошибки только в лог. Управляется SED_DEBUG=1 в .env.
$__debug = filter_var(Config::get('SED_DEBUG', '0'), FILTER_VALIDATE_BOOL);
ini_set('display_errors', $__debug ? '1' : '0');
ini_set('log_errors', '1');

require_once __DIR__ . '/Core/RemoteRunner.php';
require_once __DIR__ . '/Modules/Remote/RemoteController.php';
require_once __DIR__ . '/Modules/Export/ExportController.php';
require_once __DIR__ . '/Modules/Auth/AuthController.php';
require_once __DIR__ . '/Modules/System/SystemController.php';
require_once __DIR__ . '/Modules/Asset/AssetController.php';

$_queryLogPath = __DIR__ . '/Modules/QueryLog/QueryLogController.php';
if (file_exists($_queryLogPath)) {
    require_once $_queryLogPath;
}

$_localQueryPath = __DIR__ . '/Modules/Local/LocalQueryController.php';
if (file_exists($_localQueryPath)) {
    require_once $_localQueryPath;
}

$_userPrefsPath = __DIR__ . '/Modules/UserPrefs/UserPrefsController.php';
if (file_exists($_userPrefsPath)) {
    try {
        require_once $_userPrefsPath;
    } catch (\Throwable $e) {
        error_log('[UserPrefs] Load error: ' . $e->getMessage());
    }
}

// ── Лимит тела запроса ────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($contentLength > 2_097_152) { 
        header('Content-Type: application/json; charset=utf-8');
        http_response_code(413);
        echo json_encode(['ok' => false, 'error' => 'Payload too large (max 2 MB)'], JSON_UNESCAPED_UNICODE);
        exit;
    }
}


$isHttps = !empty($_SERVER['HTTPS'])
    || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'
    || ($_SERVER['HTTP_X_FORWARDED_SSL']   ?? '') === 'on';

// Серверная сессия должна жить столько же, сколько cookie (8 ч),
// иначе сборщик мусора PHP убьёт её через ~24 мин простоя.
ini_set('session.gc_maxlifetime', '28800');

session_set_cookie_params([
    'lifetime' => 28800,
    'path'     => '/',
    'secure'   => $isHttps,   
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();

$m = $_GET['m'] ?? '';
$a = $_GET['a'] ?? '';

$sessionWriteRoutes = ['Auth:login' => true, 'Auth:logout' => true, 'Auth:verify2fa' => true, 'Auth:reEnroll2fa' => true, 'Auth:tfaList' => true, 'Auth:tfaReset' => true, 'Auth:unlockUser' => true, 'Auth:lockList' => true, 'Auth:unlockKey' => true];
if (!isset($sessionWriteRoutes["{$m}:{$a}"])) {
    session_write_close();
}

// ── CSRF-кука ─────────────────────────────────────────────────────
if (empty($_COOKIE['XSRF-TOKEN'])) {
    setcookie('XSRF-TOKEN', bin2hex(random_bytes(24)), [
        'expires'  => 0,
        'path'     => '/',
        'secure'   => $isHttps,  
        'httponly' => false,
        'samesite' => 'Strict',
    ]);
}

// ── CSRF-проверка для POST-запросов ───────────────────────────────
// Мобильное приложение SEDAdmin использует заголовок X-Mobile-Client вместо CSRF
$isMobileClient = ($_SERVER['HTTP_X_MOBILE_CLIENT'] ?? '') === 'SEDAdmin';

if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$isMobileClient) {
    $csrfHeader = $_SERVER['HTTP_X_XSRF_TOKEN'] ?? '';
    $csrfCookie = $_COOKIE['XSRF-TOKEN']        ?? '';
    if ($csrfCookie === '' || $csrfHeader === ''
        || !hash_equals($csrfCookie, $csrfHeader)) {
        header('Content-Type: application/json; charset=utf-8');
        http_response_code(403);
        echo json_encode(['ok' => false, 'error' => 'CSRF validation failed'], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

// ── CORS ──────────────────────────────────────────────────────────
$requestOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
$configOrigin  = Config::get('APP_ORIGIN', '');

if ($configOrigin !== '' && $requestOrigin === $configOrigin) {
    header("Access-Control-Allow-Origin: {$configOrigin}");
    header('Access-Control-Allow-Credentials: true');
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-XSRF-TOKEN, X-Mobile-Client');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── Заголовки безопасности ────────────────────────────────────────
header('X-Frame-Options: DENY');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';");
header('Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=(), bluetooth=()');

// HSTS — только если соединение HTTPS
if ($isHttps) {
    header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
}

// ── Публичные эндпоинты (без авторизации) ─────────────────────────
$publicRoutes = [
    'Auth:users'  => true,
    'Auth:login'  => true,
    'Auth:verify2fa' => true,
    'Auth:logout' => true,
];

// Rate limit для Auth:users: 20 запросов в 5 минут с одного IP
if ("{$m}:{$a}" === 'Auth:users') {
    $ip       = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $rlKey    = 'sed_rl_users_' . md5($ip);
    $rlFile   = sys_get_temp_dir() . '/' . $rlKey . '.rl';
    $rlData   = ['count' => 0, 'expires' => time() + 300];
    if (file_exists($rlFile)) {
        $existing = json_decode(file_get_contents($rlFile), true);
        if (($existing['expires'] ?? 0) > time()) {
            $rlData = $existing;
        }
    }
    if ($rlData['count'] >= 20) {
        http_response_code(429);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['ok' => false, 'error' => 'Слишком много запросов. Подождите немного.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $rlData['count']++;
    file_put_contents($rlFile, json_encode($rlData), LOCK_EX);
}


// ── Mobile token auth (X-Mobile-Client) ──────────────────────────
// Мобильное приложение использует X-Auth-Token вместо session cookie
if ($isMobileClient) {
    $mobileToken   = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? '';
    $tokenFile     = sys_get_temp_dir() . '/sed_mobile_' . md5($mobileToken) . '.tok';
    $mobileUser    = [];
    if ($mobileToken && file_exists($tokenFile)) {
        $tok = json_decode(file_get_contents($tokenFile), true);
        if (is_array($tok) && ($tok['expires'] ?? 0) > time()) {
            $mobileUser = $tok['user'];
        }
    }
    if (!isset($publicRoutes["{$m}:{$a}"]) && empty($mobileUser)) {
        header('Content-Type: application/json; charset=utf-8');
        http_response_code(401);
        echo json_encode(['ok' => false, 'error' => 'Не авторизован'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    global $sessionUser;
    $sessionUser = $mobileUser;
} else {
    if (!isset($publicRoutes["{$m}:{$a}"])) {
        if (empty($_SESSION['sed_user'])) {
            header('Content-Type: application/json; charset=utf-8');
            http_response_code(401);
            echo json_encode(['ok' => false, 'error' => 'Не авторизован'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }
    global $sessionUser;
    $sessionUser = $_SESSION['sed_user'] ?? [];
}

// ── Маршрутизация ─────────────────────────────────────────────────
match (true) {
    $m === 'Auth'      && $a === 'users'     => (new AuthController())->users(),
    $m === 'Auth'      && $a === 'login'     => (new AuthController())->login(),
    $m === 'Auth'      && $a === 'verify2fa' => (new AuthController())->verify2fa(),
    $m === 'Auth'      && $a === 'reEnroll2fa' => (new AuthController())->reEnroll2fa(),
    $m === 'Auth'      && $a === 'tfaList'   => (new AuthController())->tfaList(),
    $m === 'Auth'      && $a === 'tfaReset'  => (new AuthController())->tfaReset(),
    $m === 'Auth'      && $a === 'unlockUser'=> (new AuthController())->unlockUser(),
    $m === 'Auth'      && $a === 'lockList'  => (new AuthController())->lockList(),
    $m === 'Auth'      && $a === 'unlockKey' => (new AuthController())->unlockKey(),
    $m === 'Auth'      && $a === 'logout'    => (new AuthController())->logout(),
    $m === 'Remote'    && $a === 'preview'   => (new RemoteController())->preview(),
    $m === 'Remote'    && $a === 'export'    => (new RemoteController())->export(),
    $m === 'Remote'    && $a === 'submit'    => (new RemoteController())->submit(),
    $m === 'Remote'    && $a === 'poll'      => (new RemoteController())->poll(),
    $m === 'Remote'    && $a === 'cancel'    => (new RemoteController())->cancel(),
    $m === 'Export'    && $a === 'download'  => (new ExportController())->download(),
    $m === 'System'    && $a === 'daemonLog'  => (new SystemController())->daemonLog(),
    $m === 'System'    && $a === 'clearCache' => (new SystemController())->clearCache(),
    $m === 'Asset'     && $a === 'script'     => (new AssetController())->script(),
    $m === 'Asset'     && $a === 'shell'      => (new AssetController())->shell(),
    $m === 'QueryLog'  && $a === 'add'       => class_exists('QueryLogController') ? (new QueryLogController())->add()   : (function(){ echo json_encode(['ok'=>true]); })(),
    $m === 'QueryLog'  && $a === 'list'      => class_exists('QueryLogController') ? (new QueryLogController())->list()  : (function(){ echo json_encode(['ok'=>false,'error'=>'Not available']); })(),
    $m === 'QueryLog'  && $a === 'stats'     => class_exists('QueryLogController') ? (new QueryLogController())->stats() : (function(){ echo json_encode(['ok'=>false,'error'=>'Not available']); })(),
    $m === 'Local'     && $a === 'stats'     => class_exists('LocalQueryController') ? (new LocalQueryController())->stats() : (function(){ echo json_encode(['ok'=>false,'error'=>'Not available']); })(),
    $m === 'Local'     && $a === 'query'     => class_exists('LocalQueryController') ? (new LocalQueryController())->query() : (function(){ echo json_encode(['ok'=>false,'error'=>'Not available']); })(),
    $m === 'UserPrefs' && $a === 'get'  => class_exists('UserPrefsController')
        ? (new UserPrefsController())->get()
        : (static fn() => (function(){ header('Content-Type: application/json'); echo json_encode(['ok'=>true,'data'=>[]]); })())(),
    $m === 'UserPrefs' && $a === 'save' => class_exists('UserPrefsController')
        ? (new UserPrefsController())->save()
        : (static fn() => (function(){ header('Content-Type: application/json'); echo json_encode(['ok'=>true]); })())(),
    default => (static function (): void {
        header('Content-Type: application/json; charset=utf-8');
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => 'Not found'], JSON_UNESCAPED_UNICODE);
    })(),
};