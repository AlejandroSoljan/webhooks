// Asisto | Version: 5.00.050 | Fecha: 2026-09-08
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const { EventEmitter } = require('node:events');
const { migrate } = require('../src/support/migration');
const { createVault } = require('../src/support/crypto');
const { SupportService } = require('../src/support/service');
const { WorkerLease } = require('../src/support/worker');
const { createRouter, mountSupport } = require('../src/support/routes');
const { encryptedAuth, BaileysSessions } = require('../src/support/baileys');
const { scopedId, hash } = require('../src/support/core');
let mongo, connection, db, service, now;
const scope = { tenantId: 'tenant-a', userId: new ObjectId().toHexString() };
const other = { tenantId: 'tenant-a', userId: new ObjectId().toHexString() };
const foreign = { tenantId: 'tenant-b', userId: scope.userId };
const vault = createVault({ test: Buffer.alloc(32, 9).toString('base64') }, 'test');
before(async () => { mongo = await MongoMemoryServer.create(); connection = await new MongoClient(mongo.getUri()).connect(); db = connection.db('support_test'); });
after(async () => { await connection?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await db.dropDatabase(); await migrate(db); now = new Date('2026-09-01T12:00:00Z');
  service = new SupportService(db, vault, { now: () => now });
  await db.collection('users').insertMany([scope, other].map(s => ({ _id: new ObjectId(s.userId), tenantId: s.tenantId, role: 'user', allowedPages: ['support'] })));
});
const message = (id, seconds = 0, extra = {}) => ({ id, jid: '123@s.whatsapp.net', at: new Date(Date.parse('2026-09-01T11:00:00Z') + seconds * 1000), text: 'Manager no imprime la factura', fromMe: false, name: 'Contacto', ...extra });
async function processMessages(messages, owner = scope) {
  for (const row of messages) await service.ingest(owner, row);
  now = new Date(+now + 180001);
  for (let i = 0; i < 10 && await service.runOne(); i++) { /* drain due work */ }
  return service.listDrafts(owner);
}
test('migration is repeatable and unique message identity isolates both users and tenants', async () => {
  await migrate(db);
  await Promise.all([service.ingest(scope, message('one')), service.ingest(other, message('one')), service.ingest(foreign, message('one'))]);
  await service.ingest(scope, message('one'));
  assert.equal(await service.col('messages').countDocuments(), 3);
  const stored = await service.col('messages').findOne(scope);
  assert.equal(stored.text, undefined); assert.ok(!JSON.stringify(stored).includes('no imprime'));
  now = new Date(+now + 180001); await service.runOne(); await service.runOne(); await service.runOne();
  const [draft] = await service.listDrafts(scope);
  await assert.rejects(() => service.editDraft(other, draft._id, 1, { subject: 'steal' }), /not_found/);
  await assert.rejects(() => service.editDraft(foreign, draft._id, 1, { subject: 'steal' }), /not_found/);
});
test('debounce, outgoing context, replay and overlapping history produce one draft', async () => {
  await service.ingest(scope, message('one'));
  assert.equal(await service.runOne(), false);
  await service.ingest(scope, message('two', 90, { fromMe: true, text: 'Se revisó el spooler.' }));
  now = new Date(+now + 180001); await service.runOne();
  let [draft] = await service.listDrafts(scope);
  assert.match(draft.fields.description, /spooler/);
  assert.equal(draft.fields.companyId, '');
  await service.history(scope, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z'); await service.runOne();
  assert.equal((await service.listDrafts(scope)).length, 1);
  assert.equal(await service.col('usage').countDocuments({ kind: 'analysis' }), 1);
});
test('late evidence preserves edits, invalidates approval and checks optimistic revision', async () => {
  const [draft] = await processMessages([message('one')]);
  await service.editDraft(scope, draft._id, 1, { subject: 'Título humano', companyId: '123', proposedAction: 'create' });
  await assert.rejects(() => service.editDraft(scope, draft._id, 1, { subject: 'stale' }), /revision_conflict/);
  await service.editDraft(scope, draft._id, 2, {}, true);
  await processMessages([message('earlier', -30, { text: 'Hola' })]);
  const [changed] = await service.listDrafts(scope);
  assert.equal(changed._id, draft._id); assert.equal(changed.fields.subject, 'Título humano');
  assert.equal(changed.state, 'needs_review'); assert.equal(changed.sourceChanged, true);
  await assert.rejects(() => service.editDraft(scope, changed._id, changed.revision, {}, true), /source_reconciliation_required/);
});
test('missing audio provider fails closed, retries are bounded, local transcript is metered and reused', async () => {
  const audio = message('audio', 30, { text: '', raw: 'fixture', audio: { seconds: 5, bytes: 50 } });
  await processMessages([message('one'), audio]);
  assert.equal((await service.listDrafts(scope)).length, 0);
  assert.equal((await service.col('jobs').findOne(scope)).error, 'transcription_provider_required');
  now = new Date(+now + 30000); await service.runOne(); now = new Date(+now + 60000); await service.runOne();
  assert.equal((await service.col('jobs').findOne(scope)).state, 'failed');
  let calls = 0;
  service.transcribe = { model: 'local-fixture', run: async () => { calls++; return { text: 'Necesito actualizar Manager', costUsd: 0 }; } };
  await service.history(scope, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z'); await service.runOne();
  assert.equal(calls, 1); assert.equal((await service.listDrafts(scope)).length, 1);
  const usage = await service.col('usage').findOne({ kind: 'transcription' });
  assert.equal(usage.audioSeconds, 5); assert.equal(usage.costUsd, 0); assert.equal(usage.result, 'ok');
  await service.history(scope, '2026-09-01T10:30:00Z', '2026-09-01T12:00:00Z'); await service.runOne();
  assert.equal(calls, 1);
});
test('queue repairs insertion/enqueue crash and fences an expired worker', async () => {
  await service.ingest(scope, message('one'));
  await service.col('jobs').deleteMany({}); await service.col('messages').updateMany({}, { $set: { queued: false } });
  await service.repairQueue(); assert.equal(await service.col('jobs').countDocuments(), 1);
  const first = new WorkerLease(db, () => now), second = new WorkerLease(db, () => now);
  assert.equal(await first.acquire(), true); assert.equal(await second.acquire(), false);
  now = new Date(+now + 30001); assert.equal(await second.acquire(), true);
  await assert.rejects(() => first.assert(), /worker_lease_lost/);
  await assert.rejects(() => first.renew(), /worker_lease_lost/);
  await first.release(); await second.assert(); await second.release();
});
test('exclusions do not cross tenants and block approval if changed after generation', async () => {
  await service.saveConfig({ ...scope, userId: '*' }, { excludedNames: ['Juan Garziera'] });
  assert.deepEqual(await service.ingest(scope, message('internal', 0, { name: 'Juan Garziera' })), { ignored: true });
  assert.ok((await service.ingest(foreign, message('internal', 0, { name: 'Juan Garziera' }))).id);
  const [draft] = await processMessages([message('one')]);
  await service.saveConfig(scope, { excludedJids: ['123@s.whatsapp.net'] });
  await assert.rejects(() => service.editDraft(scope, draft._id, 1, { companyId: '1', proposedAction: 'create' }, true), /conversation_excluded/);
});
test('encrypted Baileys auth persists binary keys without filesystem credentials', async () => {
  const b = await import('@whiskeysockets/baileys');
  const auth = await encryptedAuth(service, scope, b, async () => {});
  await auth.state.keys.set({ session: { abc: Buffer.from([1, 2, 3]) } }); await auth.saveCreds();
  const restored = await encryptedAuth(service, scope, b, async () => {});
  assert.deepEqual((await restored.state.keys.get('session', ['abc'])).abc, Buffer.from([1, 2, 3]));
  const separate = await encryptedAuth(service, other, b, async () => {});
  assert.equal((await separate.state.keys.get('session', ['abc'])).abc, null);
  await restored.state.keys.set({ session: { abc: null } });
  assert.equal((await restored.state.keys.get('session', ['abc'])).abc, null);
});
test('Baileys QR, live/history ingestion and logout operate through backend events', async () => {
  const b = await import('@whiskeysockets/baileys');
  const ev = new EventEmitter(), fakeSocket = { ev, end() {} };
  const runtime = new BaileysSessions(service, async () => {}, async () => ({ ...b, default: () => fakeSocket }));
  const id = scopedId(scope, 'session');
  await service.col('sessions').insertOne({ _id: id, ...scope, desired: 'connected' });
  await runtime.sync();
  ev.emit('connection.update', { qr: 'fake-qr' }); await runtime.sockets.get(id).tail;
  const row = await service.col('sessions').findOne(scope);
  assert.equal(row.state, 'qr'); assert.equal(vault.open(row.qr, id + ':qr'), 'fake-qr');
  const raw = { key: { remoteJid: '123@s.whatsapp.net', id: 'baileys-one' }, messageTimestamp: Date.parse('2026-09-01T11:00:00Z') / 1000, message: { conversation: 'Manager tiene un error' } };
  ev.emit('messages.upsert', { messages: [raw] }); await runtime.sockets.get(id).tail;
  ev.emit('messaging-history.set', { messages: [raw] }); await runtime.sockets.get(id).tail;
  assert.equal(await service.col('messages').countDocuments(scope), 1);
  const entry = runtime.sockets.get(id);
  ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: b.DisconnectReason.loggedOut } } } }); await entry.tail;
  assert.equal((await service.col('sessions').findOne(scope)).desired, 'disconnected');
  assert.equal(await service.col('auth').countDocuments(scope), 0); await runtime.stop();
});
test('HTTP scope ignores caller tenant/user overrides, rejects CSRF and hides credentials', async () => {
  const app = express();
  app.use((req, res, next) => { req.user = { uid: scope.userId, tenantId: scope.tenantId, role: req.headers['test-role'] || 'user', allowedPages: ['support'] }; next(); });
  app.use('/api/support', createRouter({ getService: async () => service, publicOrigin: 'https://asisto.example', hubspotEnabled: true, hubspotFactory: () => ({ metadata: async () => ({ properties: [] }) }) }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/support`;
  const headers = { 'Content-Type': 'application/json', Origin: 'https://asisto.example', 'X-Asisto-Support': '1' };
  try {
    let response = await fetch(base + '/settings', { method: 'PUT', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' }); assert.equal(response.status, 403);
    response = await fetch(base + '/settings?tenantId=evil', { method: 'PUT', headers, body: JSON.stringify({ userId: other.userId, inactivityMs: 60000 }) }); assert.equal(response.status, 200);
    assert.equal((await service.col('settings').findOne(scope)).config.inactivityMs, 60000); assert.equal(await service.col('settings').findOne(other), null);
    response = await fetch(base + '/hubspot', { method: 'PUT', headers, body: JSON.stringify({ token: 'fake-private-token' }) }); assert.equal(response.status, 403);
    response = await fetch(base + '/hubspot', { method: 'PUT', headers: { ...headers, 'test-role': 'admin' }, body: JSON.stringify({ token: 'fake-private-token' }) });
    assert.equal(response.status, 200); assert.equal((await response.text()).includes('fake-private-token'), false);
    const stored = await service.col('integrations').findOne({ tenantId: scope.tenantId });
    assert.equal(JSON.stringify(stored).includes('fake-private-token'), false);
    assert.equal(vault.open(stored.token, hash(scope.tenantId, 'hubspot')), 'fake-private-token');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('oversized message blocks its entire window instead of producing a partial draft', async () => {
  await processMessages([message('one'), message('too-long', 30, { text: 'x'.repeat(20001) })]);
  assert.equal((await service.listDrafts(scope)).length, 0);
  assert.equal((await service.col('jobs').findOne(scope)).error, 'message_too_large');
});
test('revoked user cannot incur processing after messages were queued', async () => {
  await service.ingest(scope, message('one'));
  await db.collection('users').updateOne({ _id: new ObjectId(scope.userId) }, { $set: { isLocked: true } });
  now = new Date(+now + 180001); await service.runOne();
  assert.equal(await service.col('usage').countDocuments(scope), 0);
  assert.equal((await service.col('jobs').findOne(scope)).error, 'access_revoked');
});
test('two simultaneous job claims produce only one analysis and an abandoned claim recovers', async () => {
  await service.ingest(scope, message('one')); now = new Date(+now + 180001);
  await Promise.all([service.runOne(), service.runOne()]);
  assert.equal(await service.col('usage').countDocuments({ kind: 'analysis' }), 1);
  await service.col('jobs').updateOne(scope, { $set: { state: 'processing', leaseUntil: new Date(+now - 1), claim: 'crashed-worker' } });
  await service.runOne(); assert.equal((await service.col('jobs').findOne(scope)).state, 'done');
  assert.equal((await service.listDrafts(scope)).length, 1);
});

test('Asisto menu, shell and user editor expose support only under the intended access rules', async () => {
  const dbModule = require('../db'), originalGetDb = dbModule.getDb;
  dbModule.getDb = async () => db;
  let auth;
  try { auth = require('../auth_ui'); } finally { dbModule.getDb = originalGetDb; }
  const app = express();
  app.use((req, res, next) => {
    req.user = { uid: scope.userId, username: 'fixture', tenantId: scope.tenantId, role: 'admin', allowedPages: req.headers['test-denied'] ? ['users'] : ['support', 'users'] };
    next();
  });
  auth.mountAuthRoutes(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const previous = process.env.SUPPORT_ENABLED;
  try {
    process.env.SUPPORT_ENABLED = 'true';
    const menu = await (await fetch(base + '/app')).text();
    assert.match(menu, /href="\/ui\/support"/);
    const shell = await fetch(base + '/ui/support'); assert.equal(shell.status, 200);
    assert.match(await shell.text(), /src="\/admin\/support\?embed=1"/);
    const editor = await (await fetch(base + '/admin/users')).text();
    assert.match(editor, /key: "support", title: "Tickets desde WhatsApp"/);
    const denied = await fetch(base + '/ui/support', { headers: { 'test-denied': '1' } }); assert.equal(denied.status, 403);
    const restrictedMenu = await (await fetch(base + '/app', { headers: { 'test-denied': '1' } })).text();
    assert.doesNotMatch(restrictedMenu, /href="\/ui\/support"/);
    process.env.SUPPORT_ENABLED = 'false';
    assert.match(await (await fetch(base + '/app')).text(), /href="\/ui\/support"/);
    assert.equal((await fetch(base + '/ui/support')).status, 200);
  } finally {
    if (previous === undefined) delete process.env.SUPPORT_ENABLED; else process.env.SUPPORT_ENABLED = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test('incomplete setup leaves the panel visible and operations blocked without crashing Asisto', async () => {
  const original = process.env.SUPPORT_ENCRYPTION_KEYS;
  process.env.SUPPORT_ENCRYPTION_KEYS = 'invalid-secret-fixture';
  const app = express();
  app.use((req, res, next) => { req.user = { uid: scope.userId, tenantId: scope.tenantId, role: 'user', allowedPages: ['support'] }; next(); });
  try { mountSupport(app); } finally { if (original === undefined) delete process.env.SUPPORT_ENCRYPTION_KEYS; else process.env.SUPPORT_ENCRYPTION_KEYS = original; }
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + '/api/support/status'), status = await response.json();
    assert.equal(response.status, 200); assert.equal(status.ready, false);
    assert.equal(JSON.stringify(status).includes('invalid-secret-fixture'), false);
    assert.equal((await fetch(base + '/admin/support')).status, 200);
    assert.equal((await fetch(base + '/api/support/session', { method: 'POST' })).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('manual identity flows into a draft and permits local approval with no HubSpot IDs or token', async () => {
  const identity = await service.rememberContact(scope, { jid: '123@s.whatsapp.net', company: 'Empresa de prueba', contact: 'Contacto de prueba' });
  assert.equal(identity.source, 'manual');
  assert.equal(await service.col('memory').findOne(other), null);
  assert.equal(await service.col('memory').findOne(foreign), null);
  const [draft] = await processMessages([message('local-only')]);
  assert.equal(draft.fields.company, identity.company);
  assert.equal(draft.fields.contact, identity.contact);
  assert.equal(draft.fields.companyId, ''); assert.equal(draft.fields.contactId, '');
  assert.equal(draft.fields.identitySource, 'manual');
  const approval = await service.editDraft(scope, draft._id, draft.revision, { proposedAction: 'create' }, true);
  assert.equal(approval.state, 'approved'); assert.equal(approval.remoteWrite, false);
  assert.equal(await service.col('integrations').countDocuments(), 0);
});

test('manual identity edits clear previous remote verification and reject fabricated verification', async () => {
  await service.col('memory').insertOne({ ...scope, jid: '123@s.whatsapp.net', companyId: 'remote-1', contactId: 'remote-2', verifiedAt: now, source: 'hubspot' });
  await service.rememberContact(scope, { jid: '123@s.whatsapp.net', company: 'Otra empresa', contact: 'Nombre manual' });
  const identity = await service.col('memory').findOne(scope);
  assert.equal(identity.source, 'manual'); assert.equal(identity.companyId, undefined); assert.equal(identity.contactId, undefined); assert.equal(identity.verifiedAt, undefined);
  assert.equal(identity.events.at(-1).action, 'identity_recorded_manually');
  await assert.rejects(() => service.rememberContact(scope, { jid: '123@s.whatsapp.net', company: 'Nombre', source: 'hubspot' }), /manual_identity_fields_only/);
  await assert.rejects(() => service.rememberContact(scope, { jid: '123@s.whatsapp.net', company: '  ' }), /company_required/);
});

test('deferred HubSpot phase rejects all connection endpoints before invoking the remote client', async () => {
  let remoteCalls = 0;
  const app = express();
  app.use((req, res, next) => { req.user = { uid: scope.userId, tenantId: scope.tenantId, role: 'admin', allowedPages: ['support'] }; next(); });
  app.use('/api/support', createRouter({ getService: async () => service, publicOrigin: 'https://asisto.example', hubspotEnabled: false, hubspotFactory: () => { remoteCalls++; throw new Error('unexpected_remote_call'); } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/support`;
  const headers = { 'Content-Type': 'application/json', Origin: 'https://asisto.example', 'X-Asisto-Support': '1' };
  try {
    assert.deepEqual(await (await fetch(base + '/capabilities')).json(), { hubspotEnabled: false });
    for (const [path, method] of [['/hubspot', 'PUT'], ['/hubspot/metadata', 'GET'], ['/hubspot/companies/123/tickets', 'GET'], ['/memory/verify', 'PUT']]) {
      const response = await fetch(base + path, { method, headers, ...(method === 'PUT' ? { body: '{}' } : {}) });
      assert.equal(response.status, 409); assert.equal((await response.json()).error, 'hubspot_deferred');
    }
    const saved = await fetch(base + '/memory', { method: 'PUT', headers, body: JSON.stringify({ jid: '123@s.whatsapp.net', company: 'Empresa manual', contact: 'Contacto manual' }) });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).source, 'manual');
    assert.equal(remoteCalls, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
