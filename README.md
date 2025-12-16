Linart Systems — Central Hub + Example Services

What I added
- A small central "hub" web app in `hub/` that serves a static main page and proxies/redirects to demo services
- Two example microservices in `service1/` and `service2/`
- `docker-compose.yml` to build and run all three containers

Quick start (Docker Compose):

1. Copy `.env.example` to `.env` and set values:
   - `SESSION_SECRET`, `HUB_ADMIN_PASSWORD`
   - `ADMIN_PASSWORD` (service2 admin)
   - `HUB_PORT` (leave 8080 unless busy)
   - `LETSENCRYPT_EMAIL`
2. From the repository root run:
   ```powershell
   docker compose up --build -d
   ```
3. Open http://localhost:8080 (or your `HUB_PORT`).

Notes
- The hub runs on port 8080 and redirects /service/1 to http://service1:3000 inside the compose network.
- The docker-compose maps host ports for convenience.
- You can also proxy paths /s1 and /s2 through the hub (e.g. http://localhost:8080/s1/).

Portainer (few clicks)
- Build method: Repository → `https://github.com/Vikinges/LinartSystems.git`, reference `refs/heads/feature/hub-service-zip`, compose path `docker-compose.yml`.
- Environment variables (Advanced mode): `HUB_PORT` (optional), `SESSION_SECRET`, `HUB_ADMIN_PASSWORD`, `ADMIN_PASSWORD`, `LETSENCRYPT_EMAIL`.
- Deploy. No extra env files are needed because compose now reads vars directly.
