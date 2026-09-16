// Asisto | Version: 5.00.080 | Fecha: 2026-09-09
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { createVault } = require('../src/support/crypto');
const { SupportService } = require('../src/support/service');
const { createExtensionRouter } = require('../src/support/extension');
const { HubSpotContract } = require('../src/support/hubspot');
const { hash, scopedId } = require('../src/support/core');
const { matchContact } = require('../extensions/whatsapp-support/matcher');
let mongo, client, db, service, server, base, remote, writes;
const scope = { tenantId: 'tenant-a', userId: 'user-a' }, id = 'd'.repeat(64), extensionId = 'a'.repeat(32);
const vault = createVault({ test: Buffer.alloc(32, 7).toString('base64') }, 'test');
const fields = { subject:'Consulta de stock', description:'Solicitud y respuesta', company:'Empresa de prueba', contact:'Contacto WhatsApp', category:'Soporte Remoto', errorType:'Consulta', channel:'WhatsApp', messageDate:'2026-09-08T12:00:00Z', proposedAction:'review' };
const metadata = { pipelines:[{id:'p',stages:[{id:'s'}]}], owners:[{id:'owner-1',firstName:'Alejandro',lastName:'Soljan',email:'alejandro@example.test'}], properties:['subject','content','hs_pipeline','hs_pipeline_stage','hubspot_owner_id','category','error','channel'].map(name=>({name,type:'string'})), associationTypes:{companies:[],contacts:[]} };
const mapping = {ownerId:'owner-1',pipelineId:'p',stageId:'s',fields:{category:{property:'category'},errorType:{property:'error'},channel:{property:'channel'}}};
before(async()=>{
 mongo=await MongoMemoryServer.create(); client=await new MongoClient(mongo.getUri()).connect(); db=client.db('extension');
 const app=express(); app.use((req,res,next)=>{req.user={uid:req.headers['test-user']||scope.userId,tenantId:req.headers['test-tenant']||scope.tenantId,role:req.headers['test-role']||'user',allowedPages:['support']};next();});
 app.use(createExtensionRouter({getService:async()=>service,hubspotFactory:()=>remote}));
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await client.close();await mongo.stop();});
beforeEach(async()=>{
 await db.dropDatabase();service=new SupportService(db,vault);writes=[];
 remote={metadata:async()=>metadata,preflight:async()=>({portalId:'123',metadata}),search:async()=>({results:[]}),request:async()=>({portalId:123}),ticket:async()=>({properties:{content:'Descripción anterior'}}),findSimilarOpenTicket:async()=>null,prepare:(f,m,p)=>new HubSpotContract('unused').prepare(f,m,p),save:async(payload,ticketId)=>{writes.push({payload,ticketId});return{id:ticketId||'99'};}};
 await service.col('integrations').insertOne({tenantId:scope.tenantId,token:vault.seal('secret',hash(scope.tenantId,'hubspot')),portalId:'123'});
 await service.col('drafts').insertOne({_id:id,...scope,jid:'123@lid',revision:1,mode:'approval',state:'pending',messageIds:[],fields:vault.seal(fields,id),source:vault.seal(fields,id+':source')});
});
async function call(path,body,extra={}) {
 const headers={'X-Asisto-Extension-Id':extensionId,Origin:'chrome-extension://'+extensionId,...extra};
 if(body){const r=await fetch(base+'/session',{headers});const session=await r.json();headers['X-Asisto-Extension']=session.csrf;headers['Content-Type']='application/json';}
 const response=await fetch(base+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};
}
test('extension requires the session origin, scoped grant and access to the draft',async()=>{
 assert.equal((await fetch(base+'/session')).status,403);
 assert.equal((await call('/session',null,{Origin:'https://evil.example'})).status,403);
 const session=(await call('/session')).data;
 let response=await fetch(base+'/drafts/'+id+'/save',{method:'POST',headers:{'Content-Type':'application/json','X-Asisto-Extension-Id':extensionId,'X-Asisto-Extension':session.csrf,'test-user':'other'},body:JSON.stringify({revision:1,fields:{subject:'wrong'}})});
 assert.equal(response.status,403);
 assert.equal((await call('/drafts/'+id,null,{'test-tenant':'other'})).status,404);
 assert.equal((await call('/drafts/'+id+'/save',{revision:1,fields:{subject:'Editado'}})).status,200);
 const expired=Buffer.from(JSON.stringify(vault.seal({...scope,origin:'chrome-extension://'+extensionId,expires:0},'extension-csrf'))).toString('base64url');
 response=await fetch(base+'/drafts/'+id+'/save',{method:'POST',headers:{'Content-Type':'application/json','X-Asisto-Extension-Id':extensionId,'X-Asisto-Extension':expired},body:'{}'});assert.equal(response.status,403);
});
test('approved desktop authorization lets the extension connect without a web login',async()=>{
 const token='D'.repeat(43), userId=new ObjectId();
 await db.collection('users').insertOne({_id:userId,tenantId:'desktop-tenant',role:'user',allowedPages:['support']});
 await service.col('devices').insertOne({_id:hash(token),tenantId:'desktop-tenant',userId:String(userId),state:'approved',expiresAt:new Date(Date.now()+60000)});
 const response=await fetch(base+'/session',{headers:{Authorization:'Bearer '+token,'X-Asisto-Extension-Id':extensionId,Origin:'chrome-extension://'+extensionId}});
 assert.equal(response.status,200); assert.equal((await response.json()).tenantId,'desktop-tenant');
});
test('extension session exposes the existing Asisto classifications as dropdown choices',async()=>{
 const result=await call('/session');
 assert.ok(result.data.choices.status.includes('En Proceso'));
 assert.ok(result.data.choices.category.includes('Soporte Remoto'));
 assert.ok(result.data.choices.errorType.includes('Consulta / Capacitacion'));
 assert.deepEqual(result.data.choices.channel,['Telefono','Email','WhatsApp','Reunion','Interno']);
});
test('contact control excludes aliases for this user and restores monitoring without deleting tickets',async()=>{
 await service.col('contacts').insertOne({...scope,jid:'123@lid',name:'Esther (local)',aliases:['123@lid','549123@s.whatsapp.net']});
 let rows=(await call('/contact-control?q=%28local%29')).data;assert.equal(rows.length,1);assert.equal(rows[0].excluded,false);
 assert.equal((await call('/contact-control',{jid:'123@lid',excluded:true},{'test-user':'other'})).status,404);
 assert.equal((await call('/contact-control',{jid:'123@lid',excluded:true})).status,200);
 assert.equal((await call('/index')).data.chats.length,0);
 assert.equal((await call('/drafts?jid=123%40lid')).data.length,0);
 assert.equal((await call('/messages?jid=549123%40s.whatsapp.net')).data.excluded,true);
 assert.equal((await call('/messages/assign',{jid:'123@lid',messageIds:['test'],destination:'new'})).data.error,'conversation_excluded');
 assert.deepEqual(await service.ingest(scope,{id:'excluded',jid:'549123@s.whatsapp.net',at:new Date(),text:'Necesito ayuda'}),{ignored:true});
 assert.equal(await service.col('drafts').countDocuments(scope),1);
 assert.equal((await call('/contact-control',{jid:'549123@s.whatsapp.net',excluded:false})).status,200);
 assert.equal((await call('/index')).data.chats[0].count,1);
 assert.equal((await call('/contact-control')).data[0].excluded,false);
 await service.saveConfig({...scope,userId:'*'},{excludedJids:['123@lid']});
 assert.equal((await call('/contact-control')).data[0].locked,true);
 await call('/contact-control',{jid:'123@lid',excluded:false});
 assert.equal((await call('/contact-control')).data[0].excluded,true);
});
test('index contains contact labels and counts, respects exclusions and omits private task contents',async()=>{
 await service.col('contacts').insertOne({_id:scopedId(scope,'contact','123@lid'),...scope,jid:'123@lid',name:'Juan',aliases:['123@lid','549111@s.whatsapp.net']});
 const result=await call('/index');assert.equal(result.data.chats[0].name,'Juan');assert.equal(result.data.chats[0].count,1);assert.ok(!JSON.stringify(result).includes(fields.description));
 await service.saveConfig(scope,{excludedNames:['Juan']});assert.equal((await call('/index')).data.chats.length,0);
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).data.error,'conversation_excluded');
});
test('task indicator remains pending until HubSpot save or explicit dismissal',async()=>{
 assert.equal((await call('/index')).data.chats[0].count,1);
 assert.equal((await call('/drafts/'+id+'/save',{revision:1,fields:{subject:'Editado'}})).status,200);
 assert.equal((await call('/index')).data.chats[0].count,1);
 assert.equal((await call('/drafts/'+id+'/dismiss',{revision:2})).status,200);
 assert.equal((await call('/index')).data.chats.length,0);
});
test('saved tasks stay available and new source messages restore their pending indicator without duplicating tickets',async()=>{
 await service.col('drafts').updateOne({_id:id},{$set:{hubspot:{state:'saved',ticketId:'48435078214'},sourceChanged:false}});
 let tasks=(await call('/drafts?jid=123%40lid')).data;
 assert.equal(tasks.length,0);
 assert.equal((await call('/drafts/'+id)).data.hubspot.ticketId,'48435078214');
 assert.equal((await call('/index')).data.chats.length,0);
 await service.col('drafts').updateOne({_id:id},{$set:{sourceChanged:true,reconciliationRequired:true}});
 tasks=(await call('/drafts?jid=123%40lid')).data;
 assert.equal(tasks[0].status,'pending');assert.equal(tasks[0].hubspot.ticketId,'48435078214');
 assert.equal((await call('/index')).data.chats[0].count,1);
 assert.equal(await service.col('drafts').countDocuments(scope),1);
 await service.col('drafts').updateOne({_id:id},{$set:{state:'ignored'}});
 assert.equal((await call('/drafts?jid=123%40lid')).data.length,0);
 assert.equal((await call('/index')).data.chats.length,0);
 assert.equal((await call('/messages?jid=123%40lid')).data.tasks[0].status,'discarded');
});
test('task can wait for the tenant HubSpot connection without losing its indicator',async()=>{
 await service.col('integrations').deleteMany({tenantId:scope.tenantId});
 assert.deepEqual((await call('/hubspot')).data,{configured:false});
 const queued=await call('/drafts/'+id+'/queue',{revision:1});assert.equal(queued.status,200);assert.equal(queued.data.revision,2);
 const row=await service.col('drafts').findOne({_id:id});assert.equal(row.hubspot.state,'awaiting_configuration');
 assert.equal((await call('/index')).data.chats[0].count,1);
});
test('extension searches HubSpot companies without exposing the configured credential',async()=>{
 remote.search=async(type,query,limit)=>({results:[{id:'company-1',properties:{name:'Empresa Uno',domain:'empresa.test'}}],type,query,limit});
 const result=await call('/hubspot/search?type=companies&q=Empresa');
 assert.equal(result.status,200);assert.equal(result.data.results[0].id,'company-1');assert.equal(result.data.results[0].properties.name,'Empresa Uno');assert.ok(!JSON.stringify(result).includes('secret'));
});
test('confirmed browser creation closes the indicator without requiring the HubSpot API',async()=>{
 await service.col('integrations').deleteMany({tenantId:scope.tenantId});
 let queued=await call('/drafts/'+id+'/queue',{revision:1});
 const completed=await call('/drafts/'+id+'/manual-complete',{revision:queued.data.revision,ticketId:'manual-123'});
 assert.equal(completed.status,200);assert.equal(completed.data.method,'browser_extension');
 assert.equal((await call('/index')).data.chats.length,0);
 const row=await service.col('drafts').findOne({_id:id});assert.equal(row.state,'approved');assert.equal(row.hubspot.ticketId,'manual-123');
});
test('visible WhatsApp contact names enrich existing owned chats but never create foreign contacts',async()=>{
 assert.equal((await call('/contact',{jid:'123@lid',name:'Nombre de WhatsApp'})).data.saved,true);
 assert.equal((await call('/index')).data.chats[0].name,'Nombre de WhatsApp');
 assert.equal((await call('/contact',{jid:'123@lid',name:'Ajeno'},{'test-user':'other'})).data.saved,false);
 assert.equal(await service.col('contacts').countDocuments(),1);
 const saved=await service.col('drafts').findOne({_id:id});assert.equal(vault.open(saved.fields,id).contact,'Contacto WhatsApp');
});
test('WhatsApp address-book batches add names only to the current users existing task chats',async()=>{
 await service.col('drafts').insertOne({_id:'e'.repeat(64),...scope,jid:'456@s.whatsapp.net',revision:1,state:'pending',fields:vault.seal(fields,'e'.repeat(64)),source:vault.seal(fields,'e'.repeat(64)+':source')});
 const result=await call('/contacts',{contacts:[{jid:'123@lid',name:'Vane',aliases:['123@lid','549123@s.whatsapp.net']},{jid:'456@s.whatsapp.net',name:'Gime',aliases:['456@s.whatsapp.net']},{jid:'999@lid',name:'Ajeno',aliases:['999@lid']}]});
 assert.equal(result.status,200);assert.equal(result.data.saved,2);
 const index=(await call('/index')).data.chats;assert.equal(index.find(row=>row.jid==='123@lid').name,'Vane');assert.equal(index.find(row=>row.jid==='456@s.whatsapp.net').name,'Gime');
 assert.equal(await service.col('contacts').countDocuments({jid:'999@lid'}),0);
});
test('message selection creates a draft when the chat has no pending task and is idempotent',async()=>{
 await service.col('drafts').deleteMany({});
 await service.ingest(scope,{id:'wa-1',jid:'123@lid',fromMe:false,name:'Vane',at:new Date('2026-09-10T10:00:00Z'),text:'Necesito configurar una impresora'});
 let result=await call('/messages/assign',{jid:'123@lid',messageIds:['wa-1'],destination:'new'});
 assert.equal(result.status,200);assert.equal(result.data.created,true);const draftId=result.data.draftId;
 result=await call('/messages/assign',{jid:'123@lid',messageIds:['wa-1'],destination:draftId});
 assert.equal(result.status,200);assert.equal(result.data.assigned,0);assert.equal(await service.col('drafts').countDocuments({jid:'123@lid'}),1);
 const overview=(await call('/messages?jid=123%40lid')).data;assert.equal(overview.messages[0].assignments[0].draftId,draftId);assert.equal(overview.messages[0].assignments[0].status,'pending');
});
test('message assignments are visible and selectable through either WhatsApp contact alias',async()=>{
 await service.col('contacts').insertOne({_id:scopedId(scope,'contact','123@lid'),...scope,jid:'123@lid',name:'Vane',aliases:['123@lid','549123@s.whatsapp.net']});
 await service.ingest(scope,{id:'alias-message',jid:'549123@s.whatsapp.net',fromMe:false,name:'Vane',at:new Date('2026-09-10T10:00:00Z'),text:'Necesito configurar una impresora'});
 const stored=await service.col('messages').findOne({...scope,id:'alias-message'});
 await service.col('drafts').updateOne({_id:id},{$set:{messageIds:[stored._id]}});
 const overview=(await call('/messages?jid=549123%40s.whatsapp.net')).data;
 assert.equal(overview.tasks.length,1);assert.equal(overview.messages[0].assignments[0].draftId,id);
 const result=await call('/messages/assign',{jid:'549123@s.whatsapp.net',messageIds:['alias-message'],destination:id});
 assert.equal(result.status,200);assert.equal(result.data.assigned,0);
});
test('message selection appends to one chosen task and preserves manual edits',async()=>{
 await service.ingest(scope,{id:'wa-2',jid:'123@lid',fromMe:false,name:'Vane',at:new Date('2026-09-10T11:00:00Z'),text:'También debe imprimir por TSPrint'});
 await service.col('drafts').updateOne({_id:id},{$set:{events:[{action:'edited'}],fields:vault.seal({...fields,subject:'Título escrito por el usuario',description:'Detalle manual'},id),messageIds:[]}});
 const result=await call('/messages/assign',{jid:'123@lid',messageIds:['wa-2'],destination:id});assert.equal(result.status,200);assert.equal(result.data.assigned,1);
 const row=await service.col('drafts').findOne({_id:id}),saved=vault.open(row.fields,id);assert.equal(saved.subject,'Título escrito por el usuario');assert.match(saved.description,/Detalle manual/);assert.match(saved.description,/Actualización:/);assert.equal(row.events.at(-1).action,'messages_assigned_existing');
});
test('multiple pending tasks require an explicit destination and reassignment is audited',async()=>{
 const other='f'.repeat(64);await service.col('drafts').insertOne({_id:other,...scope,jid:'123@lid',revision:1,state:'pending',messageIds:[],fields:vault.seal({...fields,subject:'Segunda tarea'},other),source:vault.seal(fields,other+':source'),events:[{action:'generated'}]});
 await service.ingest(scope,{id:'wa-3',jid:'123@lid',fromMe:false,name:'Vane',at:new Date('2026-09-10T12:00:00Z'),text:'Revisar el servidor'});
 assert.equal((await call('/messages/assign',{jid:'123@lid',messageIds:['wa-3'],destination:''})).status,404);
 let result=await call('/messages/assign',{jid:'123@lid',messageIds:['wa-3'],destination:id});assert.equal(result.status,200);
 result=await call('/messages/assign',{jid:'123@lid',messageIds:['wa-3'],destination:other});assert.equal(result.data.error,'message_already_assigned');
 result=await call('/messages/assign',{jid:'123@lid',messageIds:['wa-3'],destination:other,reassign:true});assert.equal(result.status,200);
 assert.equal((await service.col('drafts').findOne({_id:id})).messageIds.includes((await service.col('messages').findOne({id:'wa-3'}))._id),false);
 assert.equal((await service.col('drafts').findOne({_id:id})).events.at(-1).action,'messages_reassigned_out');
});
test('a saved HubSpot ticket requires an explicit follow-up action and stays visible in message status',async()=>{
 await service.col('drafts').updateOne({_id:id},{$set:{hubspot:{state:'saved',ticketId:'hs-77',portalId:'123',companyId:'',contactId:''},state:'approved',messageIds:[]}});
 await service.ingest(scope,{id:'wa-4',jid:'123@lid',fromMe:true,name:'',at:new Date('2026-09-10T13:00:00Z'),text:'Se realizó una nueva prueba'});
 let result=await call('/messages/assign',{jid:'123@lid',messageIds:['wa-4'],destination:id});assert.equal(result.data.error,'saved_ticket_action_required');
 result=await call('/messages/assign',{jid:'123@lid',messageIds:['wa-4'],destination:id,existingAction:'followup'});assert.equal(result.status,200);assert.equal(result.data.savedTicket,true);
 const overview=(await call('/messages?jid=123%40lid')).data;assert.equal(overview.messages.find(row=>row.waId==='wa-4').assignments[0].status,'pending');assert.equal(overview.tasks.find(task=>task.id===id).ticketId,'hs-77');
 const index=(await call('/index')).data;assert.equal(index.chats[0].jid,'123@lid');assert.equal(index.knownChats[0].jid,'123@lid');
 result=await call('/drafts/'+id+'/reconcile',{revision:2,fields:vault.open((await service.col('drafts').findOne({_id:id})).fields,id)});assert.equal(result.status,200);
 result=await call('/drafts/'+id+'/publish',{revision:4,mapping});assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(writes[0].ticketId,'hs-77');assert.match(writes[0].payload.properties.content,/Descripción anterior/);assert.match(writes[0].payload.properties.content,/Seguimiento desde WhatsApp/);
});
test('publish creates once and subsequent explicit saves update the same HubSpot ticket',async()=>{
 let result=await call('/drafts/'+id+'/publish',{revision:1,mapping});assert.equal(result.status,200);assert.equal(result.data.ticketId,'99');
 assert.equal((await service.col('settings').findOne(scope)).hubspotOwnerId,'owner-1');
 assert.equal((await call('/hubspot')).data.preferredOwnerId,'owner-1');
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).status,409);
 result=await call('/drafts/'+id+'/save',{revision:2,fields:{description:'Ampliado'}});assert.equal(result.status,200);
 result=await call('/drafts/'+id+'/publish',{revision:3,mapping});assert.equal(result.status,200);assert.equal(writes.length,2);assert.equal(writes[0].ticketId,undefined);assert.equal(writes[1].ticketId,'99');assert.match(writes[1].payload.properties.content,/Ampliado/);assert.match(writes[1].payload.properties.content,/Contacto WhatsApp/);
});
test('a similar open company ticket is linked without creating a duplicate',async()=>{
 remote.findSimilarOpenTicket=async()=>({id:'existing-42',properties:{subject:'Consulta de stock'}});
 const result=await call('/drafts/'+id+'/publish',{revision:1,mapping});
 assert.equal(result.status,200);assert.equal(result.data.ticketId,'existing-42');assert.equal(result.data.matched,true);assert.equal(writes.length,0);
 assert.equal((await call('/index')).data.chats.length,0);
 const row=await service.col('drafts').findOne({_id:id});assert.equal(row.hubspot.method,'matched_existing');
});
test('the extension incorporates newly analyzed messages before publishing',async()=>{
 const latest={...fields,subject:'Configurar impresora con TSPrint',description:'Se debe configurar TSPrint como impresora predeterminada.'};
 await service.col('drafts').updateOne({_id:id},{$set:{sourceChanged:true,reconciliationRequired:true,state:'needs_review',source:vault.seal(latest,id+':source')}});
 let result=await call('/drafts/'+id+'/publish',{revision:1,mapping});assert.equal(result.data.error,'source_reconciliation_required');
 result=await call('/drafts/'+id+'/reconcile',{revision:1,fields});
 assert.equal(result.status,200);assert.equal(result.data.revision,3);assert.equal(result.data.fields.subject,latest.subject);
 result=await call('/drafts/'+id+'/publish',{revision:3,mapping});assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(writes[0].payload.properties.subject,latest.subject);assert.match(writes[0].payload.properties.content,/configurar TSPrint/);
});
test('a changed source displays its current task title instead of the stale draft title',async()=>{
 const latest={...fields,subject:'Configurar impresión de comandas',description:'Conversación original',summaryDescription:'Se debe corregir la impresión de comandas.'};
 await service.col('drafts').updateOne({_id:id},{$set:{sourceChanged:true,source:vault.seal(latest,id+':source')}});
 const detail=(await call('/drafts/'+id)).data;assert.equal(detail.fields.subject,latest.subject);assert.equal(detail.source.summaryDescription,latest.summaryDescription);
});
test('opening a changed draft regenerates a stale source title from its assigned messages',async()=>{
 service.titleAnalyzer={run:async()=>({subject:'Corregir importes cobrados con tarjeta',description:'La clienta consulta diferencias en importes y recargos de pagos con tarjeta.',model:'fixture',inputTokens:12,outputTokens:7,totalTokens:19})};
 const ingested=await service.ingest(scope,{id:'wa-title',jid:'123@lid',fromMe:false,name:'Esther',at:new Date('2026-09-10T14:00:00Z'),text:'Me sigue apareciendo una diferencia en centavos con tarjeta'});
 await service.col('drafts').updateOne({_id:id},{$set:{messageIds:[ingested.id],sourceChanged:true,source:vault.seal({...fields,subject:'Título viejo de notebook'},id+':source')}});
 const detail=(await call('/drafts/'+id)).data;assert.equal(detail.fields.subject,'Corregir importes cobrados con tarjeta');assert.equal(detail.source.summaryDescription,'La clienta consulta diferencias en importes y recargos de pagos con tarjeta.');
 assert.equal(await db.collection('ai_token_usage_log').countDocuments({'meta.source':'extension_changed_source'}),1);
 await call('/drafts/'+id);
 assert.equal(await db.collection('ai_token_usage_log').countDocuments(),1);
});
test('opening a current generated summary never calls AI or changes its revision',async()=>{
 let calls=0;service.titleAnalyzer={run:async()=>{calls++;throw Error('unexpected AI call');}};
 await service.col('drafts').updateOne({_id:id},{$set:{analyzerVersion:require('../src/support/core').ANALYZER_VERSION,events:[{action:'generated'}]}});
 const first=await call('/drafts/'+id),second=await call('/drafts/'+id);
 assert.equal(first.data.revision,1);assert.equal(second.data.revision,1);assert.equal(calls,0);
});
test('in-flight delivery blocks duplicate publishing and editing; uncertain outcomes cannot create again',async()=>{
 let release, started;const entered=new Promise(resolve=>started=resolve);remote.save=async()=>{started();await new Promise(resolve=>release=resolve);throw Error('network_timeout');};
 const first=call('/drafts/'+id+'/publish',{revision:1,mapping});await entered;
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).status,409);
 assert.equal((await call('/drafts/'+id+'/save',{revision:1,fields:{subject:'race'}})).status,409);
 release();assert.equal((await first).data.error,'hubspot_delivery_unconfirmed');
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).status,409);
});
test('confirmed rejection can retry and connection secrets remain backend-managed',async()=>{
 remote.save=async()=>{const e=Error('rejected');e.remoteStatus=400;throw e;};
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).data.error,'hubspot_request_failed');
 assert.equal((await service.col('drafts').findOne({_id:id})).hubspot.state,'failed');
 assert.equal((await call('/hubspot/connect',{token:'private-token'})).status,410);
 const result=await call('/hubspot/connect',{token:'private-token'},{'test-role':'admin'});assert.equal(result.status,410);assert.ok(!JSON.stringify(result).includes('private-token'));
});
test('HubSpot transport uses POST for new tickets, PATCH for existing tickets and preserves rejection status',async()=>{
 const calls=[];const contract=new HubSpotContract('test',async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({id:'99'})};});
 await contract.save({properties:{subject:'A'},associations:[]});await contract.save({properties:{subject:'B'},associations:[]},'99');
 assert.equal(calls[0].options.method,'POST');assert.equal(calls[1].options.method,'PATCH');assert.equal(calls[1].url,'https://api.hubapi.com/crm/v3/objects/tickets/99');assert.equal(JSON.parse(calls[1].options.body).associations,undefined);
 await assert.rejects(()=>new HubSpotContract('test',async()=>({ok:false,status:403})).save({properties:{}}),e=>e.remoteStatus===403&&e.code==='hubspot_tickets_forbidden');
});
test('HubSpot preflight does not require account-info or an unused contact search',async()=>{
 const calls=[];
 const contract=new HubSpotContract('test',async(url,options)=>{
  calls.push(url);
  if(url.includes('/properties/tickets')) return {ok:true,json:async()=>({results:metadata.properties})};
  if(url.includes('/pipelines/tickets')) return {ok:true,json:async()=>({results:metadata.pipelines})};
  if(url.includes('/associations/tickets/companies/labels')) return {ok:true,json:async()=>({results:[]})};
  if(url.includes('/associations/tickets/contacts/labels')) return {ok:true,json:async()=>({results:[]})};
  if(url.includes('/owners')) return {ok:true,json:async()=>({results:metadata.owners})};
  if(url.includes('/objects/companies/search')) return {ok:true,json:async()=>({results:[]})};
  return {ok:false,status:403,json:async()=>({})};
 });
 const checked=await contract.preflight();assert.equal(checked.portalId,null);
 assert.equal(calls.some(url=>url.includes('/account-info/')),false);
 assert.equal(calls.some(url=>url.includes('/objects/contacts/search')),false);
});
test('a configured owner id avoids the owners API while retaining ticket ownership',async()=>{
 const calls=[];
 const contract=new HubSpotContract('test',async(url)=>{
  calls.push(url);
  if(url.includes('/properties/tickets')) return {ok:true,json:async()=>({results:metadata.properties})};
  if(url.includes('/pipelines/tickets')) return {ok:true,json:async()=>({results:metadata.pipelines})};
  if(url.includes('/associations/')) return {ok:true,json:async()=>({results:[]})};
  if(url.includes('/objects/companies/search')) return {ok:true,json:async()=>({results:[]})};
  return {ok:false,status:403,json:async()=>({})};
 });
 const checked=await contract.preflight('owner-fixed');
 assert.equal(checked.metadata.owners[0].id,'owner-fixed');
 assert.equal(calls.some(url=>url.includes('/owners')),false);
});
test('an owned reference ticket resolves the reusable HubSpot owner id',async()=>{
 const calls=[];
 const contract=new HubSpotContract('test',async(url)=>{calls.push(url);return {ok:true,json:async()=>({properties:{hubspot_owner_id:'owner-alejandro'}})};});
 assert.equal(await contract.ownerFromTicket('48433472163'),'owner-alejandro');
 assert.match(calls[0],/\/crm\/v3\/objects\/tickets\/48433472163\?properties=hubspot_owner_id$/);
});
test('contact matching handles aliases and refuses ambiguous equal names',()=>{
 const chats=[{jid:'1@lid',aliases:['5491@s.whatsapp.net'],name:'Juan',count:2},{jid:'2@lid',name:'Juan',count:1}];
 assert.equal(matchContact(chats,{name:'Juan'}),null);assert.equal(matchContact(chats,{jid:'5491@s.whatsapp.net',name:'Juan'}).count,2);
 assert.equal(matchContact(chats,{name:'Juana'}),null);assert.equal(matchContact(chats.slice(0,1),{name:' JUAN '}).jid,'1@lid');
 assert.equal(matchContact(chats,{jid:'999@lid',name:'Juan'}),null);
 assert.equal(matchContact([{jid:'5493415551234@s.whatsapp.net',count:1}],{name:'+54 9 341 555-1234'}).count,1);
});
test('WhatsApp contact reader exports only names and normalized identifiers from its contact store',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const messages=[];
 const rows=[{id:'123@lid',phoneNumber:'549123@c.us',name:'Vane',privateField:'never-copy'},{id:'456@lid',shortName:'Gime'},{id:'group@g.us',name:'Grupo'}];let position=0;
 const store={openCursor(){const request={};queueMicrotask(function next(){const value=rows[position++];request.result=value?{value,continue:()=>queueMicrotask(next)}:null;request.onsuccess();});return request;}};
 const db={objectStoreNames:{contains:name=>name==='contact'},transaction:()=>({objectStore:()=>store}),close(){}};
 const indexedDB={databases:async()=>[{name:'model-storage'}],open(){const request={result:db};queueMicrotask(()=>request.onsuccess());return request;}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extensions/whatsapp-support/contacts-main.js'),'utf8'),{indexedDB,location:{origin:'https://web.whatsapp.com'},window:{postMessage:(value,target)=>messages.push({value,target})},queueMicrotask});
 await new Promise(resolve=>setTimeout(resolve,20));const contacts=messages.flatMap(message=>message.value.contacts||[]);
 assert.deepEqual(JSON.parse(JSON.stringify(contacts)),[{name:'Vane',aliases:['123@lid','549123@s.whatsapp.net']},{name:'Gime',aliases:['456@lid']}]);assert.ok(!JSON.stringify(messages).includes('never-copy'));assert.ok(messages.at(-1).value.complete);
});
test('explicit selection imports missing readable messages once and preserves stored evidence', async () => {
 const jid = '123@s.whatsapp.net';
 const input = { jid, destination: 'new', messageIds: ['selected-text', 'selected-caption'], selectedMessages: [
   { id: 'selected-text', jid, at: '2026-09-14T14:31:00Z', fromMe: false, text: 'Hola Alejandro, buen día' },
   { id: 'selected-caption', jid, at: '2026-09-14T14:33:00Z', fromMe: false, text: 'Esta factura figura en julio pero el período difiere en ingreso de comprobantes' },
 ] };
 const first = await service.assignMessages(scope, input);
 const row = await service.col('drafts').findOne({ _id: first.draftId });
 assert.equal(row.messageIds.length, 2);
 assert.match(vault.open(row.fields, row._id).description, /factura/);
 assert.equal(await service.col('messages').countDocuments({ ...scope, historical: true }), 2);
 const again = await service.assignMessages(scope, { ...input, destination: first.draftId, selectedMessages: input.selectedMessages.map(m => ({ ...m, text: 'incorrect replacement' })) });
 assert.equal(again.assigned, 0);
 const stored = await service.col('messages').findOne({ ...scope, id: 'selected-caption' });
 assert.match(vault.open(stored.payload, stored._id).text, /factura/);
 assert.equal(await service.col('drafts').countDocuments({ _id: first.draftId }), 1);
});

