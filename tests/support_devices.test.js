// Asisto | Version: 5.00.053 | Fecha: 2026-09-08
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { migrate } = require('../src/support/migration');
const { SupportService } = require('../src/support/service');
const { createVault } = require('../src/support/crypto');
const { createDeviceRouter, deviceLeaseId } = require('../src/support/devices');
let mongo, client, db, service, server, base;
const a = { tenantId: 'a', userId: new ObjectId().toHexString() }, b = { tenantId: 'b', userId: new ObjectId().toHexString() };
before(async () => {
  mongo = await MongoMemoryServer.create(); client = await new MongoClient(mongo.getUri()).connect(); db = client.db('devices');
  service = new SupportService(db, createVault({ test: Buffer.alloc(32, 5).toString('base64') }, 'test'));
  const app = express();
  app.use((req, res, next) => { const scope = req.headers['x-test-user'] === 'a' ? a : req.headers['x-test-user'] === 'b' ? b : null; if (scope) req.user = { uid: scope.userId, tenantId: scope.tenantId, role: 'user', allowedPages: ['support'] }; next(); });
  app.use('/device', createDeviceRouter({ getService: async () => service, publicOrigin: 'https://asisto.example' }));
  server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  base = 'http://127.0.0.1:' + server.address().port + '/device';
});
beforeEach(async () => {
  await db.dropDatabase(); await migrate(db);
  await db.collection('users').insertMany([a, b].map(s => ({ _id: new ObjectId(s.userId), tenantId: s.tenantId, role: 'user', allowedPages: ['support'] })));
});
after(async () => { await new Promise(resolve => server?.close(resolve)); await client?.close(); await mongo?.stop(); });
async function call(route, body = {}, headers = {}) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const userHeaders = user => ({ 'x-test-user': user, Origin: 'https://asisto.example', 'X-Asisto-Support': '1' });
async function register(user) {
  const started = await call('/start', { name: 'Fixture PC' }); assert.equal(started.status, 200);
  const approved = await call('/approve', { code: started.body.code }, userHeaders(user)); assert.equal(approved.status, 200);
  return { Authorization: 'Bearer ' + started.body.token, 'X-Asisto-Instance': randomUUID() };
}
test('PC pairing requires explicit authenticated approval and returns no global credentials', async () => {
  const start = await call('/start', { name: 'Fixture PC' });
  assert.match(start.body.verificationUrl, /^https:\/\/asisto.example\/ui\/support\?device=/);
  assert.equal((await call('/approve', { code: start.body.code })).status, 401);
  assert.equal((await call('/approve', { code: start.body.code }, { 'x-test-user': 'a' })).status, 403);
  const headers = { Authorization: 'Bearer ' + start.body.token, 'X-Asisto-Instance': randomUUID() };
  assert.deepEqual((await call('/poll', {}, headers)).body, { state: 'pending' });
  assert.equal((await call('/heartbeat', {}, headers)).status, 401);
  assert.equal((await call('/approve', { code: start.body.code }, userHeaders('a'))).status, 200);
  assert.deepEqual((await call('/poll', {}, headers)).body, { state: 'approved', ...a });
  assert.equal((await call('/approve', { code: start.body.code }, userHeaders('b'))).status, 404);
  const doc = await db.collection('support_devices').findOne({ code: start.body.code });
  assert.equal(JSON.stringify(doc).includes(start.body.token), false);
});
test('two PCs belonging to different users run concurrently with isolated leases and jobs', async () => {
  const ha = await register('a'), hb = await register('b');
  assert.equal((await call('/heartbeat', {}, ha)).status, 200);
  assert.equal((await call('/heartbeat', {}, hb)).status, 200);
  assert.notEqual(deviceLeaseId(a), deviceLeaseId(b));
  assert.equal((await call('/heartbeat', {}, { ...ha, 'X-Asisto-Instance': randomUUID() })).status, 409);
  for (const [headers, id] of [[ha, 'a1'], [hb, 'b1']]) {
    assert.equal((await call('/messages', { ...b, messages: [{ id, jid: '123@s.whatsapp.net', text: 'Manager no imprime', at: new Date(), fromMe: false }] }, headers)).status, 200);
  }
  assert.equal(await db.collection('support_messages').countDocuments(a), 1);
  assert.equal(await db.collection('support_messages').countDocuments(b), 1);
  await db.collection('support_jobs').updateMany({}, { $set: { dueAt: new Date(0) } });
  await call('/work', {}, ha);
  assert.equal((await db.collection('support_jobs').findOne(b)).state, 'pending');
  assert.equal((await call('/revoke', {}, userHeaders('a'))).status, 200);
  assert.equal((await call('/messages', { messages: [] }, ha)).status, 401);
  assert.equal((await call('/heartbeat', {}, hb)).status, 200);
});
test('replacing a PC revokes the old device, and revoked user permissions block the new one', async () => {
  const old = await register('a'); await call('/heartbeat', {}, old);
  const current = await register('a');
  assert.equal((await call('/heartbeat', {}, old)).status, 401);
  assert.equal((await call('/heartbeat', {}, current)).status, 200);
  await db.collection('users').updateOne({ _id: new ObjectId(a.userId) }, { $set: { allowedPages: [] } });
  assert.equal((await call('/heartbeat', {}, current)).status, 403);
});
test('expired desktop lease allows recovery and fences the old process', async () => {
  const first = await register('a'), second = { ...first, 'X-Asisto-Instance': randomUUID() };
  await call('/heartbeat', {}, first);
  await db.collection('support_leases').updateOne({ _id: deviceLeaseId(a) }, { $set: { until: new Date(0) } });
  assert.equal((await call('/heartbeat', {}, second)).status, 200);
  assert.equal((await call('/session', { state: 'connected' }, first)).status, 409);
  assert.equal((await call('/session', { state: 'connected' }, second)).status, 200);
});
