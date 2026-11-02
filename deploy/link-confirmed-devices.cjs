'use strict';
const fs=require('fs'),crypto=require('crypto');
const [runtime,pid,report,backup]=process.argv.slice(2);
for(const item of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0')){const i=item.indexOf('=');if(i>0)process.env[item.slice(0,i)]=item.slice(i+1);}
require(runtime+'/node_modules/dotenv').config({path:'/etc/asisto/production.env',quiet:true});
(async()=>{
 const db=await require(runtime+'/db').getDb();
 if(db.databaseName!=='Cluster0'||new URL(process.env.MONGODB_URI).hostname!=='127.0.0.1')throw Error('unexpected_database');
 const {results,validateOnly}=JSON.parse(fs.readFileSync(report));if(!validateOnly)throw Error('not_a_validation_report');
 const ids=results.filter(d=>d.tenantId==='MCN'&&d.deviceName==='OnePlus OnePlus8Pro').map(d=>d.installId);
 if(ids.length!==22)throw Error('confirmed_scope_changed');
 const devices=db.collection('customer_app_devices'),targets=await devices.find({$or:[{tenantId:'MCN',installId:{$in:ids}},...results.filter(d=>d.code==='UNREGISTERED').map(d=>({tenantId:d.tenantId,installId:d.installId}))]}).toArray();
 fs.writeFileSync(backup,JSON.stringify(targets.map(d=>({id:String(d._id),tenantId:d.tenantId,installId:d.installId,
  notificationGroupId:d.notificationGroupId,notificationInvalidTokenHash:d.notificationInvalidTokenHash,
  notificationInvalidAt:d.notificationInvalidAt})),null,2),{mode:0o600,flag:'wx'});
 const grouped=await devices.updateMany({tenantId:'MCN',installId:{$in:ids},deviceName:'OnePlus OnePlus8Pro'},{$set:{notificationGroupId:'verified-mcn-oneplus-20261101',notificationGroupVerifiedAt:new Date(),notificationGroupReason:'operator_confirmed_same_test_phone'}});
 let invalid=0;for(const result of results.filter(d=>d.code==='UNREGISTERED')){
  const row=targets.find(d=>d.tenantId===result.tenantId&&d.installId===result.installId);if(!row)continue;
  if(crypto.createHash('sha256').update(row.pushToken||'').digest('hex')!==result.tokenHash)continue;
  const out=await devices.updateOne({_id:row._id,pushToken:row.pushToken},{$set:{notificationInvalidTokenHash:result.tokenHash,notificationInvalidAt:new Date()}});invalid+=out.modifiedCount;
 }
 console.log(JSON.stringify({linked:grouped.matchedCount,invalidTokensMarked:invalid,backup}));process.exit(0);
})().catch(e=>{console.error(e.name);process.exit(1);});
