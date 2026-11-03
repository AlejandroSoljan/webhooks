#!/usr/bin/env bash
set -euo pipefail
# Run as root with source archive and configuration directory, on the approved host.
archive="$1"; config="$2"
release=/opt/asisto-staging/releases/79852e6
test ! -e "$release"
id asisto-staging >/dev/null 2>&1 || useradd --system --home-dir /var/lib/asisto-staging --shell /usr/sbin/nologin asisto-staging
install -d -m 755 /opt/asisto-staging/releases "$release"
install -d -o asisto-staging -g asisto-staging -m 700 /var/lib/asisto-staging/mongo /var/lib/asisto-staging/app
tar -xf "$archive" -C "$release"
cd "$release"
NODE_OPTIONS=--max-old-space-size=384 npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/var/log/asisto-staging-install.log 2>&1
ln -s "$release" /opt/asisto-staging/current
install -m 644 "$config/server.cjs" /opt/asisto-staging/server.cjs
install -m 644 "$config/asisto-staging.service" /etc/systemd/system/asisto-staging.service
install -m 644 "$config/asisto-staging-mongo.service" /etc/systemd/system/asisto-staging-mongo.service
umask 077
python3 - <<'PY'
import secrets
from pathlib import Path
p=Path('/etc/asisto-staging.env')
if p.exists(): raise RuntimeError('Refusing to overwrite environment')
p.write_text('NODE_ENV=development\nASISTO_ENVIRONMENT=staging\nASISTO_STAGING_RELEASE=/opt/asisto-staging/current\nMONGODB_URI=mongodb://127.0.0.1:27018/asisto_staging\nMONGODB_DBNAME=asisto_staging\nMONGODB_MAX_POOL_SIZE=5\nENABLE_TELEGRAM=false\nAUTH_COOKIE_NAME=asisto_staging_sess\nAUTH_COOKIE_SECRET='+secrets.token_hex(48)+'\n')
PY
systemctl daemon-reload
systemctl start asisto-staging-mongo
systemctl reset-failed asisto-staging
systemctl start asisto-staging
install -m 644 "$config/nginx.conf" /etc/nginx/conf.d/asisto-staging.conf
nginx -t
systemctl reload nginx
for attempt in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:3101/healthz; then exit 0; fi
  sleep 1
done
exit 1
