#!/usr/bin/env bash
# Быстрая диагностика доступности сервисов и сертификатов.
# Запускать из корня проекта: ./scripts/site-doctor.sh

set -u

timestamp() { date '+%F %T'; }
info() { echo "[$(timestamp)] $*"; }
warn() { echo "[$(timestamp)] WARN: $*" >&2; }
error() { echo "[$(timestamp)] ERROR: $*" >&2; }

# Определяем docker compose
if command -v docker &>/dev/null && docker compose version &>/dev/null; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
else
  error "Не найден docker compose. Установите Docker/Compose."
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

info "Рабочая директория: $ROOT_DIR"
info "Проверяю состояние контейнеров..."
$COMPOSE_CMD ps

running_services=$($COMPOSE_CMD ps --status running --services 2>/dev/null || true)

if [[ "$running_services" != *"reverse-proxy"* ]]; then
  warn "reverse-proxy (Traefik) не запущен. Команда: $COMPOSE_CMD up -d reverse-proxy"
fi
if [[ "$running_services" != *"hub"* ]]; then
  warn "hub не запущен. Команда: $COMPOSE_CMD up -d hub"
fi
if [[ "$running_services" != *"service1"* ]]; then
  warn "service1 не запущен. Команда: $COMPOSE_CMD up -d service1"
fi

has_curl=1
if ! command -v curl &>/dev/null; then
  warn "curl не установлен. Установите: apt install -y curl"
  has_curl=0
fi

check_http() {
  local url="$1"
  local label="$2"
  if [[ $has_curl -eq 0 ]]; then
    warn "Пропускаю проверку $label (нет curl)"
    return
  fi
  info "HTTP проверка ($label): $url"
  if curl -fsS "$url" >/dev/null; then
    info "$label OK"
  else
    warn "$label не отвечает или вернул ошибку."
  fi
}

# Проверяем доступ к сервисам из хоста
check_http "http://localhost:8080/service1/health" "hub -> service1 (локально)"
check_http "http://localhost:8080/" "hub root (локально)"

if [[ $has_curl -eq 1 ]]; then
  info "Проверяю HTTPS до публичного домена..."
  if curl -vk --max-time 10 "https://linart.club/" >/dev/null 2>&1; then
    info "HTTPS linart.club отвечает."
  else
    warn "HTTPS linart.club не отвечает или self-signed. Проверьте Traefik и сертификат."
  fi
fi

if command -v openssl &>/dev/null; then
  info "Информация о сертификате linart.club:"
  # Показываем даты и subject; ошибки скрываем, чтобы не падать.
  openssl s_client -servername linart.club -connect linart.club:443 </dev/null 2>/dev/null \
    | openssl x509 -noout -dates -subject || warn "Не удалось получить сертификат (Traefik не слушает 443?)."
else
  warn "openssl не установлен, пропускаю проверку сертификата."
fi

# Подсказка по повторному запуску
info "Если есть проблемы со статусом контейнеров: $COMPOSE_CMD up -d reverse-proxy hub service1 service2"
info "Если Traefik не получает сертификат: остановить reverse-proxy, очистить traefik/letsencrypt/acme.json (пустой файл 600), запустить reverse-proxy заново и проверить логи."
info "Готово."
