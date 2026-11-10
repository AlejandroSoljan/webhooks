#!/usr/bin/env bash
set -Eeuo pipefail
source_dir="$1"
base=/opt/asisto
old=$(readlink -f "$base/current")
[[ "$old" == "$base/releases/v5.00.342-whatsapp-groups-20261110" ]]
new="$base/releases/v5.00.343-bot-test-recovery-20261110"
test ! -e "$new"
cp -al "$old" "$new"
replace(){
  local name="$1"
  cp "$source_dir/$name" "$new/$name.new"
  chown --reference="$old/$name" "$new/$name.new"
  chmod --reference="$old/$name" "$new/$name.new"
  mv -Tf "$new/$name.new" "$new/$name"
}
for file in bot_test_history.js bot_test_projection.js bot_test_panel.js conversation_followup_panel.js wa_inbox_panel.js ASISTO_VERSION.json; do
 replace "$file"
 if [[ "$file" == *.js ]]; then node --check "$new/$file"; fi
done
{ head -n1 "$source_dir/HISTORIAL_CAMBIOS_BACKEND.txt"; cat "$old/HISTORIAL_CAMBIOS_BACKEND.txt"; } > "$new/HISTORIAL_CAMBIOS_BACKEND.txt.new"
mv -Tf "$new/HISTORIAL_CAMBIOS_BACKEND.txt.new" "$new/HISTORIAL_CAMBIOS_BACKEND.txt"
switch(){ ln -s "$1" "$base/next-bot-test-$$"; mv -Tf "$base/next-bot-test-$$" "$base/current"; }
rollback(){ switch "$old"; systemctl restart asisto-production; }
trap rollback ERR
switch "$new"
systemctl restart asisto-production
for i in $(seq 1 30); do if curl -fsS --max-time 2 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then break; fi; sleep 1; done
curl -fsS --max-time 5 http://127.0.0.1:3000/healthz
systemctl is-active asisto-production
trap - ERR
printf '\nACTIVE=%s\n' "$new"