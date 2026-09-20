// Asisto | Version: 5.00.171 | Fecha: 2026-09-19
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const express = require('express');
const { JSDOM } = require('jsdom');
const { argentinaDay, dashboardRange, dashboardScope, sessionRow, dashboardFeatures, loadDashboard, mountOperationsDashboard, dashboardHtml } = require('../operations_dashboard');
const now = new Date('2026-09-18T02:00:00Z');
const user = { uid: 'u1', role: 'admin', tenantId: 'NEA' };
const source = fs.readFileSync(require.resolve('../auth_ui'), 'utf8');
const messagePipeline = vm.runInNewContext('(' + source.slice(source.indexOf('function wwebRealMessagePipeline('), source.indexOf('const wwebDashboardStatsCache')).trim() + ')');

test('Argentina today boundaries do not depend on server timezone', () => {
  const range = argentinaDay(now);
  assert.equal(range.day, '2026-09-17');
  assert.equal(range.start.toISOString(), '2026-09-17T03:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-09-18T03:00:00.000Z');
});
test('only superadmin may change domain or select all', () => {
  assert.equal(dashboardScope(user, 'RVL'), 'NEA');
  assert.equal(dashboardScope(user, ''), 'NEA');
  assert.equal(dashboardScope({ ...user, role: 'superadmin' }, ''), '');
  assert.equal(dashboardScope({ ...user, role: 'superadmin' }, 'RVL'), 'RVL');
  assert.throws(() => dashboardScope(null, ''));
});
test('periods use Argentina boundaries and reject arbitrary ranges', () => {
  const yesterday = dashboardRange('yesterday', now);
  assert.equal(yesterday.fromDay, '2026-09-16');
  assert.equal(yesterday.toDay, '2026-09-16');
  assert.equal(yesterday.end.toISOString(), '2026-09-17T03:00:00.000Z');
  assert.equal(dashboardRange('7d', now).fromDay, '2026-09-11');
  assert.equal(dashboardRange('7d', now).toDay, '2026-09-17');
  assert.throws(() => dashboardRange('all', now), { status: 400 });
  assert.equal(dashboardRange('month', now).fromDay, '2026-09-01');
  assert.equal(dashboardRange('month', now).toDay, '2026-09-17');
  assert.equal(dashboardRange('30d', now).fromDay, '2026-08-19');
  assert.equal(dashboardRange('30d', now).toDay, '2026-09-17');
  assert.equal(dashboardRange('month', new Date('2026-03-01T02:00:00Z')).fromDay, '2026-02-01');
  assert.equal(dashboardRange('30d', new Date('2024-03-01T03:00:00Z')).fromDay, '2024-02-01');
});
test('connection state uses heartbeat and policies, exposes no credentials', () => {
  const lock = { tenantId: 'NEA', numero: '123', state: 'online', lastSeenAt: new Date(+now - 60000), runtimeVersion: '4.04.55', desiredTag: 'v4.04.56', token: 'secret' };
  const row = sessionRow(lock, {}, 'WhatsApp', now);
  assert.equal(row.state, 'inactive'); assert.equal(row.versionMismatch, true); assert.equal(row.token, undefined);
  assert.equal(sessionRow(lock, { disabled: true }, 'WhatsApp', now).state, 'disabled');
  assert.equal(sessionRow({ ...lock, runtimeVersion: '4.04.56' }, {}, 'WhatsApp', now).versionMismatch, false);
});
test('selected tenant capabilities classify only configured services', () => {
  assert.deepEqual(dashboardFeatures({ numero: '1', habilitar_bot: true, habilitar_consulta_mensajes: false }, {}, []), { classified: true, whatsapp: true, telegram: false, orders: false, followup: false, leads: false, tasks: false, tokens: false });
  const enabled = dashboardFeatures({ services: ['Tareas WhatsApp', 'Ayuda Manager'] }, {}, []);
  assert.equal(enabled.tasks, true); assert.equal(enabled.tokens, true); assert.equal(enabled.orders, false);
});
test('production-shaped data: tenant isolation, dedupe, day, permissions and own tasks', async () => {
  const mongo = await MongoMemoryServer.create();
  const client = await new MongoClient(mongo.getUri(), { serverApi: { version: '1', strict: true } }).connect();
  try {
    const db = client.db('dashboard_test');
    await db.collection('tenant_config').insertOne({ _id: 'NEA', services: ['Pedidos', 'Conversacional', 'Tareas WhatsApp', 'Lead'] });
    await db.collection('settings').insertOne({ _id: 'behavior:NEA', bot_mode: 'conversacional', lead_capture_enabled: true });
    await db.collection('wa_wweb_message_log').insertMany([
      { tenantId: 'NEA', numero: '1', contact: '2', body: 'Factura', direction: 'out', at: now },
      { tenantId: 'NEA', numero: '1', contact: '2', body: 'Factura', direction: 'out', at: new Date(+now + 1000), messageId: 'modern-id' },
      { tenantId: 'NEA', numero: '1', contact: '2', body: 'OK', direction: 'in', at: now },
      { tenantId: 'RVL', numero: '1', direction: 'out', at: now },
      { tenantId: 'NEA', numero: '1', direction: 'out', at: new Date('2026-09-17T02:59:59Z') },
    ]);
    await db.collection('wa_locks').insertMany([{ tenantId: 'NEA', numero: '1', state: 'online', lastSeenAt: now, secret: 'never' }, { tenantId: 'RVL', numero: '3', state: 'online', lastSeenAt: now }]);
    await db.collection('wa_wweb_policies').insertOne({ tenantId: 'NEA', numero: '1', paused: true });
    await db.collection('leads').insertMany([{ createdAt: now }, { tenantId: 'NEA', createdAt: now }, { tenantId: 'RVL', createdAt: now }]);
    await db.collection('ai_token_usage_log').insertMany([{ tenantId: 'NEA', createdAt: now, totalTokens: 42 }, { tenantId: 'RVL', createdAt: now, totalTokens: 999 }]);
    await db.collection('orders').insertMany([{ tenantId: 'NEA', status: 'COMPLETED', createdAt: now }, { tenantId: 'NEA', status: 'DRAFT', createdAt: now }]);
    await db.collection('support_drafts').insertMany([{ tenantId: 'NEA', userId: 'u1', state: 'pending' }, { tenantId: 'NEA', userId: 'u2', state: 'pending' }, { tenantId: 'NEA', userId: 'u1', state: 'ignored' }]);
    await db.collection('conversation_followups').insertMany([{ tenantId: 'NEA', pendingContact: true }, { tenantId: 'NEA', pendingContact: true, workflowStatus: 'resolved' }]);
    const data = await loadDashboard(db, { user, tenant: 'NEA', now, messagePipeline, access: ['wweb', 'leads', 'token_control', 'admin', 'support', 'followup'] });
    assert.deepEqual(data.unavailable, []);
    const values = Object.fromEntries(data.metrics.map(m => [m.key, m.value]));
    assert.equal(values.sent, 1); assert.equal(values.leads, 1); assert.equal(values.tokens, 42); assert.equal(values.orders, 1); assert.equal(values.tasks, 1); assert.equal(values.contacts, 1);
    assert.equal(data.activity.length, 24);
    assert.deepEqual(data.activity[23], { label: '23', sent: 1, received: 1 });
    assert.equal(data.activity.reduce((n, r) => n + r.sent, 0), values.sent);
    const weekly = await loadDashboard(db, { user, tenant: 'NEA', now, messagePipeline, access: ['wweb'], period: '7d' });
    assert.deepEqual(weekly.unavailable, []);
    assert.equal(weekly.activity.length, 7);
    assert.deepEqual(weekly.activity[5], { label: '16/09', sent: 1, received: 0 });
    assert.deepEqual(weekly.activity[6], { label: '17/09', sent: 1, received: 1 });
    assert.equal(weekly.metrics.find(m => m.key === 'sent').value, 2);
    for (const [period, size] of [['month', 17], ['30d', 30]]) {
      const longer = await loadDashboard(db, { user, tenant: 'NEA', now, messagePipeline, access: ['wweb'], period });
      assert.deepEqual(longer.unavailable, []);
      assert.equal(longer.activity.length, size);
      assert.equal(longer.activity.reduce((n, r) => n + r.sent, 0), 2);
    }
    assert.equal(data.sessions.length, 1); assert.equal(data.sessions[0].state, 'paused');
    assert.equal(JSON.stringify(data).includes('never'), false);
    const global = await loadDashboard(db, { user: { ...user, role: 'superadmin' }, tenant: '', access: ['leads'], now });
    assert.equal(global.metrics[0].value, 3);
    const empty = await loadDashboard(db, { user, tenant: 'NEA', access: [], now });
    assert.equal(empty.metrics.length, 0); assert.equal(empty.sessions.length, 0);
    assert.equal(empty.activity, null);
  } finally { await client.close(); await mongo.stop(); }
});
test('failed query is unavailable, not zero; sibling queries still work', async () => {
  const db = { collection: name => ({ findOne: async query => name === 'tenant_config' ? null : {}, find: () => ({ limit: () => ({ toArray: async () => [] }) }), countDocuments: async () => { if (name === 'orders') throw new Error('timeout'); return 2; } }) };
  const data = await loadDashboard(db, { user, tenant: 'NEA', access: ['admin', 'leads'], now });
  assert.deepEqual(data.unavailable, ['orders']);
  assert.equal(data.metrics.length, 1); assert.equal(data.metrics[0].value, 2);
});
test('API rejects anonymous access, confines ordinary users and coalesces refreshes', async () => {
  const app = express(); let calls = 0;
  app.use((req, res, next) => { req.user = req.headers['x-test-anonymous'] ? null : user; next(); });
  mountOperationsDashboard(app, {
    requireAuth: (req, res, next) => req.user ? next() : res.sendStatus(401), getAccess: () => ['leads'],
    getDb: async () => ({ collection: name => ({
      findOne: async () => name === 'tenant_config' ? null : {},
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
      countDocuments: async query => { calls++; assert.equal(query.tenantId, 'NEA'); return 3; },
    }) }), messagePipeline,
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const results = await Promise.all(Array.from({ length: 5 }, () => fetch(base + '/api/operations-dashboard?tenant=RVL').then(r => r.json())));
    assert.equal(calls, 1); assert.ok(results.every(r => r.tenant === 'NEA'));
    assert.equal((await fetch(base + '/api/operations-dashboard?period=all')).status, 400);
    await fetch(base + '/api/operations-dashboard?period=yesterday');
    assert.equal(calls, 2, 'period must be included in the cache key');
    assert.equal((await fetch(base + '/api/operations-dashboard/tenants')).status, 403);
    assert.equal((await fetch(base + '/api/operations-dashboard', { headers: { 'x-test-anonymous': '1' } })).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('dashboard DOM renders real values safely and handles total failure', async () => {
  const dom = new JSDOM(dashboardHtml(user), { url: 'https://asistobot.com.ar/app', runScripts: 'outside-only' });
  try {
    let fail = false;
    assert.equal(dom.window.document.querySelector('#opsPeriod option[value="month"]').textContent, 'Mes corriente');
    assert.equal(dom.window.document.querySelector('#opsPeriod option[value="30d"]').textContent, 'Últimos 30 días');
    dom.window.fetch = async () => { if (fail) throw new Error('offline'); return { ok: true, json: async () => ({ metrics: [{ key: 'sent', label: '<img src=x>', value: 7, detail: 'Registrados', href: '/admin/wweb' }], sessions: [], unavailable: [], generatedAt: now.toISOString() }) }; };
    dom.window.eval(fs.readFileSync(require.resolve('../static/operations_dashboard.js'), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(dom.window.document.querySelector('.opsMetric strong').textContent, '7');
    assert.equal(dom.window.document.querySelector('.opsMetric img'), null);
    fail = true; dom.window.document.getElementById('opsRefresh').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(dom.window.document.getElementById('opsStatus').textContent, /No se pudo actualizar/);
    assert.equal(dom.window.document.querySelectorAll('.opsMetric').length, 0);
  } finally { dom.window.close(); }
});
