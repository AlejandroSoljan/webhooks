// Asisto | Turnero AWS | Fecha: 2026-09-14
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const { mountQueue, presenceToken, validPresence } = require('../customer_queue');
const { queuePage } = require('../queue_pages');
const vm = require('node:vm');
let mongo, client, db, server, url, queue, sent = 0;
const notifications = []; let rejectPush = false;
const cfg = { businessName: 'Mecan', branchId: 'CENTRAL', queuePresence: 'open', sectors: [{ id: 'ferreteria', name: 'Ferretería', prefix: 'F' }, { id: 'caja', name: 'Caja', prefix: 'C' }] };
before(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db('queue_isolated_test');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.get('x-test-user')) req.user = { uid: 'test', tenantId: req.get('x-test-user'), username: 'Tester', role: req.get('x-test-role') || 'admin' }; next(); });
  queue = mountQueue(app, { openTenants: ['OPEN'], getDb: async () => db, configFor: async () => cfg, dayKey: () => '2026-09-14', secret: 'test-secret', auth: { appShell: ({ active, main }) => `<nav data-active="${active}">Menú Asisto</nav>${main}` }, firebaseSender: async () => async (token, message) => { if (rejectPush) throw Error('mock_failure'); sent++; notifications.push({ token, ...message }); } });
  app.get('/api/customer-app/:tenant/config', (_req, res) => res.json(cfg));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); url = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  if (server) await new Promise(r => server.close(r)); await client?.close();
  await mongo?.stop();
});
async function req(route, body, user = '') { const r = await fetch(url + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; }
const api = '/api/customer-app/TEST', admin = '/api/customer-app-admin/TEST';
test('statistics reconstruct transfers and do not reset service time on recalls', () => {
  const { summarize, ticketVisits, statsPage } = require('../queue_stats');
  const at = seconds => new Date(Date.UTC(2026, 8, 14, 12, 0, seconds));
  const doc = { _id: 'stats', displayNumber: 'F001', dayKey: '2026-09-14', status: 'DONE', createdAt: at(0), history: [
    { action: 'created', sectorId: 'ferreteria', at: at(0) }, { action: 'claimed', at: at(30) },
    { action: 'next', at: at(90) }, { action: 'recall', at: at(100) },
    { action: 'transfer', destination: 'caja', at: at(150) }, { action: 'next', at: at(270) }, { action: 'finish', at: at(450) },
  ] };
  assert.deepEqual(ticketVisits(doc).map(v => [v.sectorId, v.waitSeconds, v.serviceSeconds]), [['ferreteria', 60, 60], ['caja', 120, 180]]);
  const x = summarize([doc], cfg.sectors); assert.equal(x.summary.transfers, 1); assert.equal(x.summary.issued, 1); assert.equal(x.summary.averageWaitSeconds, 90); assert.equal(x.summary.averageServiceSeconds, 120);
  assert.deepEqual(ticketVisits({ status: 'CANCELLED', history: [] }), []);
  const cancelled = { _id: 'cancelled', displayNumber: 'F002', dayKey: '2026-09-14', status: 'CANCELLED', source: 'mobile', sectorId: 'ferreteria', createdAt: at(0), history: [{ action: 'created', sectorId: 'ferreteria', at: at(0) }, { action: 'customer_cancelled', sectorId: 'ferreteria', at: at(30) }] };
  const cancellationStats = summarize([cancelled], cfg.sectors); assert.equal(cancellationStats.summary.customerCancelled, 1); assert.equal(cancellationStats.summary.expired, 0); assert.equal(ticketVisits(cancelled)[0].outcome, 'customer_cancelled');
  new vm.Script(statsPage('TEST', '2026-09-14').match(/<script>([\s\S]*)<\/script>/)[1]);
});
test('queue statistics use the Asisto shell and superadmin can select a tenant', async () => {
  await db.collection('tenant_config').insertMany([{ _id: 'ALFA' }, { _id: 'BETA' }]);
  const shell = await fetch(url + '/ui/turnero/TEST/estadisticas', { headers: { 'x-test-user': 'TEST' } });
  const shellHtml = await shell.text(); assert.equal(shell.status, 200); assert.match(shellHtml, /Menú Asisto/); assert.match(shellHtml, /data-active="queue_stats"/); assert.match(shellHtml, /<iframe[^>]+embed=1/); assert.doesNotMatch(shellHtml, /id="statsTenant"/);
  const embedded = await fetch(url + '/ui/turnero/TEST/estadisticas?embed=1', { headers: { 'x-test-user': 'TEST', 'x-test-role': 'superadmin' } });
  const embeddedHtml = await embedded.text(); assert.equal(embedded.status, 200); assert.match(embeddedHtml, /id="statsTenant"/); assert.match(embeddedHtml, />ALFA</); assert.match(embeddedHtml, />BETA</); new vm.Script(embeddedHtml.match(/<script>([\s\S]*)<\/script>/)[1]);
});
test('notification history filters preserve legacy manual records and separate queue automation', () => {
  const { notificationHistoryFilter, panelPage } = require('../customer_notifications');
  assert.deepEqual(notificationHistoryFilter('test', 'automatic_queue'), { tenantId: 'TEST', notificationType: 'automatic_queue' });
  assert.deepEqual(notificationHistoryFilter('test', 'manual'), { tenantId: 'TEST', $or: [{ notificationType: 'manual' }, { notificationType: { $exists: false } }] });
  assert.deepEqual(notificationHistoryFilter('test', 'all'), { tenantId: 'TEST' });
  assert.equal(notificationHistoryFilter('test', 'wrong'), null);
  const html = panelPage({ tenantId: 'TEST', tenants: ['TEST'], isSuper: false });
  assert.match(html, /Automáticas por turnos/); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
});
test('Asisto navigation builds the queue statistics link without breaking login users', () => {
  const { getNavItemsForUser } = require('../auth_ui');
  const regular = getNavItemsForUser({ role: 'admin', tenantId: 'demo_ferreteria', allowedPages: ['queue_stats'] });
  assert.ok(regular.some(item => item.title === 'Estadísticas' && item.href === '/ui/turnero/demo_ferreteria/estadisticas'));
  assert.doesNotThrow(() => getNavItemsForUser({ role: 'admin', tenantId: null }));
  assert.ok(!getNavItemsForUser({ role: 'admin', tenantId: 'TEST', allowedPages: [] }).some(item => item.key === 'queue_stats'));
});
test('temporary open tenant exposes operation and statistics without a session', async () => {
  cfg.queuePresence = 'open';
  for (const route of ['/customer-app/OPEN/kiosk', '/ui/turnero/OPEN']) assert.equal((await fetch(url + route, { redirect: 'manual' })).status, 200);
  const x = await req('/api/customer-app/OPEN/tickets', { sectorId: 'caja', installId: 'open-kiosk', source: 'kiosk' }); assert.equal(x.status, 200);
  assert.equal((await req('/api/customer-app-admin/OPEN/sectors/caja/next', { expectedTicketId: null, desk: 'Caja abierta' })).status, 200);
  const publicStatsPage = await fetch(url + '/ui/turnero/OPEN/estadisticas', { redirect: 'manual' });
  assert.equal(publicStatsPage.status, 200); assert.match(await publicStatsPage.text(), /Estadísticas de turnos/);
  assert.equal((await req('/api/customer-app-admin/OPEN/stats')).status, 200);
  assert.equal((await req('/api/customer-app-admin/OPEN/stats', undefined, 'TEST')).status, 200);
  assert.equal((await req('/api/customer-app-admin/OPEN/stats', undefined, 'OPEN')).status, 200);
  assert.equal((await req('/api/customer-app-admin/OPEN/stats?from=2026-02-30')).status, 400);
});
test('QR expires, rejects tampering and cannot be used by a different commerce', () => {
  const token = presenceToken('TEST', 'secret', 1000);
  assert.equal(validPresence(token, 'TEST', 'secret', 2000), true);
  assert.equal(validPresence(token, 'OTHER', 'secret', 2000), false);
  assert.equal(validPresence(token, 'TEST', 'secret', 91000), false);
  assert.equal(validPresence(token + 'x', 'TEST', 'secret', 2000), false);
});
test('pages contain syntactically valid scripts and escape tenant names', () => {
  for (const mode of ['kiosk', 'display', 'admin']) { const html = queuePage('TEST', mode); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]); if (mode === 'kiosk') assert.match(html, /id="dismissTicket"[^>]+aria-label="Cerrar y cancelar esta reserva"/); else { assert.match(html, /enableCallSound/); assert.match(html, /transferControls/); } }
  assert.match(queuePage('TEST', 'kiosk'), /Recibí el llamado en tu celular/);
  assert.match(queuePage('MCN', 'kiosk'), /Te avisaremos en el celular cuando sea tu turno/);
});
test('attention page only builds the section selector for the all-sections view', () => {
  const html = queuePage('MCN', 'admin');
  assert.match(html, /if\(!selectedSector\)\{root\.append\(element\('label','Sección'\)\)/);
  assert.match(html, /const visible=x\.sectors\.filter\(s=>!selectedSector\|\|s\.id===selectedSector\)/);
});
test('existing Android page renders cancellation and product discovery with a valid script', async () => {
  const app = express(); require('../customer_app_web').mountCustomerApp(app);
  const temp = app.listen(0, '127.0.0.1'); await new Promise(r => temp.once('listening', r));
  try { const html = await (await fetch('http://127.0.0.1:' + temp.address().port + '/customer-app/TEST')).text(); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]); assert.match(html, /Cancelar mi turno/); assert.match(html, /consultar con IA/); assert.match(html, /activeTicketDialog/); }
  finally { await new Promise(r => temp.close(r)); }
});
test('two kiosks allocate unique numbers; same device retries return the same ticket', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => req(api + '/tickets', { sectorId: 'ferreteria', installId: 'device-' + i, source: 'kiosk' }, 'TEST')));
  assert.ok(results.every(r => r.status === 200)); assert.equal(new Set(results.map(r => r.body.displayNumber)).size, 12);
  const repeated = await Promise.all(Array.from({ length: 4 }, () => req(api + '/tickets', { sectorId: 'ferreteria', installId: 'device-0' })));
  assert.ok(repeated.every(r => r.body.id === results[0].body.id)); assert.equal(sent, 0);
});
test('a phone can cancel only its own active ticket and then request a new one', async () => {
  const created = await req(api + '/tickets', { sectorId: 'caja', installId: 'cancel-owner' });
  assert.equal(created.status, 200);
  assert.equal((await req(api + '/tickets/' + created.body.id + '/cancel', { installId: 'somebody-else' })).status, 404);
  const cancelled = await req(api + '/tickets/' + created.body.id + '/cancel', { installId: 'cancel-owner' });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.status, 'CANCELLED'); assert.equal(cancelled.body.cancelled, true);
  const repeated = await req(api + '/tickets/' + created.body.id + '/cancel', { installId: 'cancel-owner' }); assert.equal(repeated.status, 200);
  const replacement = await req(api + '/tickets', { sectorId: 'ferreteria', installId: 'cancel-owner' });
  assert.equal(replacement.status, 200); assert.notEqual(replacement.body.id, created.body.id);
  const doc = await db.collection('queue_tickets').findOne({ _id: new (require('mongodb').ObjectId)(created.body.id) });
  assert.deepEqual(doc.history.map(h => h.action), ['created', 'customer_cancelled']);
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
test('calling next finishes the current ticket and advances in one action', async () => {
  const a = await req('/api/customer-app/ADVANCE/tickets', { sectorId: 'ferreteria', installId: 'advance-a', presence: presenceToken('ADVANCE', 'test-secret') });
  const b = await req('/api/customer-app/ADVANCE/tickets', { sectorId: 'ferreteria', installId: 'advance-b', presence: presenceToken('ADVANCE', 'test-secret') });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const op = '/api/customer-app-admin/ADVANCE/sectors/ferreteria/next';
  const first = await req(op, { expectedTicketId: null, desk: 'Mostrador 1' }, 'ADVANCE');
  assert.equal(first.status, 200); assert.equal(first.body.ticket.id, a.body.id);
  const stale = await req(op, { expectedTicketId: null, desk: 'Mostrador 2' }, 'ADVANCE');
  assert.equal(stale.status, 409);
  const second = await req(op, { expectedTicketId: a.body.id, desk: 'Mostrador 1' }, 'ADVANCE');
  assert.equal(second.status, 200); assert.equal(second.body.ticket.id, b.body.id);
  const old = await db.collection('queue_tickets').findOne({ _id: new (require('mongodb').ObjectId)(a.body.id) });
  assert.equal(old.status, 'DONE'); assert.equal(old.history.at(-1).action, 'finish'); assert.equal(old.history.at(-1).reason, 'next');
  const state = await req('/api/customer-app/ADVANCE/queue');
  assert.equal(state.body.sectors[0].current.id, b.body.id);
  assert.equal((await req(op, { expectedTicketId: b.body.id }, 'ADVANCE')).status, 409);
  const stillCurrent = await req('/api/customer-app/ADVANCE/tickets/' + b.body.id + '?installId=advance-b');
  assert.equal(stillCurrent.body.status, 'CALLED');
});
let reserved, claim;
test('QR-first issuance reserves without joining the callable queue; a retry keeps its QR', async () => {
  const payload = { sectorId: 'caja', installId: 'kiosk-reservation', source: 'kiosk', delivery: 'qr_or_print' };
  const r = await req(api + '/tickets', payload, 'TEST'); assert.equal(r.status, 200); reserved = r.body;
  assert.equal(reserved.status, 'RESERVED'); assert.match(reserved.claimQr, /^data:image\/png/);
  claim = new URLSearchParams(new URL(reserved.claimUrl).hash.slice(1)).get('code');
  const retry = await req(api + '/tickets', payload, 'TEST'); assert.equal(retry.body.claimUrl, reserved.claimUrl);
  const state = await req(api + '/queue'); assert.ok(!state.body.sectors[1].next.some(t => t.displayNumber === reserved.displayNumber));
});
test('closing the QR dialog cancels only an unclaimed reservation', async () => {
  const x = (await req(api + '/tickets', { sectorId: 'caja', installId: 'dismiss-me', source: 'kiosk', delivery: 'qr_or_print' }, 'TEST')).body;
  const closed = await req(admin + '/tickets/' + x.id + '/cancel', {}, 'TEST');
  assert.equal(closed.status, 200); assert.equal(closed.body.cancelled, true); assert.equal(closed.body.status, 'CANCELLED');
  const again = await req(admin + '/tickets/' + x.id + '/cancel', {}, 'TEST'); assert.equal(again.status, 200); assert.equal(again.body.cancelled, true);
  const doc = await db.collection('queue_tickets').findOne({ _id: new (require('mongodb').ObjectId)(x.id) });
  assert.deepEqual(doc.history.map(h => h.action), ['created', 'kiosk_closed']);
  const state = await req(api + '/queue'); assert.ok(!state.body.sectors.find(s => s.id === 'caja').next.some(n => n.displayNumber === x.displayNumber));
});
test('only the first phone can claim the QR, preserving the assigned number', async () => {
  assert.equal((await req(api + '/tickets/' + reserved.id + '/claim', { installId: 'phone-a', code: 'é'.repeat(43) })).status, 403);
  assert.equal((await req('/api/customer-app/OTHER/tickets/' + reserved.id + '/claim', { installId: 'phone-a', code: claim })).status, 404);
  const claims = await Promise.all(['phone-a', 'phone-b'].map(installId => req(api + '/tickets/' + reserved.id + '/claim', { installId, code: claim })));
  assert.deepEqual(claims.map(x => x.status).sort(), [200, 409]);
  const winner = claims.find(x => x.status === 200).body; assert.equal(winner.displayNumber, reserved.displayNumber); assert.equal(winner.status, 'WAITING');
  const dbTicket = await db.collection('queue_tickets').findOne({ kioskRequestId: 'kiosk-reservation' }); reserved.owner = dbTicket.installId;
  assert.equal((await req(api + '/tickets/' + reserved.id + '/claim', { installId: reserved.owner, code: claim })).status, 200);
  const state = await req(admin + '/tickets/' + reserved.id + '/delivery', undefined, 'TEST'); assert.equal(state.body.claimed, true);
  assert.equal((await req(admin + '/tickets/' + reserved.id + '/print', {}, 'TEST')).status, 409);
});
test('browser-to-app handoff transfers notification ownership, is retryable, and rejects replay by a stranger', async () => {
  assert.equal((await req(api + '/tickets/' + reserved.id + '/handoff', { installId: 'stranger' })).status, 403);
  const handoff = await req(api + '/tickets/' + reserved.id + '/handoff', { installId: reserved.owner }); assert.equal(handoff.status, 200);
  const payload = { installId: 'native-phone', code: handoff.body.code };
  assert.equal((await req(api + '/tickets/' + reserved.id + '/claim', payload)).status, 200);
  assert.equal((await req(api + '/tickets/' + reserved.id + '/claim', payload)).status, 200);
  assert.equal((await req(api + '/tickets/' + reserved.id + '/claim', { ...payload, installId: 'stranger' })).status, 403);
  const doc = await db.collection('queue_tickets').findOne({ kioskRequestId: 'kiosk-reservation' }); assert.equal(doc.installId, 'native-phone');
  assert.equal((await req(api + '/tickets/' + reserved.id + '?installId=' + reserved.owner)).status, 200);
  assert.equal((await req(api + '/tickets', { sectorId: 'caja', installId: reserved.owner })).body.id, reserved.id);
});
test('printing activates the same reservation and retries never create a second ticket', async () => {
  const x = (await req(api + '/tickets', { sectorId: 'caja', installId: 'paper', source: 'kiosk', delivery: 'qr_or_print' }, 'TEST')).body;
  assert.equal((await req(admin + '/tickets/' + x.id + '/print', {})).status, 401);
  const printed = await req(admin + '/tickets/' + x.id + '/print', {}, 'TEST'); assert.equal(printed.body.displayNumber, x.displayNumber); assert.equal(printed.body.status, 'WAITING');
  const repeated = await req(admin + '/tickets/' + x.id + '/print', {}, 'TEST'); assert.equal(repeated.body.id, x.id);
  const doc = await db.collection('queue_tickets').findOne({ kioskRequestId: 'paper' }); assert.equal(doc.history.filter(h => h.action === 'print_requested').length, 1);
});
test('abandoned reservations expire and never enter the waiting queue', async () => {
  const x = (await req(api + '/tickets', { sectorId: 'caja', installId: 'abandoned', source: 'kiosk', delivery: 'qr_or_print' }, 'TEST')).body;
  await db.collection('queue_tickets').updateOne({ kioskRequestId: 'abandoned' }, { $set: { reservationExpiresAt: new Date(Date.now() - 1) } });
  const state = await req(admin + '/tickets/' + x.id + '/delivery', undefined, 'TEST'); assert.equal(state.body.status, 'CANCELLED');
  assert.equal((await req(admin + '/tickets/' + x.id + '/print', {}, 'TEST')).status, 410);
});

test('push milestones 2, 1 and called are durable, current position includes the called ticket, and transfer starts a fresh visit', async () => {
  cfg.queuePresence = 'open';
  const t = 'NOTIFY', a = '/api/customer-app/' + t, op = '/api/customer-app-admin/' + t;
  const make = (id, sectorId = 'ferreteria') => req(a + '/tickets', { sectorId, installId: id });
  const first = (await make('n1')).body, second = (await make('n2')).body, target = (await make('n3')).body;
  await db.collection('customer_app_devices').insertOne({ tenantId: t, installId: 'n3', pushToken: 'n3-token' });
  await Promise.all([queue.reconcileTenant(t), queue.reconcileTenant(t)]);
  const mine = () => notifications.filter(n => n.token === 'n3-token');
  assert.deepEqual(mine().map(n => n.title), ['Faltan 2 turnos para el tuyo']);
  const action = (verb, expectedTicketId, sector = 'ferreteria', destination) => req(op + '/sectors/' + sector + '/' + verb, { expectedTicketId, destination }, t);
  await action('next', null);
  assert.equal((await req(a + '/tickets/' + target.id + '?installId=n3')).body.peopleAhead, 2);
  assert.equal(mine().length, 1);
  await action('finish', first.id);
  assert.equal(mine().at(-1).title, 'Falta 1 turno para el tuyo');
  await action('next', null); await action('skip', second.id); await action('next', null);
  assert.deepEqual(mine().map(n => n.title), ['Faltan 2 turnos para el tuyo', 'Falta 1 turno para el tuyo', '¡Es tu turno!']);
  await queue.reconcileTenant(t); assert.equal(mine().length, 3);
  await make('cash-a', 'caja'); await make('cash-b', 'caja');
  await action('transfer', target.id, 'ferreteria', 'caja');
  assert.equal(mine().at(-1).title, 'Faltan 2 turnos para el tuyo'); assert.equal(mine().length, 4);
  const saved = await db.collection('queue_tickets').findOne({ installId: 'n3' });
  assert.equal(Object.values(saved.queueNotifications).filter(n => n.status === 'sent').length, 4);
  const automatic = await db.collection('customer_app_notifications').find({ tenantId: t, notificationType: 'automatic_queue' }).toArray();
  assert.equal(automatic.length, 4); assert.ok(automatic.every(n => n.successCount === 1 && n.ticketNumber));
  // A new reconciler (process restart) sees the same persisted milestones.
  const { createQueueNotifications } = require('../queue_notifications');
  await createQueueNotifications({ firebaseSender: async () => async () => { throw Error('duplicate'); }, publicBase: 'https://asistobot.com.ar' }).reconcile(db, { tenantId: t, branchId: 'CENTRAL', dayKey: '2026-09-14' });
  const stats = await req(op + '/stats', undefined, t); assert.equal(stats.body.summary.transfers, 1);
  assert.ok(!JSON.stringify(stats.body).includes('n3-token'));
});
test('late device registration sends only the current milestone; failed delivery retries without replaying success', async () => {
  const t='RETRY', a='/api/customer-app/'+t;
  await req(a+'/tickets', { installId:'r1', sectorId:'caja' });
  await req(a+'/tickets', { installId:'r2', sectorId:'caja' });
  await db.collection('customer_app_devices').insertOne({ tenantId:t, installId:'r2', pushToken:'retry-token' });
  rejectPush=true; await queue.reconcileTenant(t); rejectPush=false;
  const doc=await db.collection('queue_tickets').findOne({ tenantId:t, installId:'r2' });
  assert.equal(doc.queueNotifications.v0_ahead_1.status, 'failed');
  await db.collection('queue_tickets').updateOne({ _id:doc._id }, { $set:{ 'queueNotifications.v0_ahead_1.attemptedAt':new Date(0) } });
  await queue.reconcileTenant(t); await queue.reconcileTenant(t);
  assert.deepEqual(notifications.filter(n=>n.token==='retry-token').map(n=>n.title), ['Falta 1 turno para el tuyo']);
});
