const test = require('node:test');
const assert = require('node:assert/strict');
const {MongoMemoryServer} = require('mongodb-memory-server');
const {MongoClient} = require('mongodb');
const {beginTestRecord,finishTestRecord} = require('../bot_test_history');
const {syncPilotRecord} = require('../bot_test_projection');

test('new test chats persist before model reply, isolate tenants and survive replay', async () => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri(),{serverApi:{version:'1',strict:true}});
  try {
    const db = client.db('synthetic');
    const input = {sessionId:'same-session',userId:'tester',message:'Synthetic question'};
    const a = await beginTestRecord(db,{...input,tenant:'NEA'});
    const b = await beginTestRecord(db,{...input,tenant:'NEA_PRUEBAS'});
    assert.equal(await db.collection('messages').countDocuments({isTest:true,role:'user'}),2);
    assert.equal(await db.collection('conversations').countDocuments({isTest:true,channelType:'bot_test'}),2);
    await finishTestRecord(a,{reply:'Synthetic answer'});
    await finishTestRecord(a,{error:true});
    const saved = await db.collection('bot_test_history').findOne({_id:a.id});
    assert.equal(saved.status,'completed');
    assert.equal(saved.reply,'Synthetic answer');
    const id = await syncPilotRecord(db,saved);
    await db.collection('conversations').updateOne({_id:id},{$set:{finalized:true}});
    await syncPilotRecord(db,saved);
    assert.equal((await db.collection('conversations').findOne({_id:id})).finalized,true);
    assert.equal(await db.collection('messages').countDocuments({tenantId:'NEA',conversationId:id}),2);
    await finishTestRecord(b,{error:true});
    assert.equal(await db.collection('messages').countDocuments({tenantId:'NEA_PRUEBAS',role:'assistant'}),0);
    const later = new Date(+saved.createdAt+1000);
    await syncPilotRecord(db,{...saved,_id:'new-event',createdAt:later});
    assert.equal((await db.collection('conversations').findOne({_id:id})).finalized,false);
  } finally { await client.close(); await server.stop(); }
});
