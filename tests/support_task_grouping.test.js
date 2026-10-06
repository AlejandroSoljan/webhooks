// Asisto | Objective grouping contracts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGroups, enabled } = require('../src/support/task_grouping');
const { asistoTitleAnalyzer } = require('../src/support/title_analyzer');
const { incrementalInput } = require('../src/support/task_grouping');
test('incremental grouping retains old memberships and sends only bounded context plus new messages', () => {
  const rows=Array.from({length:41},(_,i)=>({_id:String(i),text:'x'.repeat(1000),at:new Date(i),fromMe:false}));
  const sig=rows.map(r=>r._id);
  const cached={signatures:sig.slice(0,40),groups:[Array.from({length:40},(_,i)=>i)]};
  const units=incrementalInput(rows,cached,sig,[{messageIds:['0'],text:'Resolver facturación'}]);
  assert.equal(units.length,2);
  assert.equal(units[0].indices.length,40);
  assert.match(units[0].text,/Resolver facturación/);
  assert.ok(units[0].text.length<1500);
  assert.equal(units[1].text,rows[40].text);
  assert.equal(incrementalInput(rows,cached,['changed',...sig.slice(1)]),null);
  assert.equal(incrementalInput(rows,{},sig),null);
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
