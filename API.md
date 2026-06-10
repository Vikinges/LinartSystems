# Linart Systems — API & Integration Guide

Этот документ описывает публичные и внутренние API, формат данных и рекомендации для разработчиков мини‑сервисов (например, `service1` и `service2`). Поместите этот файл в корень репозитория — он служит справочником для разработчиков контейнеров.

Все примеры предполагают, что вы работаете в среде Docker Compose, где имена сервисов (например `service1`, `service2`) разрешаются внутри сети compose.

## Обзор структуры
- `hub/` — центральный сайт-хаб, служит UI, reverse-proxy и агрегатором статусов.
- `service1/`, `service2/` — примеры мини-сервисов (Express-приложения).
- `docker-compose.yml` — собирает и поднимает все сервисы.
- `service1/fields.json` — полный список полей (используется формой и генератором PDF).

## Общие соглашения для контейнеров
- Контейнеры должны слушать HTTP на порту, указанном в `PORT` (по умолчанию 3000 для `service1`, 3001 для `service2`).
- Ожидается наличие health endpoint: `GET /health` — возвращает JSON с минимальным набором: `{ status: 'ok'|'fail', service: '<name>', uptime: <number>, now: '<ISO timestamp>' }`.
- Если сервис принимает формы/файлы — его обработчики должны корректно отвечать на `POST /submit` (см. ниже).
- Для разработки удобно поддерживать `GET /` отдающий UI (index.html) и относительные пути к ассетам.

## Hub (центральный)
Base URL (локально): `http://localhost:8080`

Основные endpoint'ы:
- `GET /` — главная страница (UI с логотипами и ссылками)
- `GET /status` — страница статуса (UI)
- `GET /api/status` — агрегированный JSON-статус всех сервисов (вызывается UI)
  - Хаб опрашивает внутр. URL-ы: `http://service1:3000/health` и `http://service2:3001/health`.
- `GET /service1/*` и `GET /service2/*` — reverse-proxy к соответствующим сервисам (путь переписывается, т.е. `/service1/submit` проксируется в `http://service1:3000/submit`).

Пример ответа `/api/status`:

```json
{
  "services": [
    { "name": "service1", "ok": true, "info": { "status": "ok", "service": "service1", "uptime": 28.37, "now": "..." } },
    { "name": "service2", "ok": true, "info": { "status": "ok", "service": "service2", "uptime": 12.12, "now": "..." } }
  ],
  "hub": { "now": "2025-..." }
}
```

### Token auth для API/мобильных клиентов
Base URL (локально): `http://localhost:8080`

- `POST /api/auth/token` — логин, выдаёт Bearer-токен (TTL 7 дней).
  - Body: `{ "username": "operator1", "password": "secret" }`
  - Ответ: `{ "ok": true, "token": "...", "tokenType": "Bearer", "expiresAt": "...", "user": { ... } }`
  - Токен отправлять как `Authorization: Bearer <token>` — принимается на всех маршрутах hub (включая прокси `/service2/*`) наравне с cookie.
- `POST /api/auth/refresh` — обновить токен (требует действующий токен; права перечитываются из хранилища).
- `GET /api/auth/me` — текущий пользователь и права.

### Идемпотентность /submit (service2)

- В `multipart/form-data` можно передать поле `client_report_id` (UUID, `[A-Za-z0-9_-]`, ≤128).
- Повторная отправка с тем же id не создаёт дубликат: сервер возвращает сохранённый ответ + `"duplicate": true`. Одновременный повтор → HTTP 409 `duplicate_in_progress`.

### Пагинация /api/files (service2)

- `GET /api/files?type=&limit=&offset=` — ответ содержит `total`, `offset`, `limit`, `files`.

### Задания на подпись (service2 → service-sign)

- `POST /api/sign/create` — создать задание (admin/links-права). Body: `{ "type": "...", "file": "..." }`.
- `GET /api/sign/jobs?status=pending|signed|expired&limit=&offset=` — список заданий: `{ ok, total, limit, offset, jobs: [{ id, status, originalName, createdAt, expiresAt, signedAt, downloadCount }] }`.

### Admin API (только superadmin)
Base URL (локально): `http://localhost:8080`

- `GET /admin/users` — список пользователей (без паролей). Ответ:

```json
{ "ok": true, "users": [ { "username": "operator1", "allowedServices": ["service2"] } ] }
```

- `POST /admin/users` — создать пользователя.
  - Body: `{ "username": "operator1", "password": "secret", "allowedServices": ["service2"] }`
- `PATCH /admin/users/:username` — обновить права/пароль.
  - Body: `{ "allowedServices": ["service2"], "password": "newpass" }`
- `DELETE /admin/users/:username` — удалить пользователя.
- `POST /admin/password` — сменить пароль superadmin.
  - Body: `{ "currentPassword": "...", "newPassword": "..." }`

