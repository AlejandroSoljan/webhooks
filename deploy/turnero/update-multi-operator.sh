#!/usr/bin/env bash
# Asisto | Dual MCN deployment v5.00.258 | 2026-09-26
set -euo pipefail
case "${1:-}" in
  aws) base=/opt/asisto/turnero; service=asisto-turnero ;;
  mecan) base=/opt/asisto/turnero-local; service=asisto-turnero-local ;;
  *) exit 2 ;;
esac
release="$base/releases/v5.00.258"
previous="$base/releases/v5.00.257"
commit=f7dfc2e24f88c64b3fb746a3c9e0a7691dbe5dcd
files=(queue_pages.js HISTORIAL_CAMBIOS_BACKEND.txt)
verify() {
  cd "$release"
  sha256sum -c <<'HASHES'
b2849b735859c4efe7f9f5e4e2902ff9949b6445e8c239dba959cb0caa8b1ab7  queue_pages.js
c2ac18d6c0bb54f8053d70e201f35e86dfa9cd490572caa4c96c45983a082087  HISTORIAL_CAMBIOS_BACKEND.txt
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
    test ! -e "$base/next-v500258"
    verify
    rollback() {
      ln -s "$previous" "$base/rollback-v500258"
      mv -Tf "$base/rollback-v500258" "$base/current"
      systemctl restart "$service"
      echo "ROLLED_BACK $previous" >&2
    }
    trap rollback ERR
    ln -s "$release" "$base/next-v500258"
    mv -Tf "$base/next-v500258" "$base/current"
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
