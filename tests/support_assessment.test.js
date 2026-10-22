// Asisto | Version: 5.00.307 | Fecha: 2026-10-22
const {test}=require('node:test');const assert=require('node:assert/strict');
const {contextOnly,summaryDecision,repairable}=require('../src/support/task_assessment');
const {analyze}=require('../src/support/core');
const {asistoTitleAnalyzer}=require('../src/support/title_analyzer');
const rows=texts=>texts.map((text,i)=>({_id:String(i),at:new Date(1700000000000+i*60000),text,fromMe:i===1}));
test('corregido resolves a request, but coordination and subsequent failure stay open',()=>{
 assert.equal(analyze(rows(['Necesito borrar la orden','CORREGIDO']),{strictResolution:true}).status,'Cerrado RESUELTO');
 assert.notEqual(analyze(rows(['No imprime','Listo, mañana lo reviso']),{strictResolution:true}).status,'Cerrado RESUELTO');
 assert.notEqual(analyze(rows(['No imprime','Ya funciona','Todavía no funciona']),{strictResolution:true}).status,'Cerrado RESUELTO');
});
test('test and automatic notice are context, but real requests and closure are retained',()=>{
 assert.equal(contextOnly(rows(['prueba','ESTE ES UN MENSAJE AUTOMATICO\n"ESTOY FUERA DE MI HORARIO LABORAL"'])),true);
 assert.equal(contextOnly(rows(['Hola, no puedo imprimir','Gracias'])),false);
 assert.equal(contextOnly(rows(['CORREGIDO'])),false);
});
test('closed assessment requires an exact completion quote and rejects contradictions or courtesy',()=>{
 const m=rows(['No imprime','Listo, ahí está solucionado','Muchas gracias']);
 const p={status:'Cerrado RESUELTO',resolutionMessage:1,resolutionQuote:'ahí está solucionado',description:'El operador confirmó la solución.'};
 assert.equal(summaryDecision(p,m).status,'Cerrado RESUELTO');
 assert.throws(()=>summaryDecision({...p,resolutionQuote:'ya imprime perfecto'},m),/task_assessment_invalid/);
 assert.throws(()=>summaryDecision({...p,resolutionMessage:2,resolutionQuote:'Muchas gracias'},m),/task_assessment_invalid/);
 assert.throws(()=>summaryDecision({...p,description:'Sin confirmación de resolución.'},m),/task_assessment_invalid/);
});
test('repair never accepts edited, dismissed, saved or uncertain drafts',()=>{
 const row={state:'pending',events:[{action:'generated'}]};assert.equal(repairable(row),true);
 for(const change of [{events:[{action:'edited',by:'user'}]},{state:'ignored'},{hubspot:{ticketId:'42'}},{hubspot:{state:'saved'}},{hubspot:{state:'uncertain'}}])assert.equal(repairable({...row,...change}),false);
});
test('objective review joins followup blocks, retains unrelated task and meters both calls',async()=>{
 let calls=0;const analyzer=asistoTitleAnalyzer({OPENAI_API_KEY_TAREAS_WS:'fixture'},{configFor:async()=>({}),clientFor:()=>({chat:{completions:{create:async()=>({choices:[{message:{content:JSON.stringify({groups:++calls===1?[[0],[1],[2]]:[[0,1],[2]]})}}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})}}})});
 const r=await analyzer.group(rows(['No imprime cotizaciones','Al día siguiente: ya está solucionado','Otra consulta: renovar licencia']),{tenantId:'ALSO'});
 assert.deepEqual(r.groups,[[0,1],[2]]);assert.equal(calls,2);assert.equal(r.totalTokens,24);
});
test('mini grouping requests strict assignments with one slot per original message',async()=>{
 let format;const analyzer=asistoTitleAnalyzer({OPENAI_API_KEY_TAREAS_WS:'fixture'},{configFor:async()=>({}),clientFor:()=>({chat:{completions:{create:async args=>{format=args.response_format;return {choices:[{message:{content:'{"assignments":[0,0]}'}}]}}}}})});
 const r=await analyzer.group(rows(['No imprime','Ya está solucionado']),{tenantId:'ALSO'});
 assert.deepEqual(r.groups,[[0,1]]);assert.equal(format.json_schema.strict,true);assert.equal(format.json_schema.schema.properties.assignments.minItems,2);
});

test('access and availability bursts attach to the actual issue without absorbing another request',()=>{
 const {absorbCoordination}=require('../src/support/task_grouping');
 const m=rows(['Santi tengo que salir, antes de irme te lo paso','Okaa','Listo, ya está aplicada la modificación','No imprime cotizaciones','Diego pasame el delivery y nos vemos. No, no hay problema','Ah bueno listo, ahí te lo paso','Así tranqui, yo me voy y vos apaga la máquina','Ahí está solucionado','Otra consulta: necesito renovar licencia']);m[2].fromMe=true;m[4].fromMe=true;
 const groups=absorbCoordination([[0,1,2,4,5,6],[3,7],[8]],m);
 assert.deepEqual(groups,[[0,1,2,3,4,5,6,7],[8]]);
});
