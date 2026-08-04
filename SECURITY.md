# Безопасность СЭД-вьювера

Документ отражает статус исправлений по аудиту `SED_security_audit.md`
и операционные шаги, которые нельзя выполнить только правкой кода
(конфигурация Nginx/Apache и привилегии ролей PostgreSQL).

## Статус находок

| #    | Находка                                             | Статус | Где |
|------|-----------------------------------------------------|--------|-----|
| V-01 | Обход 2FA через `X-Mobile-Client`                   | ✅ исправлено в коде | `AuthController::gate2fa/verify2fa` |
| V-02 | `.env`/`storage`/`scripts` доступны по HTTP         | ⚙️ конфиг деплоя | `.htaccess`, `deploy/nginx-security.conf` |
| V-03 | CSV/formula injection в экспорте                    | ✅ исправлено в коде | PHP + оба remote-скрипта |
| V-04 | Обход блэклиста SQL (`pg_sleep_for`, `pg_cancel_backend`) | ✅ исправлено в коде | `RemoteRunner::assertReadOnly` |
| V-05 | Слабый фильтр в `LocalQueryController`              | ✅ исправлено в коде | общий валидатор |
| V-06 | CSP `script-src 'unsafe-inline'`                    | ✅ исправлено в коде | `db_viewer.html` meta + `index.php` + делегирование |
| V-07 | IDOR в `poll()`/`cancel()`                          | ✅ исправлено в коде | `RemoteController` |
| V-08 | `System:clearCache` без admin-гейта                | ✅ исправлено в коде | `SystemController` |
| V-09 | TOTP без anti-replay                                | ✅ исправлено в коде | `Totp` + `AuthController` |
| V-10 | TOFU-риск первичной привязки 2FA                   | 🔶 организационно | см. ниже |
| V-11 | Блокировка аккаунта по `userId` — DoS              | 🔶 организационно | см. ниже |
| V-12 | Гигиена (дубли роутов, мёртвый код, `display_errors`) | ✅ исправлено в коде | `index.php`, `RemoteController` |
| I-01 | Публичный список сотрудников + username-oracle      | ℹ️ by design | см. ниже |

---

## Стратегическая граница: привилегии ролей БД (ГЛАВНОЕ)

Модель «разрешён любой `SELECT`, опасное режем блэклистом» держится **только**
на привилегиях ролей PostgreSQL. Блэклист — не граница безопасности.
Проверьте и зафиксируйте для **всех** ролей (`DB_USER`, `CHED_DB_USER`,
`KSP_DB_USER`, `LOG_DB_USER`):

```sql
-- Роль не суперпользователь, не может создавать роли/БД
ALTER ROLE sed_ro NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Только чтение нужных схем
REVOKE ALL   ON DATABASE  <db>   FROM sed_ro;
GRANT  CONNECT ON DATABASE <db>  TO sed_ro;
GRANT  USAGE  ON SCHEMA    public TO sed_ro;
GRANT  SELECT ON ALL TABLES IN SCHEMA public TO sed_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sed_ro;

-- Проверка: роль НЕ должна читать хеши и файлы
--   SELECT * FROM pg_authid;            -- должно быть отказано
--   SELECT pg_read_file('/etc/passwd'); -- должно быть отказано
```

При таких ролях V-04/V-05 становятся практически неэксплуатируемыми
независимо от фильтра. Дополнительно в сессии выставлен
`statement_timeout=590000` (снимает класс sleep/DoS).

---

## V-02 — закрыть `.env` / `storage` / `scripts` по HTTP

**Apache (mod_php):** корневой `.htaccess` и per-directory `.htaccess`
уже в репозитории (нужен `AllowOverride All`).

**Nginx (в т.ч. схема Nginx → Apache):** `.htaccess` не читается —
подключите сниппет в `server { }`:

```nginx
include /path/to/deploy/nginx-security.conf;
```

**Лучший вариант архитектурно:** DocumentRoot → отдельный `public/`,
а `.env`, `scripts`, `storage`, исходники — **выше** корня сайта.