test('missing selection cannot import another contact or silently omit unreadable messages', async () => {
 const input = { jid: '123@s.whatsapp.net', destination: 'new', messageIds: ['missing'], selectedMessages: [{ id: 'missing', jid: '999@s.whatsapp.net', at: '2026-09-14T14:31:00Z', text: 'Private other contact' }] };
 await assert.rejects(service.assignMessages(scope, input), /message_selection_not_found/);
 await assert.rejects(service.assignMessages(scope, { ...input, selectedMessages: [{ ...input.selectedMessages[0], jid: input.jid, text: '' }] }), /message_selection_not_found/);
 assert.equal(await service.col('messages').countDocuments(scope), 0);
});

test('extension always selects the local agent account and never falls back to a browser login', async () => {
 const vm = require('node:vm'), fs = require('node:fs');
 const listeners = [], calls = []; let available = true;
 const chrome = { runtime: { id: extensionId, getURL: p => 'chrome-extension://' + extensionId + '/' + p, onMessage: { addListener: fn => listeners.push(fn) } }, action: { onClicked: { addListener() {} } } };
 vm.runInNewContext(fs.readFileSync(require.resolve('../extensions/whatsapp-support/background.js'), 'utf8'), { chrome, AbortSignal, fetch: async (url, options) => {
   calls.push({ url, options });
   if (url.includes('127.0.0.1')) return { ok: available, status: available ? 200 : 401, headers: { get: () => 'application/json' }, json: async () => ({ token: 'A'.repeat(43) }) };
   return { ok: true, headers: { get: () => 'application/json' }, json: async () => options.credentials === 'omit' && options.headers.Authorization ? { tenantId: 'ALSO', userId: 'agent-user' } : { tenantId: 'CARICO', userId: 'browser-user' } };
 } });
 const send = () => new Promise(resolve => listeners[0]({ action: 'SESSION' }, { id: extensionId, url: chrome.runtime.getURL('panel.html') }, resolve));
 assert.equal((await send()).data.tenantId, 'ALSO');
 assert.match(calls[0].url, /127\.0\.0\.1/);
 calls.length = 0; available = false;
 assert.equal((await send()).error, 'agent_not_authorized');
 assert.equal(calls.length, 1, 'no remote browser-account fallback');
});
test('simultaneous panel requests retain their own agent token while one local login waits', async () => {
 const vm = require('node:vm'), fs = require('node:fs');
 const listeners = [], calls = [], held = []; let localCalls = 0;
 const chrome = { runtime: { id: extensionId, getURL: p => 'chrome-extension://' + extensionId + '/' + p, onMessage: { addListener: fn => listeners.push(fn) } }, action: { onClicked: { addListener() {} } }, sidePanel: { setOptions: async () => {} } };
 const json = value => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => value });
 vm.runInNewContext(fs.readFileSync(require.resolve('../extensions/whatsapp-support/background.js'), 'utf8'), { chrome, AbortSignal, fetch: (url, options) => {
   if (url.includes('127.0.0.1')) { localCalls++; return localCalls === 2 ? new Promise(resolve => held.push(() => resolve(json({ token: 'B'.repeat(43) })))) : Promise.resolve(json({ token: 'A'.repeat(43) })); }
   calls.push({ url, options }); return Promise.resolve(json(url.endsWith('/session') ? { ...scope, csrf: 'private-grant' } : { chats: [] }));
 } });
 const sender = { id: extensionId, url: chrome.runtime.getURL('panel.html') };
 const send = action => new Promise(resolve => listeners[0]({ action }, sender, resolve));
 const first = send('INDEX');
 while (!calls.some(call => call.url.endsWith('/session'))) await new Promise(resolve => setImmediate(resolve));
 const second = send('SESSION');
 while (localCalls < 2) await new Promise(resolve => setImmediate(resolve));
 assert.ok((await first).data);
 assert.equal(calls.find(call => call.url.endsWith('/index')).options.headers.Authorization, 'Bearer ' + 'A'.repeat(43));
 held[0](); assert.ok((await second).data);
});

