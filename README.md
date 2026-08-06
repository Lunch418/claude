# СЭД-вьювер

[![CI](https://github.com/Lunch418/claude/actions/workflows/ci.yml/badge.svg)](https://github.com/Lunch418/claude/actions/workflows/ci.yml)

Веб-приложение для **безопасного просмотра баз данных СЭД** (PostgreSQL) —
только чтение, доступ к БД через изолированный PAM-бастион по SSH.
Внутренний инструмент: вход по паролю + обязательная 2FA, готовые SQL-шаблоны,
экспорт, история и статистика запросов.

## Возможности
- Просмотр таблиц и запуск SQL (только `SELECT`/`WITH`), пагинация, поиск,
  экспорт в CSV/Excel.
- Готовые шаблоны запросов с параметрами; сохранённые запросы, история,
  избранное.
- Четыре источника: **СЭД / CHED / CHED2 / КСП** (переключение в UI).
- Аутентификация: пароль (bcrypt) + **2FA (TOTP)** с anti-replay; админ-панель
  (сброс 2FA, снятие блокировок).
- Тёмная/светлая тема, 9 акцентов, современный экран входа.

## Архитектура
```
Браузер (db_viewer.html + JS)
   │  fetch → index.php?m=<модуль>&a=<действие>
   ▼
index.php  (роутинг, сессии, CSRF, CORS, rate-limit, заголовки безопасности)
   ├── Modules/*        (PHP-контроллеры: Auth, Remote, Export, System, …)
   └── Core/RemoteRunner (валидация SQL → демон или разовый процесс)
          │ Unix-сокет /tmp/sed_query.sock
          ▼
   scripts/pam_daemon.py   (пул постоянных SSH-сессий на профиль + кэш)
          │ SSH через PAM-бастион
          ▼
   PostgreSQL (psycopg2)     ← роль NOSUPERUSER, read-only
```
Локальная лог-БД хранит логи запросов, пользовательские настройки и 2FA.

## Стек
PHP 8 (front-controller + модули) · Python 3 (SSH-демон, `pexpect`/`psycopg2`) ·
ванильный JS SPA · PostgreSQL · Nginx + PHP-FPM (или Apache).

## Безопасность (кратко)
Только `SELECT`; единый строгий валидатор; CSRF (double-submit + SameSite);
строгий **CSP без `script-src 'unsafe-inline'`**; bcrypt + 2FA; защита от
path-traversal и CSV-инъекций; секреты через env/base64. Настоящая граница —
**read-only роли PostgreSQL**. Подробности и статус находок аудита — в
[`SECURITY.md`](SECURITY.md).

## Тесты
```bash
bash tests/run.sh
```
Static (php -l, компиляция Python + разбор встроенных remote-скриптов,
node --check, проверка отсутствия инлайн-обработчиков и строгого CSP) +
unit (PHP: валидатор/CSV/TOTP; Python: `validate_readonly`, `_csv_safe`,
пул сессий) + браузерный тест (Playwright/Chromium: CSP-violations +
делегирование; авто-скип без Chromium). CI гоняет static+unit на каждый push.

## Конфигурация
Скопируйте [`.env.example`](.env.example) → `.env` и заполните (PAM/DB/LOG_DB/
CHED/KSP, `AUTH_ORG_ID`, `SED_ADMIN_PASS` — bcrypt-хеш, размеры пулов).
`.env` не коммитится.

## Документация
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — развёртывание на предприятии (HTTPS/443,
  Nginx/Apache/PHP-FPM, роли БД, systemd-демон, firewall, чек-лист).
- [`SCALING.md`](SCALING.md) — одновременная работа нескольких пользователей.
- [`SECURITY.md`](SECURITY.md) — модель безопасности и статус находок.
- `deploy/` — готовые конфиги (nginx, apache, php-fpm, systemd-юнит).
