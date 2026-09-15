#!/bin/bash
set -euo pipefail
source_dir=/home/ubuntu/turnero-release-20260914
release_dir=/opt/asisto/turnero/releases/20260914-3
previous=$(readlink -f /opt/asisto/turnero/current)
test "$previous" = /opt/asisto/turnero/releases/20260914-2
test ! -e "$release_dir"
install -d -m 755 "$release_dir/static/turnero"
for file in auth_ui.js db.js web_access_stats.js; do
    install -m 644 "$previous/$file" "$release_dir/$file"
done
for file in customer_app_web.js customer_queue.js customer_notifications.js queue_pages.js queue_kiosk.js queue_mobile.js queue_branding.js queue_stats.js queue_notifications.js turnero_server.js; do
    install -m 644 "$source_dir/$file" "$release_dir/$file"
    node --check "$release_dir/$file"
done
for file in mecan-logo.webp asisto-logo.png; do
    install -m 644 "$previous/static/turnero/$file" "$release_dir/static/turnero/$file"
done
install -m 644 "$source_dir/assetlinks.json" "$release_dir/static/turnero/assetlinks.json"
install -m 644 "$source_dir/Asisto-1.1.7.apk" "$release_dir/Asisto-1.1.7.apk"
ln -s "$(readlink -f "$previous/node_modules")" "$release_dir/node_modules"
cp -p /etc/nginx/snippets/asisto-turnero.conf "$release_dir/nginx-before.conf"
install -m 600 /etc/asisto/turnero.env /etc/asisto/turnero-before-v3.env
rollback() {
    install -m 644 "$release_dir/nginx-before.conf" /etc/nginx/snippets/asisto-turnero.conf
    install -m 600 /etc/asisto/turnero-before-v3.env /etc/asisto/turnero.env
    ln -s "$previous" /opt/asisto/turnero/rollback
    mv -Tf /opt/asisto/turnero/rollback /opt/asisto/turnero/current
    systemctl restart asisto-turnero
    nginx -t && systemctl reload nginx
}
trap rollback ERR
sed -i '/^QUEUE_OPEN_TENANTS=/d' /etc/asisto/turnero.env
printf '\nQUEUE_OPEN_TENANTS=DEMO_FERRETERIA\n' >> /etc/asisto/turnero.env
install -m 644 "$source_dir/nginx-turnero.conf" /etc/nginx/snippets/asisto-turnero.conf
nginx -t
ln -s "$release_dir" /opt/asisto/turnero/next
mv -Tf /opt/asisto/turnero/next /opt/asisto/turnero/current
systemctl restart asisto-turnero
for attempt in $(seq 1 20); do
    if curl --fail --silent http://127.0.0.1:3102/healthz >/dev/null; then break; fi
    sleep 1
done
curl --fail --silent http://127.0.0.1:3102/healthz
curl --fail --silent http://127.0.0.1:3102/.well-known/assetlinks.json >/dev/null
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3102/customer-app/DEMO_FERRETERIA/kiosk)" = 200
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3102/ui/turnero/DEMO_FERRETERIA)" = 200
systemctl reload nginx
systemctl is-active asisto-turnero asisto-production
trap - ERR
