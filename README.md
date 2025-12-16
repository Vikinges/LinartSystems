Linart Systems — Hub + PDF service
==================================

Состав
- Hub (`hub/`) — главная страница и прокси.
- Service2 (`service2/`) — PDF формы/заявки.

Быстрый запуск (Docker/Portainer)
1) Скопируйте `.env.example` → `.env` и задайте переменные:
   - `SESSION_SECRET`, `HUB_ADMIN_PASSWORD`
   - `ADMIN_PASSWORD` (админ парол service2)
   - `HUB_PORT` (8080 по умолчанию; смените если занят)
2) В Portainer:
   - Repository: `https://github.com/Vikinges/LinartSystems.git`
   - Reference: `refs/heads/feature/hub-service-zip`
   - Compose path: `docker-compose.yml`
   - Env (Advanced mode): `HUB_PORT`, `SESSION_SECRET`, `HUB_ADMIN_PASSWORD`, `ADMIN_PASSWORD`
   - Deploy.

Запуск из консоли (если нужно)
```bash
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Доступ
- Hub: `http://localhost:<HUB_PORT>` (или ваш домен через Cloudflare/Tunnel)
- Service2 внутри сети: `http://service2:3001`
