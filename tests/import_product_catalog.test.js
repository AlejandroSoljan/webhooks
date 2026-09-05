// Asisto | Version: 5.00.043 | Fecha: 2026-09-05
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { createRequire } = require('module');
function setup(rows, apply = false) {
  const batches = [], file = path.resolve(__dirname, '../scripts/import_product_catalog.js');
  const realRequire = createRequire(file);
  const db = { collection: () => ({ createIndexes: async () => {}, bulkWrite: async ops => { batches.push(ops); } }) };
  const sandbox = { module: { exports: {} }, console: { log() {} }, process: { argv: ['node', 'import', '--tenant', 'A', '--file', 'test.json', '--observed-at', '2026-09-01T00:00:00Z', ...(apply ? ['--apply'] : [])] },
    require: name => {
      if (name === 'fs') return { readFileSync: () => JSON.stringify(rows) };
      if (name === 'dotenv') return { config() {} };
      if (name === '../db') return { getDb: async () => db };
      if (name === '../qr_product_web') return { loadQrConfig: async () => ({ apiUrl: 'https://example.invalid' }), normalizeQrProduct: row => ({ code: row.Codigo }) };
      return realRequire(name);
    } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { run: sandbox.module.exports.main, batches };
}
test('importación valida sin escribir por defecto', async () => {
  const f = setup([{ Codigo: '001', Codbarra: '0001' }]); await f.run(); assert.equal(f.batches.length, 0);
});
test('importación explícita divide 501 artículos y protege fecha previa', async () => {
  const f = setup(Array.from({ length: 501 }, (_, i) => ({ Codigo: String(i), Descripcion: '$literal' })), true);
  await f.run(); assert.equal(f.batches.length, 2); assert.equal(f.batches[0].length, 500);
  const update = f.batches[0][0].updateOne;
  assert.equal(update.filter.tenantId, 'A'); assert.equal(update.upsert, true);
  assert.equal(update.update[0].$set.raw.$cond[1], '$raw');
  assert.equal(update.update[0].$set.raw.$cond[2].$literal.Descripcion, '$literal');
  assert.equal(update.update[0].$set.fetchedAt.$cond[0].$gt[0], '$fetchedAt');
});
test('códigos repetidos impiden toda escritura', async () => {
  const f = setup([{ Codigo: '1' }, { Codigo: '1' }], true);
  await assert.rejects(f.run(), /duplicado/); assert.equal(f.batches.length, 0);
});
