const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mountHelpPlaylists } = require('../help_playlists');

test('HTTP playlists: persistencia, orden, validaciones y aislamiento', async t => {
  const rows = new Map();
  let enabled = true, fail = false, reads = 0;
  const app = express();
  const dependencies = {
    json: express.json({ limit: '128kb' }),
    requireAccess(req, res, next) {
      if (req.headers['x-api-key'] !== 'synthetic-key') return res.sendStatus(401);
      next();
    },
    async resolveOwner(agent) {
      return { domain: agent === 'OTHER' ? 'OTHER_TENANT' : 'MSM_TEST', enabled };
    },
    async getDb() {
      reads++;
      if (fail) throw new Error('private database error');
      return { collection(name) {
        assert.equal(name, 'help_playlists');
        return {
          async createIndex() {},
          find(query) {
            let result = [...rows.values()].filter(row => row.tenantId === query.tenantId && row.agente === query.agente);
            return {
              sort() { result.sort((a, b) => b.creada_en.localeCompare(a.creada_en) || b._id.localeCompare(a._id)); return this; },
              skip(n) { result = result.slice(n); return this; },
              limit(n) { result = result.slice(0, n); return this; },
              async toArray() { return result; }
            };
          },
          async insertOne(doc) { rows.set(doc._id, structuredClone(doc)); },
          async findOne(query) {
            const row = rows.get(query._id);
            return row && row.tenantId === query.tenantId && row.agente === query.agente ? row : null;
          }
        };
      } };
    }
  };
  mountHelpPlaylists(app, dependencies);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, body, key = 'synthetic-key') {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    return { status: response.status, text, body: text.startsWith('{') ? JSON.parse(text) : null };
  }
  const path = '/api/ext/ayuda/playlists';
  const data = { nombre: 'Introducción', descripcion: 'Ejemplo sintético', vimeo_ids: ['300', '100', '300'] };
  assert.equal((await call(path, data, '')).status, 401);
  assert.equal(reads, 0);
  const created = await call(path, data);
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created.body.vimeo_ids, data.vimeo_ids);
  assert.equal(rows.size, 1);
  const url = `${path}/${created.body.id}`;
  assert.deepEqual((await call(url)).body, created.body);
  assert.deepEqual((await call(`/api/ext/help/playlists/${created.body.id}`)).body, created.body);
  assert.equal((await call(url, undefined, 'wrong')).status, 401);
  assert.equal((await call(`${url}?agente=OTHER`)).status, 404);
  assert.equal((await call(`${url}?agente=SAME_TENANT_OTHER_AGENT`)).status, 404);
  assert.equal((await call(`${path}/00000000-0000-4000-8000-000000000000`)).status, 404);
  assert.equal((await call(`${path}/invalid`)).status, 400);
  for (const patch of [
    { nombre: '' }, { nombre: {} }, { nombre: 'a'.repeat(201) },
    { descripcion: null }, { descripcion: ' ' }, { descripcion: 'a'.repeat(4001) },
    { vimeo_ids: [] }, { vimeo_ids: ['0'] }, { vimeo_ids: [123] },
    { vimeo_ids: [{ $ne: null }] }, { vimeo_ids: ['12/34'] },
    { vimeo_ids: Array(501).fill('1') }, { agente: {} }
  ]) assert.equal((await call(path, { ...data, ...patch })).status, 400, JSON.stringify(patch).slice(0, 100));
  enabled = false;
  assert.equal((await call(path, data)).status, 403);
  assert.equal((await call(url)).status, 403);
  enabled = true;
  fail = true;
  const failed = await call(path, data);
  assert.equal(failed.status, 500);
  assert.equal(failed.text.includes('private'), false);
  fail = false;
  const second = await call('/api/ext/help/playlists', data);
  assert.equal(second.status, 201);
  assert.notEqual(second.body.id, created.body.id);
  const list = await call(`${path}?limit=1`);
  assert.equal(list.status, 200);
  assert.equal(list.body.playlists.length, 1);
  assert.equal(list.body.has_more, true);
  const next = await call(`${path}?limit=1&offset=1`);
  assert.equal(next.body.has_more, false);
  assert.notEqual(next.body.playlists[0].id, list.body.playlists[0].id);
  assert.deepEqual((await call(`${path}?agente=OTHER`)).body.playlists, []);
  assert.deepEqual((await call(`${path}?agente=SAME_TENANT_OTHER_AGENT`)).body.playlists, []);
  assert.equal((await call('/api/ext/help/playlists')).body.playlists.length, 2);
  assert.deepEqual((await call(`${path}?offset=2`)).body.playlists, []);
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=10001', 'limit[x]=1']) {
    assert.equal((await call(`${path}?${query}`)).status, 400);
  }
  assert.equal((await call(path, undefined, '')).status, 401);
  enabled = false;
  assert.equal((await call(path)).status, 403);
});

test('montaje real de Ayuda exige su credencial antes de acceder a datos', async t => {
  process.env.HELP_API_KEY = 'synthetic-integration-key';
  const { mountHelpTool } = require('../help_tool');
  const app = express();
  mountHelpTool(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const prefix of ['ayuda', 'help']) {
    for (const method of ['GET', 'POST']) {
      const url = `${base}/api/ext/${prefix}/playlists${method === 'GET' ? '/00000000-0000-4000-8000-000000000000' : ''}`;
      assert.equal((await fetch(url, { method })).status, 401);
      // Invalid input with a valid key reaches validation, without database access.
      const response = await fetch(method === 'GET' ? url.replace(/00000000.*$/, 'invalid') : url, {
        method, headers: { 'X-API-Key': 'synthetic-integration-key' }
      });
      assert.equal(response.status, 400);
    }
  }
});
