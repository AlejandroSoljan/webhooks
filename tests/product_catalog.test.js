// Asisto | Version: 5.00.043 | Fecha: 2026-09-05
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProductCatalog, sourceKey } = require('../product_catalog');
const { fixture } = require('./catalog_fixture');
const cfg = { apiUrl: 'https://example.invalid/products', fieldCode: 'Codigo' };
const raw = { Codigo: '0012', Codbarra: '0001234567890', Descripcion: 'Prueba', Precio: 10 };
const normalize = row => ({ code: row.Codigo, price: row.Precio });
function setup(fetchExternal = async () => raw) {
  const f = fixture(); let clock = 1000000;
  const service = createProductCatalog({ getDb: async () => f.db, fetchExternal, normalize, now: () => clock, warn: () => {} });
  return { ...f, service, setTime: time => { clock = time; } };
}
test('consulta por código y barras conserva ceros e índices y evita API', async () => {
  const f = setup(() => { throw Error('API should not run'); });
  await f.service.save(cfg, 'tienda', raw);
  assert.equal((await f.service.get(cfg, 'TIENDA', raw.Codbarra)).code, '0012');
  assert.equal((await f.service.get(cfg, 'tienda', '0012')).price, 10);
  assert.equal(f.indexCalls.length, 1);
  assert.equal(f.indexCalls[0][0].unique, true);
});
test('separa comercios y orígenes sin guardar credenciales', async () => {
  let calls = 0;
  const f = setup(async () => { calls++; return { ...raw, Precio: 20 }; });
  await f.service.save(cfg, 'A', raw);
  assert.equal((await f.service.get(cfg, 'B', '0012')).price, 20);
  await f.service.get({ ...cfg, apiAuthValue: 'secret' }, 'A', '0012');
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(f.rows).includes('secret'), false);
  assert.notEqual(sourceKey(cfg), sourceKey({ ...cfg, apiAuthValue: 'secret' }));
});
test('100 consultas de un producto comparten una llamada externa', async () => {
  let calls = 0;
  const f = setup(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return raw; });
  const products = await Promise.all(Array.from({ length: 100 }, () => f.service.get(cfg, 'A', '0012')));
  assert.equal(calls, 1); assert.equal(products.length, 100); assert.equal(f.rows.length, 1);
});
test('100 productos vigentes distintos se responden localmente', async () => {
  const f = setup(() => { throw Error('API should not run'); });
  for (let i = 0; i < 100; i++) await f.service.save(cfg, 'A', { ...raw, Codigo: String(i) });
  const result = await Promise.all(Array.from({ length: 100 }, (_, i) => f.service.get(cfg, 'A', String(i))));
  assert.equal(result.length, 100);
});
test('renueva en segundo plano por código interno y actualiza precio y barras', async () => {
  let finish, codeSeen;
  const f = setup(async (c, t, code) => { codeSeen = code; return new Promise(resolve => { finish = resolve; }); });
  await f.service.save(cfg, 'A', raw); f.setTime(1060000);
  assert.equal((await f.service.get(cfg, 'A', raw.Codbarra)).price, 10);
  assert.equal(codeSeen, '0012');
  finish({ ...raw, Precio: 25, Codbarra: 'NEW' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.service.get(cfg, 'A', 'NEW')).price, 25);
  assert.equal(f.rows[0].Codbarra, 'NEW');
});
test('precio vencido espera API y no se sirve ante error', async () => {
  const f = setup(async () => { throw Error('offline'); });
  await f.service.save(cfg, 'A', raw); f.setTime(1300000);
  await assert.rejects(f.service.get(cfg, 'A', raw.Codbarra), /offline/);
});
test('falla de MongoDB conserva fallback a API', async () => {
  const service = createProductCatalog({ getDb: async () => { throw Error('offline'); }, fetchExternal: async () => raw, normalize, warn: () => {} });
  assert.equal((await service.get(cfg, 'A', '0012')).price, 10);
});
test('código de barras ambiguo no elige un producto arbitrario', async () => {
  const f = setup();
  await f.service.save(cfg, 'A', raw);
  await f.service.save(cfg, 'A', { ...raw, Codigo: 'other' });
  await assert.rejects(f.service.get(cfg, 'A', raw.Codbarra), { statusCode: 409 });
});
