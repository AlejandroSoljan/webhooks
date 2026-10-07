// Asisto | Objective grouping contracts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGroups, enabled, VERSION, automaticNotice } = require('../src/support/task_grouping');
const { asistoTitleAnalyzer } = require('../src/support/title_analyzer');
const { incrementalInput } = require('../src/support/task_grouping');
test('strict task status does not close an unresolved request on courtesy thanks', () => {
  const { analyze } = require('../src/support/core');
  const rows=['No envía comprobantes','Lo reviso','Gracias'].map((text,i)=>({_id:String(i),text,fromMe:i===1,at:new Date(i)}));
  assert.equal(analyze(rows,{strictResolution:true}).status,'En Proceso');
  assert.equal(analyze([...rows,{_id:'4',text:'Ya funciona',fromMe:false,at:new Date(4)}],{strictResolution:true}).status,'Cerrado RESUELTO');
});
test('incremental grouping retains old memberships and sends only bounded context plus new messages', () => {
  const rows=Array.from({length:41},(_,i)=>({_id:String(i),text:'x'.repeat(1000),at:new Date(i),fromMe:false}));
  const sig=rows.map(r=>r._id);
  const cached={version:VERSION,signatures:sig.slice(0,40),groups:[Array.from({length:40},(_,i)=>i)]};
  const units=incrementalInput(rows,cached,sig,[{messageIds:['0'],text:'Resolver facturación'}]);
  assert.equal(units.length,2);
  assert.equal(units[0].indices.length,40);
  assert.doesNotMatch(units[0].text,/Resolver facturación/);
  assert.ok(units[0].text.length<2700);
  assert.equal(units[1].text,rows[40].text);
  assert.equal(incrementalInput(rows,cached,['changed',...sig.slice(1)]),null);
  assert.equal(incrementalInput(rows,{},sig),null);
});
test('short conversations and obsolete caches use original evidence rather than generated summaries', () => {
  const rows=[{_id:'1',text:'No salen comprobantes',at:new Date(),fromMe:false}];
  assert.equal(incrementalInput(rows,{version:VERSION,signatures:['1'],groups:[[0]]},['1']),null);
  assert.equal(incrementalInput([{...rows[0],text:'x'.repeat(13000)}],{signatures:['1'],groups:[[0]]},['1']),null);
  assert.equal(automaticNotice({fromMe:true,text:'ESTE ES UN MENSAJE AUTOMATICO\nEstoy fuera de mi horario laboral (Lunes a Viernes)'}),true);
  assert.equal(automaticNotice({fromMe:false,text:'Estoy fuera de horario, necesito ayuda'}),false);
});
test('grounded summary retains the beginning and prohibits invented actions and courtesy closure', async () => {
  let payload;
  const analyzer=asistoTitleAnalyzer({OPENAI_API_KEY_TAREAS_WS:'test'},{runtimeFor:async()=>({}),configFor:async()=>({}),clientFor:()=>({chat:{completions:{create:async p=>{payload=p;return {choices:[{message:{content:JSON.stringify({subject:'Revisar envío',description:'Sin confirmación de resolución.'})}}]};}}}})});
  await analyzer.run([{text:'PEDIDO ORIGINAL '+ 'x'.repeat(31000),fromMe:false}],{tenantId:'ALSO'});
  assert.match(payload.messages.at(-1).content,/PEDIDO ORIGINAL/);
  assert.match(payload.messages.filter(m=>m.role==='system').at(-1).content,/No completes huecos/);
  assert.match(payload.messages.filter(m=>m.role==='system').at(-1).content,/NO prueban resolución/);
});
const messages = ['No puedo ingresar', 'Ya ingresé, necesito facturar', 'También revisar el precio', 'Otra vez el código se borra'].map((text,i) => ({_id: String(i), text, at:new Date(1000*i), fromMe:false}));
test('complete independent objectives can include non-adjacent messages', () => {
  assert.deepEqual(validateGroups([[0,3],[1,2]], messages).map(g => g.map(m=>m._id)), [['0','3'],['1','2']]);
});
test('missing, repeated, invented and empty assignments fail without dropping evidence', () => {
  for (const groups of [null, [], [[0,1]], [[0,1,2,3,3]], [[0,1,2,4]], [[0,1,2,3],[]]]) assert.throws(()=>validateGroups(groups,messages), /task_grouping_invalid/);
});
test('scope excludes unrelated bots including MCN', () => {
  for (const tenant of ['ALSO','DEMJG','SANA']) assert.equal(enabled(tenant),true);
  for (const tenant of ['MCN','SDG']) assert.equal(enabled(tenant),false);
});
test('grouping uses configured task model, all context and returns usage', async () => {
  let payload;
  const analyzer = asistoTitleAnalyzer({OPENAI_API_KEY_TAREAS_WS:'test'}, {configFor:async()=>({}),clientFor:()=>({chat:{completions:{create:async p=>{
    payload=p; return {choices:[{message:{content:'{"groups":[[0],[1,2,3]]}'}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};
  }}}})});
  const result=await analyzer.group(messages,{tenantId:'ALSO'});
  assert.equal(payload.model,'gpt-4o-mini');
  assert.equal(JSON.parse(payload.messages[1].content).length,4);
  assert.match(payload.messages[0].content,/NO justifican/);
  assert.equal(result.totalTokens,120);
  assert.equal(validateGroups(result.groups,messages).length,2);
});
