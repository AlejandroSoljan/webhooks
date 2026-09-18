// Asisto | Version: 5.00.157 | Fecha: 2026-09-18
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('mesa QR carga la carta y registra un pedido con precio del servidor', async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri('resto_test');
  const { getDb, closeDb } = require('../db');
  const { mountRestaurant } = require('../restaurant');
  const db = await getDb();
  const token = 'a'.repeat(32);
  await db.collection('tenant_config').insertOne({ _id: 'RES', restaurant_enabled: true, nom_emp: 'Prueba' });
  await db.collection('tenant_config').insertOne({ _id: 'OTRO', restaurant_enabled: false, nom_emp: 'Otro' });
  await db.collection('restaurant_tables').insertOne({ tenantId: 'RES', label: '1', token, active: true });
  const inserted = await db.collection('products').insertOne({ tenantId: 'RES', descripcion: 'Pasta', tag: 'Principal', importe: 1200, observacion: 'Trigo y tomate', active: true });
  const app = express();
  let role = 'superadmin';
  app.use((req, _res, next) => { req.user = { uid: 'operador', role, tenantId: 'RES' }; next(); });
  mountRestaurant(app, { resolveTenantId: req => req.user.role === 'superadmin' ? (req.query?.tenant || 'RES') : req.user.tenantId });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/resto/RES/${token}`);
    assert.equal(page.status, 200);
    const listing = await fetch(`${base}/api/public/resto/RES/${token}/menu`).then(r => r.json());
    assert.equal(listing.items.length, 1);
    assert.equal(listing.items[0].observacion, 'Trigo y tomate');
    const domains = await fetch(`${base}/api/resto/domains`).then(r => r.json());
    assert.deepEqual(domains.domains.map(x => x.id), ['OTRO', 'RES']);
    assert.equal((await fetch(`${base}/api/resto/summary?tenant=RES`).then(r => r.json())).menuCount, 1);
    assert.equal((await fetch(`${base}/api/resto/summary?tenant=OTRO`).then(r => r.json())).enabled, false);
    role = 'user';
    assert.deepEqual((await fetch(`${base}/api/resto/domains`).then(r => r.json())).domains.map(x => x.id), ['RES']);
    assert.equal((await fetch(`${base}/api/resto/summary?tenant=OTRO`).then(r => r.json())).tenant, 'RES');
    role = 'superadmin';
    const response = await fetch(`${base}/api/public/resto/RES/${token}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'order', items: [{ id: String(inserted.insertedId), quantity: 2, unitPrice: 1 }] }) });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).total, 2400);
    const events = await fetch(`${base}/api/resto/events`).then(r => r.json());
    assert.equal(events.events[0].tableLabel, '1');
    assert.equal(events.events[0].items[0].unitPrice, 1200);
    const done = await fetch(`${base}/api/resto/events/${events.events[0]._id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }) });
    assert.equal(done.status, 200);
    assert.equal((await fetch(`${base}/api/resto/events`).then(r => r.json())).events.length, 0);
    const table = await fetch(`${base}/api/resto/tables?tenant=RES`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ label:'2' }) });
    assert.equal(table.status, 201);
    assert.equal((await fetch(`${base}/api/resto/tables?tenant=RES`).then(r => r.json())).tables.length, 2);
    assert.equal((await fetch(`${base}/api/resto/tables?tenant=OTRO`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ label:'1' }) })).status, 409);
    const device = await fetch(`${base}/api/resto/devices?tenant=RES`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ deviceId:'telefono-1', pushToken:'token-de-prueba-con-suficiente-longitud', platform:'android' }) });
    assert.equal(device.status, 200);
    assert.equal(await db.collection('restaurant_operator_devices').countDocuments({ tenantId:'RES', ownerId:'operador' }), 1);
    const pdf = await fetch(`${base}/api/resto/qr-pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await fetch(`${base}/api/public/resto/RES/${'b'.repeat(32)}/menu`)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await closeDb();
    await mongo.stop();
  }
});
