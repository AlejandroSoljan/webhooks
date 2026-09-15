#!/bin/bash
set -euo pipefail
source_dir=/home/ubuntu/turnero-release-20260914
queue_previous=$(readlink -f /opt/asisto/turnero/current)
queue_release=/opt/asisto/turnero/releases/20260914-5
main_previous=$(readlink -f /opt/asisto/current)
main_release=/opt/asisto/releases/5cf94e5354a5-turnero-notifications
test "$queue_previous" = /opt/asisto/turnero/releases/20260914-4
test "$main_previous" = /opt/asisto/releases/5cf94e5354a5
test ! -e "$queue_release"
test ! -e "$main_release"

# Create complete rollback-ready releases before changing either service.
cp -a "$queue_previous" "$queue_release"
install -m 644 "$source_dir/queue_notifications.js" "$queue_release/queue_notifications.js"
install -m 644 "$source_dir/customer_notifications.js" "$queue_release/customer_notifications.js"
node --check "$queue_release/queue_notifications.js"
node --check "$queue_release/customer_notifications.js"

cp -a "$main_previous" "$main_release"
install -m 644 "$source_dir/customer_notifications.js" "$main_release/customer_notifications.js"
install -m 644 "$source_dir/auth_ui.js" "$main_release/auth_ui.js"
node --check "$main_release/customer_notifications.js"
node --check "$main_release/auth_ui.js"

rollback() {
    ln -s "$main_previous" /opt/asisto/main-rollback
    mv -Tf /opt/asisto/main-rollback /opt/asisto/current
    systemctl restart asisto-production
    ln -s "$queue_previous" /opt/asisto/turnero/rollback
    mv -Tf /opt/asisto/turnero/rollback /opt/asisto/turnero/current
    systemctl restart asisto-turnero
}
trap rollback ERR

ln -s "$main_release" /opt/asisto/main-next
mv -Tf /opt/asisto/main-next /opt/asisto/current
systemctl restart asisto-production
for attempt in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null; then break; fi
    sleep 1
done
curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null

ln -s "$queue_release" /opt/asisto/turnero/next
mv -Tf /opt/asisto/turnero/next /opt/asisto/turnero/current
systemctl restart asisto-turnero
for attempt in $(seq 1 20); do
    if curl --fail --silent http://127.0.0.1:3102/healthz >/dev/null; then break; fi
    sleep 1
done
curl --fail --silent http://127.0.0.1:3102/healthz >/dev/null
systemctl is-active asisto-production asisto-turnero
trap - ERR
