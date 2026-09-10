// Asisto | Version: 5.00.077 | Fecha: 2026-09-09
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const { EventEmitter } = require('node:events');

const { migrate } = require('../src/support/migration');
const { createVault } = require('../src/support/crypto');
const { SupportService } = require('../src/support/service');

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
test('queue repairs an insertion/enqueue crash', async () => {
  await service.ingest(scope, message('one'));
  await service.col('jobs').deleteMany({}); await service.col('messages').updateMany({}, { $set: { queued: false } });
  await service.repairQueue(); assert.equal(await service.col('jobs').countDocuments(), 1);
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
    response = await fetch(base + '/hubspot', { method: 'PUT', headers, body: JSON.stringify({ token: 'fake-private-token' }) }); assert.equal(response.status, 410);
    response = await fetch(base + '/hubspot', { method: 'PUT', headers: { ...headers, 'test-role': 'admin' }, body: JSON.stringify({ token: 'fake-private-token' }) });
    assert.equal(response.status, 410); assert.equal((await response.text()).includes('fake-private-token'), false);
    assert.equal(await service.col('integrations').findOne({ tenantId: scope.tenantId }), null);
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
    req.user = { uid: scope.userId, username: 'fixture', tenantId: scope.tenantId, role: 'admin', allowedPages: req.headers['test-denied'] ? ['users'] : req.headers['test-both'] ? ['wweb', 'support'] : req.headers['test-legacy'] ? ['wweb'] : ['support', 'users'] };
    next();
  });
  auth.protectRoutes(app);
  auth.mountAuthRoutes(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const previous = process.env.SUPPORT_ENABLED;
  try {
    process.env.SUPPORT_ENABLED = 'true';
    const menu = await (await fetch(base + '/app')).text();
    assert.doesNotMatch(menu, /href="\/ui\/support"/);
    assert.match(menu, /href="\/admin\/wweb"/);
    const sessions = await fetch(base + '/admin/wweb?device=ABCDEF123456');
    assert.equal(sessions.status, 200);
    const personal = await sessions.text();
    assert.match(personal, /view=connection&amp;device=ABCDEF123456/);
    assert.doesNotMatch(personal, /id="wwebBody"/);
    assert.equal((await fetch(base + '/api/wweb/locks')).status, 403);
    assert.equal((await fetch(base + '/admin/wweb', { headers: { 'test-denied': '1' } })).status, 403);
    const legacy = await (await fetch(base + '/admin/wweb', { headers: { 'test-legacy': '1' } })).text();
    assert.match(legacy, /id="wwebBody"/);
    assert.doesNotMatch(legacy, /title="Vincular mi PC y WhatsApp"/);
    const combined = await (await fetch(base + '/admin/wweb', { headers: { 'test-both': '1' } })).text();
    for (const id of ['wwebBody', 'wwebSearch', 'wwebStateFilter', 'qrModal', 'statsModal']) assert.ok(combined.includes(`id="${id}"`));
    assert.match(combined, /id="personalQrOpen">Escanear mi QR/);
    assert.doesNotMatch(combined, /<dialog[^>]*\sopen[\s>]/);
    assert.doesNotMatch(combined, /<iframe[^>]*\ssrc=/);
    assert.doesNotMatch(combined, /Mi WhatsApp en esta PC|height:850px/);
    assert.ok(combined.indexOf('<h2 style="margin:0 0 6px">Sesiones WhatsApp Web') < combined.indexOf('id="personalQrOpen"'));
    const invalidCode = await (await fetch(base + '/admin/wweb?device=%22%3E%3Cscript%3E')).text();
    assert.doesNotMatch(invalidCode, /view=connection&amp;device=/);
    const shell = await fetch(base + '/ui/support'); assert.equal(shell.status, 200);
    assert.match(shell.url, /\/admin\/wweb$/); assert.doesNotMatch(await shell.text(), /Tickets desde WhatsApp/);
    const editor = await (await fetch(base + '/admin/users')).text();
    assert.match(editor, /key: "support", title: "Extensión de tareas WhatsApp"/);
    const denied = await fetch(base + '/ui/support', { headers: { 'test-denied': '1' } }); assert.equal(denied.status, 403);
    const restrictedMenu = await (await fetch(base + '/app', { headers: { 'test-denied': '1' } })).text();
    assert.doesNotMatch(restrictedMenu, /href="\/ui\/support"/);
    process.env.SUPPORT_ENABLED = 'false';
    assert.doesNotMatch(await (await fetch(base + '/app')).text(), /href="\/ui\/support"/);
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
    const panel = await fetch(base + '/admin/support');
    assert.equal(panel.status, 200);
    const directives = new Map(panel.headers.get('content-security-policy').split(';').map(part => { const [name, ...sources] = part.trim().split(/\s+/); return [name, sources]; }));
    assert.deepEqual(directives.get('connect-src'), ["'self'", 'http://127.0.0.1:17658']);
    assert.deepEqual(directives.get('script-src'), ["'self'"]);
    assert.deepEqual(directives.get('frame-ancestors'), ["'self'"]);
    assert.equal((await fetch(base + '/api/support/session', { method: 'POST' })).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('AI task analysis creates a title and operational summary under the dedicated token-control type', async () => {
  service.titleAnalyzer = { run: async () => ({ subject: 'Corregir impresión de facturas', description: 'El cliente informa que la factura no se imprime. Queda pendiente revisar la configuración de impresión.', model: 'fixture-ai', inputTokens: 40, outputTokens: 8, totalTokens: 48 }) };
  const [draft] = await processMessages([message('ai-title', 0, { text: 'Esto no aparece, así que lo vuelvo a generar.' })]);
  assert.equal(draft.fields.subject, 'Corregir impresión de facturas');
  assert.match(draft.fields.description, /Queda pendiente/);
  assert.match(draft.source.description, /Esto no aparece/);
  assert.doesNotMatch(draft.fields.description, /Esto no aparece/);
  const usage = await db.collection('ai_token_usage_log').findOne({ tenantId: scope.tenantId, channelType: 'whatsapp_tasks' });
  assert.equal(usage.meta.usageType, 'whatsapp_task_summary');
  assert.equal(usage.totalTokens, 48);
});
test('old generated task titles are repaired without overwriting a human title', async () => {
  let calls = 0;
  service.titleAnalyzer = { run: async () => { calls++; return { subject: 'Coordinar entrega de mercadería pendiente', description: 'Se debe coordinar la entrega de mercadería que continúa pendiente.', model: 'fixture-ai', inputTokens: 20, outputTokens: 6, totalTokens: 26 }; } };
  let [draft] = await processMessages([message('old-title', 0, { text: 'Después sigo teniendo el tema de la mercadería pendiente de entrega.' })]);
  await service.col('drafts').updateOne({ _id: draft._id }, { $set: { analyzerVersion: 'support-task-groups-v4' } });
  assert.equal(await service.repairTitle(scope), true);
  [draft] = await service.listDrafts(scope); assert.equal(draft.fields.subject, 'Coordinar entrega de mercadería pendiente'); assert.match(draft.fields.description, /coordinar la entrega/);
  await service.editDraft(scope, draft._id, draft.revision, { subject: 'Título definido por la persona' });
  await service.col('drafts').updateOne({ _id: draft._id }, { $set: { analyzerVersion: 'support-task-groups-v4' } });
  assert.equal(await service.repairTitle(scope), true);
  [draft] = await service.listDrafts(scope); assert.equal(draft.fields.subject, 'Título definido por la persona'); assert.equal(calls, 2);
});
test('opening an edited legacy task summarizes only a description that still copies its source conversation', async () => {
  let summary = 'Resumen inicial.';
  service.titleAnalyzer = { run: async () => ({ subject: 'Título de IA', description: summary, model: 'fixture-ai', inputTokens: 10, outputTokens: 5, totalTokens: 15 }) };
  let [draft] = await processMessages([message('legacy-description', 0, { text: 'Necesito revisar la configuración del servidor.' })]);
  await service.editDraft(scope, draft._id, draft.revision, { subject: 'Título definido por el usuario', description: draft.source.description, category: 'Soporte Servidor Virtual' });
  [draft] = await service.listDrafts(scope);
  const differentSource = { ...draft.source, description: 'Conversación de origen:\n' + draft.source.description };
  await service.col('drafts').updateOne({ _id: draft._id }, { $set: { source: service.vault.seal(differentSource, draft._id + ':source') } });
  summary = 'El cliente solicita revisar la configuración del servidor. Queda pendiente realizar el diagnóstico.';
  assert.equal(await service.summarizeDraft(scope, draft._id), true);
  [draft] = await service.listDrafts(scope);
  assert.equal(draft.fields.subject, 'Título definido por el usuario');
  assert.equal(draft.fields.category, 'Soporte Servidor Virtual');
  assert.equal(draft.fields.description, summary);
  assert.match(draft.source.description, /Necesito revisar/);
});

test('discarded conversations have evidence, a separate scoped view, and populate fields when later history reveals a task', async () => {
  const [generated] = await processMessages([message('greeting', 0, { text: 'Buen día' })]);
  await service.col('drafts').updateOne({ _id: generated._id }, { $set: { state: 'ignored', analyzerVersion: 'manager-rules-v1' } });
  const [discarded] = await service.listDrafts(scope, null, 'ignored');
  assert.equal(discarded.state, 'ignored');
  assert.match(discarded.source.description, /Buen día/);
  assert.equal((await service.listDrafts(scope, null, 'tasks')).length, 0);
  assert.equal((await service.listDrafts(scope, null, 'ignored')).length, 1);
  assert.equal((await service.listDrafts(other, null, 'ignored')).length, 0);
  assert.match((await service.evidence(scope, discarded._id)).description, /Buen día/);
  await assert.rejects(() => service.evidence(other, discarded._id), /not_found/);
  await assert.rejects(() => service.listDrafts(scope, null, 'invalid'), /invalid_draft_view/);
  await processMessages([message('problem', 30)]);
  const [draft] = await service.listDrafts(scope, null, 'tasks');
  assert.equal(draft._id, discarded._id);
  assert.equal(draft.state, 'pending');
  assert.match(draft.fields.subject, /Manager/);
  assert.match(draft.fields.description, /Buen día/);
  assert.equal(draft.sourceChanged, false);
  assert.equal((await service.listDrafts(scope, null, 'ignored')).length, 0);
});

test('more history keeps a non-excluded conversation available for review', async () => {
  await processMessages([message('greeting', 0, { text: 'Hola' })]);
  await processMessages([message('reply', 30, { text: 'Buen día', fromMe: true })]);
  assert.equal((await service.listDrafts(scope, null, 'tasks')).length, 1);
  const [draft] = await service.listDrafts(scope, null, 'tasks');
  assert.match(draft.source.description, /Buen día/);
});

test('history requested before sync processes later messages only within the selected period and owner', async () => {
  const from = '2026-09-01T10:00:00Z', to = '2026-09-01T12:00:00Z';
  assert.equal((await service.history(scope, from, to)).messages, 0);
  await service.ingest(scope, message('older', -7200), { historical: true });
  assert.equal(await service.col('jobs').countDocuments(scope), 0);
  await service.ingest(other, message('other-history'), { historical: true });
  assert.equal(await service.col('jobs').countDocuments(other), 0);
  await service.ingest(scope, message('in-range'), { historical: true });
  now = new Date(+now + 1001); await service.runOne();
  const [draft] = await service.listDrafts(scope);
  assert.equal(draft.messageIds.length, 1);
  assert.equal((await service.historyStatus(scope, from, to)).done, 1);
  assert.equal((await service.historyStatus(other, from, to)).done, 0);
  assert.equal((await service.history(scope, from, to)).messages, 1);
});
test('history works with the strict MongoDB Stable API used by Asisto', async () => {
  await service.ingest(scope, message('strict-history'));
  const strict = await new MongoClient(mongo.getUri(), { serverApi: { version: '1', strict: true } }).connect();
  try {
    const strictService = new SupportService(strict.db('support_test'), vault, { now: () => now });
    assert.equal((await strictService.history(scope, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z')).conversations, 1);
    assert.equal((await strictService.history(other, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z')).conversations, 0);
  } finally { await strict.close(); }
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
    assert.deepEqual(await (await fetch(base + '/capabilities')).json(), { hubspotEnabled: false, ...scope });
    for (const [path, method] of [['/hubspot', 'PUT'], ['/hubspot/metadata', 'GET'], ['/hubspot/companies/123/tickets', 'GET'], ['/memory/verify', 'PUT']]) {
      const response = await fetch(base + path, { method, headers, ...(method === 'PUT' ? { body: '{}' } : {}) });
      assert.equal(response.status, 409); assert.equal((await response.json()).error, 'hubspot_deferred');
    }
    const saved = await fetch(base + '/memory', { method: 'PUT', headers, body: JSON.stringify({ jid: '123@s.whatsapp.net', company: 'Empresa manual', contact: 'Contacto manual' }) });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).source, 'manual');
    assert.equal(remoteCalls, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('upgraded analysis recovers an old discarded task even when its message fingerprint is unchanged', async () => {
  const rows = [message('totals', 0, { text: 'Necesitaría un totalizador por cuenta entre fechas para revisar gastos.' }), message('guidance', 60, { fromMe: true, text: 'Tenés que ir al módulo de contabilidad para sumas y saldos. Ahora te paso un video.' })];
  const [draft] = await processMessages(rows);
  const old = { ...draft.fields, result: 'ignored', subject: '', description: '', reason: 'no_explicit_manager_task' };
  await service.col('drafts').updateOne({ _id: draft._id }, { $set: { analyzerVersion: 'manager-rules-v1', state: 'ignored', fields: vault.seal(old, draft._id), source: vault.seal(old, draft._id + ':source') } });
  await service.history(scope, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z');
  await service.runOne();
  const [recovered] = await service.listDrafts(scope, null, 'tasks');
  assert.equal(recovered._id, draft._id);
  assert.equal(recovered.fingerprint, draft.fingerprint);
  assert.equal(recovered.state, 'pending');
  assert.equal(recovered.fields.subject, 'Totalizador de gastos por cuenta y período');
  assert.equal(recovered.fields.status, 'En Proceso');
  assert.equal(recovered.revision, 2);
  assert.equal((await service.listDrafts(scope, null, 'ignored')).length, 0);
});
test('historical fragments consolidate idempotently while retaining their records and one human edit', async () => {
  const input = [message('request', 0, { text: 'Necesito revisar el stock para cargar una venta' }), message('reply', 180, { text: 'Revisemos la cuenta contable', fromMe: true }), message('ack', 2700, { text: 'Dale, ya te paso' })];
  for (const row of input) await service.ingest(scope, row);
  const messages = await service.col('messages').find(scope).sort({ at: 1 }).toArray();
  for (const [index, row] of messages.entries()) {
    const id = scopedId(scope, 'draft', row._id), fields = { subject: index === 1 ? 'Título revisado' : input[index].text, contact: '', messageDate: row.at.toISOString(), proposedAction: 'review' };
    await service.col('drafts').insertOne({ _id: id, ...scope, jid: row.jid, messageIds: [row._id], fingerprint: hash([row._id]), analyzerVersion: 'support-documentation-v3', state: 'pending', revision: 1, fields: vault.seal(fields, id), source: vault.seal(fields, id + ':source'), createdAt: now, events: [{ action: index === 1 ? 'edited' : 'generated' }] });
  }
  await service.history(scope, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z'); await service.runOne();
  const [draft] = await service.listDrafts(scope);
  assert.equal((await service.listDrafts(scope)).length, 1);
  assert.equal(draft.fields.subject, 'Título revisado');
  assert.equal(draft.messageIds.length, 3); assert.equal(draft.mergedDraftIds.length, 2);
  assert.match(draft.source.description, /Dale, ya te paso/);
  assert.equal(draft.sourceChanged, true);
  const merged = await service.col('drafts').findOne({ ...scope, state: 'merged' });
  assert.equal(merged.mergedInto, draft._id);
  await assert.rejects(() => service.editDraft(scope, merged._id, merged.revision, { subject: 'stale form' }), /draft_merged/);
  await service.history(scope, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z'); await service.runOne();
  assert.equal((await service.listDrafts(scope)).length, 1);
  assert.equal((await service.listDrafts(scope))[0].revision, draft.revision);
});

test('late WhatsApp names fill blank contacts and preserve manually entered contact names', async () => {
  const [draft] = await processMessages([message('anonymous', 0, { name: '' }), message('later-name', 30, { name: 'Nombre del perfil' })]);
  assert.equal(draft.fields.contact, 'Nombre del perfil');
  await service.col('contacts').insertOne({ _id: scopedId(scope, 'contact', draft.jid), ...scope, jid: draft.jid, name: 'Nombre de agenda' });
  await service.editDraft(scope, draft._id, draft.revision, { contact: '' });
  assert.equal((await service.listDrafts(scope))[0].fields.contact, 'Nombre de agenda');
  const current = await service.col('drafts').findOne({ _id: draft._id });
  await service.editDraft(scope, draft._id, current.revision, { contact: 'Nombre corregido' });
  assert.equal((await service.listDrafts(scope))[0].fields.contact, 'Nombre corregido');
  assert.equal((await service.listDrafts(other)).length, 0);
});
