// help_tool.js
// Herramienta de Ayuda contextual de Asisto.
// - Fuente: Google Sheets (privado con Service Account o CSV público/directo).
// - Coincidencias técnicas: determinísticas, sin IA.
// - Categorías en lenguaje natural: IA sólo cuando hace falta, con cache por ventana+fuente.
// - Registra tokens en ai_token_usage_log con channelType=help_api.

const crypto = require('crypto');
const express = require('express');
const OpenAI = require('openai');

const { getDb } = require('./db');
const { getRuntimeByTenantId } = require('./tenant_runtime');
const { recordTokenUsage, parseTokenUsagePair } = require('./logic');

const DEFAULT_AGENT = 'MANAGER';
const DEFAULT_SOURCE_URL = 'https://docs.google.com/spreadsheets/d/1dXa_8JjpgonKzup5J2aYdgGPudxcdy7eY1ITTIl5-Z8/edit?gid=0#gid=0';
const DEFAULT_MODEL = String(process.env.HELP_MODEL || 'gpt-5.6-luna').trim() || 'gpt-5.6-luna';
const DEFAULT_SOURCE_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_AI_CACHE_DAYS = 3650;
const HELP_API_KEY = String(
  process.env.HELP_API_KEY ||
  process.env.ASISTO_HELP_API_KEY ||
  process.env.DOMAIN_STATUS_API_KEY ||
  process.env.ASISTO_DOMAIN_STATUS_API_KEY ||
  process.env.WWEB_API_KEY ||
  ''
).trim();
const ASISTO_TZ = String(process.env.STORE_TZ || 'America/Argentina/Cordoba').trim() || 'America/Argentina/Cordoba';

const DEFAULT_BEHAVIOR = `Tenes una lista de videos cuyo campo "categoria" describe en lenguaje natural a que ventanas aplica (no son nombres tecnicos exactos), por ejemplo "todas las ventanas de ABM".

Te doy el nombre tecnico de UNA ventana puntual. Tu tarea es decidir, para cada video de la lista, si esa ventana claramente pertenece a la categoria descripta.

Reglas:
- Se estricto: si tenes dudas razonables, NO lo incluyas.
- Basate solo en el nombre tecnico de la ventana y el texto de la categoria.
- No inventes informacion ni relaciones que no se desprendan claramente de esos textos.

Responde UNICAMENTE con JSON valido en este formato:
{"vimeo_ids":["<vimeo_id>"]}
Si ninguna categoria aplica, responde {"vimeo_ids":[]}.`;


// Reglas mínimas internas para interpretar nombres técnicos de Manager.
// Se anexan al comportamiento configurable para que las categorías generales
// se resuelvan semánticamente aun cuando el comportamiento guardado sea viejo.
// Ejemplo: w_pro_abm_productos pertenece claramente a una categoría que diga
// "todas las ventanas de ABM de ... artículos ...".
const CATEGORY_MATCH_GUIDANCE = `
Interpretá semánticamente los componentes evidentes del nombre técnico de la ventana; no exijas coincidencia literal de palabras.

Reglas de interpretación:
- Si el nombre contiene "_abm_" o comienza/termina con una forma equivalente, es una ventana de ABM.
- "productos" y "articulos" representan la misma entidad funcional a estos efectos.
- "acreedores" y "proveedores" representan la misma entidad funcional a estos efectos.
- "clientes" corresponde a clientes.
- Una categoría general debe incluirse cuando el nombre técnico indique claramente que la ventana pertenece a una de las entidades o tipos mencionados por esa categoría.
- Ejemplo obligatorio: "w_pro_abm_productos" SI pertenece a "Todas las ventanas de ABM de clientes, proveedores, articulos y entidades en general".
- Seguí siendo estricto para relaciones que no puedan inferirse claramente del propio nombre técnico.
`.trim();

const QUERY_ANSWER_GUIDANCE = `
MODO CONSULTA INTELIGENTE DE AYUDA.

Recibirás:
- consulta: pregunta del usuario.
- ventana: nombre técnico de la ventana actual; puede estar vacío.
- videos: candidatos de la base de ayuda.

Objetivo:
- Respondé la consulta usando EXCLUSIVAMENTE la información contenida en los videos candidatos.
- Si \"ventana\" tiene valor, dale prioridad fuerte a los videos que correspondan a esa ventana o a una categoría general que claramente la incluya.
- Si \"ventana\" está vacía, resolvé la consulta de forma general con los candidatos disponibles.
- Podés combinar información de varios videos si ayuda a responder mejor.
- Elegí solamente videos realmente útiles para la consulta.
- No inventes pasos, botones, menús, funciones ni datos que no estén respaldados por título, tags, descripción o ventana/categoría.
- Si la información disponible no alcanza para responder con seguridad, indicá eso claramente y usá \"encontrado\": false.

IMPORTANTE: para este modo IGNORÁ cualquier instrucción anterior que pida devolver solamente \"vimeo_ids\".
Respondé únicamente JSON válido con este formato:
{
  \"encontrado\": true,
  \"respuesta_texto\": \"respuesta clara y breve en español\",
  \"vimeo_ids\": [\"<id>\"]
}
`.trim();
 

const EXPECTED_HEADERS = {
  title: ['titulo', 'título'],
  vimeoId: ['id vimeo', 'id_vimeo', 'vimeo id', 'vimeo_id'],
  appliesTo: ['ventana que aplica', 'ventana_que_aplica', 'ventana aplica'],
  versionFrom: ['version desde', 'versión desde', 'version_desde'],
  versionTo: ['version hasta', 'versión hasta', 'version_hasta'],
  importance: ['importancia'],
  tags: ['tags', 'tag'],
  description: ['descripcion', 'descripción']
};

const _configCache = new Map();
const _sourceCache = new Map();
const _openAiClients = new Map();
let _indexesReady = false;
let _googleTokenCache = null;

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return !!fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(String(value).trim().toLowerCase());
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clean(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, Math.max(1, max));
}

