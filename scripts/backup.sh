#!/bin/bash
# Backup VPS data to local server via WireGuard (10.0.0.2)
set -euo pipefail

COMPOSE_DIR="/var/lib/docker/volumes/portainer_data/_data/compose/1"
REMOTE_USER="root"
REMOTE_HOST="10.0.0.2"
REMOTE_DIR="/backup/vps-pdf"
LOG="/var/log/backup-vps.log"

DATE=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$DATE] Backup started" | tee -a "$LOG"

# Create remote backup dir if needed
ssh "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $REMOTE_DIR"

# Sync bind-mounted directories
rsync -az --delete \
  "$COMPOSE_DIR/service2/data/" \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/service2-data/" \
  && echo "[OK] service2/data" | tee -a "$LOG"

rsync -az --delete \
  "$COMPOSE_DIR/service2/out/" \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/service2-out/" \
  && echo "[OK] service2/out" | tee -a "$LOG"

rsync -az \
  "$COMPOSE_DIR/traefik/letsencrypt/" \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/traefik-letsencrypt/" \
  && echo "[OK] traefik/letsencrypt" | tee -a "$LOG"

# Sync Docker named volumes
for VOL in pdf_hub-data pdf_hub-uploads pdf_sign-data; do
  VOL_PATH="/var/lib/docker/volumes/$VOL/_data"
  if [ -d "$VOL_PATH" ]; then
    rsync -az --delete \
      "$VOL_PATH/" \
      "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/$VOL/" \
      && echo "[OK] volume: $VOL" | tee -a "$LOG"
  else
    echo "[SKIP] volume not found: $VOL" | tee -a "$LOG"
  fi
done

DATE=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$DATE] Backup finished" | tee -a "$LOG"
