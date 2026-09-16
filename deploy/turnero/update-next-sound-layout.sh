#!/bin/bash
set -euo pipefail
source_dir=/home/ubuntu/turnero-release-20260914
previous=$(readlink -f /opt/asisto/turnero/current)
release_dir=/opt/asisto/turnero/releases/20260916-9
test "$previous" = /opt/asisto/turnero/releases/20260914-8
test ! -e "$release_dir"
cp -a "$previous" "$release_dir"
for file in customer_queue.js queue_kiosk.js queue_pages.js; do
    install -m 644 "$source_dir/$file" "$release_dir/$file"
    node --check "$release_dir/$file"
done
rollback() {
    ln -s "$previous" /opt/asisto/turnero/rollback
    mv -Tf /opt/asisto/turnero/rollback /opt/asisto/turnero/current
    systemctl restart asisto-turnero
}
trap rollback ERR
ln -s "$release_dir" /opt/asisto/turnero/next
mv -Tf /opt/asisto/turnero/next /opt/asisto/turnero/current
systemctl restart asisto-turnero
for attempt in $(seq 1 20); do
    if curl --fail --silent http://127.0.0.1:3102/healthz >/dev/null; then break; fi
    sleep 1
done
curl --fail --silent http://127.0.0.1:3102/healthz >/dev/null
systemctl is-active asisto-turnero asisto-production
trap - ERR
