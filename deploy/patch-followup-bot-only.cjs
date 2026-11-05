const fs=require('fs'),path=require('path'),crypto=require('crypto');
const [target,source]=process.argv.slice(2);
const read=n=>fs.readFileSync(path.join(target,n),'utf8');
if(crypto.createHash('sha256').update(fs.readFileSync(path.join(target,'conversation_followup_panel.js'))).digest('hex')!=='3682ed1f8b4e7a732231b739574b531690df83f0750adefdcfcd8d609f4d2416')throw Error('Runtime changed');
const write=(n,s)=>{const p=path.join(target,n);if(fs.existsSync(p))fs.unlinkSync(p);fs.writeFileSync(p,s)};
for(const n of ['conversation_followup_panel.js'])write(n,fs.readFileSync(path.join(source,n),'utf8'));
write('HISTORIAL_CAMBIOS_BACKEND.txt','2026-11-05 | v5.00.334 | Seguimiento exclusivo del bot; excluye envios API. Sintaxis y panel verificados. Rama codex/notifications-device-dedup.\n'+read('HISTORIAL_CAMBIOS_BACKEND.txt'));
const v=JSON.parse(read('ASISTO_VERSION.json'));Object.assign(v,{version:'5.00.334',fecha:'2026-11-05',date:'2026-11-05'});write('ASISTO_VERSION.json',JSON.stringify(v,null,2)+'\n');
