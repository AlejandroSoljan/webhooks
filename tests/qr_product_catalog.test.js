// Asisto | Version: 5.00.043 | Fecha: 2026-09-05
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('module');
const path = require('path');
const { fixture } = require('./catalog_fixture');
function load(api) {
  const f = fixture(), routes = new Map();
  const config = { qr_enabled: true, qr_api_url: 'https://example.invalid/products', qr_api_method: 'POST' };
  const db = { collection: name => name === 'settings' ? { findOne: async () => config } : f.col };
  const file = path.resolve(__dirname, '../qr_product_web.js'), realRequire = createRequire(file);
  const sandbox = { module: { exports: {} }, process, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setImmediate() {}, Buffer, URL,
    require: name => name === './logic' ? {} : name === './db' ? { getDb: async () => db } : name === 'axios' ? api : realRequire(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  sandbox.module.exports.mountQrProductWeb({ get: (route, handler) => routes.set(route, handler), post() {} });
  async function request(code) {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await routes.get('/api/ext/qr/product')({ query: { tenant: 'A', codigo: code } }, res);
    return res;
  }
  return { ...f, request, config };
}
test('POST funciona y el siguiente escaneo de barras usa MongoDB', async () => {
  let calls = 0;
  const f = load(async options => { calls++; assert.equal(options.data.codigo, '0012'); return { status: 200, data: { product: { Codigo: '0012', Codbarra: '000123', Descripcion: 'Producto', Precio_Lp1: 12 } } }; });
  const first = await f.request('0012'); assert.equal(first.statusCode, 200);
  const second = await f.request('000123'); assert.equal(second.statusCode, 200);
  assert.equal(calls, 1); assert.equal(f.rows.length, 1);
});
test('no acepta otro artículo de una respuesta múltiple', async () => {
  const f = load(async () => ({ status: 200, data: [{ Codigo: 'OTHER', Descripcion: 'Otro' }] }));
  assert.equal((await f.request('0012')).statusCode, 404); assert.equal(f.rows.length, 0);
});
test('404 externo no se convierte en caída de API', async () => {
  const f = load(async () => ({ status: 404, data: {} }));
  for (let i = 0; i < 6; i++) assert.equal((await f.request('missing')).statusCode, 404);
});
test('desactivar QR impide leer incluso un producto guardado', async () => {
  const f = load(async () => ({ status: 200, data: { Codigo: '1', Descripcion: 'Uno' } }));
  assert.equal((await f.request('1')).statusCode, 200);
  f.config.qr_enabled = false;
  assert.equal((await f.request('1')).statusCode, 404);
});
test('100 faltantes distintos respetan el máximo de 10 llamadas externas', async () => {
  let active = 0, peak = 0, calls = 0;
  const f = load(async options => {
    active++; calls++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { status: 200, data: { Codigo: options.data.codigo, Descripcion: 'Producto' } };
  });
  const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => f.request(String(i))));
  assert.equal(calls, 100); assert.ok(peak <= 10); assert.ok(responses.every(res => res.statusCode === 200));
});
test('cambio de campo de precio se aplica a los datos locales', async () => {
  let calls = 0;
  const f = load(async () => { calls++; return { status: 200, data: { Codigo: '1', Descripcion: 'Uno', Precio_Lp1: 10, Mayorista: 8 } }; });
  await f.request('1'); f.config.qr_field_price = 'Mayorista';
  const response = await f.request('1');
  assert.equal(response.body.product.price, 8); assert.equal(calls, 1);
});
test('la API tampoco puede resolver barras duplicadas arbitrariamente', async () => {
  const f = load(async () => ({ status: 200, data: [
    { Codigo: '1', Codbarra: '123', Descripcion: 'Uno' },
    { Codigo: '2', Codbarra: '123', Descripcion: 'Dos' },
  ] }));
  assert.equal((await f.request('123')).statusCode, 409); assert.equal(f.rows.length, 0);
});
