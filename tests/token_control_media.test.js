const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const { mountTokenMediaRoutes, decodeMedia } = require('../token_control_media');
let mongo, client, db, server, url;
before(async () => {
  mongo = await MongoMemoryServer.create(); client = await MongoClient.connect(mongo.getUri()); db = client.db('media_test');
  const app = express(); app.use((req, res, next) => { req.user = { role: req.get('test-role') || 'admin' }; next(); });
  mountTokenMediaRoutes(app, { requireAuth: (_req, _res, next) => next() }, async () => db);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); url = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(async () => { await db.collection('wa_wweb_actions').deleteMany({}); await db.collection('wa_wweb_message_log').deleteMany({}); await db.collection('wa_locks').deleteMany({}); });
after(async () => { await new Promise(r => server.close(r)); await client.close(); await mongo.stop(); });
test('rechaza formatos activos o MIME falso', () => {
  assert.equal(decodeMedia({ status: 'ready', mime: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }), null);
  assert.equal(decodeMedia({ status: 'ready', mime: 'image/png', data: Buffer.from('<script>').toString('base64') }), null);
  assert.equal(decodeMedia({ status: 'ready', mime: 'audio/ogg', data: Buffer.from('OggS1234').toString('base64') }).kind, 'audio');
});
test('solicitud única, sólo superadmin, contenido privado con Range y revocación al borrar log', async () => {
  const _id = new ObjectId(); await db.collection('wa_wweb_message_log').insertOne({ _id, tenantId: 'NEA', numero: '123', contact: '456', messageId: 'msg', direction: 'out', messageType: 'ptt' });
  const path = '/api/token-control/messages/' + _id + '/media', headers = { 'test-role': 'superadmin', 'X-Asisto-Media': '1' };
  assert.equal((await fetch(url + path, { method: 'POST' })).status, 403);
  assert.equal((await fetch(url + path, { method: 'POST', headers: { 'test-role': 'superadmin' } })).status, 403);
  await Promise.all([fetch(url + path, { method: 'POST', headers }), fetch(url + path, { method: 'POST', headers })]);
  assert.equal(await db.collection('wa_wweb_actions').countDocuments(), 1);
  assert.equal((await db.collection('wa_wweb_actions').findOne({ _id })).lockId, 'NEA:123');
  await db.collection('wa_wweb_actions').updateOne({ _id }, { $set: { result: JSON.stringify({ status: 'ready', mime: 'audio/ogg', data: Buffer.from('OggS12345678').toString('base64') }) } });
  const status = await (await fetch(url + '/api/token-control/media/' + _id, { headers })).json(); assert.equal(status.status, 'ready'); assert.equal(status.data, undefined);
  assert.equal((await fetch(url + status.url)).status, 403);
  const content = await fetch(url + status.url, { headers: { ...headers, Range: 'bytes=4-7' } });
  assert.equal(content.status, 206); assert.equal(await content.text(), '1234'); assert.equal(content.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url + status.url, { headers: { ...headers, Range: 'bytes=999-' } })).status, 416);
  await db.collection('wa_wweb_message_log').deleteOne({ _id }); assert.equal((await fetch(url + status.url, { headers })).status, 404);
});
test('archivo vencido no se sirve aunque TTL aún no lo haya borrado', async () => {
  const _id = new ObjectId(); await db.collection('wa_wweb_message_log').insertOne({ _id });
  await db.collection('wa_wweb_actions').insertOne({ _id, action: 'read_message_media', mediaExpiresAt: new Date(0) });
  assert.equal((await fetch(url + '/api/token-control/media/' + _id + '/content', { headers: { 'test-role': 'superadmin' } })).status, 404);
});
test('agente anterior avisa actualización sin encolar una acción incompatible', async () => {
  const _id = new ObjectId(); await db.collection('wa_wweb_message_log').insertOne({ _id, tenantId: 'NEA', numero: '123', messageId: 'msg', messageType: 'image' });
  await db.collection('wa_locks').insertOne({ _id: 'NEA:123', runtimeVersion: '4.05.07' });
  const response = await fetch(url + '/api/token-control/messages/' + _id + '/media', { method: 'POST', headers: { 'test-role': 'superadmin', 'X-Asisto-Media': '1' } });
  assert.equal((await response.json()).status, 'requires_update'); assert.equal(await db.collection('wa_wweb_actions').countDocuments(), 0);
});
test('detalle muestra reproductor o imagen ampliable tras recuperar el archivo', async () => {
  const { JSDOM } = require('jsdom');
  const { renderTokenControlPage } = require('../token_control_stats');
  for (const kind of ['audio', 'image']) {
    const dom = new JSDOM(renderTokenControlPage({ role: 'superadmin', tenantId: 'NEA' }, ['NEA']), { url: 'https://asistobot.com.ar/admin/token-control', runScripts: 'outside-only' });
    dom.window.fetch = async path => ({ ok: true, json: async () => String(path).includes('/messages/') ? { status: 'pending' } : String(path).includes('/media/') ? { status: 'ready', kind, url: '/api/token-control/media/123/content' } : { ok: true, items: [], totals: {}, byTenant: [], byDomain: [] } });
    dom.window.eval(dom.window.document.querySelector('script').textContent);
    await new Promise(r => setTimeout(r, 30));
    const rows = dom.window.document.getElementById('realMessageRows');
    rows.innerHTML = '<tr><td><div><button data-media-log="123">Ver</button><span role="status"></span></div></td></tr>';
    rows.querySelector('button').click(); await new Promise(r => setTimeout(r, 30));
    if (kind === 'image') { assert.ok(rows.querySelector('img')); assert.equal(rows.querySelector('a').target, '_blank'); }
    else assert.equal(rows.querySelector('audio').controls, true);
    dom.window.close();
  }
});
