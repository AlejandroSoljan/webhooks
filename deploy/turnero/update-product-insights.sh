#!/usr/bin/env bash
# Asisto | Product insights dedicated services | 2026-10-21
set -euo pipefail
case "${1:-}" in
 aws) base=/opt/asisto/turnero; service=asisto-turnero ;;
 mecan) base=/opt/asisto/turnero-local; service=asisto-turnero-local ;;
 *) exit 2 ;;
esac
commit="${2:?commit required}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
previous=$(readlink -f "$base/current")
release="$base/releases/v5.00.271-product-insights-${commit:0:12}"
test ! -e "$release"
cp -a --reflink=auto "$previous" "$release"
tar -xzf /tmp/mcn-product-insights-20261021.tar.gz -C "$release"
cd "$release"
sha256sum -c PRODUCT_INSIGHTS_SHA256SUMS
node deploy/turnero/patch-product-insights.cjs "$release"
for file in product_insights.js product_insights_panel.js product_insights_routes.js queue_stats.js queue_stats_page.js queue_cloud_sync.js; do node --check "$file"; done
for file in customer_queue.js customer_app_web.js turnero_server.js queue_pages.js; do cmp "$previous/$file" "$release/$file"; done
rollback(){ ln -s "$previous" "$base/rollback-product-insights-20261021"; mv -Tf "$base/rollback-product-insights-20261021" "$base/current"; systemctl restart "$service"; }
trap rollback ERR
ln -s "$release" "$base/next-product-insights-20261021"
mv -Tf "$base/next-product-insights-20261021" "$base/current"
systemctl restart "$service"
healthy=false
for attempt in {1..30}; do
 if curl -fsS http://127.0.0.1:3102/healthz | grep -q '"ok":true'; then healthy=true; break; fi
 sleep 1
done
"$healthy"
trap - ERR
echo "ACTIVE $(readlink -f "$base/current") commit=$commit"
