#!/usr/bin/env bash
# Asisto | Release reversible de enlaces comerciales | 2026-10-27
set -euo pipefail
base=${1:?Falta base}
service=${2:?Falta servicio}
port=${3:?Falta puerto}
case "$base:$service:$port" in
  /opt/asisto:asisto-production:3000|/opt/asisto/turnero:asisto-turnero:3102|/opt/asisto/turnero-local:asisto-turnero-local:3102) ;;
  *) exit 1 ;;
esac
previous=$(readlink -f "$base/current")
case "$previous" in "$base"/releases/*) ;; *) exit 1 ;; esac
release="$previous-brand-asisto-20261027"
test ! -e "$release"
cp -a "$previous" "$release"
node "$(dirname "$0")/patch-branding.cjs" "$release"
for file in queue_branding.js queue_printer.js qr_product_web.js restaurant_public_page.js static/restaurant_operations.js transfer_receipt.js; do
  if test -f "$release/$file"; then node --check "$release/$file"; fi
done
printf '%s\n' "$previous" > "$release/BRANDING_PREVIOUS_RELEASE.txt"
rollback() {
  ln -s "$previous" "$base/brand-rollback-$$"
  mv -Tf "$base/brand-rollback-$$" "$base/current"
  systemctl restart "$service"
}
trap rollback ERR
ln -s "$release" "$base/brand-next-$$"
mv -Tf "$base/brand-next-$$" "$base/current"
systemctl restart "$service"
healthy=0
for attempt in $(seq 1 25); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null; then healthy=1; break; fi
  sleep 1
done
test "$healthy" = 1
systemctl is-active --quiet "$service"
trap - ERR
printf 'ACTIVE=%s\nPREVIOUS=%s\n' "$release" "$previous"
