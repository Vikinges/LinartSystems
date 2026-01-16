## Краткие инструкции для AI

- Проект: docker-compose в корне (`docker compose up -d --build` или `scripts/dev-up.ps1`). Сервисы: `service2` (Node.js/PDF), `hub`, `reverse-proxy`, `paddle-ocr`.
- Деплой: после push можно дергать webhook Portainer (обновляет стек): `https://port.linart.club/api/stacks/webhooks/102e1dee-6a8d-44ab-b13f-207ce89807f2` (POST).
- Админка hub: пользователи и права хранятся в `admin.json` (superadmin + users). Для персистентности задайте `HUB_DATA_DIR=/app/data` и смонтируйте volume `hub-data:/app/data` (там будут `admin.json`, `services.json`, `config.json`). Для логотипов/медиа — volume `hub-uploads:/app/static/uploads`.
- Если пароль admin потерян: установить `HUB_ADMIN_PASSWORD_FORCE=1` и `HUB_ADMIN_PASSWORD=<новый>` — при старте пароль супер‑админа будет переустановлен, список пользователей сохраняется.
- Локальный запуск `service2`: из `service2/` `npm install` (первый раз), затем `npm start` (порт 3001). При старте генерится `public/index.html` на основе шаблона в `server.js`.
- Тестовое поколение PDF: запустить сервер, затем `node tools/gen-sample.js` (использует `FORM_HOST` или http://localhost:3001). Ответ `/submit` отдаёт JSON с `url`; чтобы скачать PDF, сходить GET на `http://localhost:3001/<url>` (пример в консоли).
- OCR: `PADDLE_OCR_URL` из `.env` (по умолчанию `http://paddle-ocr:8866/predict/ocr_system`, пробует и `/ocr`; при локальном запуске вне Docker — можно указать `http://localhost:8866/predict/ocr_system`). Parts OCR теперь **не заполняет** форму — только выводит статус, значения вносить руками. Поле LED display / batch заполняется руками или из карточки проекта (LSC Project number), не из OCR.
- Подсчёт сотрудников в PDF: уникальность по `name + role` (регистр/пробелы нормализованы). В PDF показываем `employeeCount` и, если есть дубликаты, добавляем суффикс с количеством записей.
- Карточка проекта (projects.json): ключ — `batch_number`/`lsc_project_number`. При сабмите сохраняем site info поля, потом автоподставляем их в форму.
- Daily report: signature removed; photos are compressed client-side before upload (JPEG, max edge 1600px).
- Daily report: project number suggestions come from projects.json; submitter uses employee name suggestions.
- Daily report: PDF uses template header (bodyTopOffset) and draws content below the boundary.
- Hub: /service2 and /download now require login; users need allowedServices including service2.
- Hub: to force reset admin password, set HUB_ADMIN_PASSWORD_FORCE=1 and redeploy (must be in container env).
- Hub: admin login accepts HUB_ADMIN_PASSWORD and refreshes stored hash if mismatched.
- Hub: admin session also sets signed hub_admin_auth cookie; /admin and /api/status are no-cache to avoid stale auth.
- Service2: added file archive UI at /files; /download/<type> redirects to /files?type=..., and /api/files lists generated PDFs from out/<type>/meta with filters.
- Hub: /files redirects to /service2/files (preserves query) to support archive access behind the proxy.
- Hub: users now have roles (admin/manager/blocked). Header shows logged role; admin UI lets you set role via checkboxes.
- Hub: added per-user files access flag; Files button appears only when allowed, and /files + /download are restricted.

Обновляй этот файл при изменении логики/команд, чтобы не обучать систему заново.
