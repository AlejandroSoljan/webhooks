// Asisto | Version: 5.00.159 | Fecha: 2026-09-18
// Ejecutar únicamente en asisto-linux con DOTENV_CONFIG_PATH=/etc/asisto/production.env.
const os = require('os');
const { getDb, closeDb } = require('../db');

function photoFor(name, category) {
  const value = `${name} ${category}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const choices = [
    [/agua mineral/, 'agua'], [/cafe|espresso/, 'cafe'], [/gaseosa/, 'gaseosa'], [/limonada/, 'limonada'],
    [/cesar/, 'cesar'], [/quinoa/, 'quinoa'], [/empanada/, 'empanadas'], [/papas bravas/, 'papas'],
    [/rucula/, 'rucula'], [/pizza/, 'pizza'], [/brownie/, 'brownie'], [/flan/, 'flan'], [/fruta/, 'fruta'],
    [/hamburguesa/, 'hamburguesa'], [/milanesa/, 'milanesa'], [/pasta|fideos|noquis|ravioles/, 'pasta'],
    [/pollo/, 'pollo'], [/risotto/, 'risotto'],
    [/bebida/, 'bebida'], [/ensalada/, 'ensalada'], [/entrada/, 'empanadas'], [/postre/, 'postre'], [/principal/, 'milanesa'],
  ];
  return `/static/restaurant_demo/${(choices.find(([pattern]) => pattern.test(value)) || [null, 'postre'])[1]}.webp`;
}

async function main() {
  if (process.platform !== 'linux' || !os.hostname().startsWith('ip-172-26-0-152') || process.env.DOTENV_CONFIG_PATH !== '/etc/asisto/production.env') throw Error('Solo se permite ejecutar en asisto-linux con el entorno productivo');
  const db = await getDb();
  if (db.databaseName !== 'Cluster0') throw Error('Base productiva inesperada');
  const rows = await db.collection('products').find({ tenantId: 'RES' }, { projection: { descripcion: 1, tag: 1, imagen: 1 } }).toArray();
  const missing = rows.filter(row => !row.imagen);
  console.log(JSON.stringify({ host: os.hostname(), database: db.databaseName, domain: 'RES', total: rows.length, missing: missing.length, preview: missing.map(row => ({ name: row.descripcion, photo: photoFor(row.descripcion, row.tag) })) }));
  if (process.argv.includes('--apply') && missing.length) {
    const operations = missing.map(row => ({ updateOne: { filter: { _id: row._id, tenantId: 'RES', imagen: { $exists: false } }, update: { $set: { imagen: photoFor(row.descripcion, row.tag), updatedAt: new Date() } } } }));
    const result = await db.collection('products').bulkWrite(operations);
    console.log(JSON.stringify({ updated: result.modifiedCount }));
  }
  await closeDb();
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { photoFor };
