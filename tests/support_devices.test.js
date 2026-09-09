// Asisto | Version: 5.00.072 | Fecha: 2026-09-09
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
const { createExtensionRouter } = require('../src/support/extension');
const { protectRoutes } = require('../auth_ui');
let mongo, client, db, service, server, base;
const a = { tenantId: 'a', userId: new ObjectId().toHexString() }, b = { tenantId: 'b', userId: new ObjectId().toHexString() };
before(async () => {
  mongo = await MongoMemoryServer.create(); client = await new MongoClient(mongo.getUri()).connect(); db = client.db('devices');
  service = new SupportService(db, createVault({ test: Buffer.alloc(32, 5).toString('base64') }, 'test'));
  const app = express();
  app.use((req, res, next) => { const scope = req.headers['x-test-user'] === 'a' ? a : req.headers['x-test-user'] === 'b' ? b : null; if (scope) req.user = { uid: scope.userId, tenantId: scope.tenantId, role: 'user', allowedPages: ['support'] }; next(); });
  protectRoutes(app);
  app.use('/api/support/device', createDeviceRouter({ getService: async () => service, publicOrigin: 'https://asisto.example' }));
  app.use('/api/support/extension', createExtensionRouter({ getService: async () => service }));
  server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  base = 'http://127.0.0.1:' + server.address().port + '/api/support/device';
});
beforeEach(async () => {
  await db.dropDatabase(); await migrate(db);
  await db.collection('users').insertMany([a, b].map(s => ({ _id: new ObjectId(s.userId), tenantId: s.tenantId, role: 'user', allowedPages: ['support'] })));
  await db.collection('tenant_config').insertMany([{ _id: 'a', numero: '5491111111111' }, { _id: 'b', numero: '5492222222222' }]);
});
after(async () => { await new Promise(resolve => server?.close(resolve)); await client?.close(); await mongo?.stop(); });
async function call(route, body = {}, headers = {}) {
  const response = await fetch(base + route, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
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
  const current = await call('/start', { name: 'PC nueva', sessionsPanel: true });
  assert.match(current.body.verificationUrl, /^https:\/\/asisto.example\/admin\/wweb\?device=/);
  assert.equal((await call('/approve', { code: start.body.code })).status, 302);
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
test('approved Baileys token reaches the extension API without opening a web login', async () => {
  const headers = await register('a');
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/support/extension/session', {
    redirect: 'manual',
    headers: { Authorization: headers.Authorization, 'X-Asisto-Extension-Id': 'a'.repeat(32), Origin: 'chrome-extension://' + 'a'.repeat(32) },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tenantId, 'a');
});
test('two PCs belonging to different users run concurrently with isolated leases and jobs', async () => {
  const ha = await register('a'), hb = await register('b');
  assert.equal((await call('/heartbeat', {}, ha)).status, 200);
  assert.equal((await call('/heartbeat', {}, hb)).status, 200);
  assert.deepEqual((await call('/session', { state: 'connected', number: '5491111111111:1@s.whatsapp.net' }, ha)).body, { ok: true });
  assert.deepEqual((await call('/session', { state: 'connected', number: '5492222222222@s.whatsapp.net' }, hb)).body, { ok: true });
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
  assert.equal((await call('/session', { state: 'connected', number: '5491111111111@s.whatsapp.net' }, second)).status, 200);
});
// Regression: HTTP retries must not launch concurrent billable jobs for one PC.
test('work resumes missing-provider failures once for its owner and coalesces slow HTTP retries', async () => {
  const headers = await register('a'); await call('/heartbeat', {}, headers);
  await service.col('jobs').insertMany([
    { _id: 'own', ...a, state: 'failed', error: 'transcription_provider_required', attempts: 3 },
    { _id: 'foreign', ...b, state: 'failed', error: 'transcription_provider_required', attempts: 3 },
  ]);
  const original = service.runOne, originalTranscribe = service.transcribe;
  let release, entered, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  service.transcribe = { run() {} };
  service.runOne = async () => { calls++; entered(); await held; return true; };
  const first = call('/work', {}, headers);
  try {
    await started;
    assert.deepEqual((await call('/work', {}, headers)).body, { processed: false, busy: true });
    assert.equal(calls, 1);
    assert.equal((await service.col('jobs').findOne({ _id: 'own' })).state, 'pending');
    assert.equal((await service.col('jobs').findOne({ _id: 'foreign' })).state, 'failed');
    release(); await first;
    await service.col('jobs').updateOne({ _id: 'own' }, { $set: { state: 'failed', error: 'transcription_provider_required' } });
    await call('/work', {}, headers);
    assert.equal((await service.col('jobs').findOne({ _id: 'own' })).state, 'failed');
  } finally { release(); await first; service.runOne = original; service.transcribe = originalTranscribe; }
});
test('WhatsApp contact sync is owner-scoped and cannot replace a manual contact', async () => {
  const headers = await register('a'); await call('/heartbeat', {}, headers);
  await call('/session', { state: 'connected', number: '5491111111111@s.whatsapp.net' }, headers);
  assert.equal((await call('/contacts', { contacts: [{ jid: '123@lid', name: 'Contacto', tenantId: b.tenantId, userId: b.userId }] }, headers)).status, 200);
  assert.equal(await service.col('contacts').countDocuments(a), 1);
  assert.equal(await service.col('contacts').countDocuments(b), 0);
  assert.equal((await call('/contacts', { contacts: [{ jid: '123@g.us', name: 'Grupo' }] }, headers)).status, 400);
});
test('desktop session is projected into the existing WhatsApp panel and rejects a different scanned number', async () => {
  const headers = await register('a');
  assert.deepEqual((await call('/heartbeat', {}, headers)).body, { desired: 'connected', configurationRequired: false, validated: false });
  assert.deepEqual((await call('/session', { state: 'qr', qr: 'fixture-qr' }, headers)).body, { ok: true });
  const lock = await db.collection('wa_locks').findOne({ tenantId: 'a', source: 'support-desktop' });
  assert.equal(lock.numero, '5491111111111');
  assert.match(lock.lastQrDataUrl, /^data:image\/png;base64,/);
  assert.deepEqual((await call('/session', { state: 'connected', number: '5499999999999@s.whatsapp.net' }, headers)).body, { ok: false, error: 'number_mismatch' });
  assert.equal((await call('/messages', { messages: [] }, headers)).status, 409);
  assert.deepEqual((await call('/session', { state: 'connected', number: '5491111111111:2@s.whatsapp.net' }, headers)).body, { ok: true });
  assert.equal((await call('/messages', { messages: [] }, headers)).status, 200);
});