test('background restricts WhatsApp messages, exposes the active chat and forces panel refreshes',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const listeners=[];let action;const calls=[],opened=[],selections=[],sessionStore={};let now=100;
 const chrome={runtime:{id:extensionId,getURL:p=>'chrome-extension://'+extensionId+'/'+p,onMessage:{addListener:fn=>listeners.push(fn)}},sidePanel:{setOptions:async()=>{},open:args=>{opened.push(args);return Promise.resolve();}},storage:{session:{set:async value=>{selections.push(value);Object.assign(sessionStore,value);},get:async key=>({[key]:sessionStore[key]})}},action:{onClicked:{addListener:fn=>action=fn}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extensions/whatsapp-support/background.js'),'utf8'),{chrome,AbortSignal,Date:{now:()=>++now},fetch:async(url,options)=>{calls.push({url,options});return{ok:true,headers:{get:()=> 'application/json'},json:async()=>url.includes('127.0.0.1')?{token:'A'.repeat(43)}:url.endsWith('/session')?{...scope,csrf:'private-grant'}:{chats:[]}};}});
 const listener=(message,sender,reply)=>{for(const candidate of listeners){const handled=candidate(message,sender,reply);if(handled)return handled;}return false;};
 assert.equal(opened.length,0);const sender={id:extensionId,url:'https://web.whatsapp.com/',tab:{id:7}};
 assert.equal(listener({action:'PUBLISH',id},sender,()=>{}),false);assert.equal(calls.length,0);
 const index=await new Promise(resolve=>listener({action:'INDEX'},sender,resolve));assert.ok(!JSON.stringify(index).includes('private-grant'));
 await new Promise(resolve=>listener({action:'OPEN',jid:'123@lid',name:'Juan'},sender,resolve));assert.equal(opened[0].tabId,7);assert.equal(selections[0]['selection-7'].jid,'123@lid');assert.equal(selections[0]['selection-7'].refreshAt,101);
 const active=await new Promise(resolve=>listener({action:'ACTIVE_CONTEXT'},sender,resolve));assert.equal(active.data.jid,'123@lid');
 await new Promise(resolve=>listener({action:'OPEN',jid:'123@lid',name:'Juan'},sender,resolve));assert.equal(selections[1]['selection-7'].refreshAt,102);
 await new Promise(resolve=>listener({action:'SAVE',id,revision:1,fields:{}},{id:extensionId,url:chrome.runtime.getURL('panel.html')},resolve));
 const save=calls.at(-1);assert.equal(save.options.headers['X-Asisto-Extension'],'private-grant');assert.equal(save.options.credentials,'omit');assert.equal(save.options.headers.Authorization,'Bearer '+'A'.repeat(43));assert.match(save.url,/^https:\/\/asistobot\.com\.ar\/api\/support\/extension\//);
 assert.equal(typeof action,'function');
});
