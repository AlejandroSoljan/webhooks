// Asisto | Centro de aplicaciones y actividad verificable | 2026-10-30
'use strict';
const {createHash,randomBytes}=require('crypto');
const clean=(v,n=120)=>String(v||'').trim().slice(0,n);
const hash=v=>createHash('sha256').update(v).digest('hex');
const YEAR=365*86400000;
const stamp=d=>Math.max(+new Date(d.lastActivityAt||0)||0,+new Date(d.updatedAt||0)||0,+new Date(d.lastSeenAt||0)||0);
// Never identify a physical device by model, IP, or user agent. Keep storage intact.
function groupDevices(rows){
 const parents=rows.map((_,i)=>i),keys=new Map(),find=i=>parents[i]===i?i:(parents[i]=find(parents[i]));
 rows.forEach((d,i)=>{for(const k of [d.installId&&'i:'+d.installId,d.pushToken&&'t:'+d.pushToken,d.deviceKey&&'d:'+d.deviceKey,d.notificationGroupId&&'g:'+d.notificationGroupId].filter(Boolean)){const key=d.tenantId+':'+k;if(keys.has(key))parents[find(i)]=find(keys.get(key));else keys.set(key,i);}});
 const groups=new Map();rows.forEach((d,i)=>{const k=find(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(d);});
 return [...groups.values()].map(members=>{members.sort((a,b)=>stamp(b)-stamp(a));const top=members[0],eligible=members.find(d=>d.pushToken&&!d.disabled&&(!d.notificationInvalidTokenHash||d.notificationInvalidTokenHash!==hash(d.pushToken))&&(!d.pushInvalidAt||(d.pushInvalidTokenHash&&d.pushInvalidTokenHash!==hash(d.pushToken)))&&!d.centerArchivedAt);return {...top,pushToken:eligible?.pushToken||null,installId:eligible?.installId||top.installId,members,installIds:[...new Set(members.map(d=>d.installId).filter(Boolean))],recordCount:members.length,lastSeenAt:new Date(stamp(top)),deviceName:members.find(d=>d.deviceName)?.deviceName||'Dispositivo sin identificar',label:members.find(d=>d.label)?.label||'',channel:members.some(d=>d.pushToken)?'app':'web',archived:members.every(d=>d.centerArchivedAt),lastActivityAt:members.map(d=>d.lastActivityAt).filter(Boolean).sort((a,b)=>+new Date(b)-+new Date(a))[0]||null};}).sort((a,b)=>stamp(b)-stamp(a));
}
function publicDevice(d){return {installId:d.installId,shortId:String(d.installId||'').slice(-8),label:d.label,deviceName:d.deviceName,platform:d.platform,channel:d.channel,recordCount:d.recordCount,archived:d.archived,createdAt:d.members.map(x=>x.createdAt).filter(Boolean).sort((a,b)=>+new Date(a)-+new Date(b))[0]||null,lastSeenAt:d.lastSeenAt,lastActivityAt:d.lastActivityAt||null,version:d.appVersion||null,pushAvailable:!!d.pushToken,pushPermission:typeof d.pushPermission==='boolean'?d.pushPermission:null,sessions7:d.sessions7||0,notificationOpens7:d.notificationOpens7||0};}
function allowedUrl(raw,t){try{const u=new URL(raw||`https://asistobot.com.ar/customer-app/${t}`);if(u.protocol!=='https:'||!['asistobot.com.ar','www.asistobot.com.ar','asisto.com.ar','www.asisto.com.ar'].includes(u.hostname)||u.username||u.password||u.port||!(u.pathname===`/customer-app/${t}`||u.pathname===`/qr/${t}`))return null;u.searchParams.delete('asisto_notice');if(u.pathname===`/qr/${t}`){u.pathname=`/customer-app/${t}`;u.searchParams.set('view','prices');}return u;}catch{return null;}}
function mountAppCenter(app,{auth,getDb,firebaseSender}){
 if(app.locals.appCenterMounted)return;app.locals.appCenterMounted=true;
 const guard=auth?.requireAuth||((_q,res)=>res.sendStatus(401));
 const access=(req,res,next)=>{const t=clean(req.params.tenant,60).toUpperCase();if(!/^[A-Z0-9_-]+$/.test(t)||!(String(req.user?.role).toLowerCase()==='superadmin'||String(req.user?.tenantId).toUpperCase()===t))return res.sendStatus(403);req.centerTenant=t;next();};
 const json=require('express').json({limit:'16kb'});
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){console.error('[app-center]',e.code||e.name);if(!res.headersSent)res.status(500).json({error:'No se pudo completar la operación.'});}};
 let indexes;
 async function ready(db){if(!indexes)indexes=Promise.all(['customer_app_activity','customer_app_receipts'].flatMap(c=>[db.collection(c).createIndex({expiresAt:1},{expireAfterSeconds:0}),db.collection(c).createIndex({tenantId:1,installId:1,at:-1})])).catch(e=>{indexes=null;throw e;});await indexes;}
 async function list(db,t){const rows=await db.collection('customer_app_devices').find({tenantId:t}).limit(10001).toArray();if(rows.length>10000)throw Error('device_limit');return groupDevices(rows);}
 require('./app_activity_summary').mountActivitySummary(app,{guard,access,wrap,getDb,list});
 app.get('/api/customer-notifications/:tenant/center',guard,access,wrap(async(req,res)=>{
  const db=await getDb(),t=req.centerTenant,devices=await list(db,t),since=new Date(Date.now()-7*86400000);
  const [events,history,totals]=await Promise.all([
   db.collection('customer_app_activity').find({tenantId:t,at:{$gte:since}}).sort({at:-1}).limit(40).project({_id:0,installId:1,type:1,at:1}).toArray(),
   db.collection('customer_app_notifications').find({tenantId:t}).sort({createdAt:-1}).limit(100).project({title:1,body:1,createdAt:1,notificationType:1,purpose:1,status:1,targetCount:1,successCount:1,failureCount:1,openedCount:1,trackingEnabled:1}).toArray(),
   db.collection('customer_app_activity').aggregate([{$match:{tenantId:t,at:{$gte:since}}},{$group:{_id:{installId:'$installId',type:'$type'},count:{$sum:1}}}]).toArray()
  ]);
  for(const d of devices){d.sessions7=totals.filter(x=>d.installIds.includes(x._id.installId)&&x._id.type==='app_open').reduce((n,x)=>n+x.count,0);d.notificationOpens7=totals.filter(x=>d.installIds.includes(x._id.installId)&&x._id.type==='notification_open').reduce((n,x)=>n+x.count,0);}
  const receiptCounts=await db.collection('customer_app_receipts').aggregate([{$match:{tenantId:t,openedAt:{$exists:true},notificationId:{$in:history.map(h=>String(h._id))}}},{$group:{_id:'$notificationId',count:{$sum:1}}}]).toArray();
  res.json({devices:devices.map(publicDevice),events,history:history.map(h=>({...h,id:String(h._id),openedCount:h.trackingEnabled?(receiptCounts.find(x=>x._id===String(h._id))?.count||0):null})),periodDays:7,configured:require('./customer_notifications').firebaseCredentials().configured});
 }));
 app.get('/api/customer-notifications/:tenant/center/devices/:id',guard,access,wrap(async(req,res)=>{
  const db=await getDb(),d=(await list(db,req.centerTenant)).find(d=>d.installIds.includes(req.params.id));if(!d)return res.sendStatus(404);
  const events=await db.collection('customer_app_activity').find({tenantId:req.centerTenant,installId:{$in:d.installIds}}).sort({at:-1}).limit(100).project({_id:0,type:1,at:1}).toArray();
  res.json({device:publicDevice(d),events,records:d.members.map(x=>({shortId:clean(x.installId).slice(-8),lastSeenAt:x.lastSeenAt||x.updatedAt,disabled:!!x.disabled,invalid:!!x.pushInvalidAt}))});
 }));
 app.patch('/api/customer-notifications/:tenant/center/devices/:id',guard,access,json,wrap(async(req,res)=>{
  const db=await getDb(),t=req.centerTenant,d=(await list(db,t)).find(x=>x.installIds.includes(req.params.id));if(!d)return res.sendStatus(404);const set={};if(typeof req.body.archived==='boolean')set.centerArchivedAt=req.body.archived?new Date():null;if(typeof req.body.label==='string')set.label=clean(req.body.label,100);if(!Object.keys(set).length)return res.sendStatus(400);
  await db.collection('customer_app_devices').updateMany({tenantId:t,installId:{$in:d.installIds}},{$set:set});res.json({ok:true});
 }));
 app.post('/api/customer-notifications/:tenant/center/send',guard,access,json,wrap(async(req,res)=>{
  const t=req.centerTenant,title=clean(req.body.title,80),body=clean(req.body.body,500),url=allowedUrl(req.body.url,t),requestId=clean(req.body.requestId),ids=Array.isArray(req.body.installIds)?req.body.installIds.filter(x=>typeof x==='string').slice(0,1000):[];
  if(!title||!body||!url||!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)||!ids.length)return res.status(400).json({error:'Revisá título, mensaje, destino y destinatarios.'});
  const db=await getDb();await ready(db);const devices=(await list(db,t)).filter(d=>d.pushToken&&!d.archived&&d.installIds.some(id=>ids.includes(id))),notificationId=hash(t+':'+requestId);
  if(!devices.length)return res.status(400).json({error:'No hay destinatarios habilitados.'});
  const record={_id:notificationId,tenantId:t,title,body,notificationType:'manual',purpose:clean(req.body.purpose,30),status:'sending',createdAt:new Date(),targetCount:devices.length,successCount:0,failureCount:0,trackingEnabled:true};
  try{await db.collection('customer_app_notifications').insertOne(record);}catch(e){if(e.code===11000){const old=await db.collection('customer_app_notifications').findOne({_id:notificationId,tenantId:t});return res.json({ok:true,repeated:true,status:old.status,successCount:old.successCount,failureCount:old.failureCount});}throw e;}
  let success=0,failure=0;
  try{const send=await firebaseSender();for(const d of devices){const secret=randomBytes(32).toString('base64url'),link=new URL(url);link.searchParams.set('asisto_notice',secret);const receiptId=hash(secret);
   await db.collection('customer_app_receipts').insertOne({_id:receiptId,tenantId:t,installId:d.installId,installIds:d.installIds,notificationId,createdAt:new Date(),expiresAt:new Date(Date.now()+YEAR)});
   try{await send(d.pushToken,{title,body,url:link.href});success++;await db.collection('customer_app_receipts').updateOne({_id:receiptId},{$set:{acceptedAt:new Date()}});}
   catch(e){failure++;if(e.fcmCode==='UNREGISTERED')await db.collection('customer_app_devices').updateMany({tenantId:t,pushToken:d.pushToken},{$set:{pushInvalidAt:new Date(),pushInvalidTokenHash:hash(d.pushToken)}});}
  }}catch{failure=devices.length-success;}
  const status=failure?(success?'partial':'failed'):'sent';await db.collection('customer_app_notifications').updateOne({_id:notificationId},{$set:{status,successCount:success,failureCount:failure,sentAt:new Date()}});res.json({ok:success>0,status,successCount:success,failureCount:failure});
 }));
 // Only a registered installation proving possession of its current token can report usage.
 app.post('/api/customer-app/:tenant/activity',json,wrap(async(req,res)=>{
  const t=clean(req.params.tenant,60).toUpperCase(),id=clean(req.body.installId),token=clean(req.body.pushToken,500),session=clean(req.body.sessionId,80);
  if(!id||!token||!/^[a-zA-Z0-9-]{16,80}$/.test(session))return res.sendStatus(400);
  const db=await getDb(),device=await db.collection('customer_app_devices').findOne({tenantId:t,installId:id,pushToken:token,disabled:{$ne:true}});if(!device)return res.sendStatus(403);await ready(db);
  const type=['screen_home','screen_turns','screen_ticket','scan_started','ticket_requested','ticket_cancelled','product_view'].includes(req.body.type)?req.body.type:'app_open';const now=new Date(),eventId=hash(t+':'+id+':'+session+':'+type+':'+(type==='app_open'?'session':Math.floor(Date.now()/30000)));
  const recent=await db.collection('customer_app_activity').findOne({tenantId:t,installId:id,type,at:{$gt:new Date(Date.now()-30000)}});
  if(!recent)await db.collection('customer_app_activity').updateOne({_id:eventId},{$setOnInsert:{tenantId:t,installId:id,type,at:now,expiresAt:new Date(Date.now()+YEAR)}},{upsert:true});
  await db.collection('customer_app_devices').updateOne({_id:device._id},{$set:{lastActivityAt:now,lastSeenAt:now}});
  if(req.body.notice){const key=hash(clean(req.body.notice,60)),receipt=await db.collection('customer_app_receipts').findOne({_id:key,tenantId:t,installIds:id,expiresAt:{$gt:now}});if(receipt){await db.collection('customer_app_receipts').updateOne({_id:key,openedAt:{$exists:false}},{$set:{openedAt:now}});await db.collection('customer_app_activity').updateOne({_id:hash(key+':open')},{$setOnInsert:{tenantId:t,installId:id,type:'notification_open',at:now,expiresAt:new Date(Date.now()+YEAR)}},{upsert:true});}}
  res.json({ok:true});
 }));
 app.get('/static/app-center-client.js',(_req,res)=>res.type('js').sendFile(require('path').join(__dirname,'app_center_client.js')));
 app.get('/static/app-center-panel.js',guard,(_req,res)=>res.type('js').sendFile(require('path').join(__dirname,'app_center_panel.js')));
}
module.exports={groupDevices,publicDevice,allowedUrl,mountAppCenter};
