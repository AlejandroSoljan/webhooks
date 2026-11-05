const test=require('node:test'),assert=require('node:assert/strict');
const {listPilotSessions,readPilotSession}=require('../bot_test_followup');
test('denies other tenants before accessing data',async()=>{for(const t of ['MCN','NEA2','OTHER']){await assert.rejects(listPilotSessions({},t),/forbidden/);await assert.rejects(readPilotSession({},t,'id'),/forbidden/)}});
test('list restricts pilot and groups by session AND operator',async()=>{
 let pipeline;const db={collection:n=>{assert.equal(n,'bot_test_history');return {aggregate:p=>{pipeline=p;return {toArray:async()=>[]}}}}};
 await listPilotSessions(db,'NEA',{q:'.*'});assert.equal(pipeline[0].$match.tenant,'NEA_PRUEBAS');assert.deepEqual(pipeline[2].$group._id,{sessionId:'$sessionId',userId:'$userId'});assert.equal(pipeline[3].$match.search.$regex,'\\.\\*');
});
test('detail scopes anchor and complete session, with safe error and pending labels',async()=>{
 const records=[{_id:'a',message:'Uno',reply:'Dos',status:'completed'},{_id:'b',message:'Tres',status:'failed'},{_id:'c',message:'Cuatro',status:'pending'}];
 const db={collection:()=>({findOne:async q=>{assert.deepEqual(q,{_id:'anchor',tenant:'NEA_PRUEBAS'});return {sessionId:'s',userId:'u'}},find:q=>{assert.deepEqual(q,{tenant:'NEA_PRUEBAS',sessionId:'s',userId:'u'});return {sort:()=>({limit:()=>({toArray:async()=>records})})}}})};
 const result=await readPilotSession(db,'NEA','anchor');assert.equal(result.length,6);assert.equal(result[1].content,'Dos');assert.match(result[3].content,/Error/);assert.match(result[5].content,/pendiente/);
});
