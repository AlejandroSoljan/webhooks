#!/usr/bin/env bash
# Asisto | Dual MCN deployment v5.00.266 | 2026-09-29
set -euo pipefail
case "${1:-}" in
  aws) base=/opt/asisto/turnero; service=asisto-turnero ;;
  mecan) base=/opt/asisto/turnero-local; service=asisto-turnero-local ;;
  *) exit 2 ;;
esac
release="$base/releases/v5.00.266"
previous="$base/releases/v5.00.258"
commit=3e1087b93ee3ed55f23a4a771d8705c845c35e10
files=(customer_queue.js queue_pages.js queue_dual_display.js HISTORIAL_CAMBIOS_BACKEND.txt)
verify() {
  cd "$release"
  sha256sum -c <<'HASHES'
e3c77c5679460b703b62aa7281a8fb561926b289ae953b8836b7c60a2c3b9f9d  customer_queue.js
02cdda6a27f083dc0329fcb552b551b8b44f74603f5a3d0a3e6eecac92313a43  queue_pages.js
f8f6b28d05c5c1f392ed2cd7e97a10fa0247c74560556ddd73c45b6f34dbb383  queue_dual_display.js
a500299ceed567ac3b63ef1e7babcccac9704822a32969d5464164b5310e974a  HISTORIAL_CAMBIOS_BACKEND.txt
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
    test ! -e "$base/next-v500266"
    verify
    rollback() {
      ln -s "$previous" "$base/rollback-v500266"
      mv -Tf "$base/rollback-v500266" "$base/current"
      systemctl restart "$service"
      echo "ROLLED_BACK $previous" >&2
    }
    trap rollback ERR
    ln -s "$release" "$base/next-v500266"
    mv -Tf "$base/next-v500266" "$base/current"
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
