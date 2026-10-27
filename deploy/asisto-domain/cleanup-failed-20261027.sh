#!/usr/bin/env bash
# Asisto | Limpieza autorizada de builds fallidos del 27/10/2026
set -euo pipefail
root=/opt/asisto/releases
audit=/var/lib/asisto/maintenance/cleanup-failed-20261027
test "$(realpath -e "$root")" = "$root"
test "$(systemctl is-active asisto-auto-deploy.timer || true)" != active
test "$(systemctl is-active asisto-auto-deploy.service || true)" != activating
mkdir -p "$audit"
active=$(readlink -f /opt/asisto/current)
mapfile -t targets < <(find "$root" -mindepth 1 -maxdepth 1 -type d -name 'a28aa1749074-auto-*' ! -name 'a28aa1749074-auto-spjx23K6' | sort)
test "${#targets[@]}" -gt 0
for target in "${targets[@]}"; do
  [[ "$target" =~ ^/opt/asisto/releases/a28aa1749074-auto-[A-Za-z0-9]{8}$ ]]
  test ! -L "$target"
  test "$(realpath -e "$target")" = "$target"
  test "$target" != "$active"
  if find /opt/asisto -maxdepth 3 -type l -lname "$target" | grep -q .; then echo "Release referenciada: $target" >&2; exit 1; fi
  if ps -eo args | grep -F "$target" | grep -v grep | grep -q .; then echo "Release en proceso: $target" >&2; exit 1; fi
done
printf '%s\n' "${targets[@]}" | tee "$audit/targets.txt"
printf 'ACTIVE=%s\nCOUNT=%s\n' "$active" "${#targets[@]}" | tee "$audit/summary.txt"
df -B1 / | tee "$audit/df-before.txt"
if test "${1:-}" != --apply; then echo 'DRY_RUN'; exit 0; fi
for target in "${targets[@]}"; do
  rm -rf --one-file-system -- "$target"
  printf '%s\n' "$target" >> "$audit/removed.txt"
done
df -B1 / | tee "$audit/df-after.txt"
curl --fail --silent --max-time 10 http://127.0.0.1:3000/healthz
curl --fail --silent --max-time 10 http://127.0.0.1:3102/healthz
