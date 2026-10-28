#!/usr/bin/env bash
# Asisto | Habilitar instalación y apertura Mecan | 2026-10-28
set -euo pipefail
base=${1:?}; service=${2:?}; port=${3:?}
case "$base:$service:$port" in
 /opt/asisto:asisto-production:3000) envfile=/etc/asisto/production.env ;;
 /opt/asisto/turnero:asisto-turnero:3102) envfile=/etc/asisto/turnero.env ;;
 /opt/asisto/turnero-local:asisto-turnero-local:3102) envfile=/etc/asisto/turnero-local.env ;;
 *) exit 1 ;;
esac
source_dir=$(cd "$(dirname "$0")" && pwd)
previous=$(readlink -f "$base/current")
case "$previous" in "$base"/releases/*) ;; *) exit 1 ;; esac
release="$base/releases/v5.00.315-mecan-app-opening-20261028"
test ! -e "$release"
cp -al "$previous" "$release"
if ! grep -q "require('./queue_install')" "$release/customer_app_web.js"; then
 # El backend principal aún no tenía el parche inicial; separar sus inodos.
 for file in customer_app_web.js queue_mobile.js customer_queue.js; do
   cp -p "$release/$file" "$release/$file.app-new"
   mv -f "$release/$file.app-new" "$release/$file"
 done
 node "$source_dir/patch-runtime.cjs" "$release"
fi
node "$source_dir/patch-app-opening.cjs" "$release"
install -m 644 "$source_dir/queue_install.js" "$release/queue_install.js.app-new"
mv -f "$release/queue_install.js.app-new" "$release/queue_install.js"
install -m 644 "$source_dir/ASISTO_VERSION.json" "$release/ASISTO_VERSION.json.app-new"
mv -f "$release/ASISTO_VERSION.json.app-new" "$release/ASISTO_VERSION.json"
node --check "$release/customer_app_web.js"
node --check "$release/queue_install.js"
envbackup="$envfile.before-mecan-app-20261028"
test ! -e "$envbackup"
cp -p "$envfile" "$envbackup"
rollback(){
 cp -p "$envbackup" "$envfile"
 ln -s "$previous" "$base/app-rollback-$$"
 mv -Tf "$base/app-rollback-$$" "$base/current"
 systemctl restart "$service"
}
trap rollback ERR
sed -i '/^MECAN_INSTALL_PROMPT_ENABLED=/d' "$envfile"
printf '\nMECAN_INSTALL_PROMPT_ENABLED=1\n' >> "$envfile"
printf '%s\n' "$previous" > "$release/APP_OPENING_PREVIOUS_RELEASE.txt"
ln -s "$release" "$base/app-next-$$"
mv -Tf "$base/app-next-$$" "$base/current"
systemctl restart "$service"
healthy=0
for attempt in $(seq 1 30); do
 if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null; then healthy=1; break; fi
 sleep 1
done
test "$healthy" = 1
curl --fail --silent "http://127.0.0.1:$port/customer-app/MCN" -o "$release/APP_OPENING_CHECK.html"
grep -q 'MECAN_INSTALL_PROMPT_ENABLED=true' "$release/APP_OPENING_CHECK.html"
grep -q 'function mecanTicketAppIntent' "$release/APP_OPENING_CHECK.html"
trap - ERR
printf 'ACTIVE=%s\nPREVIOUS=%s\n' "$release" "$previous"
