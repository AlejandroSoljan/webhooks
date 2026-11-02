'use strict';
const fs=require('fs'),crypto=require('crypto');
const [runtime,pid]=process.argv.slice(2);
for(const entry of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0')) {
 const pos=entry.indexOf('='); if(pos>0)process.env[entry.slice(0,pos)]=entry.slice(pos+1);
}
const {groupNotificationDevices}=require('./notification_devices');
if(!process.env.MONGODB_URI)require(runtime+'/node_modules/dotenv').config({path:'/etc/asisto/production.env',quiet:true});
(async()=>{
 const db=await require(runtime+'/db').getDb();
 const host=new URL(process.env.MONGODB_URI).hostname;
 if(db.databaseName!=='Cluster0'||!['127.0.0.1','localhost'].includes(host))throw Error('unexpected_production_database');
 console.log(JSON.stringify({database:db.databaseName,host}));
 const rows=await db.collection('customer_app_devices').find({disabled:{$ne:true}}).project({_id:0,tenantId:1,installId:1,pushToken:1,deviceName:1,label:1,updatedAt:1}).toArray();
 const summary=[...new Set(rows.map(d=>d.tenantId))].map(tenantId=>{
  const list=rows.filter(d=>d.tenantId===tenantId),groups=groupNotificationDevices(list);
  return {tenantId,records:list.length,destinations:groups.length,linkedGroups:groups.filter(d=>d.recordCount>1).map(d=>({model:d.deviceName,records:d.recordCount,ids:d.installIds.map(id=>id.slice(-10))})),
   onePlus:list.filter(d=>/oneplus/i.test(d.deviceName||'')).map(d=>({id:d.installId.slice(-10),tokenHash:crypto.createHash('sha256').update(d.pushToken||'').digest('hex').slice(0,12),at:d.updatedAt}))};
 });
 console.log(JSON.stringify(summary));process.exit(0);
})().catch(e=>{console.error(e.name,e.message.replace(/mongodb[^ ]*/g,'[redacted]'));process.exit(1);});
