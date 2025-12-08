#!/bin/sh
set -e

fix_dir() {
  dir="$1"
  mkdir -p "$dir"
  # Best-effort ownership/permissions; ignore failures on exotic filesystems.
  chown -R node:node "$dir" 2>/dev/null || true
  chmod -R u+rwX,g+rwX "$dir" 2>/dev/null || true
}

fix_dir /app/out
fix_dir /app/data
fix_dir /app/public/templates

exec su-exec node "$@"
