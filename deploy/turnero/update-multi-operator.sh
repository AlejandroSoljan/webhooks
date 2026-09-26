#!/usr/bin/env bash
# Asisto | Dual MCN deployment v5.00.257 | 2026-09-26
set -euo pipefail
case "${1:-}" in
  aws) base=/opt/asisto/turnero; service=asisto-turnero ;;
  mecan) base=/opt/asisto/turnero-local; service=asisto-turnero-local ;;
  *) exit 2 ;;
esac
release="$base/releases/v5.00.257"
previous="$base/releases/v5.00.256"
commit=320acf7cffe14fe9034c5bfd5fda8d7b37358e1a
files=(queue_pages.js queue_multi_operator.js HISTORIAL_CAMBIOS_BACKEND.txt)
verify() {
  cd "$release"
  sha256sum -c <<'HASHES'
9eeb15b46302df8c1cc2b6687bb41abdb2290342041e954c0198876e4725d5e9  queue_pages.js
629ec52e7d992566bfaa5d7402233bc210c87c4aee8929cf84e0e3c8008c8680  queue_multi_operator.js
cd9015f4ccafa5478adb436b48de493f9c4746cdb7b9155086ab7f4e0f56e840  HISTORIAL_CAMBIOS_BACKEND.txt
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
    test ! -e "$base/next-v500257"
    verify
    rollback() {
      ln -s "$previous" "$base/rollback-v500257"
      mv -Tf "$base/rollback-v500257" "$base/current"
      systemctl restart "$service"
      echo "ROLLED_BACK $previous" >&2
    }
    trap rollback ERR
    ln -s "$release" "$base/next-v500257"
    mv -Tf "$base/next-v500257" "$base/current"
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
