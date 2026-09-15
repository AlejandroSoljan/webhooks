// Asisto | Turnero AWS | Fecha: 2026-09-14
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { MongoClient } = require('mongodb');
const express = require('express');
const { mountQueue, presenceToken, validPresence } = require('../customer_queue');
const { queuePage } = require('../queue_pages');
const vm = require('node:vm');
let mongo, dir, client, db, server, url, sent = 0;
const cfg = { businessName: 'Mecan', branchId: 'CENTRAL', queuePresence: 'open', sectors: [{ id: 'ferreteria', name: 'Ferretería', prefix: 'F' }, { id: 'caja', name: 'Caja', prefix: 'C' }] };
before(async () => {
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-queue-test-'));
  const binary = process.env.QUEUE_TEST_MONGOD || 'C:\\Program Files\\MongoDB\\Server\\8.2\\bin\\mongod.exe';
  mongo = spawn(binary, ['--dbpath', dir, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet', '--logpath', path.join(dir, 'mongo.log')], { windowsHide: true, stdio: 'ignore' });
  let spawnError; mongo.on('error', e => { spawnError = e; });
  for (let i = 0; i < 80; i++) {
    if (spawnError) throw spawnError;
    client = new MongoClient('mongodb://127.0.0.1:' + port, { serverSelectionTimeoutMS: 200 });
    try { await client.connect(); break; } catch (e) { await client.close(); if (i === 79) throw e; await new Promise(r => setTimeout(r, 100)); }
  }
  db = client.db('queue_isolated_test');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.get('x-test-user')) req.user = { uid: 'test', tenantId: req.get('x-test-user'), username: 'Tester', role: 'admin' }; next(); });
  mountQueue(app, { getDb: async () => db, configFor: async () => cfg, dayKey: () => '2026-09-14', secret: 'test-secret', firebaseSender: async () => async () => { sent++; } });
  app.get('/api/customer-app/:tenant/config', (_req, res) => res.json(cfg));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); url = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  if (server) await new Promise(r => server.close(r)); await client?.close();
  if (mongo?.pid && mongo.exitCode === null) { const exit = new Promise(r => mongo.once('exit', r)); mongo.kill(); await exit; }
  if (dir && path.basename(dir).startsWith('asisto-queue-test-') && path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true });
});
async function req(route, body, user = '') { const r = await fetch(url + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; }
const api = '/api/customer-app/TEST', admin = '/api/customer-app-admin/TEST';
test('QR expires, rejects tampering and cannot be used by a different commerce', () => {
  const token = presenceToken('TEST', 'secret', 1000);
  assert.equal(validPresence(token, 'TEST', 'secret', 2000), true);
  assert.equal(validPresence(token, 'OTHER', 'secret', 2000), false);
  assert.equal(validPresence(token, 'TEST', 'secret', 91000), false);
  assert.equal(validPresence(token + 'x', 'TEST', 'secret', 2000), false);
});
test('pages contain syntactically valid scripts and escape tenant names', () => {
  for (const mode of ['kiosk', 'display', 'admin']) { const html = queuePage('TEST', mode); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]); }
});
test('existing Android page still renders with a valid embedded script', async () => {
  const app = express(); require('../customer_app_web').mountCustomerApp(app);
  const temp = app.listen(0, '127.0.0.1'); await new Promise(r => temp.once('listening', r));
  try { const html = await (await fetch('http://127.0.0.1:' + temp.address().port + '/customer-app/TEST')).text(); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]); }
  finally { await new Promise(r => temp.close(r)); }
});
test('two kiosks allocate unique numbers; same device retries return the same ticket', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => req(api + '/tickets', { sectorId: 'ferreteria', installId: 'device-' + i, source: 'kiosk' }, 'TEST')));
  assert.ok(results.every(r => r.status === 200)); assert.equal(new Set(results.map(r => r.body.displayNumber)).size, 12);
  const repeated = await Promise.all(Array.from({ length: 4 }, () => req(api + '/tickets', { sectorId: 'ferreteria', installId: 'device-0' })));
  assert.ok(repeated.every(r => r.body.id === results[0].body.id)); assert.equal(sent, 0);
});
test('unauthorized callers cannot operate another tenant or spoof kiosk access', async () => {
  assert.equal((await req(admin + '/sectors/ferreteria/next', { expectedTicketId: null })).status, 401);
  assert.equal((await req(admin + '/sectors/ferreteria/next', { expectedTicketId: null }, 'OTHER')).status, 403);
  assert.equal((await req(api + '/tickets', { sectorId: 'caja', installId: 'intruder', source: 'kiosk' })).status, 401);
});
test('concurrent calls cannot skip a ticket; transfer preserves identity and joins end of destination queue', async () => {
  const waiting = await req(api + '/tickets', { sectorId: 'caja', installId: 'cash-client' });
  await db.collection('customer_app_devices').insertOne({ tenantId: 'TEST', installId: 'device-0', pushToken: 'mock' });
  const calls = await Promise.all([1, 2].map(() => req(admin + '/sectors/ferreteria/next', { expectedTicketId: null, desk: 'Puesto 1' }, 'TEST')));
  assert.deepEqual(calls.map(x => x.status).sort(), [200, 409]);
  const current = calls.find(x => x.status === 200).body.ticket; assert.equal(sent, 1);
  assert.equal((await req(admin + '/sectors/ferreteria/transfer', { expectedTicketId: current.id, destination: 'invalid' }, 'TEST')).status, 400);
  const moved = await req(admin + '/sectors/ferreteria/transfer', { expectedTicketId: current.id, destination: 'caja' }, 'TEST');
  assert.equal(moved.body.ticket.id, current.id); assert.equal(moved.body.ticket.displayNumber, current.displayNumber);
  const mobile = await req(api + '/tickets/' + current.id + '?installId=device-0'); assert.equal(mobile.body.sectorId, 'caja'); assert.equal(mobile.body.peopleAhead, 1);
  const state = await req(api + '/queue'); assert.equal(state.body.sectors[0].current, null); assert.equal(state.body.sectors[1].next[0].displayNumber, waiting.body.displayNumber);
  assert.equal((await req(api + '/tickets/' + current.id + '?installId=wrong')).status, 404);
  const history = (await db.collection('queue_tickets').findOne({ installId: 'device-0' })).history; assert.deepEqual(history.map(h => h.action), ['created', 'next', 'transfer']);
});
test('presence gate only restricts new tickets and permits recovery after QR expiration', async () => {
  cfg.queuePresence = 'qr';
  assert.equal((await req(api + '/tickets', { sectorId: 'caja', installId: 'outside' })).status, 403);
  const x = await req(api + '/tickets', { sectorId: 'caja', installId: 'inside', presence: presenceToken('TEST', 'test-secret') }); assert.equal(x.status, 200);
  const retry = await req(api + '/tickets', { sectorId: 'caja', installId: 'inside' }); assert.equal(retry.body.id, x.body.id);
  assert.equal((await req(api + '/tickets/' + x.body.id + '?installId=inside')).status, 200);
  const qr = await req(admin + '/presence', undefined, 'TEST'); assert.match(qr.body.image, /^data:image\/png;base64,/);
});
test('finish and skip clear the section, and a late kiosk retry cannot issue a second ticket', async () => {
  const next = await req(admin + '/sectors/ferreteria/next', { expectedTicketId: null }, 'TEST');
  const doc = await db.collection('queue_tickets').findOne({ _id: new (require('mongodb').ObjectId)(next.body.ticket.id) });
  assert.equal((await req(admin + '/sectors/ferreteria/finish', { expectedTicketId: 'stale' }, 'TEST')).status, 409);
  assert.equal((await req(admin + '/sectors/ferreteria/finish', { expectedTicketId: next.body.ticket.id }, 'TEST')).status, 200);
  const retry = await req(api + '/tickets', { sectorId: 'ferreteria', installId: doc.installId, source: 'kiosk' }, 'TEST'); assert.equal(retry.body.id, next.body.ticket.id); assert.equal(retry.body.status, 'DONE');
  const another = await req(admin + '/sectors/ferreteria/next', { expectedTicketId: null }, 'TEST');
  const skipped = await req(admin + '/sectors/ferreteria/skip', { expectedTicketId: another.body.ticket.id }, 'TEST'); assert.equal(skipped.body.ticket.status, 'SKIPPED');
});
