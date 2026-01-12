#!/bin/sh
set -e

APP_USER=node
APP_GROUP=node
DATA_DIR="${HUB_DATA_DIR:-/app/data}"
UPLOAD_DIR="/app/static/uploads"

mkdir -p "$DATA_DIR" "$UPLOAD_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R "$APP_USER:$APP_GROUP" "$DATA_DIR" "$UPLOAD_DIR" || true
  exec su-exec "$APP_USER:$APP_GROUP" "$@"
fi

exec "$@"
