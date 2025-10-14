#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_PATH="${TEMPLATE_PATH:-/mnt/data/SNDS-LED-Preventative-Maintenance-Checklist BER Blanko.pdf}"

if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "[test-start] Template PDF not found at $TEMPLATE_PATH" >&2
  exit 1
fi

echo "[test-start] Running field extraction..."
npm run extract-fields

if [ ! -f "$ROOT_DIR/fields.json" ]; then
  echo "[test-start] fields.json was not created" >&2
  exit 1
fi

echo "[test-start] Launching server in background..."
node server.js > "$ROOT_DIR/test-server.log" 2>&1 &
SERVER_PID=$!

cleanup() {
  if ps -p $SERVER_PID > /dev/null 2>&1; then
    kill $SERVER_PID >/dev/null 2>&1 || true
    wait $SERVER_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

sleep 2

echo "[test-start] Server PID $SERVER_PID is running. Logs -> $ROOT_DIR/test-server.log"

if [ -n "${TEST_PHOTO1:-}" ] && [ -n "${TEST_PHOTO2:-}" ] && [ -f "$TEST_PHOTO1" ] && [ -f "$TEST_PHOTO2" ]; then
  echo "[test-start] Executing automated curl with TEST_PHOTO1/TEST_PHOTO2..."
  curl -fsS "http://localhost:3000/submit" \
    -F "end_customer_name=ACME" \
    -F "site_location=Berlin" \
    -F "date_of_service=2025-09-30" \
    -F "check10=on" \
    -F "submitter_name=Ivan" \
    -F "photos[]=@$TEST_PHOTO1" \
    -F "photos[]=@$TEST_PHOTO2" || true
else
  cat <<'EOF'
[test-start] Manual curl example (run this in a separate shell):
curl -X POST "http://localhost:3000/submit" \
  -F "end_customer_name=ACME" \
  -F "site_location=Berlin" \
  -F "date_of_service=2025-09-30" \
  -F "check10=on" \
  -F "submitter_name=Ivan" \
  -F "photos[]=@/path/photo1.jpg" \
  -F "photos[]=@/path/photo2.jpg"
EOF
fi

if [ -t 0 ]; then
  read -r -p "[test-start] Press enter to stop the server..." _
else
  sleep 3
fi

cleanup
