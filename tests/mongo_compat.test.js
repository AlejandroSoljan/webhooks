// Asisto | Version: 5.00.061 | Fecha: 2026-09-08
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
test('agent scoped upserts avoid duplicate tenant/phone paths, and followup works with strict Stable API', async () => {
  const mongo = await MongoMemoryServer.create();
  const client = await new MongoClient(mongo.getUri(), { serverApi: { version: '1', strict: true } }).connect();
  try {
    const db = client.db('compat');
    const source = fs.readFileSync(require.resolve('../endpoint'), 'utf8');
    const scopeUpdate = vm.runInNewContext('(' + source.slice(source.indexOf('function wwebAgentScopeUpdate('), source.indexOf('async function requireWwebAgentAccess(')).trim() + ')');
    for (const collection of ['wa_locks', 'wa_wweb_policies', 'wa_wweb_message_log', 'wa_api_mensajes_confirmaciones', 'wa_api_message_windows']) {
      const numberField = collection.startsWith('wa_api_') ? 'numeroFrom' : 'numero';
      const insert = { tenantId: 'wrong', [numberField]: 'wrong', createdAt: new Date() };
      if (collection === 'wa_locks' || collection === 'wa_wweb_policies') insert.tenantid = 'wrong';
      for (let i = 0; i < 2; i++) {
        const update = scopeUpdate(collection, { $set: { state: 'online' }, $setOnInsert: insert }, 'ALSO', '123');
        await db.collection(collection).updateOne({ _id: 'fixture' }, update, { upsert: true });
      }
      const row = await db.collection(collection).findOne({ _id: 'fixture' });
      assert.equal(row.tenantId, 'ALSO'); assert.equal(row[numberField], '123'); assert.ok(row.createdAt);
    }
    const followup = fs.readFileSync(require.resolve('../conversation_followup_panel'), 'utf8');
    const tenants = vm.runInNewContext('(' + followup.slice(followup.indexOf('async function followupTenantIds('), followup.indexOf('async function runAutoCloseSweep(')).trim() + ')');
    await db.collection('conversations').insertMany([{ tenantId: 'ALSO', botMode: 'conversacional' }, { tenantId: 'ALSO', botMode: 'conversacional' }, { tenantId: 'OTHER', botMode: 'different' }]);
    assert.deepEqual(Array.from(await tenants(db, 'conversations', { botMode: 'conversacional' })), ['ALSO']);
  } finally { await client.close(); await mongo.stop(); }
});
