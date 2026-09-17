#!/usr/bin/env bash
set -euo pipefail

# Poll GitHub from the Lightsail host. No inbound webhook or GitHub SSH key is needed.
exec 9>/run/lock/asisto-auto-deploy.lock
flock -n 9 || exit 0

repo_url=https://github.com/AlejandroSoljan/webhooks.git
source_dir=/var/lib/asisto/deploy-source
releases_dir=/opt/asisto/releases
current_link=/opt/asisto/current
failed_sha_file=/var/lib/asisto/auto-deploy-failed-sha

if [[ ! -d "$source_dir/.git" ]]; then
  git clone --filter=blob:none --no-checkout "$repo_url" "$source_dir"
fi
git -C "$source_dir" fetch --quiet --depth=1 origin main
sha=$(git -C "$source_dir" rev-parse FETCH_HEAD)
short=${sha:0:12}
previous=$(readlink -f "$current_link")

if [[ "$(basename "$previous")" == "$short"-* ]]; then
  echo "Already deployed: $sha"
  exit 0
fi
if [[ -f "$failed_sha_file" && "$(<"$failed_sha_file")" == "$sha" ]]; then
  echo "Skipping previously failed revision: $sha" >&2
  exit 1
fi

candidate=$(mktemp -d "$releases_dir/$short-auto-XXXXXXXX")
echo "Preparing $sha in $candidate"
mapfile -t paths < <(git -C "$source_dir" ls-tree --name-only "$sha" | while IFS= read -r name; do
  case "$name" in
    *.js|*.png|*.jpg|*.ico|package.json|package-lock.json|ASISTO_VERSION.json|version.json|configuracion_errores.json|src|static|desktop|scripts|extensions) printf '%s\n' "$name" ;;
  esac
done)
if git -C "$source_dir" cat-file -e "$sha:data/articulos_rodaven.txt" 2>/dev/null; then
  paths+=(data/articulos_rodaven.txt)
fi
git -C "$source_dir" archive "$sha" -- "${paths[@]}" | tar -xf - -C "$candidate"
chown -R asisto:asisto "$candidate"
if ! runuser -u asisto -- npm --prefix "$candidate" ci --no-audit --no-fund \
  || ! runuser -u asisto -- npm --prefix "$candidate" test; then
  printf '%s\n' "$sha" > "$failed_sha_file"
  echo "Build or tests failed; production unchanged" >&2
  exit 1
fi

ln -s "$candidate" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
systemctl restart asisto-production
healthy=false
for attempt in {1..20}; do
  if systemctl is-active --quiet asisto-production \
    && curl --fail --silent --max-time 3 http://127.0.0.1:3000/healthz | grep -q '"ok":true'; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  ln -s "$previous" "$current_link.next"
  mv -Tf "$current_link.next" "$current_link"
  systemctl restart asisto-production
  printf '%s\n' "$sha" > "$failed_sha_file"
  echo "Health check failed; rolled back to $previous" >&2
  exit 1
fi

rm -f "$failed_sha_file"
echo "Deployed $sha; /healthz is healthy"
