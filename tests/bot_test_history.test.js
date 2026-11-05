const test=require('node:test'),assert=require('node:assert/strict');
const {beginTestRecord,finishTestRecord}=require('../bot_test_history');
test('pilot persists query/reply with scoped identity and no runtime secrets',async()=>{
 let doc,filter,update;
 const collection={insertOne:async d=>{doc=d;return {insertedId:1}},updateOne:async(f,u)=>{filter=f;update=u.$set}};
 const db={collection:n=>{assert.equal(n,'bot_test_history');return collection}};
 const record=await beginTestRecord(db,{tenant:'NEA_PRUEBAS',sessionId:'synthetic',message:'Consulta ficticia',userId:'tester',model:'test',apiKey:'never-store'});
 assert.equal(doc.status,'pending');assert.equal(doc.apiKey,undefined);
 await finishTestRecord(record,{reply:'Respuesta ficticia',durationMs:12});
 assert.deepEqual(filter,{_id:1,tenant:'NEA_PRUEBAS'});assert.equal(update.reply,'Respuesta ficticia');assert.equal(update.status,'completed');
 await finishTestRecord(record,{error:true,durationMs:13});assert.equal(update.status,'failed');assert.equal(update.reply,undefined);
});
test('real domains never create records',async()=>{
 for(const tenant of ['NEA','NEA2','MCN','OTHER'])assert.equal(await beginTestRecord({collection:()=>{throw Error('must not access')}},{tenant}),null);
});
test('persistence failures are not swallowed',async()=>{
 await assert.rejects(beginTestRecord({collection:()=>({insertOne:async()=>{throw Error('unavailable')}})},{tenant:'NEA_PRUEBAS'}),/unavailable/);
});
