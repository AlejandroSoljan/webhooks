#!/usr/bin/env bash
# Asisto | Corrección acotada del bloqueo del reporte | 2026-10-27
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
previous=$(readlink -f /opt/asisto/current)
case "$previous" in /opt/asisto/releases/*) ;; *) exit 1 ;; esac
test "$(sha256sum "$previous/token_control_stats.js" | cut -d' ' -f1)" = 04cb91983cbc24ead13aaf03e156bee66aac3195d57d6ed85bb136fe0be6e846
release=/opt/asisto/releases/token-control-loading-5.00.314-20261027
test ! -e "$release"
cp -al "$previous" "$release"
cp -p "$release/token_control_stats.js" "$release/token_control_stats.js.new"
mv -f "$release/token_control_stats.js.new" "$release/token_control_stats.js"
cd "$release"
git apply --check "$source_dir/token-loading.patch"
git apply "$source_dir/token-loading.patch"
install -m 644 "$source_dir/ASISTO_VERSION.json" "$release/ASISTO_VERSION.json.new"
mv -f "$release/ASISTO_VERSION.json.new" "$release/ASISTO_VERSION.json"
node --check token_control_stats.js
printf '%s\n' "$previous" > "$release/TOKEN_LOADING_PREVIOUS_RELEASE.txt"
rollback() {
 ln -s "$previous" /opt/asisto/token-rollback-$$
 mv -Tf /opt/asisto/token-rollback-$$ /opt/asisto/current
 systemctl restart asisto-production
}
trap rollback ERR
ln -s "$release" /opt/asisto/token-next-$$
mv -Tf /opt/asisto/token-next-$$ /opt/asisto/current
systemctl restart asisto-production
healthy=0
for attempt in $(seq 1 30); do
 if curl --fail --silent --max-time 2 http://127.0.0.1:3000/healthz >/dev/null; then healthy=1; break; fi
 sleep 1
done
test "$healthy" = 1
trap - ERR
printf 'ACTIVE=%s\nPREVIOUS=%s\n' "$release" "$previous"
