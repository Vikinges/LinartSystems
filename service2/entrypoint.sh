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
fix_dir /app/sign
fix_dir /app/sign/inbox

# Seed admin credentials from env if provided (overwrites existing admin.json).
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  su-exec node node - <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const adminPath = path.join('/app/data', 'admin.json');
const password = process.env.ADMIN_PASSWORD;
const username = process.env.ADMIN_USERNAME || 'admin';

function generateSalt(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

function hashPassword(pw, salt) {
  return crypto.createHash('sha256').update(String(pw || '') + salt).digest('hex');
}

const salt = generateSalt();
const record = {
  username,
  passwordHash: hashPassword(password, salt),
  salt,
  updatedAt: new Date().toISOString(),
};

fs.mkdirSync(path.dirname(adminPath), { recursive: true });
fs.writeFileSync(adminPath, JSON.stringify(record, null, 2), 'utf8');
console.log('[entrypoint] service2 admin credentials written from env variables.');
NODE
fi

exec su-exec node "$@"
