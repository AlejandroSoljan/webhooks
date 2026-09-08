// Asisto | Version: 5.00.047 | Fecha: 2026-09-08
const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { isManagerCatalog, rowsFromPayload, managerPageRequest, syncManagerCatalog } = require('../product_catalog_sync');

const cfg = {
  enabled: true,
  apiMethod: 'GET',
  apiUrl: 'https://manager.example/v300/api/Api_Articulos/Consulta?key=secreto&campo=ID&valor={{codigo}}',
  apiAuthHeader: '', apiAuthValue: '',
};

test('reconoce solamente una consulta GET de articulos Manager habilitada', () => {
  assert.equal(isManagerCatalog(cfg), true);
  assert.equal(isManagerCatalog({ ...cfg, apiMethod: 'POST' }), false);
  assert.equal(isManagerCatalog({ ...cfg, apiUrl: 'https://example.invalid/products' }), false);
});

test('arma la pagina completa sin perder key ni enviar un codigo particular', () => {
  const request = managerPageRequest(cfg, 3, 500);
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('key'), 'secreto');
  assert.equal(url.searchParams.get('campo'), 'ID');
  assert.equal(url.searchParams.get('valor'), '*');
  assert.equal(url.searchParams.get('pag_num'), '3');
  assert.equal(url.searchParams.get('pag_cant_reg'), '500');
  assert.equal(url.searchParams.get('inactivos'), 'S');
  assert.equal(url.searchParams.get('solo_stock'), 'N');
  assert.equal(url.searchParams.get('error_sin_registros'), 'false');
});

test('acepta las envolturas JSON usuales y rechaza objetos sueltos', () => {
  assert.deepEqual(rowsFromPayload([{ Codigo: '1' }]), [{ Codigo: '1' }]);
  assert.deepEqual(rowsFromPayload({ articulos: [{ Codigo: '2' }] }), [{ Codigo: '2' }]);
  assert.deepEqual(rowsFromPayload({ ok: true }), []);
});

test('sincroniza paginas secuenciales y conserva Codigo y Codbarra', async t => {
  const writes = [], states = new Map();
  const db = { collection: name => name === 'qr_product_catalog' ? {
    bulkWrite: async operations => writes.push(operations),
  } : {
    findOne: async ({ _id }) => states.get(_id) || null,
    findOneAndUpdate: async ({ _id }, update) => {
      const value = { ...(states.get(_id) || {}), ...(update.$set || {}) };
      states.set(_id, value); return value;
    },
    updateOne: async ({ _id }, update) => {
      const value = { ...(states.get(_id) || {}), ...(update.$set || {}) };
      for (const key of Object.keys(update.$unset || {})) delete value[key];
      states.set(_id, value);
    },
  } };
  let page = 0;
  t.mock.method(axios, 'get', async url => {
    page += 1;
    assert.equal(new URL(url).searchParams.get('pag_num'), String(page));
    return { status: 200, data: page === 1
      ? [{ Codigo: '001', Codbarra: '0001', Descripcion: 'Uno' }]
      : [] };
  });
  const result = await syncManagerCatalog({
    db, cfg, tenant: 'tienda', normalize: raw => ({ code: raw.Codigo }), log: () => {},
  });
  assert.equal(result.products, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].updateOne.filter.Codigo, '001');
  assert.equal(writes[0][0].updateOne.update.$set.Codbarra, '0001');
});

test('una pagina vacia transitoria no corta la sincronizacion', async t => {
  const previous = process.env.QR_CATALOG_SYNC_PAGE_SIZE;
  process.env.QR_CATALOG_SYNC_PAGE_SIZE = '50';
  t.after(() => {
    if (previous == null) delete process.env.QR_CATALOG_SYNC_PAGE_SIZE;
    else process.env.QR_CATALOG_SYNC_PAGE_SIZE = previous;
  });
  const writes = [], states = new Map();
  const db = { collection: name => name === 'qr_product_catalog' ? {
    bulkWrite: async operations => writes.push(operations),
  } : {
    findOne: async ({ _id }) => states.get(_id) || null,
    findOneAndUpdate: async ({ _id }, update) => {
      const value = { ...(states.get(_id) || {}), ...(update.$set || {}) };
      states.set(_id, value); return value;
    },
    updateOne: async ({ _id }, update) => {
      const value = { ...(states.get(_id) || {}), ...(update.$set || {}) };
      for (const key of Object.keys(update.$unset || {})) delete value[key];
      states.set(_id, value);
    },
  } };
  let calls = 0;
  t.mock.method(axios, 'get', async () => {
    calls += 1;
    if (calls === 1) return { status: 200, data: Array.from({ length: 50 }, (_, i) => ({ Codigo: String(i), Descripcion: 'Fila' })) };
    if (calls === 2) return { status: 200, data: [] };
    return { status: 200, data: [{ Codigo: '50', Codbarra: '0050', Descripcion: 'Recuperado' }] };
  });
  const result = await syncManagerCatalog({ db, cfg, tenant: 'tienda', normalize: raw => ({ code: raw.Codigo }), log: () => {} });
  assert.equal(calls, 3);
  assert.equal(result.products, 51);
  assert.equal(writes.length, 2);
  assert.equal(writes[1][0].updateOne.filter.Codigo, '50');
});
