<?php
/**
 * Totp — реализация TOTP (RFC 6238) поверх hash_hmac.
 * Совместим с Google Authenticator, Authy, FreeOTP и др.
 * Это реализация открытого стандарта, а не самописная криптография:
 * вся крипта — стандартный hash_hmac('sha1').
 */
class Totp
{
    private const PERIOD = 30;     // секунд на код
    private const DIGITS = 6;      // длина кода
    private const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** Случайный секрет в base32 (по умолчанию 16 символов = 80 бит). */
    public static function generateSecret(int $len = 16): string
    {
        $s = '';
        $bytes = random_bytes($len);
        for ($i = 0; $i < $len; $i++) {
            $s .= self::B32[ord($bytes[$i]) & 31];
        }
        return $s;
    }

    /** Проверка кода с окном ±$window интервалов (по умолчанию ±1 = ±30с). */
    public static function verify(string $secret, string $code, int $window = 1): bool
    {
        return self::matchCounter($secret, $code, $window) !== null;
    }

    /**
     * Возвращает совпавший счётчик времени (floor(time/30)) или null.
     * Нужен для anti-replay: вызывающий код отклоняет счётчик, который
     * уже был использован (V-09).
     */
    public static function matchCounter(string $secret, string $code, int $window = 1): ?int
    {
        $code = preg_replace('/\D/', '', $code);
        if (strlen($code) !== self::DIGITS) return null;
        $t = (int) floor(time() / self::PERIOD);
        for ($i = -$window; $i <= $window; $i++) {
            if (hash_equals(self::codeAt($secret, $t + $i), $code)) {
                return $t + $i;
            }
        }
        return null;
    }

    /** Код для конкретного счётчика времени. */
    private static function codeAt(string $secret, int $counter): string
    {
        $key = self::b32decode($secret);
        if ($key === '') return '';
        $bin = pack('N*', 0) . pack('N*', $counter);   // 8-байтовый счётчик BE
        $hash = hash_hmac('sha1', $bin, $key, true);
        $off  = ord($hash[strlen($hash) - 1]) & 0x0F;
        $part = (ord($hash[$off]) & 0x7F) << 24
              | (ord($hash[$off + 1]) & 0xFF) << 16
              | (ord($hash[$off + 2]) & 0xFF) << 8
              | (ord($hash[$off + 3]) & 0xFF);
        $num = $part % (10 ** self::DIGITS);
        return str_pad((string) $num, self::DIGITS, '0', STR_PAD_LEFT);
    }

    /** otpauth://-строка для QR. */
    public static function otpauthUrl(string $secret, string $account, string $issuer): string
    {
        $label = rawurlencode($issuer) . ':' . rawurlencode($account);
        $q = http_build_query([
            'secret' => $secret,
            'issuer' => $issuer,
            'period' => self::PERIOD,
            'digits' => self::DIGITS,
            'algorithm' => 'SHA1',
        ]);
        return "otpauth://totp/{$label}?{$q}";
    }

    /** base32 → бинарь (для HMAC-ключа). */
    private static function b32decode(string $b32): string
    {
        $b32 = strtoupper(preg_replace('/[^A-Z2-7]/', '', $b32));
        if ($b32 === '') return '';
        $bits = '';
        for ($i = 0; $i < strlen($b32); $i++) {
            $v = strpos(self::B32, $b32[$i]);
            if ($v === false) return '';
            $bits .= str_pad(decbin($v), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) $out .= chr(bindec($byte));
        }
        return $out;
    }
}
