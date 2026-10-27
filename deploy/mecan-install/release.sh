#!/usr/bin/env bash
# Asisto | Release reversible del modal Mecan | 2026-10-27
set -euo pipefail
base=${1:?Falta base de releases}
service=${2:?Falta servicio}
source_dir=$(cd "$(dirname "$0")" && pwd)
case "$base:$service" in
  /opt/asisto/turnero:asisto-turnero|/opt/asisto/turnero-local:asisto-turnero-local) ;;
  *) printf 'Destino no permitido\n' >&2; exit 1 ;;
esac
previous=$(readlink -f "$base/current")
test -d "$previous"
case "$previous" in "$base"/releases/*) ;; *) exit 1 ;; esac
release="$base/releases/v5.00.313-mecan-install-20261027"
test ! -e "$release"
cp -a "$previous" "$release"
install -m 644 "$source_dir/queue_install.js" "$release/queue_install.js"
node "$source_dir/patch-runtime.cjs" "$release"
install -m 644 "$source_dir/assetlinks.json" "$release/static/turnero/assetlinks.json"
for file in queue_install.js queue_mobile.js customer_app_web.js customer_queue.js; do node --check "$release/$file"; done
node -e 'const f=require("fs"),p=process.argv[1];const a=JSON.parse(f.readFileSync(p));if(!a.some(x=>x.target.package_name==="ar.com.asisto.mecan"))process.exit(1)' "$release/static/turnero/assetlinks.json"
printf '%s\n' "$previous" > "$release/INSTALL_PREVIOUS_RELEASE.txt"
rollback() {
  ln -s "$previous" "$base/rollback-install-$$"
  mv -Tf "$base/rollback-install-$$" "$base/current"
  systemctl restart "$service"
}
trap rollback ERR
ln -s "$release" "$base/next-install-$$"
mv -Tf "$base/next-install-$$" "$base/current"
systemctl restart "$service"
healthy=0
for attempt in $(seq 1 25); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3102/healthz >/dev/null; then healthy=1; break; fi
  sleep 1
done
test "$healthy" = 1
systemctl is-active --quiet "$service"
trap - ERR
printf 'ACTIVE_RELEASE=%s\nPREVIOUS_RELEASE=%s\n' "$release" "$previous"
