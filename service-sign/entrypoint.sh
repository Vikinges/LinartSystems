#!/bin/sh
set -e

fix_dir() {
  dir="$1"
  mkdir -p "$dir"
  chown -R node:node "$dir" 2>/dev/null || true
  chmod -R u+rwX,g+rwX "$dir" 2>/dev/null || true
}

fix_dir /app/sign
fix_dir /app/sign/inbox
fix_dir /app/sign/signed

exec su-exec node "$@"
