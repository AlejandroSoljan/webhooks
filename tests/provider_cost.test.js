const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { costGroupFields } = require('../provider_cost');
const { calculateEstimatedCost, calculateBillableCost } = require('../token_control_stats');
test('event pricing ignores tenant overrides, respects mixed models and counts audio once', async () => {
  const server=await MongoMemoryServer.create(); const c=await new MongoClient(server.getUri()).connect();
  try {
    const col=c.db('cost_test').collection('usage');
    await col.insertMany([
      {kind:'message',model:'gpt-4o-mini',inputTokens:302997,outputTokens:14465},
      {kind:'audio',model:'gpt-4o-mini-transcribe',inputTokens:30741,outputTokens:10725,costUsd:0.1518},
    ]);
    const [row]=await col.aggregate([{$group:{_id:null,...costGroupFields()}}]).toArray();
    const tenant={token_cost_chat_input_per_1k:0.0025,token_cost_audio_input_per_1k:0.0012,monetizationConfigured:true,billingEnabled:true,aiMarkupPercent:100};
    assert.equal(calculateEstimatedCost(row,tenant),0.205929);
    assert.equal(calculateBillableCost(row,tenant),0.411858);
    await col.insertMany([{kind:'message',model:'gpt-5.4',inputTokens:1000,outputTokens:1000},{kind:'audio',model:'whisper-1',audioSeconds:60},{kind:'message',model:'unknown',inputTokens:1000}]);
    const [mixed]=await col.aggregate([{$group:{_id:null,...costGroupFields()}}]).toArray();
    assert.equal(calculateEstimatedCost(mixed,tenant),0.229429);
    assert.equal(mixed.unpriced_events,1);
  } finally {await c.close();await server.stop();}
});
