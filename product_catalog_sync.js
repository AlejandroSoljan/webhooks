// Asisto | Version: 5.00.046 | Fecha: 2026-09-08
// Sincronizacion paginada y conservadora del catalogo Manager hacia MongoDB.
const axios = require('axios');
const { COLLECTION, sourceKey } = require('./product_catalog');

const STATE_COLLECTION = 'qr_product_catalog_sync';
const SYNC_VERSION = 2;
const text = value => String(value ?? '').trim();
const intEnv = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : fallback));
};

function isManagerCatalog(cfg) {
  return cfg?.enabled && cfg?.apiMethod === 'GET' &&
    /\/api\/Api_Articulos\s*\/Consulta/i.test(text(cfg.apiUrl));
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['items', 'articulos', 'productos', 'data', 'result', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function managerPageRequest(cfg, page, pageSize) {
  const url = new URL(text(cfg.apiUrl).replace(/\{\{\s*codigo\s*\}\}/gi, '*'));
  url.searchParams.set('campo', 'ID');
  url.searchParams.set('valor', '*');
  url.searchParams.set('pag_num', String(page));
  url.searchParams.set('pag_cant_reg', String(pageSize));
  url.searchParams.set('error_sin_registros', 'false');
  const headers = { Accept: 'application/json' };
  if (cfg.apiAuthHeader && cfg.apiAuthValue) headers[cfg.apiAuthHeader] = cfg.apiAuthValue;
  return { url: url.toString(), headers };
}

async function syncManagerCatalog({ db, cfg, tenant, normalize, log = console.log }) {
  if (!isManagerCatalog(cfg)) return { skipped: 'not_manager_catalog' };
  const pageSize = intEnv('QR_CATALOG_SYNC_PAGE_SIZE', 500, 50, 2000);
  const maxPages = intEnv('QR_CATALOG_SYNC_MAX_PAGES', 1000, 1, 10000);
  const leaseMs = intEnv('QR_CATALOG_SYNC_LEASE_MS', 3600000, 60000, 21600000);
  const intervalMs = intEnv('QR_CATALOG_SYNC_INTERVAL_MS', 86400000, 3600000, 604800000);
  const tenantId = text(tenant).toUpperCase();
  const source = sourceKey(cfg);
  const stateId = `${tenantId}:${source}`;
  const now = new Date();
  const state = await db.collection(STATE_COLLECTION).findOne({ _id: stateId });
  if (state?.syncVersion === SYNC_VERSION && state?.lastCompletedAt && now - new Date(state.lastCompletedAt) < intervalMs) {
    return { skipped: 'recent', lastCompletedAt: state.lastCompletedAt };
  }
  const lease = await db.collection(STATE_COLLECTION).findOneAndUpdate(
    { _id: stateId, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] },
    { $set: { tenantId, source, syncVersion: SYNC_VERSION, leaseUntil: new Date(now.getTime() + leaseMs), startedAt: now } },
    { upsert: true, returnDocument: 'after' }
  ).catch(error => {
    if (error?.code === 11000) return null;
    throw error;
  });
  if (!lease) return { skipped: 'locked' };

  let total = 0;
  try {
    for (let page = 1; page <= maxPages; page++) {
      let rows = [];
      // Manager puede responder 200 con una página vacía transitoria. Confirmamos
      // tres veces antes de considerarla el final real del catálogo.
      for (let emptyAttempt = 1; emptyAttempt <= 3; emptyAttempt++) {
        const request = managerPageRequest(cfg, page, pageSize);
        const response = await axios.get(request.url, {
          headers: request.headers,
          timeout: cfg.apiTimeoutMs,
          validateStatus: () => true,
        });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`catalog_sync_http_${response.status}`);
        }
        rows = rowsFromPayload(response.data);
        if (rows.length) break;
        if (emptyAttempt < 3) await new Promise(resolve => setTimeout(resolve, 750 * emptyAttempt));
      }
      if (!rows.length) break;
      const fetchedAt = new Date();
      const operations = rows.map(raw => {
        const product = normalize(raw, cfg);
        return { updateOne: {
          filter: { tenantId, source, Codigo: text(product.code) },
          update: { $set: { raw, Codbarra: text(raw.Codbarra ?? raw.codbarra ?? raw.barcode), fetchedAt } },
          upsert: true,
        } };
      });
      await db.collection(COLLECTION).bulkWrite(operations, { ordered: false });
      total += rows.length;
      log(`[catalog-sync] tenant=${tenantId} page=${page} rows=${rows.length} total=${total}`);
      await db.collection(STATE_COLLECTION).updateOne(
        { _id: stateId },
        { $set: { leaseUntil: new Date(Date.now() + leaseMs), page, products: total } }
      );
      if (rows.length < pageSize) break;
      if (page === maxPages) throw new Error('catalog_sync_max_pages_reached');
    }
    await db.collection(STATE_COLLECTION).updateOne(
      { _id: stateId },
      { $set: { lastCompletedAt: new Date(), products: total }, $unset: { leaseUntil: '', error: '' } }
    );
    return { products: total };
  } catch (error) {
    await db.collection(STATE_COLLECTION).updateOne(
      { _id: stateId },
      { $set: { error: text(error?.message).slice(0, 300), failedAt: new Date() }, $unset: { leaseUntil: '' } }
    ).catch(() => {});
    throw error;
  }
}

function startManagerCatalogScheduler({ getDb, loadConfig, normalize, warn = console.warn }) {
  const startupMs = intEnv('QR_CATALOG_SYNC_STARTUP_MS', 30000, 1000, 3600000);
  const checkMs = intEnv('QR_CATALOG_SYNC_CHECK_MS', 3600000, 60000, 86400000);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const db = await getDb();
      const configs = await db.collection('settings').find({
        _id: { $regex: '^behavior:' }, qr_enabled: true,
        qr_api_method: { $in: [null, '', 'GET'] },
        qr_api_url: { $regex: '/api/Api_Articulos\\s*/Consulta', $options: 'i' },
      }).project({ _id: 1 }).toArray();
      for (const item of configs) {
        const tenant = text(item._id).slice('behavior:'.length).toUpperCase();
        try {
          const cfg = await loadConfig(db, tenant);
          await syncManagerCatalog({ db, cfg, tenant, normalize });
        } catch (error) {
          warn(`[catalog-sync] tenant=${tenant} error=${text(error?.message)}`);
        }
      }
    } catch (error) {
      warn(`[catalog-sync] scheduler error=${text(error?.message)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, startupMs);
  const timer = setInterval(run, checkMs);
  first.unref?.(); timer.unref?.();
  return { run, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { isManagerCatalog, rowsFromPayload, managerPageRequest, syncManagerCatalog, startManagerCatalogScheduler };
