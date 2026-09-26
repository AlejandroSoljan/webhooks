#!/usr/bin/env bash
# Asisto | Dual MCN deployment v5.00.256 | 2026-09-26
set -euo pipefail
case "${1:-}" in
  aws) base=/opt/asisto/turnero; service=asisto-turnero ;;
  mecan) base=/opt/asisto/turnero-local; service=asisto-turnero-local ;;
  *) exit 2 ;;
esac
release="$base/releases/v5.00.256"
previous="$base/releases/v5.00.255"
commit=8229487211b5731e2739dd77b7a878903fb6a553
files=(customer_queue.js queue_pages.js queue_multi_operator.js queue_operator_issue.js HISTORIAL_CAMBIOS_BACKEND.txt)
verify() {
  cd "$release"
  sha256sum -c <<'HASHES'
7776b036efbf99ead452695e15409da69807fdd57b971ec4ab82572420b0580f  customer_queue.js
bcba62d210e14d424a5791718503edfce7c2db793fa3690fc9e17ca11e1b0ea2  queue_pages.js
c0ae5fdb49651ab9a4acf134c700d09c3ca172385ad9d67b546ab1ee52ab31a9  queue_multi_operator.js
cba6e75dd6645ab6713c4dbbdfb5a87a05cc1ad03f5a3d7b70309bf018221c5f  queue_operator_issue.js
62cfd8c0b47686398096aaca542b959d200647a4f135356716ce4d92ceba9e87  HISTORIAL_CAMBIOS_BACKEND.txt
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
    test ! -e "$base/next-v500256"
    verify
    rollback() {
      ln -s "$previous" "$base/rollback-v500256"
      mv -Tf "$base/rollback-v500256" "$base/current"
      systemctl restart "$service"
      echo "ROLLED_BACK $previous" >&2
    }
    trap rollback ERR
    ln -s "$release" "$base/next-v500256"
    mv -Tf "$base/next-v500256" "$base/current"
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
