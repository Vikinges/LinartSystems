# Linart Hub — руководство разработчика

Документ описывает устройство проекта `hub/`, порядок запуска контейнеров и алгоритм добавления новых сервисов (service3 и далее). Все команды приведены для PowerShell в Windows; при работе в Linux или macOS заменить на аналогичные в терминале.

## 1. Архитектура

- **Traefik (`reverse-proxy`)** — фронтовой прокси на портах 80/443. Выдает сертификаты Let's Encrypt и маршрутизирует запросы на остальные контейнеры.
- **Hub (`hub/`)** — приложение Node.js/Express на порту 8080. Обслуживает статические файлы, панель администратора (`/admin`), API `/api/status`, а также проксирует сервисы через `http-proxy-middleware`.
- **Сервисы (`service1`, `service2`, …)** — независимые приложения, которые регистрируются в `services.json`. Hub отображает их в интерфейсе и проксирует по настроенному префиксу.
- **Общая сеть docker-compose** — все контейнеры находятся в одной сети и ходят друг к другу по DNS-именам (`http://service1:3000`, `http://service2:3001`, …).

## 2. Требования

- Docker Desktop или совместимый Docker Engine.
- Docker Compose v2 (входит в Docker Desktop).
- Git (для обновлений из репозитория).

## 3. Первый запуск (чистая установка)

1. Клонировать репозиторий или перенести его в `C:\Code\containers\LinartSystems` (любая директория допустима).
2. Открыть PowerShell в корне проекта.
3. Убедиться, что Docker Desktop запущен.
4. Выполнить:
   ```powershell
   docker compose up -d --build
   ```
   Эта команда построит образы `hub`, `service1`, `service2` и поднимет все контейнеры вместе с Traefik.
5. Для локальной проверки добавить в `C:\Windows\System32\drivers\etc\hosts` строку:
   ```
   127.0.0.1 linart.club
   ```
6. Открыть `https://linart.club/` и принять предупреждение о самоподписанном сертификате (при первом запуске).

## 4. Рутинное обновление контейнеров

1. Загрузить свежие изменения:
   ```powershell
   git pull
   ```
2. Пересобрать и перезапустить:
   ```powershell
   docker compose down
   docker compose up -d --build
   ```
   Если нужно быстрее без остановки Traefik, можно:
   ```powershell
   docker compose build hub
   docker compose up -d hub
   ```
3. После обновления статических файлов сделать жесткое обновление страницы в браузере (`Ctrl+F5`).

## 5. Конфигурация хаба

- **`hub/services.json`** — список сервисов, отображаемых на главной странице. Хранится в репозитории и монтируется в контейнер.
- **`hub/config.json`** — текущие настройки интерфейса (лого, тексты, цвета, видео). Изменяются через админку `/admin`. Если файл отсутствует, создается из дефолтных значений в `server.js`.
- **`hub/admin.json`** — хеш пароля администратора. Если потерян доступ, удалить файл и перезапустить `hub`; при старте он пересоздастся с дефолтным паролем `admin`.
- Загруженные пользователем файлы (лого, видео) сохраняются в `hub/static/uploads` и доступны из контейнера.

## 6. Сброс пароля администратора

### Быстрый сброс в `admin`
1. Удалить файл с хешем внутри контейнера:
   ```powershell
   docker compose exec hub sh -c "rm /app/admin.json"
   ```
2. Перезапустить сервис Hub:
   ```powershell
   docker compose up -d hub
   ```
3. Войти с паролем `admin` и задать новый в разделе Security.

### Мгновенная смена на произвольный пароль
Иногда удобнее сразу установить новый пароль, не заходя в админку. Запустите:
```powershell
$NEW_PASSWORD = "MyStrongPass123!"
docker compose exec hub sh -lc "node - <<'NODE'
const fs = require('fs');
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync(process.env.NEW_PASSWORD, 10);
fs.writeFileSync('/app/admin.json', JSON.stringify({ passwordHash: hash }, null, 2));
NODE" NEW_PASSWORD=$NEW_PASSWORD
docker compose restart hub
```
После рестарта вход выполняется с указанных значениями. Переменную `$NEW_PASSWORD` можно задать любому удобному паролю.

## 7. Добавление нового сервиса (service3 и т.д.)

1. Скопировать существующий сервис как шаблон или создать новую папку, например `service3/`, с `Dockerfile`, `package.json` и т.д.
2. В `docker-compose.yml` добавить секцию:
   ```yaml
   service3:
     build: ./service3
     container_name: linart_service3
     restart: always
     healthcheck:
       test: ["CMD-SHELL", "wget -q -O - http://localhost:3002/health || exit 1"]
       interval: 10s
       timeout: 3s
       retries: 3
   ```
   Настроить порт и команду healthcheck в соответствии с сервисом.
3. В `hub/services.json` добавить запись:
   ```json
   {
     "name": "service3",
     "target": "http://service3:3002",
     "prefix": "/service3",
     "displayName": "Service 3",
     "description": "Описание сервиса",
     "logo": "/static/uploads/service3.png"
   }
   ```
4. Пересобрать и запустить:
   ```powershell
   docker compose up -d --build service3 hub
   ```
   или полным `docker compose up -d --build` при первой сборке.
5. Проверить в браузере: на главной странице появится карточка нового сервиса, а по адресу `https://linart.club/service3/` — его приложение.

## 8. Управление и диагностика

- Посмотреть статусы контейнеров:
  ```powershell
  docker compose ps
  ```
- Логи конкретного сервиса:
  ```powershell
  docker compose logs -f hub
  docker compose logs -f service3
  ```
- Остановить все:
  ```powershell
  docker compose down
  ```
- Очистить загруженные через админку файлы — удалить из `hub/static/uploads` и при необходимости обновить `config.json`.

## 9. Админка

- Доступ: `https://linart.club/admin` (по умолчанию через всплывающее окно на главной странице).
- Возможности:
  - Изменение логотипа, описаний, цветов и прозрачностей.
  - Управление приветственным блоком (текст, изображение, WhatsApp).
  - Загрузка фонового видео.
  - Добавление/редактирование сервисов (через API `services.json`).
  - Управление ссылками на соцсети.
  - Смена пароля администратора.

После любого изменения не забудьте сохранить и проверить публичную страницу с жестким обновлением, чтобы убедиться, что новые параметры подхватились.
