const fs=require('fs'),path=require('path'),crypto=require('crypto');
const [target,source]=process.argv.slice(2);
const read=n=>fs.readFileSync(path.join(target,n),'utf8');
if(crypto.createHash('sha256').update(fs.readFileSync(path.join(target,'bot_test_panel.js'))).digest('hex')!=='238d1be3e3a2e71f4492c554efe33510b5c60bc1f438f50af097eade065cbad2')throw Error('Runtime changed');
const write=(n,s)=>{const p=path.join(target,n);if(fs.existsSync(p))fs.unlinkSync(p);fs.writeFileSync(p,s)};
for(const n of ['bot_test_panel.js','bot_test_history.js'])write(n,fs.readFileSync(path.join(source,n),'utf8'));
write('HISTORIAL_CAMBIOS_BACKEND.txt','2026-11-05 | v5.00.333 | Registro aislado de consultas y respuestas NEA_PRUEBAS. Tests bot_test_history (3). Rama codex/notifications-device-dedup.\n'+read('HISTORIAL_CAMBIOS_BACKEND.txt'));
const v=JSON.parse(read('ASISTO_VERSION.json'));Object.assign(v,{version:'5.00.333',fecha:'2026-11-05',date:'2026-11-05'});write('ASISTO_VERSION.json',JSON.stringify(v,null,2)+'\n');
