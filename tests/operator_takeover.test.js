// Asisto | 2026-10-02 | Operator takeover before any AI conversation exists.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../endpoint'),'utf8');
const start=source.indexOf("app.post('/api/ext/wweb/agent/operator-message'");
const fnStart=source.indexOf('async (req, res) => {',start);
const fnEnd=source.indexOf('\n});',fnStart);
test('first manual message creates history and sets the configured pause',async()=>{
  const saved=[];let update;let result;let created=0;
  const handler=vm.runInNewContext('('+source.slice(fnStart,fnEnd+2)+')',{
    console,Date,
    getRuntimeByWwebPhone:async()=>({whatsappTransport:'wweb',wwebBotLogicMode:'chatgpt'}),
    normalizeWhatsappTransport:x=>x,normalizeWwebBotLogicMode:x=>x,
    getDb:async()=>({collection:()=>({findOne:async()=>null,updateOne:async(q,u)=>{update=u;}})}),
    loadBehaviorConfigFromMongo:async()=>({operator_pause_minutes:15}),
    behaviorMinutes:Number,wwebOperatorPhoneVariants:x=>[x],
    upsertConversation:async()=>{created++;return {_id:'test-conv',waId:'123'};},
    saveMessageDoc:async message=>saved.push(message),normalizeTransferFlowStatus:x=>x
  });
  const before=Date.now();
  const res={json:x=>{result=x;},status:()=>res};
  await handler({body:{tenantId:'TEST',Tel_Destino:'456',Tel_Origen:'123',Mensaje:'Sí, lo agregamos',MessageId:'manual-1'},headers:{}},res);
  assert.equal(created,1);assert.equal(result.recorded,true);
  assert.equal(saved[0].content,'Sí, lo agregamos');assert.equal(saved[0].meta.from,'wweb_phone_operator');
  assert.equal(update.$set.manualOpen,true);
  assert.ok(update.$set.manualPauseUntil.getTime()>=before+15*60000);
});
