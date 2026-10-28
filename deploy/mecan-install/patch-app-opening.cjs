// Asisto | Parche acotado preservando variantes AWS/Mecan | 2026-10-28
const fs=require('fs'),path=require('path');
const root=path.resolve(process.argv[2]);
const file=path.join(root,'customer_app_web.js');
let source=fs.readFileSync(file,'utf8');
const pairs=[
 ["const { offerMecanInstall, restoreMecanInstallReturn } = require('./queue_install');", "const { offerMecanInstall, restoreMecanInstallReturn, prepareMecanTicketTransfer, mecanTicketAppIntent } = require('./queue_install');"],
 ['${offerMecanInstall.toString()}', '${offerMecanInstall.toString()}\n${prepareMecanTicketTransfer.toString()}\n${mecanTicketAppIntent.toString()}'],
 ['if(x.claimed)setupTicketNotices();', 'if(x.claimed){setupTicketNotices();if(active)offerMecanInstall(x);}']
];
for(const [before,after] of pairs){
 if(source.split(before).length!==2)throw Error('Marcador ausente o ambiguo: '+before);
 source=source.replace(before,after);
}
fs.writeFileSync(file+'.app-new',source,{mode:fs.statSync(file).mode});
fs.renameSync(file+'.app-new',file);
