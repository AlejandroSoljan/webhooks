// Asisto | Version: 5.00.169 | Fecha: 2026-09-19
const crypto = require('crypto');
const deny = (message='Esta visita terminó o venció. Pedile al personal el código de tu mesa.', status=403) => { const e=new Error(message);e.status=status;throw e; };
const digest = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const policy = (config={}) => ({ requireCode:config.restaurant_visit_code_required !== false, hours:Number.isInteger(config.restaurant_visit_hours) ? Math.max(1,Math.min(24,config.restaurant_visit_hours)) : 4, confirmation:config.restaurant_order_confirmation_required !== false });
function validateVisit(table, visitorId, token, config) {
  const service=table.service;
  if (!service || service.status==='closed' || !service.visitCode || Date.now() >= new Date((service.visitStartedAt || service.openedAt)).getTime()+policy(config).hours*3600000) deny();
  const grant=(service.guestGrants || []).find(g=>g.visitorId===visitorId && g.hash===digest(token));
  if (!grant || Date.now()>=new Date(grant.expiresAt).getTime()) deny();
  return grant;
}
async function joinVisit(ctx, body) {
  const {db,table,config}=ctx, visitorId=String(body.visitorId || '');
  if (!/^[a-f0-9-]{36}$/.test(visitorId)) deny('Sesión inválida.');
  for(let attempt=0;attempt<5;attempt++) {
    const current=await db.collection('restaurant_tables').findOne({_id:table._id,tenantId:table.tenantId,active:true});
    const service=current?.service, rules=policy(config);
    if (!service || service.status==='closed' || !service.visitCode) deny('Pedile al personal que abra la mesa y te indique el código.');
    const expiresAt=new Date(new Date((service.visitStartedAt || service.openedAt)).getTime()+rules.hours*3600000);
    if(Date.now()>=expiresAt.getTime()) deny();
    if(rules.requireCode && String(body.code || '').trim()!==service.visitCode) deny('El código no coincide. Consultá al personal.');
    const token=crypto.randomBytes(32).toString('hex');
    const grants=(service.guestGrants || []).filter(g=>g.visitorId!==visitorId && new Date(g.expiresAt)>new Date());
    if(grants.length>=100) deny('Esta mesa alcanzó el máximo de celulares vinculados.',429);
    grants.push({visitorId,lastActionAt:(service.guestGrants || []).find(g=>g.visitorId===visitorId)?.lastActionAt,hash:digest(token),expiresAt});
    const result=await db.collection('restaurant_tables').updateOne({_id:table._id,tenantId:table.tenantId,...(current.opsRevision===undefined?{opsRevision:{$exists:false}}:{opsRevision:current.opsRevision})},{$set:{'service.guestGrants':grants},$inc:{opsRevision:1}});
    if(result.modifiedCount) return {token,expiresAt,serviceId:service.id};
  }
  deny('La mesa cambió. Volvé a ingresar el código.',409);
}
module.exports={policy,validateVisit,joinVisit};
