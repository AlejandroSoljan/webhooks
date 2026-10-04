#!/usr/bin/env bash
# Asisto | Dual MCN deployment v5.00.266-day-expiry-20261004 | 2026-10-04
set -euo pipefail
case "${1:-}" in
  aws) base=/opt/asisto/turnero; service=asisto-turnero ;;
  mecan) base=/opt/asisto/turnero-local; service=asisto-turnero-local ;;
  *) exit 2 ;;
esac
release="$base/releases/v5.00.266-day-expiry-20261004"
previous="$base/releases/v5.00.266"
commit=053e435e47e5adc23961c27ff63b76e1f49006a0
files=(queue_expiration.js customer_queue.js customer_app_web.js queue_cloud_sync.js turnero_server.js HISTORIAL_CAMBIOS_BACKEND.txt)
verify() {
  cd "$release"
  sha256sum -c <<'HASHES'
ef708e421a7299c74cfd5b3a939c2b9a0a2778a5ec527022250b52ea4d7f7cb4  queue_expiration.js
90d23d6cb0af0992686804f332202d1f210d52238acd0ac9147ac8a42cb2ab7c  customer_queue.js
242ad34c171d1fc72e3d6d6f65d34a90716ad5e5268ade52f28e988308ddaa2d  customer_app_web.js
ce930e4b7781cbd126e7c74fbc3a3be8720fb149615b490624f77ddce1ccc734  queue_cloud_sync.js
938324a201b566ec7e4a0a68b34ed25cdc98cc200fbfa775ae64b57e3b5ef948  turnero_server.js
1572559b0d01411d043cccc8d44dd179e1555576dbfc99ea8210321845a5e17b  HISTORIAL_CAMBIOS_BACKEND.txt
HASHES
  for file in "${files[@]}"; do
    if [[ "$file" == *.js ]]; then node --check "$file"; fi
  done
  node -e 'const vm=require("vm"),p=require("./queue_pages"); for(const mode of ["admin","display","kiosk"]){const html=p.queuePage("MCN",mode);for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(m[1])} console.log("PAGE_SCRIPTS_OK")'
}
case "${2:-}" in
  prepare)
    test "$(readlink -f "$base/current")" = "$previous"
    test ! -e "$release"
    cp -a "$previous" "$release"
    for file in "${files[@]}"; do
      curl --fail --silent --show-error --retry 2 "https://raw.githubusercontent.com/AlejandroSoljan/webhooks/$commit/$file" -o "$release/$file"
      chmod 644 "$release/$file"
    done
    verify
    echo "PREPARED $release $commit"
    ;;
  activate)
    test "$(readlink -f "$base/current")" = "$previous"
    test ! -e "$base/next-day-expiry-20261004"
    verify
    rollback() {
      ln -s "$previous" "$base/rollback-day-expiry-20261004"
      mv -Tf "$base/rollback-day-expiry-20261004" "$base/current"
      systemctl restart "$service"
      echo "ROLLED_BACK $previous" >&2
    }
    trap rollback ERR
    ln -s "$release" "$base/next-day-expiry-20261004"
    mv -Tf "$base/next-day-expiry-20261004" "$base/current"
    systemctl restart "$service"
    healthy=false
    for attempt in {1..20}; do
      if systemctl is-active --quiet "$service" && curl -fsS http://127.0.0.1:3102/healthz | grep -q '"ok":true'; then healthy=true; break; fi
      sleep 1
    done
    "$healthy"
    trap - ERR
    echo "ACTIVE $(readlink -f "$base/current") $commit"
    systemctl is-active "$service"
    curl -fsS http://127.0.0.1:3102/healthz
    ;;
  *) exit 2 ;;
esac
