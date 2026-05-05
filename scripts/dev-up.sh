#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    echo "[dev-up] Created .env from .env.example. Update secrets if needed."
  else
    echo "[dev-up] Missing .env and .env.example. Aborting."
    exit 1
  fi
fi

docker compose --env-file .env up -d --build
docker compose --env-file .env ps
