#!/bin/bash
# Asisto | Actualización QR + comandera + marca Mecan | 2026-09-14
set -euo pipefail
source_dir=/home/ubuntu/turnero-release-20260914
release_dir=/opt/asisto/turnero/releases/20260914-2
previous=$(readlink -f /opt/asisto/turnero/current)
test "$previous" = /opt/asisto/turnero/releases/20260914-1
test ! -e "$release_dir"
install -d -m 755 "$release_dir/static/turnero"
for file in auth_ui.js db.js web_access_stats.js customer_notifications.js turnero_server.js; do
  install -m 644 "$previous/$file" "$release_dir/$file"
done
for file in customer_app_web.js customer_queue.js queue_pages.js queue_kiosk.js queue_mobile.js queue_branding.js; do
  install -m 644 "$source_dir/$file" "$release_dir/$file"
  node --check "$release_dir/$file"
done
install -m 644 "$source_dir/mecan-logo.webp" "$release_dir/static/turnero/mecan-logo.webp"
install -m 644 "$source_dir/asisto-logo.png" "$release_dir/static/turnero/asisto-logo.png"
install -m 644 "$source_dir/Asisto-1.1.6.apk" "$release_dir/Asisto-1.1.6.apk"
ln -s "$(readlink -f "$previous/node_modules")" "$release_dir/node_modules"
ln -s "$release_dir" /opt/asisto/turnero/next
mv -Tf /opt/asisto/turnero/next /opt/asisto/turnero/current
systemctl restart asisto-turnero
for attempt in $(seq 1 20); do
  if curl --fail --silent http://127.0.0.1:3102/healthz >/dev/null; then break; fi
  sleep 1
done
if ! curl --fail --silent http://127.0.0.1:3102/healthz; then
  ln -s "$previous" /opt/asisto/turnero/rollback
  mv -Tf /opt/asisto/turnero/rollback /opt/asisto/turnero/current
  systemctl restart asisto-turnero
  exit 1
fi
curl --fail --silent http://127.0.0.1:3102/customer-app/assets/mecan-logo.webp >/dev/null
systemctl is-active asisto-turnero asisto-production
