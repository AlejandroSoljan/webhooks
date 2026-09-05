// Asisto | Version: 5.00.043 | Fecha: 2026-09-05
// Validación por defecto. --apply es necesario para escribir en MongoDB.
const fs = require('fs');
const { sourceKey, COLLECTION, createProductCatalog } = require('../product_catalog');
const { loadQrConfig, normalizeQrProduct } = require('../qr_product_web');
const { getDb, closeDb } = require('../db');

async function main() {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  if (!args.includes('--tenant') || !args.includes('--file') || !args.includes('--observed-at')) {
    throw new Error('Uso: node scripts/import_product_catalog.js --tenant DOMINIO --file catalogo.json --observed-at FECHA_ISO [--apply]');
  }
  const tenant = String(value('--tenant')).trim().toUpperCase();
  if (!/^[A-Z0-9_.-]{1,100}$/.test(tenant)) throw new Error('Dominio inválido');
  const fetchedAt = new Date(value('--observed-at'));
  if (!Number.isFinite(fetchedAt.getTime()) || fetchedAt.getTime() > Date.now()) throw new Error('Fecha de extracción inválida o futura');
  const payload = JSON.parse(fs.readFileSync(value('--file'), 'utf8'));
  const rows = Array.isArray(payload) ? payload : payload.items || payload.articulos || payload.productos || payload.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Se requiere un arreglo de artículos no vacío');
  require('dotenv').config();
  const db = await getDb(), cfg = await loadQrConfig(db, tenant);
  if (!cfg.apiUrl) throw new Error('El dominio no tiene API QR configurada');
  const source = sourceKey(cfg), seen = new Set();
  const operations = rows.map(raw => {
    const product = normalizeQrProduct(raw, cfg), Codigo = product.code;
    if (seen.has(Codigo)) throw new Error('Codigo duplicado en el archivo: ' + Codigo);
    seen.add(Codigo);
    return { updateOne: {
      filter: { tenantId: tenant, source, Codigo },
      // Una importación vieja nunca reemplaza un precio consultado después.
      update: [{ $set: {
        raw: { $cond: [{ $gt: ['$fetchedAt', { $literal: fetchedAt }] }, '$raw', { $literal: raw }] },
        Codbarra: { $cond: [{ $gt: ['$fetchedAt', { $literal: fetchedAt }] }, '$Codbarra', { $literal: String(raw.Codbarra ?? raw.codbarra ?? raw.barcode ?? '').trim() }] },
        fetchedAt: { $cond: [{ $gt: ['$fetchedAt', { $literal: fetchedAt }] }, '$fetchedAt', { $literal: fetchedAt }] },
      } }], upsert: true,
    } };
  });
  console.log(JSON.stringify({ tenant, products: rows.length, observedAt: fetchedAt, apply: args.includes('--apply') }));
  if (!args.includes('--apply')) return;
  const catalog = createProductCatalog({ getDb, normalize: normalizeQrProduct });
  await catalog.ensureIndexes();
  for (let offset = 0; offset < operations.length; offset += 500) {
    await db.collection(COLLECTION).bulkWrite(operations.slice(offset, offset + 500), { ordered: true, timeoutMS: 30000 });
    console.log('Importados: ' + Math.min(offset + 500, operations.length));
  }
}
if (require.main === module) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
}).finally(() => closeDb('catalog_import'));
module.exports = { main };
