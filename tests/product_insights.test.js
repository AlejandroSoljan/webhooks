// Asisto | Commercial insight semantics, privacy and hybrid authorization | 2026-10-21
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const express = require('express');
const { period, recordLookup, buildProductInsights, summarizeProductInsights, getProductInsights } = require('../product_insights');
const { mountProductInsights, trustedLocalRequest } = require('../product_insights_routes');
const { mountQueueSyncEndpoint } = require('../queue_cloud_sync');
let mongo, client, db;
test('local network trust ignores spoofed headers except the loopback reverse proxy',()=>{
 const request=(address,header)=>({socket:{remoteAddress:address},get:()=>header});
 for(const ip of ['192.168.0.79','172.25.168.99','100.76.215.98','::ffff:10.1.2.3'])assert.equal(trustedLocalRequest(request(ip)),true);
 assert.equal(trustedLocalRequest(request('8.8.8.8','192.168.0.79')),false);
 assert.equal(trustedLocalRequest(request('127.0.0.1','8.8.8.8')),false);
 assert.equal(trustedLocalRequest(request('127.0.0.1','192.168.0.79')),true);
});
before(async()=>{mongo=await MongoMemoryServer.create({instance:{launchTimeout:60000}});client=await MongoClient.connect(mongo.getUri());db=client.db('product_insights_test');}, {timeout:90000});
after(async()=>{await client?.close();await mongo?.stop();});
test('date filters use Argentine boundaries and reject invalid or excessive ranges',()=>{
 const p=period('2026-10-20','2026-10-20');assert.equal(p.start.toISOString(),'2026-10-20T03:00:00.000Z');assert.equal(p.end.toISOString(),'2026-10-21T03:00:00.000Z');
 for(const pair of [['2026-02-30','2026-03-01'],['2026-10-21','2026-10-20'],['2026-01-01','2026-10-20']])assert.throws(()=>period(...pair));
});
test('independent telemetry is idempotent, whitelisted and never bills',async()=>{
 const e={tenantId:'TELEMETRY',eventId:'same',code:'B1',via:'scan',outcome:'available',at:new Date('2026-10-20T12:00:00Z'),product:{code:'S1',description:'Artículo'},ip:'DO_NOT_STORE',question:'PRIVATE'};
 await recordLookup(db,e);await recordLookup(db,e);await recordLookup(db,{...e,tenantId:'OTHER'});
 assert.equal(await db.collection('qr_product_events').countDocuments({tenantId:'TELEMETRY'}),1);
 const stored=await db.collection('qr_product_events').findOne({tenantId:'TELEMETRY'});assert.equal(stored.via,'scan');assert.equal(stored.ip,undefined);assert.equal(stored.question,undefined);
 assert.equal(await db.collection('monetization_events').countDocuments({tenantId:'TELEMETRY'}),0);
});
test('historical/new cutover prevents double counts, aliases merge and only user questions count',async()=>{
 const tenantId='MCN';
 await db.collection('monetization_events').insertMany([
  {tenantId,eventKey:'catalog.code_lookup',quantity:2,occurredAt:new Date('2026-10-20T10:00Z'),metadata:{code:'B1'}},
  {tenantId,eventKey:'catalog.qr_read',quantity:1,occurredAt:new Date('2026-10-20T11:00Z'),metadata:{code:'S1'}},
  {tenantId,eventKey:'catalog.code_lookup',quantity:10,occurredAt:new Date('2026-10-20T12:01Z'),metadata:{code:'S1'}},
  {tenantId:'FOREIGN',eventKey:'catalog.code_lookup',quantity:999,occurredAt:new Date('2026-10-20T10:00Z'),metadata:{code:'B1'}},
 ]);
 await db.collection('qr_product_catalog').insertOne({tenantId,Codigo:'S1',Codbarra:'B1',raw:{Descripcion:'Artículo Uno'},fetchedAt:new Date()});
 for(const [id,outcome,via,hour]of [['one','available','scan',12],['two','unavailable','sku',13],['three','error','sku',14]])await recordLookup(db,{tenantId,eventId:id,outcome,via,code:'B1',product:outcome==='available'?{code:'S1',description:'Artículo Uno'}:undefined,at:new Date(`2026-10-20T${hour}:00:00Z`)});
 const base={tenantId,role:'user',ts:new Date('2026-10-20T13:00Z'),meta:{from:'qr_web',qrProductCode:'S1',qrProductDescription:'Artículo Uno'}};
 await db.collection('messages').insertMany([
  {...base,content:'Solicitó más información',meta:{...base.meta,initial:true}},
  {...base,content:'Qué tenés similar?'}, {...base,content:'Qué batería es compatible?'},
  {...base,role:'assistant',content:'PRIVATE ANSWER'},
  {...base,tenantId:'FOREIGN',content:'PRIVATE FOREIGN'},
  {...base,ts:undefined,createdAt:new Date('2026-10-20T15:00Z'),content:'Qué precio tiene?'},
 ]);
 const result=await buildProductInsights(db,tenantId,'2026-10-20','2026-10-20');
 assert.equal(result.metrics.successful,4);assert.equal(result.metrics.legacySuccessful,3);assert.equal(result.metrics.camera,1);assert.equal(result.metrics.measuredAttempts,3);
 assert.equal(result.metrics.written,3);assert.equal(result.metrics.infoRequests,1);assert.equal(result.metrics.unavailable,1);assert.equal(result.metrics.errors,1);
 assert.equal(result.topProducts[0].code,'S1');assert.equal(result.topProducts[0].views,4);assert.equal(result.topProducts[0].questions,3);
 const serialized=JSON.stringify(result);assert.doesNotMatch(serialized,/PRIVATE|Qué batería|FOREIGN/);assert.match(serialized,/no ventas ni clientes únicos/);assert.equal(result.metrics.uniqueCustomers,undefined);
});
test('empty periods offer no invented commercial conclusions; unknown themes stay qualified',()=>{
 const empty=summarizeProductInsights({from:'2026-10-20',to:'2026-10-20'});assert.equal(empty.metrics.successful,0);assert.match(empty.insights[0].title,/no hay evidencia/);assert.equal(empty.coverage.trackingSince,null);
 const mixed=summarizeProductInsights({chats:{topics:[{_id:'other',count:8},{_id:'alternatives',count:2}]}});assert.match(mixed.insights[0].finding,/temas identificados/);assert.doesNotMatch(mixed.insights[0].finding,/Predominan/);
});
test('private summary rejects unauthenticated and foreign tenants, and validates dates',async()=>{
 const app=express();mountProductInsights(app,{scope:async req=>({t:req.params.tenant,db}),wrap:fn=>fn,allowed:(req,t)=>req.get('x-user')===t,dayKey:()=> '2026-10-20'});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/api/customer-app-admin/MCN/product-stats')).status,401);
  assert.equal((await fetch(base+'/api/customer-app-admin/MCN/product-stats',{headers:{'x-user':'FOREIGN'}})).status,401);
  assert.equal((await fetch(base+'/api/customer-app-admin/MCN/product-stats?from=bad&to=bad',{headers:{'x-user':'MCN'}})).status,400);
  const r=await fetch(base+'/api/customer-app-admin/MCN/product-stats?from=2026-10-20&to=2026-10-20',{headers:{'x-user':'MCN'}});assert.equal(r.status,200);assert.equal((await r.json()).metrics.successful,4);
 }finally{await new Promise(r=>server.close(r))}
});
test('hybrid summary requires secret and tenant authorization and never mutates queue data',async()=>{
 const secret='private-test-secret-more-than-20',app=express();let reads=0;mountQueueSyncEndpoint(app,{getDb:async()=>{reads++;return db},secret,tenantList:'MCN'});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/ext/queue-sync';
 const call=(key,tenantId)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-queue-sync-key':key},body:JSON.stringify({mode:'product_stats',tenantId,from:'2026-10-20',to:'2026-10-20',tickets:[{malicious:true}]})});
 try{
  assert.equal((await call('wrong','MCN')).status,401);assert.equal((await call(secret,'FOREIGN')).status,403);assert.equal(reads,0);
  const r=await call(secret,'MCN');assert.equal(r.status,200);assert.equal((await r.json()).metrics.successful,4);assert.equal(await db.collection('queue_tickets').countDocuments(),0);
 }finally{await new Promise(r=>server.close(r))}
});

