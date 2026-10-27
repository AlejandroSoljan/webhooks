#!/usr/bin/env bash
# Asisto | SEO canónico, release acotada preservando operación | 2026-10-27
set -euo pipefail
base=/opt/asisto
source_dir=$(cd "$(dirname "$0")" && pwd)
previous=$(readlink -f "$base/current")
case "$previous" in /opt/asisto/releases/*) ;; *) exit 1 ;; esac
release="$previous-seo-asisto-20261027-2"
test ! -e "$release"
# Hardlinks para dependencias inmutables; separar los archivos que se editan.
cp -al "$previous" "$release"
for file in auth_ui.js endpoint.js; do
  cp -p "$release/$file" "$release/$file.seo-new"
  mv -f "$release/$file.seo-new" "$release/$file"
done
cd "$release"
git apply --check "$source_dir/public-seo.patch"
git apply "$source_dir/public-seo.patch"
install -m 644 "$source_dir/public_seo.js" "$release/public_seo.js"
node --check auth_ui.js
node --check endpoint.js
node --check public_seo.js
printf '%s\n' "$previous" > "$release/SEO_PREVIOUS_RELEASE.txt"
rollback() {
  ln -s "$previous" "$base/seo-rollback-$$"
  mv -Tf "$base/seo-rollback-$$" "$base/current"
  systemctl restart asisto-production
}
trap rollback ERR
ln -s "$release" "$base/seo-next-$$"
mv -Tf "$base/seo-next-$$" "$base/current"
systemctl restart asisto-production
healthy=0
for attempt in $(seq 1 25); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3000/healthz >/dev/null; then healthy=1; break; fi
  sleep 1
done
test "$healthy" = 1
curl --fail --silent http://127.0.0.1:3000/ -o "$release/SEO_PUBLIC_CHECK.html"
grep -q 'canonical.*https://asisto.com.ar/' "$release/SEO_PUBLIC_CHECK.html"
trap - ERR
printf 'ACTIVE=%s\nPREVIOUS=%s\n' "$release" "$previous"
