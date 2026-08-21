# Развёртывание СЭД-вьювера на предприятии

Пошаговый рунбук для production на одной ВМ (интранет). Модель доступа:
ОС/SSH — только у администратора (вы); операторы работают с приложением по
**HTTPS/443** и проходят пароль + 2FA. См. также `SECURITY.md` (роли БД),
`SCALING.md` (одновременная работа), `deploy/*` (готовые конфиги).

```
Оператор ─HTTPS/443─▶ Nginx (TLS) ─▶ PHP-FPM (index.php)
                                         │
                                         ▼
                                  pam_daemon.py (systemd)
                                   пул SSH-сессий ─▶ PAM-бастион ─▶ PostgreSQL
```

## 0. Требования (пакеты)
- PHP 8.x: `php-fpm php-pgsql php-mbstring` (расширения pdo_pgsql, mbchars).
- Python 3: `python3 pip`; библиотеки: `pip3 install pexpect psycopg2-binary`.
- Nginx (рекоменд.) или Apache; `postgresql-client` (psql — для проверки).
- Доступ по SSH к PAM-бастиону с этой ВМ (демон ходит через него).

## 1. Файлы и владелец
```bash
sudo mkdir -p /var/www/sed
sudo git clone <repo> /var/www/sed        # или распаковать релиз
sudo chown -R www-data:www-data /var/www/sed
# код — только чтение для веб-пользователя, выгрузки — запись:
sudo find /var/www/sed -type f -exec chmod 640 {} \;
sudo find /var/www/sed -type d -exec chmod 750 {} \;
sudo chmod -R u+rwX,g+rwX /var/www/sed/storage
```
DocumentRoot = `/var/www/sed` (там `db_viewer.html` и `index.php`).
Секреты/скрипты закрыты правилами `deploy/nginx-security.conf` и `.htaccess`.
**Надёжнее:** вынести `.env`, `scripts/`, `storage/` ВЫШЕ корня и указать
DocumentRoot на `public/` — тогда они физически недостижимы по HTTP.

## 2. .env (секреты)
```bash
sudo -u www-data cp /var/www/sed/.env.example /var/www/sed/.env
sudo -u www-data nano /var/www/sed/.env      # заполнить все значения
sudo chmod 600 /var/www/sed/.env
```
- `SED_ADMIN_PASS` — bcrypt-ХЕШ: `php -r 'echo password_hash("пароль",PASSWORD_BCRYPT);'`
- `SED_DEBUG=0` в проде; заполнить PAM/TARGET/DB/LOG_DB/CHED/KSP/MONITORING, `AUTH_ORG_ID`.
- Размеры пулов: `SED_POOL_SIZE`, `CHED_POOL_SIZE`, `KSP_POOL_SIZE`, `MONITORING_POOL_SIZE`.

## 3. PostgreSQL — роли least-privilege (КРИТИЧНО)
Настоящая граница безопасности (детали и SQL — в `SECURITY.md`). Для КАЖДОЙ
роли (`DB_USER`, `CHED_DB_USER`, `KSP_DB_USER`, `MONITORING_DB_USER`, `LOG_DB_USER`):
```sql
ALTER ROLE sed_ro NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE <db> TO sed_ro;
GRANT USAGE ON SCHEMA public TO sed_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sed_ro;
-- проверка: SELECT pg_read_file('/etc/passwd'); и SELECT * FROM pg_authid; → ОТКАЗ
```
Локальная лог-БД (логи/2FA/префы) — обычно на этой же ВМ; роль `LOG_DB_USER`
с правом SELECT/INSERT/UPDATE на свои таблицы (их создаёт приложение само).

## 4. HTTPS / порт 443 (да, обязательно)
Приложение и так шлёт HSTS при HTTPS и ставит `Secure` на куки — но только
если соединение реально по TLS. Для интранета без публичного DNS используйте
сертификат внутреннего УЦ организации или самоподписанный (раздать корневой
сертификат клиентам), с публичным DNS — Let's Encrypt.
```bash
sudo mkdir -p /etc/ssl/sed
# самоподписанный на год (для теста/интранета):
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /etc/ssl/sed/privkey.pem -out /etc/ssl/sed/fullchain.pem \
  -subj "/CN=sed.example.local"
```

