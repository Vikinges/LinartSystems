# Site Doctor — кратко

Файл: `scripts/site-doctor.sh`

Запускать из корня репо:
```bash
cd /home/LinartSystems
chmod +x scripts/site-doctor.sh    # при первом запуске
./scripts/site-doctor.sh
```

Что делает:
- показывает состояние контейнеров (`docker compose ps`);
- предупреждает, если не запущены `reverse-proxy`, `hub`, `service1`;
- проверяет доступность hub и service1 локально (через `curl`), если curl установлен;
- проверяет HTTPS `linart.club` и кратко выводит информацию о сертификате (через openssl, если есть).

Типовые действия при проблемах:
- контейнеры не запущены: `docker compose up -d reverse-proxy hub service1 service2`;
- проблемы с Docker Hub/DNS: в `/etc/gai.conf` оставить `precedence ::ffff:0:0/96  100`; в `/etc/docker/daemon.json` DNS `["1.1.1.1","8.8.8.8"]`; `systemctl restart docker`;
- Traefik/сертификат не выдаётся: остановить `reverse-proxy`, очистить `traefik/letsencrypt/acme.json` (пустой файл 600), запустить `reverse-proxy`, проверить логи.