Примечание: данные пользователей и настройки hub хранятся в `admin.json`, `services.json`, `config.json`. Для персистентности задайте `HUB_DATA_DIR=/app/data` и смонтируйте volume `hub-data:/app/data`. Логотипы/медиа хранятся в `static/uploads` — смонтируйте volume `hub-uploads:/app/static/uploads`.
Для восстановления доступа можно задать `HUB_ADMIN_PASSWORD_FORCE=1` — при старте hub обновит пароль супер‑админа из `HUB_ADMIN_PASSWORD` и сохранит список пользователей.

## Service API (пример: service1)
Base URL (в контейнерной сети): `http://service1:3000`
Base URL (локально, если проброшен): `http://localhost:3002` (см. `docker-compose.yml`)

Ожидаемые endpoint'ы:

- `GET /` — отдаёт HTML UI (страница формы/документов).

- `GET /health` — проверка состояния. Должен вернуть JSON минимальной формы:

```json
{ "status": "ok", "service": "service1", "uptime": 123.45, "now": "2025-..." }
```

- `GET /suggest?field=<fieldName>&q=<query>` — (опционально) возвращает подсказки для автозаполнения поля. Формат:

```json
{ "ok": true, "field": "end_customer_name", "query": "Acme", "suggestions": ["Acme Ltd","Acme Corp"] }
```

- `POST /submit` — основной импорт/генерация результата (multipart/form-data ожидается, могут быть файлы/фото)
  - Content-Type: `multipart/form-data` (form fields + optional files). Поля — см. ниже (`fields.json`).
  - Ответ (пример):

```json
{ "ok": true, "url": "/download/generated/abcd1234.pdf", "overflowCount": 0, "partsRowsHidden": [] }
```

  - В случае ошибки возвращается `{ ok: false, error: 'message' }`.

### Формат полей и список
- Поля и их типы (summary) расположены в `service1/fields.json`. Там содержится полный набор (122 полей) с именами и типами (`text`, `checkbox` и т.д.).
- Пример нескольких полей:
  - `end_customer_name` (text)
  - `site_location` (text)
  - `date_of_service` (text)
  - `led_complete_1` (checkbox)

Полный файл: `service1/fields.json` — используйте его для валидации и генерации форм.

## Примеры запросов

Прямой запрос к сервису (локально, если проброшен):

```
curl -F "end_customer_name=Acme" -F "date_of_service=2025-10-14" \
  -F "photo1=@./img.jpg" http://localhost:3002/submit
```

Через hub (reverse-proxy):

```
curl -F "end_customer_name=Acme" -F "date_of_service=2025-10-14" \
  -F "photo1=@./img.jpg" http://localhost:8080/service1/submit
```

Запрос статуса агрегатора:

```
curl http://localhost:8080/api/status
```

## Docker / контейнерные рекомендации
- Service должен слушать порт `PORT` (по умолчанию 3000/3001). В `docker-compose.yml` сервисы проброшены на хостные порты (например `3002:3000`).
- Добавьте `/health` и убедитесь, что Docker healthcheck в `docker-compose.yml` может использовать этот endpoint.
- Рекомендуемые env переменные:
  - `PORT` — порт сервера
  - `TEMPLATE_PATH` — путь к PDF-шаблону, если требуется
  - Любые другие секреты — передавать через `.env` или секреты Docker (не коммитить в репозиторий)

Пример healthcheck в `docker-compose.yml` (уже добавлено):

```yaml
healthcheck:
  test: ["CMD-SHELL", "wget -q -O - http://localhost:3000/health || exit 1"]
  interval: 10s
  timeout: 3s
  retries: 3
```

## UI разработчика контейнера
- Страницы сервиса обычно используют относительные пути (`./submit`, `./suggest`) — при проксировании hub переписывает префикс (`/service1` → `/`).
- Если фронтенд делает `POST` на `./submit` (как в `service1/public/index.html`), то запросы через hub должны идти на `/service1/submit` — reverse-proxy сделает переписку автоматически.

## Безопасность и приватность
- Не коммитьте конфиденциальные данные (ключи, секреты, store.json с реальными данными). Если в репозитории есть тестовые data-файлы — пометьте их как тестовые.
- Для production используйте TLS, защиту /api/status (например, basic auth или токены) и ограничьте доступ к Docker API.

## Деплой / Webhook (Portainer)
Для обновления стека после push в Git используйте webhook Portainer:

```
POST https://lsc-led.de:9443/api/stacks/webhooks/b903907f-2110-4593-963b-e0f71779e249
```

Пример:

```bash
curl -k -X POST https://lsc-led.de:9443/api/stacks/webhooks/b903907f-2110-4593-963b-e0f71779e249
# -k обязателен: у Portainer на :9443 самоподписанный сертификат
```

## Где искать исходные примеры
- Полный список полей: `service1/fields.json`.
- Реализация `/submit` и логика генерации PDF: `service1/server.js` (см. handler `app.post('/submit', ...)`).
- Примеры тестов/скриптов: `service1/test-start.sh`.

Если нужно, могу:
- добавить OpenAPI/Swagger спецификацию для `/submit` и `/health`,
- сгенерировать пример client SDK (curl/node) для интеграции, или
- включить JSON schema для полей из `fields.json`.

---
Файл создан автоматически командой помощника. Обновляйте по мере изменения API.
