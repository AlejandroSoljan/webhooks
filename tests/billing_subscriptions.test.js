'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { billingGroups, validateProfile, mountBillingRoutes } = require('../billing_subscriptions');
const mp = require('../mercadopago_subscriptions');
let mongo, client, db, server, base;
const config = { mode: 'test', token: 'not-a-real-token', secret: 'test-secret', payerId: '222', baseUrl: 'https://asistobot.com.ar' };
let calls, payment;
const remote = { id: 'preapproval1', collector_id: 111, status: 'pending', last_modified: '2026-10-01T10:00:00Z', init_point: 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=preapproval1' };
async function provider(url, options) {
  calls.push({ url, options });
  const path = new URL(url).pathname;
  let body;
  if (path === '/users/me') body = { id: 111, tags: ['test_user'] };
  else if (path === '/users/222') body = { id: 222, tags: ['test_user'], email: 'test@example.com' };
  else if (path === '/preapproval' && options.method === 'POST') { remote.external_reference = JSON.parse(options.body).external_reference; body = remote; }
  else if (path === '/preapproval/preapproval1') { if (options.method === 'PUT') { remote.status = 'cancelled'; remote.last_modified = '2026-10-01T11:00:00Z'; } body = remote; }
  else if (path === '/preapproval/search') body = { results: [remote] };
  else if (path === '/v1/payments/123') body = payment;
  else throw new Error('unexpected path ' + path);
  return { ok: true, json: async () => body };
}
before(async () => {
  mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); db = client.db('billing_test');
  const app = express();
  app.use((req, _res, next) => { if (req.get('test-role')) req.user = { role: req.get('test-role'), username: 'test-admin' }; next(); });
  mountBillingRoutes(app, { requireAuth: (req, res, next) => req.user ? next() : res.sendStatus(401) }, { database: async () => db, config: () => config, fetcher: provider });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(async () => { await db.dropDatabase(); calls = []; remote.status = 'pending'; remote.last_modified = '2026-10-01T10:00:00Z';
  await db.collection('tenant_config').insertMany([{ _id: 'NEA', consumption_domains: ['NEA2'] }, { _id: 'NEA2' }, { _id: 'MSM', consumption_domains: ['ALSO', 'DEMJG'] }, { _id: 'ALSO' }, { _id: 'DEMJG' }]);
});
after(async () => { await new Promise(resolve => server.close(resolve)); await client.close(); await mongo.stop(); });

test('agrupa secundarios sin duplicarlos y bloquea ciclos o titularidad ambigua', () => {
  const groups = billingGroups([{ _id: 'MSM', consumption_domains: ['ALSO', 'DEMJG', 'MSM', 'ALSO'] }, { _id: 'ALSO' }, { _id: 'DEMJG' }]);
  assert.deepEqual(groups[0].domains, ['ALSO', 'DEMJG', 'MSM']); assert.equal(groups.length, 1);
  assert.throws(() => billingGroups([{ _id: 'A', consumption_domains: ['B'] }, { _id: 'B', consumption_domains: ['A'] }]), /cycle/);
  assert.throws(() => billingGroups([{ _id: 'A', consumption_domains: ['C'] }, { _id: 'B', consumption_domains: ['C'] }]), /multiple/);
});
test('perfil no permite activar cobros ni modificar la moneda; valida email y día', () => {
  assert.equal(validateProfile({ billingEmail: 'a@b.com', collectionDay: 5, liveDebitsEnabled: true, currency: 'USD' }).liveDebitsEnabled, false);
  for (const day of [0, 29, 1.5, 'oops']) assert.throws(() => validateProfile({ collectionDay: day }), /invalid_collection/);
  assert.throws(() => validateProfile({ billingEmail: 'no', collectionDay: 1 }), /email/);
  assert.equal(mp.settings({ MP_SUBSCRIPTIONS_MODE: 'production' }).mode, 'disabled');
  assert.equal(mp.publicSettings().liveDebitsEnabled, false);
});
test('rutas privadas exigen superadmin y las escrituras rechazan CSRF', async () => {
  assert.equal((await fetch(base + '/api/billing/accounts')).status, 401);
  assert.equal((await fetch(base + '/api/billing/accounts', { headers: { 'test-role': 'admin' } })).status, 403);
  const headers = { 'test-role': 'superadmin', 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/billing/accounts/NEA', { method: 'PUT', headers, body: '{}' })).status, 403);
  headers['X-Asisto-Billing'] = '1';
  assert.equal((await fetch(base + '/api/billing/accounts/NEA2', { method: 'PUT', headers, body: '{"collectionDay":5}' })).status, 409);
  const response = await fetch(base + '/api/billing/accounts/NEA', { method: 'PUT', headers, body: '{"collectionDay":5,"billingEmail":"billing@example.com"}' });
  assert.equal(response.status, 200); assert.equal(calls.length, 0);
  const list = await (await fetch(base + '/api/billing/accounts', { headers })).json();
  assert.equal(list.accounts.length, 2); assert.equal(list.accounts.find(a => a.owner === 'NEA').profile.billingEmail, 'billing@example.com');
  assert.equal(JSON.stringify(list).includes(config.token), false);
});
test('alta de prueba idempotente, sin datos de tarjeta ni email del cliente real', async () => {
  const results = await Promise.allSettled([mp.createTestSubscription(db, 'NEA', 'admin', config, provider), mp.createTestSubscription(db, 'NEA', 'admin', config, provider)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const posts = calls.filter(c => c.options.method === 'POST'); assert.equal(posts.length, 1);
  const payload = JSON.parse(posts[0].options.body); assert.equal(payload.status, 'pending'); assert.equal(payload.payer_email, 'test@example.com');
  assert.deepEqual(payload.auto_recurring, { frequency: 1, frequency_type: 'months', transaction_amount: 10, currency_id: 'ARS' });
  assert.equal(payload.card_token_id, undefined);
});
test('timeout de alta queda incierto y no se repite la escritura externa', async () => {
  const failing = async (url, options) => { const result = await provider(url, options); if (options.method === 'POST') throw Error('timeout'); return result; };
  await assert.rejects(mp.createTestSubscription(db, 'NEA', 'admin', config, failing), /unknown/);
  const row = await db.collection('billing_subscriptions').findOne({ _id: 'test:NEA' }); assert.equal(row.status, 'unknown');
  await assert.rejects(mp.createTestSubscription(db, 'NEA', 'admin', config, provider), /exists/);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  assert.equal((await mp.reconcileSubscription(db, row, config, provider)).status, 'pending');
});
test('una cuenta real o modo deshabilitado no puede crear suscripciones', async () => {
  const realSeller = async (url, options) => url.endsWith('/users/me') ? { ok: true, json: async () => ({ id: 111, tags: [] }) } : provider(url, options);
  await assert.rejects(mp.createTestSubscription(db, 'NEA', 'admin', config, realSeller), /test_accounts/);
  await assert.rejects(mp.createTestSubscription(db, 'NEA', 'admin', { ...config, mode: 'disabled' }, provider), /not_ready/);
  assert.equal(await db.collection('billing_subscriptions').countDocuments(), 0);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 0);
});
test('firma valida ID de query, no acepta firmas falsas ni URLs arbitrarias', () => {
  const ts = '1704908010', requestId = 'req-123', dataId = 'ABC';
  const sig = crypto.createHmac('sha256', config.secret).update('id:abc;request-id:req-123;ts:' + ts + ';').digest('hex');
  assert.equal(mp.validSignature({ dataId, requestId, signature: 'ts=' + ts + ',v1=' + sig, secret: config.secret }), true);
  assert.equal(mp.validSignature({ dataId: 'other', requestId, signature: 'ts=' + ts + ',v1=' + sig, secret: config.secret }), false);
  assert.equal(mp.checkoutUrl('https://www.mercadopago.com.ar.evil.test/subscriptions/checkout'), null);
  assert.equal(mp.checkoutUrl('javascript:alert(1)'), null);
});
test('conciliación de pagos verifica modo, importe y evita regresión por webhook atrasado', async () => {
  const row = await mp.createTestSubscription(db, 'NEA', 'admin', config, provider);
  payment = { id: 123, collector_id: 111, external_reference: row.reference, live_mode: false, currency_id: 'ARS', transaction_amount: 10, status: 'approved', date_last_updated: '2026-10-01T12:00:00Z' };
  await mp.reconcilePayment(db, '123', config, provider); await mp.reconcilePayment(db, '123', config, provider);
  assert.equal(await db.collection('billing_payments').countDocuments(), 1);
  payment.status = 'pending'; payment.date_last_updated = '2026-10-01T11:00:00Z'; await mp.reconcilePayment(db, '123', config, provider);
  assert.equal((await db.collection('billing_payments').findOne({ _id: 'test:123' })).status, 'approved');
  payment.date_last_updated = '2026-10-01T13:00:00Z'; payment.transaction_amount = 20; await mp.reconcilePayment(db, '123', config, provider);
  assert.equal((await db.collection('billing_payments').findOne({ _id: 'test:123' })).status, 'review');
  payment.live_mode = true; await assert.rejects(mp.reconcilePayment(db, '123', config, provider), /mismatch/);
  assert.equal(await db.collection('billing_invoices').countDocuments(), 0);
});
test('autorización no registra pago y prueba se puede cancelar', async () => {
  const row = await mp.createTestSubscription(db, 'NEA', 'admin', config, provider); remote.status = 'authorized';
  assert.equal((await mp.reconcileSubscription(db, row, config, provider)).status, 'authorized');
  assert.equal(await db.collection('billing_payments').countDocuments(), 0);
  assert.equal((await mp.cancelTestSubscription(db, row, config, provider)).status, 'cancelled');
});
test('webhook no autenticado o con ID diferente es rechazado', async () => {
  assert.equal((await fetch(base + '/webhooks/mercadopago/subscriptions?data.id=123', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"payment","data":{"id":"123"}}' })).status, 401);
});
test('webhook firmado consulta pago real de prueba; ID alterado no se procesa', async () => {
  const row = await mp.createTestSubscription(db, 'NEA', 'admin', config, provider);
  payment = { id: 123, collector_id: 111, external_reference: row.reference, live_mode: false, currency_id: 'ARS', transaction_amount: 10, status: 'approved', date_last_updated: '2026-10-01T12:00:00Z' };
  const signature = crypto.createHmac('sha256', config.secret).update('id:123;request-id:req-123;ts:1704908010;').digest('hex');
  const headers = { 'Content-Type': 'application/json', 'x-request-id': 'req-123', 'x-signature': 'ts=1704908010,v1=' + signature };
  const send = dataId => fetch(base + '/webhooks/mercadopago/subscriptions?data.id=123', { method: 'POST', headers, body: JSON.stringify({ type: 'payment', data: { id: dataId } }) });
  assert.equal((await send('456')).status, 401);
  assert.equal((await send('123')).status, 200);
  assert.equal((await send('123')).status, 200);
  assert.equal(await db.collection('billing_payments').countDocuments(), 1);
});
test('panel muestra grupos, bloqueos y escapa HTML de datos', async () => {
  const { JSDOM } = require('jsdom'), { renderBillingPage } = require('../billing_subscriptions_ui');
  const dom = new JSDOM(renderBillingPage(), { url: base + '/admin/billing', runScripts: 'outside-only' });
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ integration: mp.publicSettings(mp.settings({})), accounts: [{ owner: 'NEA', company: '<img src=x onerror=alert(1)>', domains: ['NEA', 'NEA2'] }], payments: [] }) });
  dom.window.eval(dom.window.document.querySelector('script').textContent);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dom.window.document.querySelectorAll('#accounts article').length, 1);
  assert.equal(dom.window.document.querySelector('#accounts img'), null);
  assert.equal(dom.window.document.querySelector('[data-action="test-subscription"]').disabled, true);
  assert.match(dom.window.document.querySelector('#accounts').textContent, /NEA \+ NEA2/); dom.window.close();
});
