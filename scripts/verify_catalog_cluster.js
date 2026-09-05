// Asisto | Version: 5.00.043 | Fecha: 2026-09-05
// Integración explícita en una base de prueba; nunca usa la base predeterminada del URI.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const { createRequire } = require('module');
const { performance } = require('perf_hooks');
const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const { createProductCatalog, COLLECTION, sourceKey } = require('../product_catalog');
const DB_NAME = 'asisto_catalog_test_20260905';

async function main() {
  if (!process.argv.includes('--run')) throw Error('Usar --run para ejecutar en ' + DB_NAME);
  require('dotenv').config();
  if (!process.env.MONGODB_URI) throw Error('Falta MONGODB_URI');
  const productionName = new URL(process.env.MONGODB_URI).pathname.slice(1);
  assert.notEqual(decodeURIComponent(productionName), DB_NAME);
  const client = new MongoClient(process.env.MONGODB_URI, {
    appName: 'asisto-catalog-test', maxPoolSize: 5, minPoolSize: 0,
    serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000,
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  });
  let apiServer, webServer;
  const run = Date.now().toString(), tenant = 'TEST_' + run;
  const report = { database: DB_NAME, tenant, startedAt: new Date().toISOString(), poolSize: 5, api: 'simulada localmente; MongoDB real', checks: [], load: [] };
  const reportPath = path.resolve('output/catalog-test-' + run + '.json');
  const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    await db.collection('test_runs').insertOne({ _id: run, purpose: 'Catálogo QR v5.00.043', startedAt: new Date(), tenant });
    console.log('Base de prueba creada: ' + DB_NAME);
    let apiCalls = 0, active = 0, peak = 0;
    const products = new Map();
    for (let i = 0; i < 110; i++) products.set(String(i).padStart(5, '0'), {
      Codigo: String(i).padStart(5, '0'), Codbarra: '000000' + String(i).padStart(7, '0'),
      Descripcion: 'Producto sintético ' + i, Precio_Lp1: 100 + i, Stock: 5,
    });
    const api = express(); api.use(express.json());
    api.post('/products', async (req, res) => {
      apiCalls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20)); active--;
      const product = products.get(String(req.body.codigo));
      if (!product) return res.status(404).json({});
      res.json(product);
    });
    apiServer = await listen(api);
    const settings = { _id: 'behavior:' + tenant, qr_enabled: true, qr_api_url: `http://127.0.0.1:${apiServer.address().port}/products`, qr_api_method: 'POST' };
    await db.collection('settings').insertOne(settings);
    const modulePath = path.resolve(__dirname, '../qr_product_web.js'), realRequire = createRequire(modulePath);
    const logs = [];
    const sandbox = { module: { exports: {} }, process, Buffer, URL, setTimeout, clearTimeout, setImmediate,
      console: { log() {}, warn: (...args) => logs.push(String(args[0])), error: (...args) => logs.push(String(args[0])) },
      require: name => name === './db' ? { getDb: async () => db } : name === './logic' ? {} : realRequire(name) };
    vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
    const { mountQrProductWeb, loadQrConfig, normalizeQrProduct } = sandbox.module.exports;
    const app = express(); mountQrProductWeb(app); webServer = await listen(app);
    const cfg = await loadQrConfig(db, tenant);
    const catalog = createProductCatalog({ getDb: async () => db, normalize: normalizeQrProduct, fetchExternal: async (c, t, code) => products.get(code) });
    await catalog.ensureIndexes();
    for (let i = 0; i < 100; i += 5) await Promise.all([...products.values()].slice(i, i + 5).map(raw => catalog.save(cfg, tenant, raw)));
    const request = async code => {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${webServer.address().port}/api/ext/qr/product?tenant=${tenant}&codigo=${encodeURIComponent(code)}`);
      return { status: response.status, body: await response.json(), ms: performance.now() - started };
    };
    assert.equal((await request('00000')).body.product.price, 100);
    assert.equal((await request(products.get('00000').Codbarra)).body.product.code, '00000');
    assert.equal(apiCalls, 0); report.checks.push('Lectura por Codigo y Codbarra sin API');
    const indexes = await db.collection(COLLECTION).indexes();
    assert.ok(indexes.some(index => index.name === 'tenant_source_codigo' && index.unique));
    assert.ok(indexes.some(index => index.name === 'tenant_source_codbarra'));
    report.checks.push('Índices reales creados');
    for (const concurrency of [25, 100]) {
      const before = apiCalls;
      const results = await Promise.all(Array.from({ length: concurrency }, (_, i) => request(String(i).padStart(5, '0'))));
      const times = results.map(result => result.ms).sort((a, b) => a - b);
      const errors = results.filter(result => result.status !== 200).length;
      report.load.push({ concurrency, errors, externalCalls: apiCalls - before,
        medianMs: Math.round(times[Math.floor(times.length * .5)]), p95Ms: Math.round(times[Math.ceil(times.length * .95) - 1]), maxMs: Math.round(times.at(-1)) });
      console.log(JSON.stringify(report.load.at(-1)));
      assert.equal(errors, 0); assert.equal(apiCalls, before);
    }
    const beforeMiss = apiCalls;
    const missing = await Promise.all(Array.from({ length: 25 }, () => request('00100')));
    assert.ok(missing.every(result => result.status === 200));
    assert.equal(apiCalls - beforeMiss, 1);
    assert.equal(await db.collection(COLLECTION).countDocuments({ tenantId: tenant, Codigo: '00100' }), 1);
    report.checks.push('25 faltantes simultáneos comparten una llamada y un registro');
    const filter = { tenantId: tenant, source: sourceKey(cfg), Codigo: '00000' };
    await db.collection(COLLECTION).updateOne(filter, { $set: { fetchedAt: new Date(Date.now() - 61000) } });
    products.set('00000', { ...products.get('00000'), Precio_Lp1: 999 });
    assert.equal((await request('00000')).body.product.price, 100);
    let renewed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if ((await db.collection(COLLECTION).findOne(filter)).raw.Precio_Lp1 === 999) { renewed = true; break; }
    }
    assert.ok(renewed); report.checks.push('Renovación en segundo plano persistida');
    await db.collection(COLLECTION).updateOne(filter, { $set: { fetchedAt: new Date(Date.now() - 301000) } });
    products.delete('00000');
    assert.equal((await request('00000')).status, 404);
    report.checks.push('Precio vencido no se muestra si producto desaparece');
    // Ejecuta el importador real con getDb ligado exclusivamente a la base de prueba.
    const importerPath = path.resolve(__dirname, 'import_product_catalog.js'), importRequire = createRequire(importerPath);
    const importer = { module: { exports: {} }, console: { log() {} },
      process: { argv: ['node', 'import', '--tenant', tenant, '--file', 'synthetic.json', '--observed-at', '2026-09-01T00:00:00Z', '--apply'] },
      require: name => name === '../db' ? { getDb: async () => db } : name === '../qr_product_web' ? { loadQrConfig, normalizeQrProduct } : name === 'fs' ? { readFileSync: () => JSON.stringify([{ ...products.get('00001'), Precio_Lp1: 1 }, { Codigo: 'IMPORT', Codbarra: '0099', Descripcion: 'Importado', Precio_Lp1: 5 }]) } : name === 'dotenv' ? { config() {} } : importRequire(name) };
    vm.runInNewContext(fs.readFileSync(importerPath, 'utf8'), importer, { filename: importerPath });
    await importer.module.exports.main();
    assert.equal((await db.collection(COLLECTION).findOne({ tenantId: tenant, Codigo: '00001' })).raw.Precio_Lp1, 101);
    assert.equal((await db.collection(COLLECTION).findOne({ tenantId: tenant, Codigo: 'IMPORT' })).raw.Precio_Lp1, 5);
    report.checks.push('Importación real no reemplaza precios más recientes');
    report.apiPeak = peak; report.warnings = logs; report.success = true;
    await db.collection('test_runs').updateOne({ _id: run }, { $set: { finishedAt: new Date(), report } });
  } catch (error) {
    report.success = false; report.error = String(error.message).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[URI redactada]');
    throw error;
  } finally {
    if (webServer) await new Promise(resolve => webServer.close(resolve));
    if (apiServer) await new Promise(resolve => apiServer.close(resolve));
    await client.close();
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log('Informe: ' + reportPath);
  }
}
main().catch(error => { console.error('Prueba falló: ' + String(error.message).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[URI redactada]')); process.exitCode = 1; });
