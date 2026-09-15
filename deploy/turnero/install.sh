#!/bin/bash
# Asisto | Turnero AWS | Fecha: 2026-09-14
set -euo pipefail
source_dir=/home/ubuntu/turnero-release-20260914
release_dir=/opt/asisto/turnero/releases/20260914-1
nginx_config=/etc/nginx/sites-available/asisto-production
test "$(id -u)" = 0
test ! -e "$release_dir"
test -r /etc/asisto/production.env
test "$(sha256sum /opt/asisto/current/customer_app_web.js | cut -d' ' -f1)" = f190fe88525ce441ff21e55e51827fbd2c5d60f06d589781ceac1115460dbafa
install -d -m 755 "$release_dir"
for file in auth_ui.js db.js web_access_stats.js customer_notifications.js; do
    install -m 644 "/opt/asisto/current/$file" "$release_dir/$file"
done
for file in customer_app_web.js customer_queue.js queue_pages.js turnero_server.js; do
    install -m 644 "$source_dir/$file" "$release_dir/$file"
    node --check "$release_dir/$file"
done
ln -s "$(readlink -f /opt/asisto/current)/node_modules" "$release_dir/node_modules"
ln -s "$release_dir" /opt/asisto/turnero/current
if [ ! -e /etc/asisto/turnero.env ]; then
    umask 077
    node -e "require('fs').writeFileSync('/etc/asisto/turnero.env','QUEUE_PRESENCE_SECRET='+require('crypto').randomBytes(32).toString('hex')+'\n')"
fi
install -m 644 "$source_dir/asisto-turnero.service" /etc/systemd/system/asisto-turnero.service
systemctl daemon-reload
systemctl start asisto-turnero.service
for attempt in $(seq 1 20); do
    if curl --fail --silent http://127.0.0.1:3102/healthz >/dev/null; then break; fi
    sleep 1
done
curl --fail --silent http://127.0.0.1:3102/healthz
curl --fail --silent http://127.0.0.1:3102/api/customer-app/DEMO_FERRETERIA/config >/dev/null
test "$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3102/api/customer-app-admin/DEMO_FERRETERIA/state)" = 401
cp -a "$nginx_config" "$nginx_config.before-turnero-20260914"
install -m 644 "$source_dir/nginx-turnero.conf" /etc/nginx/snippets/asisto-turnero.conf
python3 - <<'PY'
from pathlib import Path
p = Path('/etc/nginx/sites-available/asisto-production')
s = p.read_text()
anchor = '    client_max_body_size 20m;'
assert s.count(anchor) == 1
assert 'asisto-turnero.conf' not in s
p.write_text(s.replace(anchor, anchor + '\n    include /etc/nginx/snippets/asisto-turnero.conf;'))
PY
if ! nginx -t; then
    cp -a "$nginx_config.before-turnero-20260914" "$nginx_config"
    exit 1
fi
systemctl reload nginx
systemctl enable asisto-turnero.service
systemctl is-active asisto-turnero.service asisto-production.service nginx