function normalizeAgent(value) {
  return clean(value || DEFAULT_AGENT, 80).toUpperCase().replace(/[^A-Z0-9_.-]/g, '_') || DEFAULT_AGENT;
}

function normalizeHeader(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeWindow(value) {
  return clean(value, 300).toLowerCase();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function safeTimingEqual(a, b) {
  try {
    const aa = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function readApiKey(req) {
  const auth = String(req.headers?.authorization || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  return clean(
    req.headers?.['x-api-key'] ||
    req.headers?.['x-asisto-key'] ||
    (bearer ? bearer[1] : '') ||
    req.query?.key ||
    req.query?.apiKey ||
    req.body?.key ||
    req.body?.apiKey ||
    '',
    4000
  );
}

function requireHelpExternalAccess(req, res, next) {
  const provided = readApiKey(req);
  if (!HELP_API_KEY || !provided || !safeTimingEqual(provided, HELP_API_KEY)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}

function publicHelpConfig(cfg = {}) {
  return {
    enabled: cfg.enabled !== false,
    agent: normalizeAgent(cfg.agent || DEFAULT_AGENT),
    source_url: clean(cfg.source_url || DEFAULT_SOURCE_URL, 4000),
    model: clean(cfg.model || DEFAULT_MODEL, 120),
    behavior: clean(cfg.behavior || DEFAULT_BEHAVIOR, 30000),
    source_cache_minutes: Math.max(1, Math.round(Number(cfg.source_cache_ms || DEFAULT_SOURCE_CACHE_MS) / 60000)),
    ai_cache_days: clampInt(cfg.ai_cache_days, 1, 3650, DEFAULT_AI_CACHE_DAYS),
    max_videos: clampInt(cfg.max_videos, 1, 100, 20),
    google_service_account_email: clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '', 500) || null,
    api_key_configured: !!HELP_API_KEY
  };
}

async function loadHelpConfig(agent = DEFAULT_AGENT, { force = false } = {}) {
  const safeAgent = normalizeAgent(agent);
  const cached = _configCache.get(safeAgent);
  if (!force && cached && (Date.now() - cached.at) < 5 * 60 * 1000) return cached.value;

  const db = await getDb();
  const doc = await db.collection('settings').findOne({ _id: `help:${safeAgent}` }) || {};
  const isDefaultAgent = safeAgent === DEFAULT_AGENT;
  const cfg = {
    enabled: doc.enabled === undefined ? isDefaultAgent : boolValue(doc.enabled, isDefaultAgent),
    agent: safeAgent,
    source_url: clean(doc.source_url || doc.sourceUrl || (isDefaultAgent ? DEFAULT_SOURCE_URL : ''), 4000),
    model: clean(doc.model || DEFAULT_MODEL, 120),
    behavior: clean(doc.behavior || doc.comportamiento || DEFAULT_BEHAVIOR, 30000),
    source_cache_ms: clampInt(doc.source_cache_ms ?? doc.sourceCacheMs, 30000, 60 * 60 * 1000, DEFAULT_SOURCE_CACHE_MS),
    ai_cache_days: clampInt(doc.ai_cache_days ?? doc.aiCacheDays, 1, 3650, DEFAULT_AI_CACHE_DAYS),
    max_videos: clampInt(doc.max_videos ?? doc.maxVideos, 1, 100, 20)
  };

  _configCache.set(safeAgent, { value: cfg, at: Date.now() });
  return cfg;
}

async function saveHelpConfig(agent = DEFAULT_AGENT, payload = {}) {
  const safeAgent = normalizeAgent(agent || payload.agent || DEFAULT_AGENT);
  const db = await getDb();
  const existing = await db.collection('settings').findOne({ _id: `help:${safeAgent}` }) || {};

  const cfg = {
    enabled: boolValue(payload.enabled, existing.enabled === undefined ? true : existing.enabled),
    agent: safeAgent,
    source_url: clean(payload.source_url ?? payload.sourceUrl ?? existing.source_url ?? DEFAULT_SOURCE_URL, 4000),
    model: clean(payload.model ?? existing.model ?? DEFAULT_MODEL, 120) || DEFAULT_MODEL,
    behavior: clean(payload.behavior ?? payload.comportamiento ?? existing.behavior ?? DEFAULT_BEHAVIOR, 30000) || DEFAULT_BEHAVIOR,
    source_cache_ms: clampInt(
      payload.source_cache_ms ?? payload.sourceCacheMs ?? existing.source_cache_ms,
      30000,
      60 * 60 * 1000,
      DEFAULT_SOURCE_CACHE_MS
    ),
    ai_cache_days: clampInt(payload.ai_cache_days ?? payload.aiCacheDays ?? existing.ai_cache_days, 1, 3650, DEFAULT_AI_CACHE_DAYS),
    max_videos: clampInt(payload.max_videos ?? payload.maxVideos ?? existing.max_videos, 1, 100, 20),
    updatedAt: new Date()
  };

  if (!cfg.source_url) throw new Error('help_source_url_required');
  if (!/^https?:\/\//i.test(cfg.source_url)) throw new Error('help_source_url_invalid');

  await db.collection('settings').updateOne(
    { _id: `help:${safeAgent}` },
    { $set: cfg, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  _configCache.delete(safeAgent);
  _sourceCache.delete(safeAgent);
  return loadHelpConfig(safeAgent, { force: true });
}

function invalidateHelpConfigCache(agent = DEFAULT_AGENT) {
  const safeAgent = normalizeAgent(agent);
  _configCache.delete(safeAgent);
  _sourceCache.delete(safeAgent);
}

function parseGoogleSheetRef(url) {
  const s = clean(url, 4000);
  let m = s.match(/docs\.google\.com\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]+)/i);
  if (m) {
    const gidMatch = s.match(/[?#&]gid=(\d+)/i);
    return { publishedId: m[1], gid: gidMatch ? gidMatch[1] : '0', published: true };
  }
  m = s.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/i);
  if (m) {
    const gidMatch = s.match(/[?#&]gid=(\d+)/i);
    return { id: m[1], gid: gidMatch ? gidMatch[1] : '0', published: false };
  }
  return null;
}

function googlePublicCsvUrl(sourceUrl) {
  const ref = parseGoogleSheetRef(sourceUrl);
  if (!ref) return sourceUrl;
  if (ref.published && ref.publishedId) {
    return `https://docs.google.com/spreadsheets/d/e/${ref.publishedId}/pub?gid=${encodeURIComponent(ref.gid)}&single=true&output=csv`;
  }
  return `https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv&gid=${encodeURIComponent(ref.gid)}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function base64UrlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function getGoogleServiceAccountToken() {
  const email = clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '', 500);
  const privateKey = String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!email || !privateKey) return null;

  if (_googleTokenCache && _googleTokenCache.token && Date.now() < (_googleTokenCache.expiresAt - 60 * 1000)) {
    return _googleTokenCache.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = base64UrlJson({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  });
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const assertion = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });
  const resp = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }, 20000);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    throw new Error(`google_service_account_token_error:${resp.status}`);
  }
  _googleTokenCache = {
    token: String(json.access_token),
    expiresAt: Date.now() + (Number(json.expires_in || 3600) * 1000)
  };
  return _googleTokenCache.token;
}

async function fetchGoogleSheetPrivate(sourceUrl) {
  const ref = parseGoogleSheetRef(sourceUrl);
  if (!ref || !ref.id || ref.published) return null;
  const token = await getGoogleServiceAccountToken();
  if (!token) return null;

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(ref.id)}?fields=sheets.properties(sheetId,title)`;
  const metaResp = await fetchWithTimeout(metaUrl, { headers }, 20000);
  const meta = await metaResp.json().catch(() => ({}));
  if (!metaResp.ok) throw new Error(`google_sheet_metadata_error:${metaResp.status}`);

  const sheets = Array.isArray(meta.sheets) ? meta.sheets : [];
  const wantedGid = Number(ref.gid || 0);
  const selected = sheets.find(s => Number(s?.properties?.sheetId) === wantedGid) || sheets[0];
  const title = clean(selected?.properties?.title || '', 500);
  if (!title) throw new Error('google_sheet_tab_not_found');

  const range = `'${title.replace(/'/g, "''")}'!A:Z`;
  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(ref.id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const valuesResp = await fetchWithTimeout(valuesUrl, { headers }, 25000);
  const valuesJson = await valuesResp.json().catch(() => ({}));
  if (!valuesResp.ok) throw new Error(`google_sheet_values_error:${valuesResp.status}`);
  return Array.isArray(valuesJson.values) ? valuesJson.values : [];
}

function parseCsv(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

async function fetchSourceMatrix(sourceUrl) {
  try {
    const privateRows = await fetchGoogleSheetPrivate(sourceUrl);
    if (privateRows) return privateRows;
  } catch (e) {
    // Si la Service Account existe pero esta hoja no fue compartida con ella,
    // todavía puede ser una hoja pública/publicada. Probamos el CSV como fallback.
    console.warn('[help] Google Service Account fallback a CSV:', e?.message || e);
  }

  const url = googlePublicCsvUrl(sourceUrl);
  const resp = await fetchWithTimeout(url, {
    headers: {
      Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.2',
      'User-Agent': 'Asisto-Help/1.0'
    },
    redirect: 'follow'
  }, 25000);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`help_source_http_${resp.status}`);
  const head = text.slice(0, 1000).toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype html') || head.includes('accounts.google.com')) {
    throw new Error('help_source_not_public_or_service_account_not_authorized');
  }
  return parseCsv(text);
}

function resolveColumns(headers = []) {
  const normalized = headers.map(normalizeHeader);
  const out = {};
  for (const [key, aliases] of Object.entries(EXPECTED_HEADERS)) {
    const aliasSet = new Set(aliases.map(normalizeHeader));
    out[key] = normalized.findIndex(h => aliasSet.has(h));
  }
  for (const required of ['title', 'vimeoId', 'appliesTo', 'versionFrom', 'versionTo', 'importance', 'tags', 'description']) {
    if (out[required] < 0) throw new Error(`help_source_missing_column:${required}`);
  }
  return out;
}

function tagsArray(raw) {
  const text = clean(raw, 5000);
  if (!text) return [];
  const angle = [...text.matchAll(/<([^<>]+)>/g)].map(m => clean(m[1], 300)).filter(Boolean);
  const values = angle.length ? angle : text.split(/[;,|\n]+/).map(v => clean(v, 300)).filter(Boolean);
  return [...new Set(values)];
}

function matrixToHelpRows(matrix = []) {
  const rows = Array.isArray(matrix) ? matrix : [];
  if (!rows.length) return [];
  const columns = resolveColumns(rows[0] || []);
  const out = [];

  for (let i = 1; i < rows.length; i++) {
    const r = Array.isArray(rows[i]) ? rows[i] : [];
    const item = {
      rowNumber: i + 1,
      title: clean(r[columns.title], 500),
      vimeoId: clean(r[columns.vimeoId], 120),
      appliesTo: clean(r[columns.appliesTo], 5000),
      versionFrom: clean(r[columns.versionFrom], 80),
      versionTo: clean(r[columns.versionTo], 80),
      importance: Number(r[columns.importance] || 0) || 0,
      tags: tagsArray(r[columns.tags]),
      description: clean(r[columns.description], 12000)
    };
    if (!item.title && !item.vimeoId && !item.appliesTo) continue;
    out.push(item);
  }
  return out;
}

function relevantSourceHash(rows = []) {
  // El cache de clasificación sólo debe invalidarse cuando cambia algo que
  // pueda modificar la pertenencia de una ventana. Título/descripcion/tags/importancia
  // se toman siempre de la hoja actual y no obligan a volver a gastar tokens.
  return sha256(JSON.stringify(rows.map(r => [
    r.vimeoId,
    r.appliesTo,
    r.versionFrom,
    r.versionTo
  ])));
}

async function loadHelpSource(cfg, { force = false } = {}) {
  const agent = normalizeAgent(cfg.agent);
  const cached = _sourceCache.get(agent);
  if (!force && cached && cached.sourceUrl === cfg.source_url && (Date.now() - cached.at) < cfg.source_cache_ms) {
    return cached;
  }
  const matrix = await fetchSourceMatrix(cfg.source_url);
  const rows = matrixToHelpRows(matrix);
  const value = {
    rows,
    hash: relevantSourceHash(rows),
    at: Date.now(),
    sourceUrl: cfg.source_url
  };
  _sourceCache.set(agent, value);
  return value;
}

function parseVersionParts(value) {
  const s = clean(value, 80);
  if (!s) return [];
  if (/^\d+$/.test(s)) return [Number(s)];
  const nums = s.match(/\d+/g);
  return nums ? nums.map(Number) : [];
}

function compareVersions(a, b) {
  const aa = parseVersionParts(a);
  const bb = parseVersionParts(b);
  if (!aa.length || !bb.length) return null;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const av = Number(aa[i] || 0);
    const bv = Number(bb[i] || 0);
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function versionApplies(version, from, to) {
  const v = clean(version, 80);
  if (!v) return false;
  if (from) {
    const cmp = compareVersions(v, from);
    if (cmp !== null && cmp < 0) return false;
  }
  if (to) {
    const cmp = compareVersions(v, to);
    if (cmp !== null && cmp > 0) return false;
  }
  return true;
}

function technicalWindowsFromRule(value) {
  const raw = clean(value, 5000);
  if (!raw) return null;
  const parts = raw.split(/[,;\n]+/).map(v => clean(v, 500)).filter(Boolean);
  if (!parts.length) return null;
  if (!parts.every(v => /^w_[a-z0-9_.$-]+$/i.test(v))) return null;
  return [...new Set(parts.map(normalizeWindow))];
}

function normalizeNaturalText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fallback determinístico para relaciones MUY evidentes en categorías generales.
// No reemplaza a la IA: suma coincidencias seguras y deja los casos ambiguos a Luna.
// Ejemplo: w_pro_abm_productos + "... ABM ... articulos ..." => aplica.
function obviousNaturalCategoryApplies(windowName, categoryText) {
  const win = normalizeNaturalText(windowName);
  const cat = normalizeNaturalText(categoryText);
  if (!win || !cat) return false;

  const isAbmWindow = /(^|_)abm(_|$)/.test(win);
  const categoryIsAbm = /\babm\b/.test(cat);

  // Si la categoría habla específicamente de ABM, la ventana también debe ser ABM.
  if (categoryIsAbm && !isAbmWindow) return false;

  const entityAliases = [
    {
      window: ['producto', 'productos', 'articulo', 'articulos'],
      category: ['producto', 'productos', 'articulo', 'articulos']
    },
    {
      window: ['acreedor', 'acreedores', 'proveedor', 'proveedores'],
      category: ['acreedor', 'acreedores', 'proveedor', 'proveedores']
    },
    {
      window: ['cliente', 'clientes'],
      category: ['cliente', 'clientes']
    }
  ];

  const winTokens = new Set(win.split(/[_\s]+/).filter(Boolean));
  const catTokens = new Set(cat.split(/[_\s]+/).filter(Boolean));

  for (const group of entityAliases) {
    const windowMatches = group.window.some(t => winTokens.has(t));
    const categoryMatches = group.category.some(t => catTokens.has(t));
    if (windowMatches && categoryMatches) return true;
  }

  // "entidades en general" se considera general sólo para ventanas ABM cuyo
  // nombre técnico evidencia una entidad conocida. Evitamos incluir cualquier ABM.
  if (
    isAbmWindow &&
    /\bentidad(?:es)?\b/.test(cat) &&
    entityAliases.some(group => group.window.some(t => winTokens.has(t)))
  ) {
    return true;
  }

  return false;
}

function sortVideos(rows = []) {
  return [...rows].sort((a, b) => {
    const imp = Number(b.importance || 0) - Number(a.importance || 0);
    if (imp) return imp;
    return String(a.title || '').localeCompare(String(b.title || ''), 'es');
  });
}

function outputVideo(row) {
  return {
    titulo: row.title,
    vimeo_id: row.vimeoId,
    importancia: Number(row.importance || 0),
    tags: Array.isArray(row.tags) ? row.tags : [],
    descripcion: row.description || ''
  };
}

async function ensureIndexes(db) {
  if (_indexesReady) return;
  try {
    await Promise.all([
      db.collection('help_category_cache').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'help_cache_expiry' }),
      db.collection('help_intelligent_query_cache').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'help_intelligent_query_cache_expiry' }),
      db.collection('help_query_log').createIndex({ createdAt: -1 }, { name: 'help_query_createdAt' }),
      db.collection('help_query_log').createIndex({ dominio: 1, createdAt: -1 }, { name: 'help_query_domain_createdAt' })
    ]);
    _indexesReady = true;
  } catch (e) {
    console.warn('[help] indexes:', e?.message || e);
  }
}

async function getOpenAiKey(domain) {
  const runtime = await getRuntimeByTenantId(domain).catch(() => null);
  return clean(runtime?.openaiApiKey || process.env.OPENAI_API_KEY || '', 5000);
}

function getOpenAiClient(apiKey) {
  const key = clean(apiKey, 5000);
  if (!key) return null;
  if (_openAiClients.has(key)) return _openAiClients.get(key);
  const client = new OpenAI({ apiKey: key });
  _openAiClients.set(key, client);
  return client;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

async function resolveNaturalCategories({ cfg, sourceHash, windowName, rows, domain, user }) {
  if (!rows.length) return { vimeoIds: [], aiUsed: false, cacheHit: false, usage: null };
  const db = await getDb();
  await ensureIndexes(db);

  const effectiveBehavior = `${cfg.behavior}\n\n${CATEGORY_MATCH_GUIDANCE}`.trim();
  const behaviorHash = sha256(effectiveBehavior);
  const cacheKey = sha256(JSON.stringify({
    agent: cfg.agent,
    window: normalizeWindow(windowName),
    sourceHash,
    model: cfg.model,
    behaviorHash
  }));

  const cached = await db.collection('help_category_cache').findOne({ _id: cacheKey, expiresAt: { $gt: new Date() } });
  if (cached && Array.isArray(cached.vimeoIds)) {
    return { vimeoIds: cached.vimeoIds.map(String), aiUsed: false, cacheHit: true, usage: null };
  }

  const apiKey = await getOpenAiKey(domain);
  if (!apiKey) throw new Error('openai_api_key_missing');
  const client = getOpenAiClient(apiKey);
  if (!client) throw new Error('openai_client_unavailable');

  const categories = rows.slice(0, 250).map(r => ({
    vimeo_id: String(r.vimeoId),
    categoria: String(r.appliesTo)
  }));
  const payloadText = JSON.stringify({ ventana: windowName, categorias });

  const request = {
    model: cfg.model,
    messages: [
      { role: 'system', content: effectiveBehavior },
      { role: 'user', content: payloadText }
    ],
    response_format: { type: 'json_object' },
    reasoning_effort: 'none',
    max_completion_tokens: 600
  };

  let response;
  try {
    response = await client.chat.completions.create(request);
  } catch (e) {
    // Compatibilidad con modelos/endpoints que todavía esperan max_tokens.
    const message = String(e?.message || e || '');
    if (/max_completion_tokens|unsupported parameter/i.test(message)) {
      delete request.max_completion_tokens;
      request.max_tokens = 600;
      response = await client.chat.completions.create(request);
    } else {
      throw e;
    }
  }

  const raw = response?.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(raw) || {};
  const allowed = new Set(rows.map(r => String(r.vimeoId)));
  const vimeoIds = [...new Set(
    (Array.isArray(parsed.vimeo_ids) ? parsed.vimeo_ids : [])
      .map(v => String(v || '').trim())
      .filter(v => allowed.has(v))
  )];

  const usage = parseTokenUsagePair(response?.usage || null, 'message');
  const traceId = `help:${cfg.agent}:${domain}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
  const conversationId = `${traceId}:${clean(user, 80).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'user'}`;
  await recordTokenUsage({
    tenantId: domain,
    kind: 'message',
    provider: 'openai',
    model: response?.model || cfg.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    conversationId,
    waId: user,
    channelType: 'help_api',
    usageTraceId: traceId,
    meta: {
      usageType: 'ayuda',
      agent: cfg.agent,
      window: windowName,
      user,
      sourceHash,
      categoryCandidates: rows.length
    }
  });

  const expiresAt = new Date(Date.now() + cfg.ai_cache_days * 24 * 60 * 60 * 1000);
  await db.collection('help_category_cache').updateOne(
    { _id: cacheKey },
    {
      $set: {
        agent: cfg.agent,
        window: normalizeWindow(windowName),
        sourceHash,
        model: response?.model || cfg.model,
        behaviorHash,
        vimeoIds,
        updatedAt: new Date(),
        expiresAt
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  ).catch(e => console.warn('[help] cache write:', e?.message || e));

  return { vimeoIds, aiUsed: true, cacheHit: false, usage };
}

function intelligentQueryTokens(value) {
  const normalized = normalizeNaturalText(value);
  const stop = new Set([
    'como','hago','hacer','para','por','que','qué','una','uno','unos','unas',
    'del','de','la','las','el','los','en','con','sin','sobre','quiero','puedo',
    'se','me','mi','un','y','o','a','al'
  ]);
  return [...new Set(
    normalized
      .split(/[_\s]+/)
      .map(v => v.trim())
      .filter(v => v.length >= 3 && !stop.has(v))
  )];
}

function intelligentQueryRowScore(query, row) {
  const tokens = intelligentQueryTokens(query);
  if (!tokens.length) return 0;

  const title = normalizeNaturalText(row?.title);
  const tags = normalizeNaturalText((row?.tags || []).join(' '));
  const description = normalizeNaturalText(row?.description);
  const appliesTo = normalizeNaturalText(row?.appliesTo);

  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 14;
    if (tags.includes(token)) score += 10;
    if (appliesTo.includes(token)) score += 7;
    if (description.includes(token)) score += 4;
  }

  const whole = normalizeNaturalText(query);
  if (whole && title.includes(whole)) score += 25;
  if (whole && tags.includes(whole)) score += 18;
  if (whole && description.includes(whole)) score += 8;

  score += Math.max(0, Number(row?.importance || 0)) * 0.25;
  return score;
}

function dedupeRowsByVimeo(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const id = String(row?.vimeoId || '').trim();
    if (!id) continue;
    const previous = map.get(id);
    if (!previous || Number(row?.importance || 0) > Number(previous?.importance || 0)) {
      map.set(id, row);
    }
  }
  return [...map.values()];
}

function compactQueryVideo(row) {
  return {
    vimeo_id: String(row?.vimeoId || ''),
    titulo: clean(row?.title, 500),
    importancia: Number(row?.importance || 0),
    tags: (Array.isArray(row?.tags) ? row.tags : []).slice(0, 15),
    ventana_aplica: clean(row?.appliesTo, 900),
    descripcion: clean(row?.description, 1200)
  };
}

async function buildIntelligentQueryCandidates({
  cfg,
  sourceHash,
  eligible,
  windowName,
  query,
  domain,
  user
}) {
  const wantedWindow = normalizeWindow(windowName);
  const exactRows = [];
  const naturalRows = [];

  if (wantedWindow) {
    for (const row of eligible) {
      const technical = technicalWindowsFromRule(row.appliesTo);
      if (technical) {
        if (technical.includes(wantedWindow)) exactRows.push(row);
      } else {
        naturalRows.push(row);
      }
    }
  }

  const obviousNaturalRows = wantedWindow
    ? naturalRows.filter(row => obviousNaturalCategoryApplies(windowName, row.appliesTo))
    : [];

  let naturalSelected = [...obviousNaturalRows];
  let categoryAiInfo = { aiUsed: false, cacheHit: false, usage: null };
  let categoryAiError = null;

  if (wantedWindow && naturalRows.length) {
    try {
      const resolved = await resolveNaturalCategories({
        cfg,
        sourceHash,
        windowName,
        rows: naturalRows,
        domain,
        user
      });
      categoryAiInfo = resolved;
      const ids = new Set([
        ...obviousNaturalRows.map(r => String(r.vimeoId)),
        ...resolved.vimeoIds.map(String)
      ]);
      naturalSelected = naturalRows.filter(r => ids.has(String(r.vimeoId)));
    } catch (e) {
      categoryAiError = e;
      console.warn(`[help] consulta: clasificación de ventana falló agent=${cfg.agent} domain=${domain} window=${windowName}:`, e?.message || e);
    }
  }

  const scored = eligible
    .map(row => ({ row, score: intelligentQueryRowScore(query, row) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.row.importance || 0) - Number(a.row.importance || 0))
    .map(x => x.row);

  const priority = dedupeRowsByVimeo([...exactRows, ...naturalSelected]);
  const fallbackImportant = sortVideos(eligible).slice(0, 12);
  const combined = dedupeRowsByVimeo([
    ...priority,
    ...scored.slice(0, 30),
    ...(scored.length < 8 ? fallbackImportant : [])
  ]);

  return {
    rows: combined.slice(0, 36),
    exactRows,
    naturalRows,
    naturalSelected,
    categoryAiInfo,
    categoryAiError
  };
}

async function resolveIntelligentHelpQuery({
  cfg,
  sourceHash,
  windowName,
  query,
  rows,
  domain,
  user
}) {
  const db = await getDb();
  await ensureIndexes(db);

  const effectiveBehavior = [
    cfg.behavior,
    CATEGORY_MATCH_GUIDANCE,
    QUERY_ANSWER_GUIDANCE
  ].filter(Boolean).join('\n\n').trim();

  const behaviorHash = sha256(effectiveBehavior);
  const candidateIds = rows.map(r => String(r.vimeoId || '')).filter(Boolean);
  const cacheKey = sha256(JSON.stringify({
    agent: cfg.agent,
    query: normalizeNaturalText(query),
    window: normalizeWindow(windowName),
    sourceHash,
    model: cfg.model,
    behaviorHash,
    candidateIds
  }));

  const cached = await db.collection('help_intelligent_query_cache').findOne({
    _id: cacheKey,
    expiresAt: { $gt: new Date() }
  });

  if (cached) {
    return {
      found: cached.found === true,
      answerText: String(cached.answerText || ''),
      vimeoIds: Array.isArray(cached.vimeoIds) ? cached.vimeoIds.map(String) : [],
      aiUsed: false,
      cacheHit: true,
      usage: null
    };
  }

  if (!rows.length) {
    return {
      found: false,
      answerText: 'No encontré información suficiente en la ayuda disponible para responder esa consulta.',
      vimeoIds: [],
      aiUsed: false,
      cacheHit: false,
      usage: null
    };
  }

  const apiKey = await getOpenAiKey(domain);
  if (!apiKey) throw new Error('openai_api_key_missing');
  const client = getOpenAiClient(apiKey);
  if (!client) throw new Error('openai_client_unavailable');

  const payloadText = JSON.stringify({
    consulta: query,
    ventana: windowName || '',
    videos: rows.map(compactQueryVideo)
  });

  const request = {
    model: cfg.model,
    messages: [
      { role: 'system', content: effectiveBehavior },
      { role: 'user', content: payloadText }
    ],
    response_format: { type: 'json_object' },
    reasoning_effort: 'none',
    max_completion_tokens: 900
  };

  let response;
  try {
    response = await client.chat.completions.create(request);
  } catch (e) {
    const message = String(e?.message || e || '');
    if (/max_completion_tokens|unsupported parameter/i.test(message)) {
      delete request.max_completion_tokens;
      request.max_tokens = 900;
      response = await client.chat.completions.create(request);
    } else {
      throw e;
    }
  }

  const raw = response?.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(raw) || {};
  const allowed = new Set(rows.map(r => String(r.vimeoId)));
  const vimeoIds = [...new Set(
    (Array.isArray(parsed.vimeo_ids) ? parsed.vimeo_ids : [])
      .map(v => String(v || '').trim())
      .filter(v => allowed.has(v))
  )];

  const answerText = clean(
    parsed.respuesta_texto ?? parsed.respuesta ?? parsed.answer ?? '',
    12000
  );
  const found = parsed.encontrado === true ||
    ['1','true','yes','si','sí'].includes(String(parsed.encontrado || '').trim().toLowerCase());

  const usage = parseTokenUsagePair(response?.usage || null, 'message');
  const traceId = `help-query:${cfg.agent}:${domain}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
  const conversationId = `${traceId}:${clean(user, 80).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'user'}`;

  await recordTokenUsage({
    tenantId: domain,
    kind: 'message',
    provider: 'openai',
    model: response?.model || cfg.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    conversationId,
    waId: user,
    channelType: 'help_api',
    usageTraceId: traceId,
    meta: {
      usageType: 'ayuda_consulta',
      agent: cfg.agent,
      window: windowName || '',
      query,
      user,
      sourceHash,
      candidates: rows.length
    }
  });

  const expiresAt = new Date(Date.now() + cfg.ai_cache_days * 24 * 60 * 60 * 1000);
  await db.collection('help_intelligent_query_cache').updateOne(
    { _id: cacheKey },
    {
      $set: {
        agent: cfg.agent,
        query: normalizeNaturalText(query),
        window: normalizeWindow(windowName),
        sourceHash,
        model: response?.model || cfg.model,
        behaviorHash,
        candidateIds,
        found,
        answerText,
        vimeoIds,
        updatedAt: new Date(),
        expiresAt
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  ).catch(e => console.warn('[help] intelligent query cache write:', e?.message || e));

  return {
    found,
    answerText,
    vimeoIds,
    aiUsed: true,
    cacheHit: false,
    usage
  };
}

function asistoDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ASISTO_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    fecha: `${map.year}-${map.month}-${map.day}`,
    fechaHora: `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`,
    zonaHoraria: ASISTO_TZ
  };
}

function requestField(req, ...names) {
  const wanted = new Set(names.map(n => String(n || '').trim().toLowerCase()).filter(Boolean));
  for (const source of [req.body, req.query]) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (!wanted.has(String(key || '').trim().toLowerCase())) continue;
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
  }
  return '';
}

async function handleHelpQuery(req, res) {
  const started = Date.now();
  const now = new Date();
  const dateInfo = asistoDateParts(now);

  const agent = normalizeAgent(requestField(req, 'agente', 'agent') || DEFAULT_AGENT);
  const windowName = clean(requestField(req, 'ventana', 'window'), 300);
  const query = clean(requestField(req, 'consulta', 'query', 'pregunta'), 4000);
  const version = clean(requestField(req, 'version', 'versión'), 80);
  const domain = clean(requestField(req, 'dominio', 'domain', 'tenant', 'tenantId'), 120).toUpperCase();
  const user = clean(requestField(req, 'usuario', 'user', 'username'), 200);

  // Sin consulta se mantiene el contrato histórico: ventana obligatoria.
  // Con consulta, ventana es opcional y actúa como contexto prioritario.
  if (!query && !windowName) return res.status(400).json({ ok: false, error: 'ventana_required' });
  if (!version) return res.status(400).json({ ok: false, error: 'version_required' });
  if (!domain) return res.status(400).json({ ok: false, error: 'dominio_required' });
  if (!user) return res.status(400).json({ ok: false, error: 'usuario_required' });

  let cfg;
  let source;
  let aiInfo = { aiUsed: false, cacheHit: false, usage: null };
  try {
    cfg = await loadHelpConfig(agent);
    if (cfg.enabled === false) {
      return res.json({
        ok: true,
        ...dateInfo,
        agente: agent,
        ventana: windowName || '',
        ...(query ? { consulta: query } : {}),
        version,
        dominio: domain,
        usuario: user,
        respuesta: 'N',
        videos: []
      });
    }

    source = await loadHelpSource(cfg);
    const eligible = source.rows.filter(r =>
      r.vimeoId && r.appliesTo && versionApplies(version, r.versionFrom, r.versionTo)
    );

    // ===================== MODO CONSULTA INTELIGENTE =====================
    // Si consulta viene vacía, este bloque no se ejecuta y el modo anterior
    // continúa funcionando sin cambios.
    if (query) {
      const candidateInfo = await buildIntelligentQueryCandidates({
        cfg,
        sourceHash: source.hash,
        eligible,
        windowName,
        query,
        domain,
        user
      });

      const intelligent = await resolveIntelligentHelpQuery({
        cfg,
        sourceHash: source.hash,
        windowName,
        query,
        rows: candidateInfo.rows,
        domain,
        user
      });

      const selectedIds = new Set(intelligent.vimeoIds.map(String));
      const selectedRows = candidateInfo.rows.filter(r => selectedIds.has(String(r.vimeoId)));
      const videos = sortVideos(selectedRows).slice(0, cfg.max_videos).map(outputVideo);

      const responseBody = {
        ok: true,
        ...dateInfo,
        agente: agent,
        ventana: windowName || '',
        consulta: query,
        version,
        dominio: domain,
        usuario: user,
        respuesta: intelligent.found ? 'S' : 'N',
        respuesta_texto: intelligent.answerText || (
          intelligent.found
            ? 'Encontré información relacionada con tu consulta.'
            : 'No encontré información suficiente en la ayuda disponible para responder esa consulta.'
        ),
        videos
      };

      if (candidateInfo.categoryAiError) {
        responseBody.clasificacion_ventana_parcial = true;
        responseBody.clasificacion_ventana_error = String(
          candidateInfo.categoryAiError?.message || candidateInfo.categoryAiError || 'error_ia'
        ).slice(0, 240);
      }

      const db = await getDb();
      await ensureIndexes(db);
      await db.collection('help_query_log').insertOne({
        createdAt: now,
        fechaAsisto: dateInfo.fecha,
        agente: agent,
        ventana: windowName || '',
        consulta: query,
        version,
        dominio: domain,
        usuario: user,
        respuesta: responseBody.respuesta,
        respuestaTexto: responseBody.respuesta_texto,
        videoIds: videos.map(v => v.vimeo_id),
        mode: 'intelligent_query',
        candidates: candidateInfo.rows.length,
        exactMatches: candidateInfo.exactRows.length,
        naturalCandidates: candidateInfo.naturalRows.length,
        naturalSelectedForWindow: candidateInfo.naturalSelected.length,
        categoryAiUsed: candidateInfo.categoryAiInfo.aiUsed === true,
        categoryAiCacheHit: candidateInfo.categoryAiInfo.cacheHit === true,
        answerAiUsed: intelligent.aiUsed === true,
        answerAiCacheHit: intelligent.cacheHit === true,
        sourceHash: source.hash,
        durationMs: Date.now() - started
      }).catch(e => console.warn('[help] intelligent query log:', e?.message || e));

      res.set('Cache-Control', 'no-store');
      return res.json(responseBody);
    }

    const wantedWindow = normalizeWindow(windowName);
    const exactRows = [];
    const naturalRows = [];
    for (const row of eligible) {
      const technical = technicalWindowsFromRule(row.appliesTo);
      if (technical) {
        if (technical.includes(wantedWindow)) exactRows.push(row);
      } else {
        naturalRows.push(row);
      }
    }

    // Coincidencias naturales obvias que podemos resolver sin IA.
    // Se UNEN a lo que determine Luna; nunca sustituyen la clasificación IA.
    const obviousNaturalRows = naturalRows.filter(row =>
      obviousNaturalCategoryApplies(windowName, row.appliesTo)
    );
    const obviousNaturalIds = obviousNaturalRows.map(row => String(row.vimeoId));

    let naturalIds = [...obviousNaturalIds];
    let aiError = null;
    if (naturalRows.length) {
      try {
        const resolved = await resolveNaturalCategories({
          cfg,
          sourceHash: source.hash,
          windowName,
          rows: naturalRows,
          domain,
          user
        });
        naturalIds = [...new Set([
          ...obviousNaturalIds,
          ...resolved.vimeoIds.map(String)
        ])];
        aiInfo = resolved;
      } catch (e) {
        aiError = e;
        console.warn(`[help] categoria IA agent=${agent} domain=${domain} window=${windowName}:`, e?.message || e);
        if (!exactRows.length) throw e;
      }
    }

    const selectedIds = new Set(naturalIds.map(String));
    const naturalSelected = naturalRows.filter(r => selectedIds.has(String(r.vimeoId)));
    const dedupe = new Map();
    for (const row of [...exactRows, ...naturalSelected]) {
      const key = String(row.vimeoId || '').trim();
      if (!key) continue;
      const previous = dedupe.get(key);
      if (!previous || Number(row.importance || 0) > Number(previous.importance || 0)) dedupe.set(key, row);
    }

    const selected = sortVideos([...dedupe.values()]).slice(0, cfg.max_videos);
    const videos = selected.map(outputVideo);
    const responseBody = {
      ok: true,
      ...dateInfo,
      agente: agent,
      ventana: windowName,
      version,
      dominio: domain,
      usuario: user,
      respuesta: videos.length ? 'S' : 'N',
      videos
    };
    if (aiError && (exactRows.length || obviousNaturalRows.length)) {
      responseBody.parcial = true;
      responseBody.ia_error = String(aiError?.message || aiError || 'error_ia').slice(0, 240);
    }

    const db = await getDb();
    await ensureIndexes(db);
    await db.collection('help_query_log').insertOne({
      createdAt: now,
      fechaAsisto: dateInfo.fecha,
      agente: agent,
      ventana: windowName,
      version,
      dominio: domain,
      usuario: user,
      respuesta: responseBody.respuesta,
      videoIds: videos.map(v => v.vimeo_id),
      exactMatches: exactRows.length,
      naturalDeterministicMatches: obviousNaturalRows.length,
      aiUsed: aiInfo.aiUsed === true,
      aiCacheHit: aiInfo.cacheHit === true,
      sourceHash: source.hash,
      durationMs: Date.now() - started
    }).catch(e => console.warn('[help] query log:', e?.message || e));

    res.set('Cache-Control', 'no-store');
    return res.json(responseBody);
  } catch (e) {
    const message = String(e?.message || e || 'internal');
    console.error(`[help] query error agent=${agent} domain=${domain} window=${windowName}:`, message);
    const status = /required|invalid/.test(message) ? 400
      : /openai_api_key_missing/.test(message) ? 503
      : /source_|google_sheet|google_service_account/.test(message) ? 502
      : 500;
    return res.status(status).json({
      ok: false,
      ...dateInfo,
      agente: agent,
      ventana: windowName || null,
      ...(query ? { consulta: query } : {}),
      version: version || null,
      dominio: domain || null,
      usuario: user || null,
      error: message.slice(0, 240)
    });
  }
}

function mountHelpTool(app) {
  if (!app) throw new Error('app_required');
  const json = express.json({ limit: '128kb' });

  // Alias inglés y español para facilitar integración con Manager.
  app.get('/api/ext/help', requireHelpExternalAccess, handleHelpQuery);
  app.post('/api/ext/help', json, requireHelpExternalAccess, handleHelpQuery);
  app.get('/api/ext/ayuda', requireHelpExternalAccess, handleHelpQuery);
  app.post('/api/ext/ayuda', json, requireHelpExternalAccess, handleHelpQuery);

  // Endpoint corto de estado para verificar que la herramienta esté configurada.
  app.get('/api/ext/help/status', requireHelpExternalAccess, async (req, res) => {
    try {
      const agent = normalizeAgent(requestField(req, 'agente', 'agent') || DEFAULT_AGENT);
      const cfg = await loadHelpConfig(agent);
      return res.json({
        ok: true,
        agente: agent,
        enabled: cfg.enabled !== false,
        source_configured: !!cfg.source_url,
        model: cfg.model,
        google_service_account: !!clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '', 500)
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e || 'internal') });
    }
  });
}

module.exports = {
  DEFAULT_AGENT,
  DEFAULT_SOURCE_URL,
  DEFAULT_MODEL,
  DEFAULT_BEHAVIOR,
  loadHelpConfig,
  saveHelpConfig,
  invalidateHelpConfigCache,
  publicHelpConfig,
  mountHelpTool,
  // Exportados para pruebas unitarias/smoke tests.
  parseCsv,
  matrixToHelpRows,
  versionApplies,
  technicalWindowsFromRule,
  obviousNaturalCategoryApplies,
  intelligentQueryRowScore,
  buildIntelligentQueryCandidates,
  resolveIntelligentHelpQuery,
  googlePublicCsvUrl
};
