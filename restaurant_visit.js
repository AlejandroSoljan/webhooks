// Asisto | Version: 5.00.170 | Fecha: 2026-09-19
const crypto = require('crypto');
const deny = (message='Esta visita terminó o venció. Solicitá al personal que habilite tu celular.', status=403) => { const e=new Error(message);e.status=status;throw e; };
const digest = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const policy = (config={}) => ({ operatorApproval:config.restaurant_guest_auto_approval !== true, hours:Number.isInteger(config.restaurant_visit_hours) ? Math.max(1,Math.min(24,config.restaurant_visit_hours)) : 4, confirmation:config.restaurant_order_confirmation_required !== false });
function validateVisit(table, visitorId, token, config) {
  const service=table.service;
  if (!service || service.status==='closed' || Date.now() >= new Date((service.visitStartedAt || service.openedAt)).getTime()+policy(config).hours*3600000) deny();
  const grant=(service.guestGrants || []).find(g=>g.visitorId===visitorId && g.hash===digest(token));
  if (!grant || (policy(config).operatorApproval && !grant.approvedBy) || Date.now()>=new Date(grant.expiresAt).getTime()) deny();
  return grant;
}
async function joinVisit(ctx, body) {
  const {db,table,config}=ctx, visitorId=String(body.visitorId || '');
  if(policy(config).operatorApproval) deny('El personal debe habilitar tu celular desde el panel de la mesa.');
  if (!/^[a-f0-9-]{36}$/.test(visitorId)) deny('Sesión inválida.');
  for(let attempt=0;attempt<5;attempt++) {
    const current=await db.collection('restaurant_tables').findOne({_id:table._id,tenantId:table.tenantId,active:true});
    const service=current?.service, rules=policy(config);
    if (!service || service.status==='closed') deny('Pedile al personal que abra la mesa.');
    const expiresAt=new Date(new Date((service.visitStartedAt || service.openedAt)).getTime()+rules.hours*3600000);
    if(Date.now()>=expiresAt.getTime()) deny();
    const token=crypto.randomBytes(32).toString('hex');
    const grants=(service.guestGrants || []).filter(g=>g.visitorId!==visitorId && new Date(g.expiresAt)>new Date());
    if(grants.length>=100) deny('Esta mesa alcanzó el máximo de celulares vinculados.',429);
    grants.push({visitorId,lastActionAt:(service.guestGrants || []).find(g=>g.visitorId===visitorId)?.lastActionAt,hash:digest(token),expiresAt});
    const result=await db.collection('restaurant_tables').updateOne({_id:table._id,tenantId:table.tenantId,...(current.opsRevision===undefined?{opsRevision:{$exists:false}}:{opsRevision:current.opsRevision})},{$set:{'service.guestGrants':grants},$inc:{opsRevision:1}});
    if(result.modifiedCount) return {token,expiresAt,serviceId:service.id};
  }
  deny('La mesa cambió. Reintentá la vinculación.',409);
}
async function scanVisit(ctx,body){
 const {db,table,config}=ctx,token=String(body.deviceToken || ''),visitorId=String(body.visitorId || '');
 if(!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9-]{36}$/.test(visitorId)) deny('Celular inválido.');
 const id=digest(table.tenantId+':'+table._id+':'+token),requests=db.collection('restaurant_access_requests');
 let row=await requests.findOne({_id:id,tenantId:table.tenantId,tableId:table._id});
 const now=new Date();
 if(!row){
  if(await requests.countDocuments({tenantId:table.tenantId,tableId:table._id,lastSeenAt:{$gte:new Date(Date.now()-600000)}})>=50) deny('Hay demasiadas solicitudes en esta mesa. Consultá al personal.',429);
  await requests.updateOne({_id:id},{$setOnInsert:{tenantId:table.tenantId,tableId:table._id,visitorId,hash:digest(token),status:'pending',visitId:table.service?.id || null,waitingForOpen:!table.service || table.service.status==='closed',requestedAt:now,createdAt:now},$set:{lastSeenAt:now}},{upsert:true});
  row=await requests.findOne({_id:id});
 }
 if(row.visitorId!==visitorId) deny('Celular inválido.');
 const changes={lastSeenAt:now};
 if(typeof body.name==='string')changes.name=body.name.trim().slice(0,60);
 // Un navegador abierto no se vuelve a postular solo al finalizar una visita.
 if(body.request===true)Object.assign(changes,{status:row.status==='blocked'?'blocked':'pending',visitId:table.service?.id || null,waitingForOpen:!table.service || table.service.status==='closed',requestedAt:now});
 await requests.updateOne({_id:id},{$set:changes});row={...row,...changes};
 const stale=(row.visitId && !row.waitingForOpen && row.visitId!==table.service?.id) || (table.service?.closedAt && new Date(row.requestedAt)<=new Date(table.service.closedAt));
 if(!policy(config).operatorApproval && row.status==='pending' && !stale && table.service && table.service.status!=='closed'){
   const expiresAt=new Date(new Date(table.service.visitStartedAt || table.service.openedAt).getTime()+policy(config).hours*3600000);
   const grants=(table.service.guestGrants || []).filter(g=>g.visitorId!==visitorId && new Date(g.expiresAt)>now);
   if(expiresAt>now && grants.length<100){
     grants.push({visitorId,hash:digest(token),deviceId:id,approvedBy:'Automático',expiresAt});
     const updated=await db.collection('restaurant_tables').updateOne({_id:table._id,tenantId:table.tenantId,opsRevision:table.opsRevision,'service.id':table.service.id,'service.status':{$ne:'closed'}},{$set:{'service.guestGrants':grants},$inc:{opsRevision:1}});
     if(updated.modifiedCount){table.service.guestGrants=grants;row.status='approved';await requests.updateOne({_id:id},{$set:{status:'approved',serviceId:table.service.id,visitId:table.service.id,waitingForOpen:false}});}
   }
 }
 let approved=false;try{validateVisit(table,visitorId,token,config);approved=true;}catch{}
 const ended=row.status==='approved' && !approved || stale;
 const status=row.status==='blocked'?'blocked':approved?'approved':ended?'ended':'pending';
 return {id,label:row.name || 'Celular '+id.slice(-4).toUpperCase(),status};
}
module.exports={policy,validateVisit,joinVisit,scanVisit};
