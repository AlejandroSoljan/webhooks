#!/usr/bin/env bash
# Asisto | Retención autorizada: activa + cinco respaldos por servicio AWS
set -euo pipefail
audit=/var/lib/asisto/maintenance/retain-five-20261027
mkdir -p "$audit"
test "$(systemctl is-active asisto-auto-deploy.timer || true)" != active
test "$(systemctl is-active asisto-auto-deploy.service || true)" != activating
main=/opt/asisto/releases
queue=/opt/asisto/turnero/releases
main_active=$(readlink -f /opt/asisto/current)
queue_active=$(readlink -f /opt/asisto/turnero/current)
keep=(
 "$main_active"
 "$main/ced5f0a5cecc-auto-OXtWSPWb-brand-asisto-20261027-seo-asisto-20261027-2"
 "$main/ced5f0a5cecc-auto-OXtWSPWb-brand-asisto-20261027"
 "$main/ced5f0a5cecc-auto-OXtWSPWb"
 "$main/c6a07705dc5f-auto-bXBKhfQ3"
 "$main/a8de28713357-auto-LGvJUZ0H"
 "$queue_active"
 "$queue/v5.00.313-mecan-install-20261027"
 "$queue/v5.00.271-product-insights-cc8627e73522"
 "$queue/v5.00.271-product-insights-bd08bfab1785"
 "$queue/v5.00.270-play-review-20261021.1"
 "$queue/v5.00.270-catalog-sql-bdd698409e90"
)
declare -A kept
for path in "${keep[@]}"; do
 test -d "$path"; test ! -L "$path"
 test "$(realpath -e "$path")" = "$path"
 test -z "${kept[$path]:-}"
 kept[$path]=1
done
test "$(printf '%s\n' "${keep[@]}" | grep -c '^/opt/asisto/releases/')" = 6
test "$(printf '%s\n' "${keep[@]}" | grep -c '^/opt/asisto/turnero/releases/')" = 6
targets=()
for root in "$main" "$queue"; do
 test "$(realpath -e "$root")" = "$root"
 while IFS= read -r -d '' path; do
   test "$(dirname "$path")" = "$root"
   if test -n "${kept[$path]:-}"; then continue; fi
   test -d "$path" || test -L "$path"
   if test ! -L "$path"; then test "$(realpath -e "$path")" = "$path"; fi
   targets+=("$path")
 done < <(find "$root" -mindepth 1 -maxdepth 1 -print0)
done
# No borrar una dependencia de una release conservada, ni directorios de procesos vivos.
for path in "${keep[@]}"; do
 while IFS= read -r -d '' link; do
   resolved=$(readlink -m "$link")
   for target in "${targets[@]}"; do
     case "$resolved" in "$target"|"$target"/*) echo "Dependencia retenida: $link -> $resolved" >&2; exit 1;; esac
   done
 done < <(find "$path" -maxdepth 2 -type l ! -name '*broken*' -print0)
done
for cwd in /proc/[0-9]*/cwd; do
 resolved=$(readlink -f "$cwd" || true)
 for target in "${targets[@]}"; do
   case "$resolved" in "$target"|"$target"/*) echo "Proceso en $resolved" >&2; exit 1;; esac
 done
done
printf '%s\n' "${keep[@]}" | tee "$audit/retained.txt"
printf '%s\n' "${targets[@]}" > "$audit/targets.txt"
printf 'KEEP=%s REMOVE=%s\n' "${#keep[@]}" "${#targets[@]}"
df -B1 / | tee "$audit/df-before.txt"
if test "${1:-}" != --apply; then echo DRY_RUN; exit 0; fi
for path in "${targets[@]}"; do
 test "$(readlink -f /opt/asisto/current)" = "$main_active"
 test "$(readlink -f /opt/asisto/turnero/current)" = "$queue_active"
 if test -L "$path"; then rm -- "$path"; else rm -rf --one-file-system -- "$path"; fi
 printf '%s\n' "$path" >> "$audit/removed.txt"
done
df -B1 / | tee "$audit/df-after.txt"
for root in "$main" "$queue"; do find "$root" -mindepth 1 -maxdepth 1 -printf '%p\n'; done
curl --fail --silent --max-time 10 http://127.0.0.1:3000/healthz
curl --fail --silent --max-time 10 http://127.0.0.1:3102/healthz
