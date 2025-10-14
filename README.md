Linart Systems — Central Hub + Demo Services

What I added
- A small central "hub" web app in `hub/` that serves a static main page and proxies/redirects to demo services
- Two demo microservices in `service1/` and `service2/`
- `docker-compose.yml` to build and run all three containers

Run locally (requires Docker & Docker Compose):

1. From the repository root run:

```powershell
docker compose up --build
```

2. Open http://localhost:8080 in your browser. Click the service tiles to open each service.

Notes
- The hub runs on port 8080 and redirects /service/1 to http://service1:3000 inside the compose network.
- The docker-compose maps host ports for convenience.
- You can also proxy paths /s1 and /s2 through the hub (e.g. http://localhost:8080/s1/).
