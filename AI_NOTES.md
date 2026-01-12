## Краткие инструкции для AI

- Проект: docker-compose в корне (`docker compose up -d --build` или `scripts/dev-up.ps1`). Сервисы: `service2` (Node.js/PDF), `hub`, `reverse-proxy`, `paddle-ocr`.
- Деплой: после push можно дергать webhook Portainer (обновляет стек): `https://port.linart.club/api/stacks/webhooks/102e1dee-6a8d-44ab-b13f-207ce89807f2` (POST).
- Админка hub: пользователи и права хранятся в `hub/admin.json` (superadmin + users). Смена пароля админа сохраняет список пользователей. Для сохранения данных админки между пересборками — смонтировать `hub/admin.json`, `hub/services.json`, `hub/config.json`, `hub/static/uploads` как volume.
- Локальный запуск `service2`: из `service2/` `npm install` (первый раз), затем `npm start` (порт 3001). При старте генерится `public/index.html` на основе шаблона в `server.js`.
- Тестовое поколение PDF: запустить сервер, затем `node tools/gen-sample.js` (использует `FORM_HOST` или http://localhost:3001). Ответ `/submit` отдаёт JSON с `url`; чтобы скачать PDF, сходить GET на `http://localhost:3001/<url>` (пример в консоли).
- OCR: `PADDLE_OCR_URL` из `.env` (по умолчанию `http://paddle-ocr:8866/predict/ocr_system`, пробует и `/ocr`; при локальном запуске вне Docker — можно указать `http://localhost:8866/predict/ocr_system`). Parts OCR теперь **не заполняет** форму — только выводит статус, значения вносить руками. Поле LED display / batch заполняется руками или из карточки проекта (LSC Project number), не из OCR.
- Подсчёт сотрудников в PDF: уникальность по `name + role` (регистр/пробелы нормализованы). В PDF показываем `employeeCount` и, если есть дубликаты, добавляем суффикс с количеством записей.
- Карточка проекта (projects.json): ключ — `batch_number`/`lsc_project_number`. При сабмите сохраняем site info поля, потом автоподставляем их в форму.

Обновляй этот файл при изменении логики/команд, чтобы не обучать систему заново.
