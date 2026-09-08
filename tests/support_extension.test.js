// Asisto | Version: 5.00.069 | Fecha: 2026-09-08
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
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
const metadata = { pipelines:[{id:'p',stages:[{id:'s'}]}], properties:['subject','content','hs_pipeline','hs_pipeline_stage','category','error','channel'].map(name=>({name,type:'string'})), associationTypes:{companies:[],contacts:[]} };
const mapping = {pipelineId:'p',stageId:'s',fields:{category:{property:'category'},errorType:{property:'error'},channel:{property:'channel'}}};
before(async()=>{
 mongo=await MongoMemoryServer.create(); client=await new MongoClient(mongo.getUri()).connect(); db=client.db('extension');
 const app=express(); app.use((req,res,next)=>{req.user={uid:req.headers['test-user']||scope.userId,tenantId:req.headers['test-tenant']||scope.tenantId,role:req.headers['test-role']||'user',allowedPages:['support']};next();});
 app.use(createExtensionRouter({getService:async()=>service,hubspotFactory:()=>remote}));
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await client.close();await mongo.stop();});
beforeEach(async()=>{
 await db.dropDatabase();service=new SupportService(db,vault);writes=[];
 remote={metadata:async()=>metadata,request:async()=>({portalId:123}),prepare:(f,m,p)=>new HubSpotContract('unused').prepare(f,m,p),save:async(payload,ticketId)=>{writes.push({payload,ticketId});return{id:ticketId||'99'};}};
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
test('index contains contact labels and counts, respects exclusions and omits private task contents',async()=>{
 await service.col('contacts').insertOne({_id:scopedId(scope,'contact','123@lid'),...scope,jid:'123@lid',name:'Juan',aliases:['123@lid','549111@s.whatsapp.net']});
 const result=await call('/index');assert.equal(result.data.chats[0].name,'Juan');assert.equal(result.data.chats[0].count,1);assert.ok(!JSON.stringify(result).includes(fields.description));
 await service.saveConfig(scope,{excludedNames:['Juan']});assert.equal((await call('/index')).data.chats.length,0);
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).data.error,'conversation_excluded');
});
test('visible WhatsApp contact names enrich existing owned chats but never create foreign contacts',async()=>{
 assert.equal((await call('/contact',{jid:'123@lid',name:'Nombre de WhatsApp'})).data.saved,true);
 assert.equal((await call('/index')).data.chats[0].name,'Nombre de WhatsApp');
 assert.equal((await call('/contact',{jid:'123@lid',name:'Ajeno'},{'test-user':'other'})).data.saved,false);
 assert.equal(await service.col('contacts').countDocuments(),1);
 const saved=await service.col('drafts').findOne({_id:id});assert.equal(vault.open(saved.fields,id).contact,'Contacto WhatsApp');
});
test('publish creates once and subsequent explicit saves update the same HubSpot ticket',async()=>{
 let result=await call('/drafts/'+id+'/publish',{revision:1,mapping});assert.equal(result.status,200);assert.equal(result.data.ticketId,'99');
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).status,409);
 result=await call('/drafts/'+id+'/save',{revision:2,fields:{description:'Ampliado'}});assert.equal(result.status,200);
 result=await call('/drafts/'+id+'/publish',{revision:3,mapping});assert.equal(result.status,200);assert.equal(writes.length,2);assert.equal(writes[0].ticketId,undefined);assert.equal(writes[1].ticketId,'99');assert.match(writes[1].payload.properties.content,/Ampliado/);assert.match(writes[1].payload.properties.content,/Contacto WhatsApp/);
});
test('in-flight delivery blocks duplicate publishing and editing; uncertain outcomes cannot create again',async()=>{
 let release, started;const entered=new Promise(resolve=>started=resolve);remote.save=async()=>{started();await new Promise(resolve=>release=resolve);throw Error('network_timeout');};
 const first=call('/drafts/'+id+'/publish',{revision:1,mapping});await entered;
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).status,409);
 assert.equal((await call('/drafts/'+id+'/save',{revision:1,fields:{subject:'race'}})).status,409);
 release();assert.equal((await first).data.error,'hubspot_delivery_unconfirmed');
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).status,409);
});
test('confirmed rejection can retry and only admins can save encrypted connection tokens',async()=>{
 remote.save=async()=>{const e=Error('rejected');e.remoteStatus=400;throw e;};
 assert.equal((await call('/drafts/'+id+'/publish',{revision:1,mapping})).data.error,'hubspot_request_failed');
 assert.equal((await service.col('drafts').findOne({_id:id})).hubspot.state,'failed');
 assert.equal((await call('/hubspot/connect',{token:'private-token'})).status,403);
 const result=await call('/hubspot/connect',{token:'private-token'},{'test-role':'admin'});assert.equal(result.status,200);assert.ok(!JSON.stringify(result).includes('private-token'));
 const integration=await service.col('integrations').findOne({tenantId:scope.tenantId});assert.equal(vault.open(integration.token,hash(scope.tenantId,'hubspot')),'private-token');
});
test('HubSpot transport uses POST for new tickets, PATCH for existing tickets and preserves rejection status',async()=>{
 const calls=[];const contract=new HubSpotContract('test',async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({id:'99'})};});
 await contract.save({properties:{subject:'A'},associations:[]});await contract.save({properties:{subject:'B'},associations:[]},'99');
 assert.equal(calls[0].options.method,'POST');assert.equal(calls[1].options.method,'PATCH');assert.equal(calls[1].url,'https://api.hubapi.com/crm/v3/objects/tickets/99');assert.equal(JSON.parse(calls[1].options.body).associations,undefined);
 await assert.rejects(()=>new HubSpotContract('test',async()=>({ok:false,status:403})).save({properties:{}}),e=>e.remoteStatus===403);
});
test('contact matching handles aliases and refuses ambiguous equal names',()=>{
 const chats=[{jid:'1@lid',aliases:['5491@s.whatsapp.net'],name:'Juan',count:2},{jid:'2@lid',name:'Juan',count:1}];
 assert.equal(matchContact(chats,{name:'Juan'}),null);assert.equal(matchContact(chats,{jid:'5491@s.whatsapp.net',name:'Juan'}).count,2);
 assert.equal(matchContact(chats,{name:'Juana'}),null);assert.equal(matchContact(chats.slice(0,1),{name:' JUAN '}).jid,'1@lid');
 assert.equal(matchContact(chats,{jid:'999@lid',name:'Juan'}),null);
 assert.equal(matchContact([{jid:'5493415551234@s.whatsapp.net',count:1}],{name:'+54 9 341 555-1234'}).count,1);
});
test('background restricts WhatsApp messages to the index/open actions and keeps grants outside the page',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');let listener,action;const calls=[],opened=[],selections=[];
 const chrome={runtime:{id:extensionId,getURL:p=>'chrome-extension://'+extensionId+'/'+p,onMessage:{addListener:fn=>listener=fn}},sidePanel:{open:args=>{opened.push(args);return Promise.resolve();}},storage:{session:{set:async value=>selections.push(value)}},action:{onClicked:{addListener:fn=>action=fn}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extensions/whatsapp-support/background.js'),'utf8'),{chrome,AbortSignal,fetch:async(url,options)=>{calls.push({url,options});return{ok:true,headers:{get:()=> 'application/json'},json:async()=>url.endsWith('/session')?{...scope,csrf:'private-grant'}:{chats:[]}};}});
 assert.equal(opened.length,0);const sender={id:extensionId,url:'https://web.whatsapp.com/',tab:{id:7}};
 assert.equal(listener({action:'PUBLISH',id},sender,()=>{}),false);assert.equal(calls.length,0);
 const index=await new Promise(resolve=>listener({action:'INDEX'},sender,resolve));assert.ok(!JSON.stringify(index).includes('private-grant'));
 await new Promise(resolve=>listener({action:'OPEN',jid:'123@lid',name:'Juan'},sender,resolve));assert.equal(opened[0].tabId,7);assert.equal(selections[0]['selection-7'].jid,'123@lid');
 await new Promise(resolve=>listener({action:'SAVE',id,revision:1,fields:{}},{id:extensionId,url:chrome.runtime.getURL('panel.html')},resolve));
 const save=calls.at(-1);assert.equal(save.options.headers['X-Asisto-Extension'],'private-grant');assert.equal(save.options.credentials,'include');assert.match(save.url,/^https:\/\/asistobot\.com\.ar\/api\/support\/extension\//);
 assert.equal(typeof action,'function');
});