test('only the enabled local node permits anonymous open-tenant statistics on private networks',async()=>{
 const previous=process.env.QUEUE_LOCAL_NETWORK_ACCESS;
 const app=express();mountProductInsights(app,{scope:async req=>({t:req.params.tenant,db}),wrap:fn=>fn,allowed:()=>false,isOpen:t=>t==='MCN',dayKey:()=> '2026-10-20'});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/customer-app-admin/';
 try{
  process.env.QUEUE_LOCAL_NETWORK_ACCESS='0';assert.equal((await fetch(url+'MCN/product-stats')).status,401);
  process.env.QUEUE_LOCAL_NETWORK_ACCESS='1';
  assert.equal((await fetch(url+'MCN/product-stats',{headers:{'x-real-ip':'8.8.8.8'}})).status,401);
  assert.equal((await fetch(url+'FOREIGN/product-stats')).status,401);
  // Invalid dates prove authorization passed without calling a remote data source.
  assert.equal((await fetch(url+'MCN/product-stats?from=invalid&to=invalid',{headers:{'x-real-ip':'192.168.0.79'}})).status,400);
 }finally{if(previous===undefined)delete process.env.QUEUE_LOCAL_NETWORK_ACCESS;else process.env.QUEUE_LOCAL_NETWORK_ACCESS=previous;await new Promise(r=>server.close(r))}
});
test('local proxy forwards only the selected tenant and filter, outages do not become zeroes',async()=>{
 const previous=global.fetch;const env={QUEUE_LOCAL_NETWORK_ACCESS:'1',QUEUE_SYNC_URL:'https://example.invalid/api/ext/queue-sync',QUEUE_SYNC_SECRET:'test-private-key-more-than-20'};
 try{
  global.fetch=async(url,options)=>{assert.equal(url,env.QUEUE_SYNC_URL);assert.equal(options.headers['x-queue-sync-key'],env.QUEUE_SYNC_SECRET);assert.deepEqual(JSON.parse(options.body),{mode:'product_stats',tenantId:'MCN',from:'2026-10-20',to:'2026-10-20'});return{ok:true,json:async()=>({ok:true,metrics:{successful:7}})}};
  assert.equal((await getProductInsights(null,'MCN','2026-10-20','2026-10-20',env)).metrics.successful,7);
  global.fetch=async()=>({ok:false});await assert.rejects(getProductInsights(null,'MCN','2026-10-20','2026-10-20',env),/turnos siguen funcionando/);
 }finally{global.fetch=previous}
});
