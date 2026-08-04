<?php
class Config {
    // Load .env file into getenv() on bootstrap
    public static function load(): void {
    $envFile = dirname(__DIR__) . '/.env';
    if (!file_exists($envFile)) return;

    foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) continue;
        if (!str_contains($line, '=')) continue;

        [$key, $val] = explode('=', $line, 2);
        $key = trim($key);
        $val = trim($val);

        // Снять одинарные или двойные кавычки если есть
        if (preg_match('/^([\'"])(.*)\1$/s', $val, $m)) {
            $val = $m[2];
        }

        if ($key !== '') {
            putenv($key . '=' . $val);
        }
    }
}

    public static function get(string $key, string $default = ''): string {
        $v = getenv($key);
        return $v !== false ? $v : $default;
    }
}