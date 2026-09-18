// Asisto | Version: 5.00.159 | Fecha: 2026-09-18
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { validProductImageUrl, mountProductImageRoutes } = require('../restaurant_image');

test('las imágenes cargadas se guardan y sirven desde el dominio correcto', async () => {
  assert.equal(validProductImageUrl('javascript:alert(1)'), false);
  assert.equal(validProductImageUrl('/static/restaurant_demo/pasta.webp'), true);
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri('resto_image_test');
  const { getDb, closeDb } = require('../db');
  const app = express();
  mountProductImageRoutes(app, { getDb, resolveTenantId: req => req.query.tenant || 'RES', express });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const uploaded = await fetch(`${base}/api/products/images?tenant=RES`, { method:'POST', headers:{ 'content-type':'image/png' }, body:bytes });
    assert.equal(uploaded.status, 201);
    const { url } = await uploaded.json();
    assert.equal(validProductImageUrl(url), true);
    const image = await fetch(base + url);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    const db = await getDb();
    assert.equal(await db.collection('product_images').countDocuments({ tenantId:'RES' }), 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await closeDb();
    await mongo.stop();
  }
});
