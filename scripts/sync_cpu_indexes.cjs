// Asisto CPU indexes, 2026-11-06. Non-unique, additive and idempotent.
'use strict';
const specs={support_messages:[{tenantId:1,userId:1,historical:1,assignmentRecoveryV1:1,receivedAt:1},{tenantId:1,userId:1,catchup:1,assignmentRecoveryV1:1,receivedAt:1},{tenantId:1,userId:1,queued:1},{tenantId:1,userId:1,assignmentRecoveryV1:1,receivedAt:1},{tenantId:1,userId:1,at:-1}],wa_api_mensajes_confirmaciones:[{tenantId:1,numeroFrom:1,solicitudDayKey:1,pedidoAt:1},{tipoDocumento:1,solicitudDayKey:1}],tenant_config:[{tenantId:1},{tenantid:1}],support_contacts:[{tenantId:1,userId:1,jid:1},{tenantId:1,userId:1,aliases:1}]};

async function syncCpuIndexes(db){const created=[];for(const [collection,keys] of Object.entries(specs)){for(const key of keys){const existing=await db.collection(collection).listIndexes().toArray();if(existing.some(x=>JSON.stringify(x.key)===JSON.stringify(key)))continue;created.push(await db.collection(collection).createIndex(key,{name:'cpu_20261106_'+Object.keys(key).join('_')}));}}return created;}
module.exports={syncCpuIndexes,specs};
