const { getDb } = require('./db');

async function getActiveProducts() {
  const db = await getDb();
  const items = await db.collection('products')
    .find({ active: { $ne: false } })
    .sort({ createdAt: -1, descripcion: 1 })
    .toArray();
  return items;
}

function buildCatalogText(items) {
  if (!items || !items.length) return "Catálogo de productos: (ninguno activo)";
  const lines = items.map(p => {
    const precioTxt = (typeof p.importe === 'number') ? ` — $${p.importe}` : (p.importe ? ` — $${p.importe}` : '');
    const obsTxt = p.observacion ? ` | Obs: ${p.observacion}` : '';
    return `- ${p.descripcion}${precioTxt}${obsTxt}`;
  });
  return "Catálogo de productos (nombre — precio | Obs: observaciones):\n" + lines.join("\n");
}

module.exports = { getActiveProducts, buildCatalogText };
