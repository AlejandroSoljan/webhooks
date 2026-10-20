#!/usr/bin/env bash
# Asisto | Dedicated-node catalog package, no queue or auth changes | 2026-10-20
set -euo pipefail
case "${1:-}" in
 aws) base=/opt/asisto/turnero; service=asisto-turnero ;;
 mecan) base=/opt/asisto/turnero-local; service=asisto-turnero-local ;;
 *) exit 2 ;;
esac
commit="${2:?commit required}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
previous=$(readlink -f "$base/current")
release="$base/releases/v5.00.270-catalog-sql-20261020"
test -d "$previous"
test ! -e "$release"
cp -a --reflink=auto "$previous" "$release"
tar -xzf /tmp/mcn-catalog-sql-20261020.tar.gz -C "$release"
cd "$release"
sha256sum -c CATALOG_SHA256SUMS
node --check manager_sql_catalog.js
node --check qr_product_web.js
# Preserve all installed turnero, daily-expiry, scanner and access-control fixes.
cmp "$previous/turnero_server.js" "$release/turnero_server.js"
cmp "$previous/customer_app_web.js" "$release/customer_app_web.js"
cmp "$previous/qr_local_scanner.js" "$release/qr_local_scanner.js"
rollback(){ ln -s "$previous" "$base/rollback-catalog-20261020"; mv -Tf "$base/rollback-catalog-20261020" "$base/current"; systemctl restart "$service"; }
trap rollback ERR
ln -s "$release" "$base/next-catalog-20261020"
mv -Tf "$base/next-catalog-20261020" "$base/current"
systemctl restart "$service"
healthy=false
for attempt in {1..30}; do
 if curl -fsS http://127.0.0.1:3102/healthz | grep -q '"ok":true'; then healthy=true; break; fi
 sleep 1
done
"$healthy"
trap - ERR
echo "ACTIVE $(readlink -f "$base/current") commit=$commit"