## 5. Веб-сервер
**Вариант А (рекоменд.): Nginx → PHP-FPM**
```bash
sudo cp /var/www/sed/deploy/php-fpm-sed.conf /etc/php/8.x/fpm/pool.d/sed.conf
sudo cp /var/www/sed/deploy/nginx-sed.conf   /etc/nginx/sites-available/sed
sudo ln -s /etc/nginx/sites-available/sed /etc/nginx/sites-enabled/sed
# nginx-sed.conf уже слушает 443 ssl и включает nginx-security.conf
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart php8.x-fpm
```
Добавьте редирект 80→443:
```nginx
server { listen 80; server_name sed.example.local; return 301 https://$host$request_uri; }
```
**Вариант Б: сохранить Apache** — `deploy/apache-sed.conf` (mpm_event +
proxy_fcgi к тому же FPM-сокету). Не используйте mod_php+prefork под нагрузкой.

`APP_ORIGIN` в `.env` = `https://<домен>` (для CORS).

## 6. Демон запросов (systemd)
```bash
sudo cp /var/www/sed/deploy/sed-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sed-daemon
sudo systemctl status sed-daemon        # ✓ active
python3 /var/www/sed/scripts/pam_daemon.py --status   # пинг сокета/SSH
```
Демон работает под `www-data` (иначе PHP не достучится до `/tmp/sed_query.sock`)
и держит `PrivateTmp=false`. Проверьте лимиты SSH на бастионе/ВМ:
`MaxSessions`/`MaxStartups` ≥ суммы размеров пулов.

## 7. Firewall / сетевой доступ
Открыть наружу ТОЛЬКО 443 (и только нужной подсети операторов); SSH — только
вам, лучше по ключам и с ограничением по IP.
```bash
sudo ufw default deny incoming
sudo ufw allow from <подсеть_операторов> to any port 443 proto tcp
sudo ufw allow from <ваш_админ_IP> to any port 22 proto tcp
sudo ufw enable
```
Круг пользователей приложения ограничивайте на сетевом уровне (подсеть/VPN) —
это второй рубеж поверх пароля+2FA. Список сотрудников `Auth:users` публичен
внутри доступной сети by design (для экрана выбора).

## 8. Проверка после развёртывания
```bash
curl -sk -o /dev/null -w "%{http_code}\n" https://<хост>/.env               # 403/404
curl -sk -o /dev/null -w "%{http_code}\n" https://<хост>/scripts/pam_daemon.py  # 403/404
curl -sk -o /dev/null -w "%{http_code}\n" https://<хост>/db_viewer.html      # 200
```
В браузере: экран входа → выбрать пользователя → пароль → привязать/ввести
2FA → войти → открыть таблицу/шаблон, выполнить запрос, экспорт CSV.
Первый вход `__admin__` → сразу настроить 2FA (QR).

## 9. Обслуживание
- Логи: `journalctl -u sed-daemon`, `/tmp/sed_daemon.log`, PHP-FPM
  (`/var/log/php-fpm/sed-error.log`), Nginx access/error.
- Обновление кода: `git -C /var/www/sed pull` →
  `systemctl restart php8.x-fpm sed-daemon`.
- Кэш запросов сбрасывается кнопкой «Обновить» (админ) или
  `System:clearCache`; TTL 20 с (справочники 1 ч).
- Бэкап: лог-БД (`sed_query_log`, `sed_user_prefs`, `sed_2fa`) — там 2FA-секреты.
- Ротация `/tmp/sed_daemon.log` (logrotate) — файл растёт.

## 10. Чек-лист безопасности перед запуском
- [ ] Роли БД `NOSUPERUSER`, read-only; `pg_read_file`/`pg_authid` недоступны.
- [ ] `.env` 600, владелец www-data, вне DocumentRoot (или закрыт правилами).
- [ ] HTTPS/443, редирект с 80, HSTS виден в ответе.
- [ ] `curl` к `.env`/`scripts` даёт 403/404.
- [ ] `SED_DEBUG=0`; `display_errors` off.
- [ ] Firewall: наружу только 443 нужной подсети; SSH ограничен.
- [ ] Демон под www-data, автозапуск, статус active.
- [ ] Админ настроил свой 2FA; сотрудникам роздан порядок первичной привязки.
