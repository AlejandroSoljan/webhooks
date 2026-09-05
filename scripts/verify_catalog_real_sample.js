// Asisto | Version: 5.00.043 | Fecha: 2026-09-05
// Lee configuración comercial; todas las escrituras quedan en la base de prueba.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const { createRequire } = require('module');
const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { COLLECTION } = require('../product_catalog');
const { performance } = require('perf_hooks');
async function main() {
  if (!process.argv.includes('--run')) throw Error('Requiere --run');
  require('dotenv').config();
  const uri = process.env.MONGODB_URI, url = new URL(uri);
  const productionName = decodeURIComponent(url.pathname.slice(1)) || process.env.MONGODB_DBNAME || 'test';
  const testName = 'asisto_catalog_test_20260905';
  assert.notEqual(productionName, testName);
  const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 });
  const tenant = 'DEMO_FERRETERIA', code = 'RT4097.1SX';
  const report = { database: testName, tenant, code, startedAt: new Date().toISOString(), checks: [] };
  let server, calls = 0;
  try {
    await client.connect();
    const settings = await client.db(productionName).collection('settings').findOne({ _id: 'behavior:' + tenant });
    assert.ok(settings?.qr_enabled); assert.equal(settings.qr_api_method, 'GET');
    const allowedOrigin = new URL(settings.qr_api_url).origin;
    const testDb = client.db(testName);
    // Credenciales y configuración permanecen en memoria, no se copian a la base ni al informe.
    const db = { collection: name => name === 'settings' ? { findOne: async () => settings } : testDb.collection(name) };
    const file = path.resolve(__dirname, '../qr_product_web.js'), realRequire = createRequire(file);
    const messages = [];
    const sandbox = { module: { exports: {} }, process, Buffer, URL, setTimeout, clearTimeout, setImmediate,
      console: { log() {}, warn() {}, error() {} },
      require: name => name === './db' ? { getDb: async () => db } : name === './logic' ? {} : name === 'axios' ? async options => {
        assert.equal(options.method, 'GET'); assert.equal(new URL(options.url).origin, allowedOrigin);
        if (++calls > 3) throw Error('Límite de muestra externa excedido');
        const start = performance.now(), response = await axios(options);
        messages.push({ status: response.status, ms: Math.round(performance.now() - start) });
        return response;
      } : realRequire(name) };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
    const app = express(); sandbox.module.exports.mountQrProductWeb(app);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    async function request(value) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ext/qr/product?tenant=${tenant}&codigo=${encodeURIComponent(value)}`);
      return { status: response.status, body: await response.json(), ms: Math.round(performance.now() - start) };
    }
    const initial = await request(code);
    report.initial = { status: initial.status, ms: initial.ms, error: initial.body.error };
    assert.equal(initial.status, 200, 'La API comercial no devolvió un producto válido');
    report.product = initial.body.product;
    const saved = await testDb.collection(COLLECTION).findOne({ tenantId: tenant, Codigo: code });
    assert.ok(saved); report.barcode = saved.Codbarra || null;
    report.checks.push('Producto comercial guardado en base de prueba');
    const before = calls, repeated = await request(code);
    assert.equal(repeated.status, 200); assert.equal(repeated.body.product.price, initial.body.product.price); assert.equal(calls, before);
    report.localMs = repeated.ms;
    report.checks.push('Consulta repetida local conserva precio sin llamar API');
    if (saved.Codbarra) {
      const barcode = await request(saved.Codbarra);
      assert.equal(barcode.status, 200); assert.equal(barcode.body.product.code, code); assert.equal(calls, before);
      report.checks.push('Código de barras real resuelto localmente');
    }
    const results = await Promise.all(Array.from({ length: 100 }, () => request(saved.Codbarra || code)));
    const times = results.map(x => x.ms).sort((a, b) => a - b);
    report.load = { concurrency: 100, errors: results.filter(x => x.status !== 200).length, p95Ms: times[94], maxMs: times[99], apiCalls: calls - before };
    assert.equal(report.load.errors, 0); assert.equal(report.load.apiCalls, 0);
    report.external = messages; report.externalCalls = calls; report.success = true;
    console.log(JSON.stringify({ product: { code: report.product.code, description: report.product.description, price: report.product.price }, barcode: report.barcode, externalCalls: calls, localMs: report.localMs, load: report.load }));
  } catch (error) {
    report.success = false; report.error = error.code || error.name;
    throw error;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await client.close();
    // No incluir imágenes/base64 de la respuesta en el informe.
    if (report.product) delete report.product.image;
    const dest = path.resolve('output/catalog-real-sample-' + Date.now() + '.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, JSON.stringify(report, null, 2)); console.log('Informe: ' + dest);
  }
}
main().catch(error => { console.error('Prueba falló: ' + (error.code || error.name)); process.exitCode = 1; });
