const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

let mongo;
let client;
let db;
let buildTokenTimeline;
let calculateBillableCost;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db('token_control_timeline');
  const dbPath = require.resolve('../db');
  require(dbPath);
  require.cache[dbPath].exports.getDb = async () => db;
  delete require.cache[require.resolve('../token_control_stats')];
  ({ buildTokenTimeline, calculateBillableCost } = require('../token_control_stats'));
});

beforeEach(async () => {
  await db.dropDatabase();
});

after(async () => {
  await client?.close();
  await mongo?.stop();
});

test('ubica tokens en la hora real de Argentina y respeta el día local', async () => {
  await db.collection('tenant_config').insertOne({ _id: 'RVL' });
  await db.collection('ai_token_usage_log').insertMany([
    { tenantId: 'RVL', createdAt: new Date('2026-09-30T17:10:00.000Z'), kind: 'message', model: 'gpt-4o-mini', inputTokens: 635, outputTokens: 99, totalTokens: 734 },
    { tenantId: 'RVL', createdAt: new Date('2026-10-01T01:15:00.000Z'), kind: 'message', model: 'gpt-4o-mini', inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    { tenantId: 'RVL', createdAt: new Date('2026-09-30T01:00:00.000Z'), kind: 'message', model: 'gpt-4o-mini', inputTokens: 5000, outputTokens: 0, totalTokens: 5000 }
  ]);

  const result = await buildTokenTimeline({ tenantId: 'RVL', from: '2026-09-30', to: '2026-09-30' });

  assert.equal(result.granularity, 'hour');
  assert.equal(result.items.length, 24);
  assert.equal(result.items.find(row => row.date.endsWith('T14:00')).tokens, 734);
  assert.equal(result.items.find(row => row.date.endsWith('T22:00')).tokens, 120);
  assert.equal(result.items.reduce((sum, row) => sum + row.tokens, 0), 854);
});

test('valoriza por modelo dentro de la misma hora en lugar de aplicar la tarifa máxima a todo', async () => {
  await db.collection('tenant_config').insertOne({ _id: 'MIX' });
  const events = [
    { tenantId: 'MIX', createdAt: new Date('2026-09-30T15:00:00.000Z'), kind: 'message', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    { tenantId: 'MIX', createdAt: new Date('2026-09-30T15:20:00.000Z'), kind: 'message', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }
  ];
  await db.collection('ai_token_usage_log').insertMany(events);

  const result = await buildTokenTimeline({ tenantId: 'MIX', from: '2026-09-30', to: '2026-09-30' });
  const noon = result.items.find(row => row.date.endsWith('T12:00'));
  const expected = events.reduce((sum, event) => sum + calculateBillableCost({
    message_input_tokens: event.inputTokens,
    message_output_tokens: event.outputTokens,
    total_tokens: event.totalTokens,
    model: event.model,
    models: [event.model]
  }, { _id: 'MIX' }), 0);

  assert.equal(noon.tokens, 3000);
  assert.equal(noon.billed, Number(expected.toFixed(6)));
});
