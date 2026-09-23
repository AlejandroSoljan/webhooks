#!/bin/sh
# Asisto | Display MCN en Linux con sonido automático | 2026-09-23
set -eu

DISPLAY_URL="${1:-http://172.25.168.99/customer-app/MCN/display}"
BROWSER="$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"

if [ -z "$BROWSER" ]; then
  echo "No se encontró Chromium o Google Chrome." >&2
  exit 1
fi

exec "$BROWSER" \
  --kiosk \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-infobars \
  "$DISPLAY_URL"
