const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { businessDay, expirePreviousDays, expireIncomingTicket } = require('../queue_expiration');
const { mountQueue } = require('../customer_queue');
const { preferred, reviveTicket } = require('../queue_cloud_sync');
const { summarize } = require('../queue_stats');
let mongo, client, db, server, url, today='2026-10-03';
const cfg={branchId:'CENTRAL',queuePresence:'open',sectors:[{id:'test',name:'Prueba',prefix:'T'}],sellers:[{id:'seller',name:'Prueba',active:true}]};
before(async()=>{mongo=await MongoMemoryServer.create();client=await new MongoClient(mongo.getUri()).connect();db=client.db('expiry_test');const app=express();app.use(express.json());mountQueue(app,{getDb:async()=>db,configFor:async()=>cfg,dayKey:()=>today,openTenants:['TEST'],secret:'test-secret',auth:{},firebaseSender:async()=>{throw Error('No push expected')}});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url='http://127.0.0.1:'+server.address().port;});
after(async()=>{await new Promise(r=>server.close(r));await client.close();await mongo.stop()});
async function request(path,body){const r=await fetch(url+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()}}
test('day boundary uses Argentina rather than UTC',()=>{assert.equal(businessDay(new Date('2026-10-04T02:59:59Z')),'2026-10-03');assert.equal(businessDay(new Date('2026-10-04T03:00:00Z')),'2026-10-04')});
test('expiry preserves terminal states, scopes tenants, records original midnight and is idempotent',async()=>{
 const docs=['WAITING','CALLED','RESERVED','DONE','CANCELLED','SKIPPED'].map(status=>({_id:new ObjectId(),tenantId:'UNIT',dayKey:'2026-10-01',status,sectorId:'test',history:[{action:'created',at:new Date('2026-10-01T12:00:00Z')}]}));
 await db.collection('queue_tickets').insertMany([...docs,{tenantId:'OTHER',dayKey:'2026-10-01',status:'WAITING'},{tenantId:'UNIT',dayKey:'2026-10-04',status:'WAITING'},{tenantId:'UNIT',dayKey:'2026-10-05',status:'WAITING'}]);
 assert.equal(await expirePreviousDays(db,'2026-10-04','UNIT'),3);assert.equal(await expirePreviousDays(db,'2026-10-04','UNIT'),0);
 for(const d of docs.slice(0,3)){const x=await db.collection('queue_tickets').findOne({_id:d._id});assert.equal(x.status,'SKIPPED');assert.equal(x.expiredAt.toISOString(),'2026-10-02T03:00:00.000Z');assert.equal(x.history.length,2);assert.equal(x.history[1].reason,'day_end')}
 assert.equal((await db.collection('queue_tickets').findOne({tenantId:'OTHER'})).status,'WAITING');
 for(const d of docs.slice(3))assert.equal((await db.collection('queue_tickets').findOne({_id:d._id})).status,d.status);
});
test('phone, operator and display cannot reuse a previous-day ticket; stats retain absence',async()=>{
 const api='/api/customer-app/TEST',admin='/api/customer-app-admin/TEST';
 const reserved=await request(api+'/tickets',{sectorId:'test',installId:'old-kiosk',source:'kiosk',delivery:'qr_or_print'});assert.equal(reserved.status,200);
 const u=new URL(reserved.body.claimUrl),code=new URLSearchParams(u.hash.slice(1)).get('code');
 assert.equal((await request(api+'/tickets/'+reserved.body.id+'/claim',{installId:'phone',code})).status,200);
 const called=await request(admin+'/sectors/test/next',{expectedWaitingId:reserved.body.id,sellerId:'seller'});assert.equal(called.status,200);
 today='2026-10-04';
 const phone=await request(api+'/tickets/'+reserved.body.id+'?installId=phone');assert.equal(phone.body.status,'SKIPPED');assert.equal(phone.body.expiryReason,'day_end');
 assert.equal((await request(api+'/queue')).body.sectors[0].current,null);
 assert.equal((await request(admin+'/state')).body.sectors[0].waiting,0);
 for(const action of ['finish','recall','skip'])assert.notEqual((await request(admin+'/sectors/test/'+action,{expectedTicketId:reserved.body.id})).status,200);
 assert.notEqual((await request(api+'/tickets/'+reserved.body.id+'/claim',{installId:'phone',code})).status,200);
 assert.notEqual((await request(admin+'/tickets/'+reserved.body.id+'/print',{})).status,200);
 const stored=await db.collection('queue_tickets').findOne({_id:new ObjectId(reserved.body.id)});assert.equal(summarize([stored],cfg.sectors).summary.skipped,1);
 const newTicket=await request(api+'/tickets',{sectorId:'test',installId:'phone'});assert.equal(newTicket.status,200);assert.notEqual(newTicket.body.id,reserved.body.id);
});
test('sync cannot resurrect expired tickets, including a previously offline source',()=>{
 const old={_id:new ObjectId(),tenantId:'TEST',dayKey:'2026-01-01',status:'WAITING',history:[],updatedAt:new Date()};
 const expired=expireIncomingTicket(old,'2026-10-04');assert.equal(expired.status,'SKIPPED');assert.equal(expireIncomingTicket(expired,'2026-10-04').history.length,1);
 assert.equal(reviveTicket(old,'TEST').status,'SKIPPED');assert.equal(preferred(expired,{...old,updatedAt:new Date(Date.now()+10000)}),'local');
 assert.equal(preferred(old,expired),'cloud');
});
