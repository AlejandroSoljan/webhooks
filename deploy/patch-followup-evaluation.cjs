const fs=require('fs'),path=require('path'),crypto=require('crypto');
const [target,source]=process.argv.slice(2);
const read=n=>fs.readFileSync(path.join(target,n),'utf8');
if(crypto.createHash('sha256').update(fs.readFileSync(path.join(target,'conversation_followup_panel.js'))).digest('hex')!=='46edbd30045b47d3c7bb452d671ad6160f776d132f86dbd31068769b2ee3d671')throw Error('Runtime changed');
const write=(n,s)=>{const p=path.join(target,n);if(fs.existsSync(p))fs.unlinkSync(p);fs.writeFileSync(p,s)};
for(const n of ['conversation_followup_panel.js','bot_test_history.js','bot_test_projection.js'])write(n,fs.readFileSync(path.join(source,n),'utf8'));
write('HISTORIAL_CAMBIOS_BACKEND.txt','2026-11-05 | v5.00.336 | Pruebas NEA evaluadas normalmente con filtro origen y bloqueo de entregas. Reemplaza v335. Rama codex/notifications-device-dedup.\n'+read('HISTORIAL_CAMBIOS_BACKEND.txt'));
const v=JSON.parse(read('ASISTO_VERSION.json'));Object.assign(v,{version:'5.00.336',fecha:'2026-11-05',date:'2026-11-05'});write('ASISTO_VERSION.json',JSON.stringify(v,null,2)+'\n');

const ep=read('endpoint.js');const marker='    const to = conv.waId;';if(ep.split(marker).length!==2)throw Error('Endpoint marker changed');write('endpoint.js',ep.replace(marker,'    if (conv.isTest === true || conv.channelType === "bot_test") return res.status(403).json({ error: "test_conversation_no_delivery" });\n'+marker));
