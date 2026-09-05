// Asisto | Version: 5.00.043 | Fecha: 2026-09-05
// Catálogo por comercio y origen. No sirve precios vencidos si la API falla.
const crypto = require('crypto');
const COLLECTION = 'qr_product_catalog';
const text = value => String(value ?? '').trim();
function sourceKey(cfg) {
  return crypto.createHash('sha256').update(JSON.stringify([
    cfg.apiUrl, cfg.apiMethod, cfg.apiCodeParam, cfg.apiBodyTemplate,
    cfg.apiAuthHeader, cfg.apiAuthValue, cfg.fieldCode,
  ])).digest('hex');
}
function createProductCatalog({ getDb, fetchExternal, normalize, now = Date.now,
  maxAgeMs = 300000, refreshAfterMs = 60000, warn = console.warn }) {
  const indexes = new WeakMap(), pending = new Map(), retryAfter = new Map();
  async function collection() {
    const db = await getDb();
    const col = db.collection(COLLECTION);
    if (!indexes.has(db)) {
      const ready = col.createIndexes([
        { key: { tenantId: 1, source: 1, Codigo: 1 }, name: 'tenant_source_codigo', unique: true },
        { key: { tenantId: 1, source: 1, Codbarra: 1 }, name: 'tenant_source_codbarra' },
      ], { timeoutMS: 5000 }).catch(error => { indexes.delete(db); throw error; });
      indexes.set(db, ready);
    }
    await indexes.get(db);
    return col;
  }
  const scope = (cfg, tenant) => ({ tenantId: text(tenant).toUpperCase(), source: sourceKey(cfg) });
  async function save(cfg, tenant, raw, fetchedAt = new Date(now())) {
    const product = normalize(raw, cfg);
    const Codigo = text(product.code);
    if (!Codigo) throw new Error('catalog_codigo_required');
    const filter = { ...scope(cfg, tenant), Codigo };
    const col = await collection();
    const update = { $set: { raw, Codbarra: text(raw.Codbarra ?? raw.codbarra ?? raw.barcode), fetchedAt } };
    try { await col.updateOne(filter, update, { upsert: true, timeoutMS: 2000 }); }
    catch (error) {
      if (error.code !== 11000) throw error;
      await col.updateOne(filter, update, { timeoutMS: 2000 });
    }
    return product;
  }
  async function lookup(cfg, tenant, code) {
    const col = await collection(), filter = scope(cfg, tenant);
    const exact = await col.findOne({ ...filter, Codigo: code }, { timeoutMS: 1500 });
    if (exact) return exact;
    const rows = await col.find({ ...filter, Codbarra: code }, { timeoutMS: 1500 }).limit(2).toArray();
    if (rows.length > 1) throw Object.assign(new Error('catalog_ambiguous_barcode'), { statusCode: 409 });
    return rows[0] || null;
  }
  async function refresh(cfg, tenant, code) {
    const key = JSON.stringify([scope(cfg, tenant), code]);
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      const raw = await fetchExternal(cfg, tenant, code);
      const product = normalize(raw, cfg);
      try { await save(cfg, tenant, raw); }
      catch { warn('[catalog] persistence unavailable; serving external product'); }
      return product;
    })();
    pending.set(key, request);
    try { return await request; }
    finally { if (pending.get(key) === request) pending.delete(key); }
  }
  async function get(cfg, tenant, code) {
    code = text(code);
    let doc = null;
    try { doc = await lookup(cfg, tenant, code); }
    catch (error) {
      if (error.message === 'catalog_ambiguous_barcode') throw error;
      warn('[catalog] local lookup unavailable; using external API');
    }
    const age = doc ? now() - new Date(doc.fetchedAt).getTime() : Infinity;
    if (doc && age >= 0 && age < maxAgeMs) {
      const product = normalize(doc.raw, cfg);
      const key = JSON.stringify([scope(cfg, tenant), doc.Codigo]);
      if (age >= refreshAfterMs && (retryAfter.get(key) || 0) <= now()) {
        // Una renovación por minuto como máximo por producto, incluso ante fallas.
        if (retryAfter.size >= 5000) retryAfter.delete(retryAfter.keys().next().value);
        retryAfter.set(key, now() + 60000);
        void refresh(cfg, tenant, doc.Codigo).catch(() => warn('[catalog] background refresh failed'));
      }
      return product;
    }
    // Un código de barras conocido se renueva usando el código interno de la API.
    return refresh(cfg, tenant, doc?.Codigo || code);
  }
  return { get, save, ensureIndexes: collection };
}
module.exports = { createProductCatalog, sourceKey, COLLECTION };
