const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

let mongo;
let client;
let db;
let buildApiMessageWindowBilling;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db('token_control_api_messages');

  const dbPath = require.resolve('../db');
  require(dbPath);
  require.cache[dbPath].exports.getDb = async () => db;
  delete require.cache[require.resolve('../token_control_stats')];
  ({ buildApiMessageWindowBilling } = require('../token_control_stats'));
});

after(async () => {
  await client?.close();
  await mongo?.stop();
});

test('excluye eventos salientes vacíos y conserva medios sin texto', async () => {
  const at = new Date('2026-09-30T12:00:00.000Z');
  await db.collection('tenant_config').insertOne({ _id: 'TFG', nom_emp: 'TFG' });
  await db.collection('wa_wweb_message_log').insertMany([
    { tenantId: 'TFG', numero: '5493412114193', contact: '1', direction: 'out', messageType: 'chat', body: '', at },
    { tenantId: 'TFG', numero: '5493412114193', contact: '2', direction: 'out', messageType: 'text', body: '   ', at },
    { tenantId: 'TFG', numero: '5493412114193', contact: '3', direction: 'out', messageType: 'text', body: 'Hola', at },
    { tenantId: 'TFG', numero: '5493412114193', contact: '4', direction: 'out', messageType: 'image', body: '', at },
    { tenantId: 'TFG', numero: '5493412114193', contact: '5', direction: 'out', messageType: 'chat', body: '', hasMedia: true, at },
    { tenantId: 'TFG', numero: '5493412114193', contact: '6', direction: 'in', messageType: 'text', body: 'Entrante', at }
  ]);

  const result = await buildApiMessageWindowBilling({ tenantId: 'TFG', includeDetails: true });

  assert.equal(result.totals.realMessages, 3);
  assert.equal(result.realItems.length, 3);
  assert.deepEqual(result.realItems.map(row => row.contact).sort(), ['3', '4', '5']);
  assert.equal(result.realItems.some(row => row.contact === '4' && row.hasMedia), true);
});
