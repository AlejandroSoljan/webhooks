'use strict';
const fs=require('fs'),path=require('path');
const [release,source]=process.argv.slice(2);
function write(file,text){const tmp=file+'.device-dedup.tmp';fs.writeFileSync(tmp,text);fs.renameSync(tmp,file);}
const donor=fs.readFileSync(path.join(source,'customer_notifications.js'),'utf8');
const file=path.join(release,'customer_notifications.js');let text=fs.readFileSync(file,'utf8');
for(const prefix of ["app.get('/api/customer-notifications/:tenant',", "app.post('/api/customer-notifications/:tenant',",'async function firebaseSender(){']){
 const matches=text.split('\n').filter(line=>line.startsWith(prefix));const replacement=donor.split('\n').find(line=>line.startsWith(prefix));
 if(matches.length!==1||!replacement)throw Error('unexpected_notification_route');text=text.replace(matches[0],replacement);
}
if(!text.includes('require("./notification_devices")'))text=text.replace('const express = require("express");','const express = require("express");\nconst {groupNotificationDevices,publicNotificationDevice,tokenHash}=require("./notification_devices");');
for(const [old,next] of [["rows.length+' instalaciones en '+t()","rows.length+' destinos únicos en '+t()"],['<span>Instalaciones</span>','<span>Destinos únicos</span>'],["escape(d.shortId)+'<br>Última conexión:","escape(d.shortId)+(d.recordCount>1?' · '+Number(d.recordCount)+' registros vinculados':'')+'<br>Última conexión:"]]){
 if(text.includes(old))text=text.replace(old,next);
}
write(file,text);
const center=path.join(release,'app_center.js');
if(fs.existsSync(center)){
 let app=fs.readFileSync(center,'utf8');
 const marker="d.pushToken&&'t:'+d.pushToken";
 if(app.split(marker).length!==2)throw Error('unexpected_app_center_identity');
 app=app.replace(marker,marker+",d.deviceKey&&'d:'+d.deviceKey,d.notificationGroupId&&'v:'+d.notificationGroupId");
 const eligible='d.pushToken&&!d.disabled&&';
 if(app.split(eligible).length!==2)throw Error('unexpected_app_center_target');
 app=app.replace(eligible,eligible+'d.notificationInvalidTokenHash!==hash(d.pushToken)&&');
 write(center,app);
}
const web=path.join(release,'customer_app_web.js');text=fs.readFileSync(web,'utf8');
const marker='$set:{pushToken,userAgent,platform,';if(text.split(marker).length!==2)throw Error('unexpected_register_marker');
write(web,text.replace(marker,marker+"...(/^[a-f0-9]{64}$/.test(String(req.body.deviceKey||''))?{deviceKey:req.body.deviceKey}:{}),"));
write(path.join(release,'notification_devices.js'),fs.readFileSync(path.join(source,'notification_devices.js'),'utf8'));
const meta=path.join(release,'ASISTO_VERSION.json');const version=JSON.parse(fs.readFileSync(meta));version.version='5.00.326';version.fecha='2026-11-01';write(meta,JSON.stringify(version)+'\n');
const history=path.join(release,'HISTORIAL_CAMBIOS_BACKEND.txt');write(history,fs.readFileSync(path.join(source,'notification-release-entry.txt'),'utf8')+'\n\n'+(fs.existsSync(history)?fs.readFileSync(history,'utf8'):''));