**Проверка на бою (ждём 403/404):**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<хост>/.env
curl -s -o /dev/null -w "%{http_code}\n" https://<хост>/scripts/pam_daemon.py
curl -s -o /dev/null -w "%{http_code}\n" https://<хост>/private_js/db_app.js
curl -s -o /dev/null -w "%{http_code}\n" https://<хост>/storage/exports/x.csv
```

---

## V-06 — `script-src 'unsafe-inline'` убран (исправлено)

CSP теперь защищает и сам документ, и API:
- `db_viewer.html` несёт `<meta http-equiv="Content-Security-Policy">` с
  `script-src 'self'` (документ отдаётся статикой, заголовок из `index.php`
  к нему не применялся);
- в `index.php` `'unsafe-inline'` для `script-src` снят (`style-src
  'unsafe-inline'` оставлен как компромисс — в разметке много инлайн-стилей).

Чтобы это не сломало интерфейс, весь инлайн-JS вынесен:
- инлайновые `<script>` → `assets/js/db_boot.js` (тема) и
  `assets/js/db_init.js` (guard `showApp`, `authInit`, тумблер пароля);
- единый делегатор событий в `assets/js/db_utils.js`: элементы объявляют
  действие через `data-act` / `data-act-<event>`, реестр `SED_ACTIONS`,
  слушатели на `document` переживают `innerHTML`-инъекции;
- статические и динамические обработчики (`app_shell.html`, `db_auth.js`,
  `db_query.js`, `db_saved.js`, `db_template.js`) переведены на `data-act*`.

Проверяется автоматически (`tests/`): браузерный тест на Chromium
подтверждает ноль `script-src` CSP-violations на экране логина и в оболочке
приложения и работу делегированных действий.

> Мёртвые дубликаты `assets/js/{db_query,db_saved,db_template,db_app,
> db_columns,db_export,db_filter,db_fk,db_prefs,db_sqledit,db_table}` **удалены**
> (не грузились нигде). Живой путь приложения — `private_js/*` через
> `Asset:script`; живой путь логина — `assets/js/{db_utils,qrcode,db_2fa,
> db_auth,db_boot,db_init}` (6 файлов; проверяется `tests/run.sh`).
>
> `style-src 'unsafe-inline'` пока оставлен (осознанный компромисс). Закрытие —
> отдельная крупная задача: вынести ~223 инлайновых `style="..."` (в HTML и в
> генерируемом `innerHTML`) в классы, 2 инлайновых `<style>` и 5 создаваемых
> JS `<style>` — во внешний CSS, затем убрать `'unsafe-inline'` из style-src
> в `db_viewer.html` и `index.php`. `.style.x=`/`cssText` (CSSOM) трогать не
> нужно — они не подпадают под CSP. Выгода мала (инъекция скриптов уже закрыта
> V-06), риск регрессий высок — делать отдельно с полным браузерным тестом.

## Тесты (`tests/`)

`bash tests/run.sh` — static (php -l, компиляция Python + парсинг встроенных
remote-скриптов, node --check, проверка отсутствия инлайн-обработчиков и
строгого CSP), unit (PHP: валидатор/CSV/TOTP; Python: `validate_readonly` и
`_csv_safe`), browser (Playwright/Chromium: CSP-violations + делегирование).
Интеграция SSH/PAM/PostgreSQL не запускается (нужны `.env`/бастион/сервер БД).

---

## V-10 — контролируемая привязка 2FA (организационно)

Сейчас первый вошедший по паролю привязывает 2FA к своему устройству
(TOFU). Рекомендуется одно из:

- привязку инициирует администратор (одноразовый enroll-код сотруднику);
- энроллмент разрешён только из доверенной подсети;
- минимум — алерт админу о каждом первом энроллменте (лог уже есть).

## V-11 — lockout по `userId` как DoS (организационно)

20 неверных попыток по `userId` (в т.ч. `__admin__`) блокируют аккаунт.
Смягчение: вход `__admin__` только из доверенной подсети;
экспоненциальная задержка вместо жёсткого лока; капча после N попыток;
алерт админу (частично логируется).

## I-01 — публичный список сотрудников (by design)

`Auth:users` отдаёт `id`+`name` неуволенных сотрудников (нужно для экрана
выбора). При повышении требований к анонимности — перейти на ручной ввод
логина и единый ответ «неверные учётные данные».
