// Asisto | Objective grouping contracts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGroups, enabled } = require('../src/support/task_grouping');
const { asistoTitleAnalyzer } = require('../src/support/title_analyzer');
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
