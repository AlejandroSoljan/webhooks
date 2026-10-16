#!/usr/bin/env bash
# Asisto | Local barcode scanner on main AWS and both queue servers | 2026-10-16
set -euo pipefail
case "${1:-}" in
 main) base=/opt/asisto; service=asisto-production; port=3000 ;;
 aws) base=/opt/asisto/turnero; service=asisto-turnero; port=3102 ;;
 mecan) base=/opt/asisto/turnero-local; service=asisto-turnero-local; port=3102 ;;
 *) exit 2 ;;
esac
commit="${3:?Commit required}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
if [[ "$1" == main ]]; then
 previous=/opt/asisto/releases/609b28e0d565-auto-cVHyywHi
 release="$base/releases/${commit:0:12}-local-scanner-20261016"
else
 previous="$base/releases/v5.00.268-access-20261016"
 release="$base/releases/v5.00.269-local-scanner-20261016"
fi
case "${2:-}" in
 prepare)
  test "$(readlink -f "$base/current")" = "$previous"
  test ! -e "$release"
  if [[ "$1" == main ]]; then
   echo '5ce3e2526a0c6e105f4d7f41f40d7dac7c58b4586a72d090fd9d08e7f39aad1b  /opt/asisto/current/qr_product_web.js' | sha256sum -c -
  fi
  cp -a --reflink=auto "$previous" "$release"
  if [[ "$1" == main ]]; then tar -xzf /tmp/mcn-local-scanner-20261016.tar.gz -C "$release";
  else tar -xzf /tmp/mcn-local-scanner-20261016.tar.gz --exclude=qr_product_web.js --exclude=ASISTO_VERSION.json --exclude=HISTORIAL_CAMBIOS_BACKEND.txt -C "$release"; fi
  cd "$release"
  sha256sum -c SCANNER_SHA256SUMS
  if [[ "$1" == main ]]; then sha256sum -c SCANNER_MAIN_SHA256SUMS; fi
  if [[ "$1" != main ]]; then node deploy/turnero/patch-local-scanner.cjs "$release/turnero_server.js"; fi
  for f in qr_local_scanner.js qr_scanner_page_client.js turnero_server.js; do node --check "$f"; done
  if [[ "$1" == main ]]; then node --check qr_product_web.js; fi
  echo "PREPARED $release"
  ;;
 activate)
  test "$(readlink -f "$base/current")" = "$previous"
  test -e "$release/SCANNER_RELEASE.json"
  cd "$release"
  rollback(){ ln -s "$previous" "$base/rollback-local-scanner-20261016"; mv -Tf "$base/rollback-local-scanner-20261016" "$base/current"; systemctl restart "$service"; echo ROLLED_BACK >&2; }
  trap rollback ERR
  ln -s "$release" "$base/next-local-scanner-20261016"
  mv -Tf "$base/next-local-scanner-20261016" "$base/current"
  systemctl restart "$service"
  healthy=false
  for attempt in {1..30}; do
   if systemctl is-active --quiet "$service" && curl -fsS "http://127.0.0.1:$port/healthz" | grep -q '"ok":true'; then healthy=true; break; fi
   sleep 1
  done
  "$healthy"
  test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/ext/qr/scanner-assets/worker-v1.js")" = 200
  test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/ext/qr/scanner-assets/zxing-0.21.3.min.js")" = 200
  trap - ERR
  echo "ACTIVE $(readlink -f "$base/current")"
  curl -fsS "http://127.0.0.1:$port/healthz"
  ;;
 *) exit 2 ;;
esac
