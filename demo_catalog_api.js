// Asisto | Version: 5.00.001 | Fecha: 2026-08-29
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_FILE = path.join(__dirname, 'data', 'articulos_rodaven.txt');
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

let catalogCache = null;
let catalogMeta = null;

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDecimal(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const normalized = raw
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^0-9+\-.]/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function readUtf16LeFile(filePath) {
  const buf = fs.readFileSync(filePath);
  let text = buf.toString('utf16le');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

function loadCatalog(options = {}) {
  const filePath = path.resolve(options.filePath || process.env.DEMO_RODAVEN_DATA_FILE || DEFAULT_DATA_FILE);
  const stat = fs.statSync(filePath);

  if (catalogCache && catalogMeta && catalogMeta.filePath === filePath && catalogMeta.mtimeMs === stat.mtimeMs) {
    return { items: catalogCache, meta: catalogMeta };
  }

  const text = readUtf16LeFile(filePath);
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('catalog_empty');

  const header = lines.shift().split('\t').map((v) => String(v || '').trim());
  const items = [];

  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 2) continue;

    const producto = String(cols[0] || '').trim();
    const descripcion = String(cols[1] || '').trim();
    const marca = String(cols[2] || '').trim();
    const rubro = String(cols[3] || '').trim();
    const precioFinal = parseDecimal(cols[5]);

    if (!producto && !descripcion) continue;

    items.push({
      Codigo: producto,
      Descripcion: descripcion || producto,
      Marca: marca,
      Desc_Rubro: rubro,
      Activo: 'S',
      Precio_Lp1: precioFinal,
      _search: normalizeText([producto, descripcion, marca, rubro].filter(Boolean).join(' ')),
      _codigoNorm: normalizeText(producto),
      _descripcionNorm: normalizeText(descripcion),
      _marcaNorm: normalizeText(marca),
      _rubroNorm: normalizeText(rubro),
    });
  }

  catalogCache = items;
  catalogMeta = {
    filePath,
    mtimeMs: stat.mtimeMs,
    rows: items.length,
    header,
    loadedAt: new Date().toISOString(),
  };

  console.log(`[demo-catalog] cargado ${items.length} artículos desde ${path.basename(filePath)}`);
  return { items, meta: catalogMeta };
}

function queryTokens(valor) {
  const decoded = String(valor ?? '').replace(/%+/g, ' ').trim();
  return normalizeText(decoded).split(' ').filter(Boolean);
}

function valueForCampo(item, campo) {
  const c = String(campo || 'OTRO').trim().toUpperCase();
  if (c === 'ID' || c === 'CODIGO' || c === 'PRODUCTO') return item._codigoNorm;
  if (c === 'DESCRIPCION' || c === 'DESC') return item._descripcionNorm;
  if (c === 'MARCA') return item._marcaNorm;
  if (c === 'RUBRO') return item._rubroNorm;
  return item._search;
}

function searchCatalog(items, params = {}) {
  const campo = String(params.campo || 'OTRO').trim().toUpperCase();
  const orden = String(params.orden || 'ASC').trim().toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const valor = String(params.valor ?? '').trim();
  const tokens = queryTokens(valor);
  const limitRaw = Number(params.limit || params.limite || DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT));

  let rows = items;
  if (tokens.length) {
    rows = items.filter((item) => {
      const haystack = valueForCampo(item, campo);
      return tokens.every((token) => haystack.includes(token));
    });
  }

  const direction = orden === 'DESC' ? -1 : 1;
  rows = rows.slice().sort((a, b) => {
    const av = valueForCampo(a, campo === 'OTRO' ? 'DESCRIPCION' : campo);
    const bv = valueForCampo(b, campo === 'OTRO' ? 'DESCRIPCION' : campo);
    return av.localeCompare(bv, 'es', { numeric: true, sensitivity: 'base' }) * direction;
  });

  return rows.slice(0, limit).map(({ _search, _codigoNorm, _descripcionNorm, _marcaNorm, _rubroNorm, ...publicRow }) => publicRow);
}

function safeEqualKey(provided, expected) {
  const a = String(provided ?? '');
  const b = String(expected ?? '');
  if (!b) return true;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function mountDemoCatalogApi(app, options = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('express_app_required');

  const route = options.route || '/v300/api/Api_Articulos/Consulta';
  const healthRoute = options.healthRoute || '/v300/api/Api_Articulos/Health';

  app.get(healthRoute, (req, res) => {
    try {
      const expectedKey = String(process.env.DEMO_RODAVEN_API_KEY || '').trim();
      if (!safeEqualKey(req.query?.key, expectedKey)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      const { meta } = loadCatalog(options);
      return res.json({ ok: true, rows: meta.rows, loadedAt: meta.loadedAt });
    } catch (e) {
      console.error('[demo-catalog] health error:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'catalog_load_error' });
    }
  });

  app.get(route, (req, res) => {
    try {
      const expectedKey = String(process.env.DEMO_RODAVEN_API_KEY || '').trim();
      if (!safeEqualKey(req.query?.key, expectedKey)) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      const errorSinRegistros = /^(1|true|yes|si|sí)$/i.test(String(req.query?.error_sin_registros || 'false'));
      const { items } = loadCatalog(options);
      const results = searchCatalog(items, req.query || {});

      res.set('Cache-Control', 'no-store');
      if (!results.length && errorSinRegistros) {
        return res.status(404).json({ error: 'sin_registros' });
      }
      return res.json(results);
    } catch (e) {
      console.error('[demo-catalog] consulta error:', e?.message || e);
      return res.status(500).json({ error: 'catalog_query_error' });
    }
  });

  // Carga anticipada: si el TXT está mal, se ve inmediatamente en el log del deploy.
  try {
    loadCatalog(options);
  } catch (e) {
    console.error('[demo-catalog] no se pudo precargar catálogo:', e?.message || e);
  }

  console.log(`[demo-catalog] API montada en ${route}`);
}

module.exports = {
  mountDemoCatalogApi,
  loadCatalog,
  searchCatalog,
};
