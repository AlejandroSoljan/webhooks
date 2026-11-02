#!/usr/bin/env bash
set -Eeuo pipefail
base="$1"; service="$2"; port="$3"; source="$4"
case "$base:$service:$port" in
 /opt/asisto:asisto-production:3000|/opt/asisto/turnero:asisto-turnero:3102|/opt/asisto/turnero-local:asisto-turnero-local:3102) ;;
 *) exit 2;;
esac
previous=$(readlink -f "$base/current")
[[ "$previous" == "$base/releases/"* && -f "$previous/customer_notifications.js" ]]
release="$base/releases/v5.00.331-product-report-20261102"
test ! -e "$release"
cp -al "$previous" "$release"
node "$source/patch-product-report.cjs" "$release" "$source"
node --check "$release/product_insights.js"
node --check "$release/product_insights_panel.js"
printf '%s\n' "$previous" > "$release/NOTIFICATION_DEVICES_PREVIOUS.txt"
rollback(){ ln -s "$previous" "$base/restore-devices-$$"; mv -Tf "$base/restore-devices-$$" "$base/current"; systemctl restart "$service"; }
trap rollback ERR
ln -s "$release" "$base/next-devices-$$"; mv -Tf "$base/next-devices-$$" "$base/current"
systemctl restart "$service"
for attempt in $(seq 1 30); do if curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null; then break; fi; sleep 1; done
curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz"
systemctl is-active "$service"
trap - ERR
printf '\nACTIVE=%s\n' "$release"
