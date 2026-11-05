const test=require('node:test'),assert=require('node:assert/strict');
const {syncPilotRecord}=require('../bot_test_projection');
test('projection idempotent and isolated, keeps manual close on replay',async()=>{
 const docs=new Map(),msgs=new Map();const db={collection:n=>({findOne:async q=>docs.get(String(q._id)),updateOne:async(q,u)=>{const map=n==='conversations'?docs:msgs;const key=String(q._id);const old=map.get(key)||{};map.set(key,{...(!map.has(key)?u.$setOnInsert:{}),...old,...u.$set,...u.$max});}})};
 const record={_id:'event',tenant:'NEA_PRUEBAS',sessionId:'session',userId:'user',createdAt:new Date(),status:'completed',message:'Consulta',reply:'Respuesta'};
 const id=await syncPilotRecord(db,record);await syncPilotRecord(db,record);assert.equal(docs.size,1);assert.equal(msgs.size,2);assert.equal(docs.get(String(id)).tenantId,'NEA_PRUEBAS');assert.equal(docs.get(String(id)).isTest,true);
 docs.get(String(id)).finalized=true;await syncPilotRecord(db,record);assert.equal(docs.get(String(id)).finalized,true);
 await syncPilotRecord(db,{...record,tenant:'NEA'});assert.equal(docs.size,1);
 await syncPilotRecord(db,{...record,_id:'later',createdAt:new Date(Date.now()+1000)});assert.equal(docs.get(String(id)).finalized,false);
});
