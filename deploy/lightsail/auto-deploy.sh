#!/usr/bin/env bash
set -euo pipefail

# Poll GitHub from the Lightsail host. No inbound webhook or GitHub SSH key is needed.
exec 9>/run/lock/asisto-auto-deploy.lock
flock -n 9 || { echo "Another deployment is running" >&2; exit 1; }

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

# Each release gets a root-owned record outside its writable application tree.
state_dir=/var/lib/asisto-release-checks
release_digest() (
  cd "$1"
  find . -maxdepth 1 -type f \( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.png' -o -name '*.jpg' -o -name '*.ico' \) -print0
  find src static desktop scripts extensions tests data -type f -print0
)
file_hashes() (
  set -o pipefail
  cd "$1"
  release_digest "$PWD" | LC_ALL=C sort -z | xargs -0 -r sha256sum --
)
fingerprint() {
  file_hashes "$1" | sha256sum | cut -d' ' -f1
}

review_dir=/var/lib/asisto-review
pending_manifest=
trap 'if [[ -n "$pending_manifest" ]]; then rm -f -- "$pending_manifest"; fi' EXIT
prepare_manifest() {
  local release="$1"
  install -d -o root -g manager-go-dev -m 0750 "$review_dir"
  pending_manifest=$(mktemp "$review_dir/.production.XXXXXXXX")
  printf '# Release %s\n# UTC %s\n' "$release" "$(date -u +%FT%TZ)" > "$pending_manifest"
  file_hashes "$release" >> "$pending_manifest"
  chown root:manager-go-dev "$pending_manifest"
  chmod 0440 "$pending_manifest"
}
publish_manifest() {
  [[ "$(readlink -f "$current_link")" == "$1" ]]
  mv -Tf -- "$pending_manifest" "$review_dir/production.sha256"
  pending_manifest=
}
check_active() {
  local record="$state_dir/$(basename "$previous").sha256"
  if [[ "$(readlink -f "$current_link")" != "$previous" || ! -f "$record" || "$(fingerprint "$previous")" != "$(<"$record")" ]]; then
    echo "Active release changed or has no verified baseline. Reconcile it with Git before deploying." >&2
    exit 1
  fi
}
check_active
for template in app_center_panel.html mecan_account.html; do
  git -C "$source_dir" cat-file -e "$sha:$template" || { echo "Missing production template: $template" >&2; exit 1; }
done
if [[ "$(basename "$previous")" == "$short"-* ]]; then
  prepare_manifest "$previous"
  publish_manifest "$previous"
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
    app_center_panel.html|mecan_account.html|HISTORIAL_CAMBIOS_BACKEND.txt|docs|*.js|*.png|*.jpg|*.ico|package.json|package-lock.json|ASISTO_VERSION.json|version.json|configuracion_errores.json|src|static|desktop|scripts|extensions|tests) printf '%s\n' "$name" ;;
  esac
done)
if git -C "$source_dir" cat-file -e "$sha:data/articulos_rodaven.txt" 2>/dev/null; then
  paths+=(data/articulos_rodaven.txt)
fi
git -C "$source_dir" archive "$sha" -- "${paths[@]}" | tar -xf - -C "$candidate"
chown -R asisto:asisto "$candidate"
install -d -o asisto -g asisto -m 0750 /var/lib/asisto/npm-cache
install -d -o asisto -g asisto -m 0750 /var/lib/asisto/mongodb-binaries
cd "$candidate"
if ! runuser -u asisto -- npm --cache /var/lib/asisto/npm-cache --prefix "$candidate" ci --no-audit --no-fund \
  || ! runuser -u asisto -- env TZ=America/Argentina/Buenos_Aires MONGOMS_DOWNLOAD_DIR=/var/lib/asisto/mongodb-binaries npm --cache /var/lib/asisto/npm-cache --prefix "$candidate" test; then
  printf '%s\n' "$sha" > "$failed_sha_file"
  echo "Build or tests failed; production unchanged" >&2
  exit 1
fi

check_active
prepare_manifest "$candidate"
tail -n +3 "$pending_manifest" | sha256sum | cut -d' ' -f1 > "$state_dir/$(basename "$candidate").sha256"
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

publish_manifest "$candidate"
rm -f "$failed_sha_file"
echo "Deployed $sha; /healthz is healthy"
