// Asisto | Version: 5.00.020 | Fecha: 2026-09-03
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

// Chat web embebible. La API key nunca se envía al navegador.
const HELP_WEB_SIGNING_SECRET = String(process.env.HELP_WEB_SIGNING_SECRET || HELP_API_KEY || '').trim();
const HELP_WEB_TOKEN_TTL_MS = Math.max(300000, Math.min(86400000, Number(process.env.HELP_WEB_TOKEN_TTL_MS || 43200000) || 43200000));
const HELP_WEB_RATE_WINDOW_MS = Math.max(60000, Math.min(3600000, Number(process.env.HELP_WEB_RATE_WINDOW_MS || 600000) || 600000));
const HELP_WEB_RATE_MAX = Math.max(5, Math.min(500, Number(process.env.HELP_WEB_RATE_MAX || 60) || 60));
const _helpWebRate = new Map();

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
- Usá la transcripción como fuente principal para dar instrucciones concretas y suficientemente detalladas; no respondas con un resumen genérico si allí figuran pasos, opciones o diferencias relevantes.
- Si una consulta general abarca variantes de la misma operación (por ejemplo, factura de venta de contado y en cuenta corriente), explicá las variantes y seleccioná todos los videos pertinentes. Omití una variante solamente cuando el usuario haya especificado claramente cuál necesita.
- Cuando existan pasos respaldados por la información disponible, presentalos en el orden operativo y mencioná las diferencias importantes entre alternativas.
- No inventes pasos, botones, menús, funciones ni datos que no estén respaldados por título, tags, descripción, transcripción o ventana/categoría.
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
  cover: ['caratula', 'carátula'],
  vimeoId: ['id vimeo', 'id_vimeo', 'vimeo id', 'vimeo_id'],
  appliesTo: ['ventana que aplica', 'ventana_que_aplica', 'ventana aplica'],
  versionFrom: ['version desde', 'versión desde', 'version_desde'],
  versionTo: ['version hasta', 'versión hasta', 'version_hasta'],
  importance: ['importancia'],
  tags: ['tags', 'tag'],
  description: ['descripcion', 'descripción'],
  transcription: ['transcripcion', 'transcripción']
};

const _configCache = new Map();
const _sourceCache = new Map();
const _helpDomainConfigCache = new Map();
const _helpAgentOwnerCache = new Map();
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

function normalizeHelpDomain(value) {
  return clean(value, 120).toUpperCase();
}

function helpDomainConfigFromDoc(doc = {}, fallbackDomain = '') {
  const nested = doc?.configuracion && typeof doc.configuracion === 'object'
    ? doc.configuracion
    : {};

  const rawEnabled =
    nested.help_enabled ??
    nested.ayuda_enabled ??
    nested.ayudaManagerEnabled ??
    doc.help_enabled ??
    doc.ayuda_enabled ??
    doc.ayudaManagerEnabled;

  const rawAgent =
    nested.help_agent ??
    nested.helpAgent ??
    nested.agente_ayuda ??
    nested.agenteAyuda ??
    doc.help_agent ??
    doc.helpAgent ??
    doc.agente_ayuda ??
    doc.agenteAyuda;

  const agentExplicit = !!clean(rawAgent, 80);
  return {
    domain: normalizeHelpDomain(
      doc?.tenantId ||
      doc?.tenantid ||
      doc?._id ||
      fallbackDomain
    ),
    enabled: rawEnabled === undefined ? false : boolValue(rawEnabled, false),
    agent: normalizeAgent(rawAgent || DEFAULT_AGENT),
    agentExplicit
  };
}

async function loadHelpDomainConfig(domain, { force = false } = {}) {
  const safeDomain = normalizeHelpDomain(domain);
  if (!safeDomain) {
    return { domain: '', enabled: false, agent: DEFAULT_AGENT, agentExplicit: false };
  }

  const cached = _helpDomainConfigCache.get(safeDomain);
  if (!force && cached && (Date.now() - cached.at) < 5 * 60 * 1000) {
    return cached.value;
  }

  const db = await getDb();
  const doc = await db.collection('tenant_config').findOne({
    $or: [
      { _id: safeDomain },
      { tenantId: safeDomain },
      { tenantid: safeDomain }
    ]
  }) || {};

  const value = helpDomainConfigFromDoc(doc, safeDomain);
  _helpDomainConfigCache.set(safeDomain, { value, at: Date.now() });
  return value;
}

async function loadHelpDomainEnabled(domain, { force = false } = {}) {
  const cfg = await loadHelpDomainConfig(domain, { force });
  return cfg.enabled === true;
}

// Busca el dominio ASISTO propietario de un agente.
// El campo "dominio" recibido por el API puede ser un cliente/instalación externa
// (ej. CLIENTE_001) y NO se usa para facturación ni para habilitar Ayuda.
async function resolveHelpDomainByAgent(agent = DEFAULT_AGENT, { force = false } = {}) {
  const safeAgent = normalizeAgent(agent);
  const cached = _helpAgentOwnerCache.get(safeAgent);
  if (!force && cached && (Date.now() - cached.at) < 5 * 60 * 1000) {
    return cached.value;
  }

  const db = await getDb();
  const docs = await db.collection('tenant_config').find(
    {
      $or: [
        { help_enabled: { $exists: true } },
        { ayuda_enabled: { $exists: true } },
        { ayudaManagerEnabled: { $exists: true } },
        { help_agent: { $exists: true } },
        { helpAgent: { $exists: true } },
        { 'configuracion.help_enabled': { $exists: true } },
        { 'configuracion.ayuda_enabled': { $exists: true } },
        { 'configuracion.ayudaManagerEnabled': { $exists: true } },
        { 'configuracion.help_agent': { $exists: true } },
        { 'configuracion.helpAgent': { $exists: true } }
      ]
    },
    {
      projection: {
        _id: 1,
        tenantId: 1,
        tenantid: 1,
        help_enabled: 1,
        ayuda_enabled: 1,
        ayudaManagerEnabled: 1,
        help_agent: 1,
        helpAgent: 1,
        agente_ayuda: 1,
        agenteAyuda: 1,
        configuracion: 1
      }
    }
  ).toArray();

  const configs = docs
    .map(doc => helpDomainConfigFromDoc(doc))
    .filter(cfg => cfg.domain && cfg.enabled === true);

  // Primero mandan las asociaciones explícitas agente -> dominio.
  const exact = configs.filter(cfg => cfg.agentExplicit && cfg.agent === safeAgent);
  if (exact.length > 1) {
    throw new Error(`help_agent_multiple_domains:${safeAgent}`);
  }
  if (exact.length === 1) {
    const value = { ...exact[0], legacy: false };
    _helpAgentOwnerCache.set(safeAgent, { value, at: Date.now() });
    return value;
  }

  // Compatibilidad con la versión anterior: help_enabled podía existir sin
  // help_agent. Si hay UN solo dominio habilitado así, lo tomamos como dueño
  // del agente solicitado y evitamos obligar a guardar nuevamente la pantalla.
  const legacy = configs.filter(cfg => !cfg.agentExplicit);
  if (legacy.length > 1) {
    throw new Error(`help_agent_domain_ambiguous:${safeAgent}`);
  }
  if (legacy.length === 1) {
    const value = { ...legacy[0], agent: safeAgent, legacy: true };
    _helpAgentOwnerCache.set(safeAgent, { value, at: Date.now() });
    return value;
  }

  _helpAgentOwnerCache.set(safeAgent, { value: null, at: Date.now() });
  return null;
}

async function saveHelpDomainEnabled(domain, enabled, agent = DEFAULT_AGENT) {
  const safeDomain = normalizeHelpDomain(domain);
  const safeAgent = normalizeAgent(agent);
  if (!safeDomain) throw new Error('help_domain_required');

  const db = await getDb();

  // Un agente habilitado pertenece a un único dominio Asisto. Esto evita
  // ambigüedad en facturación y Control de Tokens.
  if (boolValue(enabled, false)) {
    const docs = await db.collection('tenant_config').find(
      {
        $or: [
          { help_agent: safeAgent },
          { helpAgent: safeAgent },
          { 'configuracion.help_agent': safeAgent },
          { 'configuracion.helpAgent': safeAgent }
        ]
      },
      {
        projection: {
          _id: 1,
          tenantId: 1,
          tenantid: 1,
          help_enabled: 1,
          ayuda_enabled: 1,
          ayudaManagerEnabled: 1,
          help_agent: 1,
          helpAgent: 1,
          configuracion: 1
        }
      }
    ).toArray();

    const conflict = docs
      .map(doc => helpDomainConfigFromDoc(doc))
      .find(cfg =>
        cfg.domain &&
        cfg.domain !== safeDomain &&
        cfg.enabled === true &&
        cfg.agentExplicit &&
        cfg.agent === safeAgent
      );

    if (conflict) {
      throw new Error(`help_agent_already_assigned:${safeAgent}:${conflict.domain}`);
    }
  }

  const existing = await db.collection('tenant_config').findOne({
    $or: [
      { _id: safeDomain },
      { tenantId: safeDomain },
      { tenantid: safeDomain }
    ]
  });

  const filter = existing?._id
    ? { _id: existing._id }
    : { _id: safeDomain };

  const setDoc = {
    help_enabled: boolValue(enabled, false),
    help_agent: safeAgent,
    updatedAt: new Date()
  };
  if (!existing) setDoc.tenantId = safeDomain;

  await db.collection('tenant_config').updateOne(
    filter,
    {
      $set: setDoc,
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );

  _helpDomainConfigCache.delete(safeDomain);
  _helpAgentOwnerCache.clear();
  return loadHelpDomainConfig(safeDomain, { force: true });
}

function invalidateHelpDomainEnabledCache(domain = '') {
  const safeDomain = normalizeHelpDomain(domain);
  if (safeDomain) _helpDomainConfigCache.delete(safeDomain);
  else _helpDomainConfigCache.clear();
  _helpAgentOwnerCache.clear();
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
      cover: clean(r[columns.cover], 5000),
      vimeoId: clean(r[columns.vimeoId], 120),
      appliesTo: clean(r[columns.appliesTo], 5000),
      versionFrom: clean(r[columns.versionFrom], 80),
      versionTo: clean(r[columns.versionTo], 80),
      importance: Number(r[columns.importance] || 0) || 0,
      tags: tagsArray(r[columns.tags]),
      description: clean(r[columns.description], 12000),
      transcription: clean(r[columns.transcription], 50000)
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
    // Importancia: 1 = más importante, 5 = menos importante.
    // Los valores 0/vacíos quedan al final.
    const ai = Number(a.importance || 0);
    const bi = Number(b.importance || 0);
    const av = ai > 0 ? ai : Number.MAX_SAFE_INTEGER;
    const bv = bi > 0 ? bi : Number.MAX_SAFE_INTEGER;
    const imp = av - bv;
    if (imp) return imp;
    return String(a.title || '').localeCompare(String(b.title || ''), 'es');
  });
}

function outputVideo(row) {
  return {
    vimeo_id: row.vimeoId,
    titulo: row.title,
    caratula: row.cover || '',
    importancia: Number(row.importance || 0),
    descripcion: row.description || ''
  };
}

// Respuesta pública compacta del API.
// Internamente se conservan todos los datos para logs, cache y Control de Tokens.
function compactHelpApiResponse({ dateInfo, responseBody, intelligent = false } = {}) {
  const vimeo_ids = Array.isArray(responseBody?.videos)
    ? [...responseBody.videos].sort((a, b) => {
        // Importancia: 1 = más importante, 5 = menos importante.
        // Los valores 0/vacíos quedan al final.
        const ai = Number(a?.importancia || 0);
        const bi = Number(b?.importancia || 0);
        const av = ai > 0 ? ai : Number.MAX_SAFE_INTEGER;
        const bv = bi > 0 ? bi : Number.MAX_SAFE_INTEGER;
        const imp = av - bv;
        if (imp) return imp;
        return String(a?.titulo || '').localeCompare(String(b?.titulo || ''), 'es');
      })
    : [];

  return {
    respuesta: intelligent
      ? String(responseBody?.respuesta_texto || '')
      : String(responseBody?.respuesta || ''),
    fecha: String(dateInfo?.fechaHora || dateInfo?.fecha || ''),
    vimeo_ids
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

async function resolveNaturalCategories({ cfg, sourceHash, windowName, rows, domain, user, usageContext = null }) {
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
  const traceId = usageContext?.traceId ||
    `help:${cfg.agent}:${domain}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
  const conversationId = usageContext?.conversationId ||
    `${traceId}:${clean(user, 80).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'user'}`;
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
      requestDomain: usageContext?.requestDomain || '',
      window: windowName,
      user,
      sourceHash,
      categoryCandidates: rows.length,
      requestId: usageContext?.requestId || null
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
  const transcription = normalizeNaturalText(row?.transcription);
  const appliesTo = normalizeNaturalText(row?.appliesTo);

  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 14;
    if (tags.includes(token)) score += 10;
    if (appliesTo.includes(token)) score += 7;
    if (description.includes(token)) score += 4;
    if (transcription.includes(token)) score += 5;
  }

  const whole = normalizeNaturalText(query);
  if (whole && title.includes(whole)) score += 25;
  if (whole && tags.includes(whole)) score += 18;
  if (whole && description.includes(whole)) score += 8;
  if (whole && transcription.includes(whole)) score += 10;

  const importance = Number(row?.importance || 0);
  if (importance > 0) {
    // 1 recibe mayor bonus que 5.
    score += Math.max(0, 6 - importance) * 0.25;
  }
  return score;
}

function queryCoverageVideoIds(query, rows = [], maxVideos = 12) {
  const scored = (rows || [])
    .map(row => ({ row, score: intelligentQueryRowScore(query, row) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];

  // Conserva variantes con una relevancia cercana a la mejor coincidencia. Así
  // una consulta general no pierde un segundo flujo igualmente pertinente.
  const threshold = Math.max(10, scored[0].score * 0.72);
  return scored
    .filter(item => item.score >= threshold)
    .slice(0, Math.max(1, maxVideos))
    .map(item => String(item.row?.vimeoId || ''))
    .filter(Boolean);
}

function dedupeRowsByVimeo(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const id = String(row?.vimeoId || '').trim();
    if (!id) continue;
    const previous = map.get(id);
    const currentImportance = Number(row?.importance || 0);
    const previousImportance = Number(previous?.importance || 0);
    if (
      !previous ||
      (currentImportance > 0 && (previousImportance <= 0 || currentImportance < previousImportance))
    ) {
      map.set(id, row);
    }
  }
  return [...map.values()];
}

function compactQueryVideo(row, transcriptionMax = 0) {
  const transcription = transcriptionMax > 0
    ? clean(row?.transcription, transcriptionMax)
    : '';
  return {
    vimeo_id: String(row?.vimeoId || ''),
    titulo: clean(row?.title, 500),
    importancia: Number(row?.importance || 0),
    tags: (Array.isArray(row?.tags) ? row.tags : []).slice(0, 15),
    ventana_aplica: clean(row?.appliesTo, 900),
    descripcion: clean(row?.description, 1200),
    transcripcion: transcription
  };
}

function compactQueryVideos(rows = []) {
  // Las transcripciones pueden ser extensas. Conservamos contexto suficiente por
  // video y un presupuesto total para evitar prompts desmedidos cuando hay muchos
  // candidatos.
  let remaining = 90000;
  return (rows || []).map(row => {
    const max = Math.max(0, Math.min(12000, remaining));
    const video = compactQueryVideo(row, max);
    remaining = Math.max(0, remaining - video.transcripcion.length);
    return video;
  });
}

async function buildIntelligentQueryCandidates({
  cfg,
  sourceHash,
  eligible,
  windowName,
  query,
  domain,
  user,
  usageContext = null
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
        user,
        usageContext
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
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ai = Number(a.row.importance || 0);
      const bi = Number(b.row.importance || 0);
      const av = ai > 0 ? ai : Number.MAX_SAFE_INTEGER;
      const bv = bi > 0 ? bi : Number.MAX_SAFE_INTEGER;
      return av - bv;
    })
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
  user,
  usageContext = null
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
    candidateIds,
    candidateContentHash: sha256(JSON.stringify(rows.map(r => [
      r.vimeoId,
      r.title,
      r.tags,
      r.appliesTo,
      r.description,
      r.transcription
    ])))
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
    videos: compactQueryVideos(rows)
  });

  const request = {
    model: cfg.model,
    messages: [
      { role: 'system', content: effectiveBehavior },
      { role: 'user', content: payloadText }
    ],
    response_format: { type: 'json_object' },
    reasoning_effort: 'none',
    max_completion_tokens: 1500
  };

  let response;
  try {
    response = await client.chat.completions.create(request);
  } catch (e) {
    const message = String(e?.message || e || '');
    if (/max_completion_tokens|unsupported parameter/i.test(message)) {
      delete request.max_completion_tokens;
      request.max_tokens = 1500;
      response = await client.chat.completions.create(request);
    } else {
      throw e;
    }
  }

  const raw = response?.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(raw) || {};
  const allowed = new Set(rows.map(r => String(r.vimeoId)));
  const selectedVimeoIds = [...new Set(
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
  const coverageIds = found
    ? queryCoverageVideoIds(query, rows, Math.min(12, Math.max(1, Number(cfg.max_videos || 12))))
    : [];
  const vimeoIds = [...new Set([...selectedVimeoIds, ...coverageIds])]
    .filter(v => allowed.has(v));

  const usage = parseTokenUsagePair(response?.usage || null, 'message');
  const traceId = usageContext?.traceId ||
    `help-query:${cfg.agent}:${domain}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
  const conversationId = usageContext?.conversationId ||
    `${traceId}:${clean(user, 80).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'user'}`;

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
      requestDomain: usageContext?.requestDomain || '',
      window: windowName || '',
      query,
      user,
      sourceHash,
      candidates: rows.length,
      requestId: usageContext?.requestId || null
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

function buildHelpApiUsageContext({ agent, domain, requestDomain, user, windowName, query } = {}) {
  const requestId = `help-api:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
  const traceId = `${requestId}:${normalizeAgent(agent || DEFAULT_AGENT)}:${clean(domain, 120) || 'DOMAIN'}`;
  const safeUser = clean(user, 80).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'user';
  return {
    requestId,
    traceId,
    conversationId: `${traceId}:${safeUser}`,
    agent: normalizeAgent(agent || DEFAULT_AGENT),
    // domain = dominio ASISTO propietario del agente (facturación/tokens/OpenAI)
    domain: clean(domain, 120).toUpperCase(),
    // requestDomain = dominio informado por Manager/cliente (auditoría)
    requestDomain: clean(requestDomain, 120).toUpperCase(),
    user: clean(user, 200),
    windowName: clean(windowName, 300),
    query: clean(query, 4000)
  };
}

async function recordHelpApiRequestEvent({
  usageContext,
  version,
  result = '',
  videoCount = 0,
  aiUsed = false,
  aiCacheHit = false,
  error = ''
} = {}) {
  try {
    const ctx = usageContext || {};
    if (!ctx.domain) return null;

    return await recordTokenUsage({
      tenantId: ctx.domain,
      kind: 'help_request',
      provider: 'asisto',
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      conversationId: ctx.conversationId,
      waId: ctx.user,
      channelType: 'help_api',
      usageTraceId: ctx.traceId,
      meta: {
        usageType: 'ayuda_request',
        requestId: ctx.requestId,
        agent: ctx.agent,
        requestDomain: ctx.requestDomain || '',
        window: ctx.windowName || '',
        query: ctx.query || '',
        version: clean(version, 80),
        user: ctx.user,
        result: clean(result, 40),
        videoCount: Math.max(0, Number(videoCount || 0)),
        aiUsed: aiUsed === true,
        aiCacheHit: aiCacheHit === true,
        error: clean(error, 500)
      }
    });
  } catch (e) {
    console.warn('[help] no se pudo registrar consulta API en control de tokens:', e?.message || e);
    return null;
  }
}

async function handleHelpQuery(req, res) {
  const started = Date.now();
  const now = new Date();
  const dateInfo = asistoDateParts(now);

  const agent = normalizeAgent(requestField(req, 'agente', 'agent') || DEFAULT_AGENT);
  
  const windowName = clean(requestField(req, 'ventana', 'window'), 300);
  const query = clean(requestField(req, 'consulta', 'query', 'pregunta'), 4000);
  const version = clean(requestField(req, 'version', 'versión'), 80);
  // Dominio informado por Manager/cliente. NO define el tenant Asisto que
  // habilita/paga la herramienta; ese tenant se resuelve por "agente".
  const requestDomain = clean(requestField(req, 'dominio', 'domain', 'tenant', 'tenantId'), 120).toUpperCase();
  const user = clean(requestField(req, 'usuario', 'user', 'username'), 200);

  // Sin consulta se mantiene el contrato histórico: ventana obligatoria.
  // Con consulta, ventana es opcional y actúa como contexto prioritario.
  if (!query && !windowName) return res.status(400).json({ ok: false, error: 'ventana_required' });
  if (!version) return res.status(400).json({ ok: false, error: 'version_required' });
  if (!requestDomain) return res.status(400).json({ ok: false, error: 'dominio_required' });
  if (!user) return res.status(400).json({ ok: false, error: 'usuario_required' });

  let ownerDomain = '';
  let usageContext = null;

  let cfg;
  let source;
  let aiInfo = { aiUsed: false, cacheHit: false, usage: null };
  try {
    cfg = await loadHelpConfig(agent);

    // El agente determina a qué dominio Asisto pertenece la herramienta.
    // Ej.: MANAGER -> MSM. El request puede traer dominio=CLIENTE_001 y eso
    // queda sólo como dato del cliente que originó la consulta.
    const owner = await resolveHelpDomainByAgent(agent);
    if (!owner || !owner.domain || owner.enabled !== true) {
      return res.json(compactHelpApiResponse({
        dateInfo,
        responseBody: { respuesta: 'N', videos: [] },
        intelligent: !!query
      }));
    }

    ownerDomain = owner.domain;
    usageContext = buildHelpApiUsageContext({
      agent,
      domain: ownerDomain,
      requestDomain,
      user,
      windowName,
      query
    });

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
        domain: ownerDomain,
        user,
        usageContext
      });

      const intelligent = await resolveIntelligentHelpQuery({
        cfg,
        sourceHash: source.hash,
        windowName,
        query,
        rows: candidateInfo.rows,
        domain: ownerDomain,
        user,
        usageContext
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
        dominio: requestDomain,
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
        tenantId: ownerDomain,
        fechaAsisto: dateInfo.fecha,
        agente: agent,
        ventana: windowName || '',
        consulta: query,
        version,
        dominio: requestDomain,
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

      await recordHelpApiRequestEvent({
        usageContext,
        version,
        result: responseBody.respuesta,
        videoCount: videos.length,
        aiUsed: candidateInfo.categoryAiInfo.aiUsed === true || intelligent.aiUsed === true,
        aiCacheHit:
          candidateInfo.categoryAiInfo.cacheHit === true ||
          intelligent.cacheHit === true
      });

      res.set('Cache-Control', 'no-store');
      return res.json(compactHelpApiResponse({
        dateInfo,
        responseBody,
        intelligent: true
      }));
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
          domain: ownerDomain,
          user,
          usageContext
        });
        naturalIds = [...new Set([
          ...obviousNaturalIds,
          ...resolved.vimeoIds.map(String)
        ])];
        aiInfo = resolved;
      } catch (e) {
        aiError = e;
        console.warn(`[help] categoria IA agent=${agent} ownerDomain=${ownerDomain} requestDomain=${requestDomain} window=${windowName}:`, e?.message || e);
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
      const currentImportance = Number(row.importance || 0);
      const previousImportance = Number(previous?.importance || 0);
      if (
        !previous ||
        (currentImportance > 0 && (previousImportance <= 0 || currentImportance < previousImportance))
      ) dedupe.set(key, row);
    }

    const selected = sortVideos([...dedupe.values()]).slice(0, cfg.max_videos);
    const videos = selected.map(outputVideo);
    const responseBody = {
      ok: true,
      ...dateInfo,
      agente: agent,
      ventana: windowName,
      version,
      dominio: requestDomain,
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
      tenantId: ownerDomain,
      createdAt: now,
      fechaAsisto: dateInfo.fecha,
      agente: agent,
      ventana: windowName,
      version,
      dominio: requestDomain,
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

    await recordHelpApiRequestEvent({
      usageContext,
      version,
      result: responseBody.respuesta,
      videoCount: videos.length,
      aiUsed: aiInfo.aiUsed === true,
      aiCacheHit: aiInfo.cacheHit === true
    });

    res.set('Cache-Control', 'no-store');
    return res.json(compactHelpApiResponse({
      dateInfo,
      responseBody,
      intelligent: false
    }));
  } catch (e) {
    const message = String(e?.message || e || 'internal');
    console.error(`[help] query error agent=${agent} ownerDomain=${ownerDomain || '-'} requestDomain=${requestDomain} window=${windowName}:`, message);
    const status = /required|invalid/.test(message) ? 400
      : /openai_api_key_missing/.test(message) ? 503
      : /source_|google_sheet|google_service_account/.test(message) ? 502
      : 500;

    await recordHelpApiRequestEvent({
      usageContext,
      version,
      result: 'ERROR',
      videoCount: 0,
      aiUsed: false,
      aiCacheHit: false,
      error: message
    });

    return res.status(status).json({
      ok: false,
      ...dateInfo,
      agente: agent,
      ventana: windowName || null,
      ...(query ? { consulta: query } : {}),
      version: version || null,
      dominio: requestDomain || null,
      usuario: user || null,
      error: message.slice(0, 240)
    });
  }
}


function signHelpWebContext(payload = {}) {
  if (!HELP_WEB_SIGNING_SECRET) throw new Error('help_web_signing_secret_missing');
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', HELP_WEB_SIGNING_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyHelpWebContext(token) {
  if (!HELP_WEB_SIGNING_SECRET) throw new Error('help_web_signing_secret_missing');
  const raw = clean(token, 12000);
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) throw new Error('help_web_token_invalid');
  const body = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', HELP_WEB_SIGNING_SECRET).update(body).digest('base64url');
  if (!safeTimingEqual(provided, expected)) throw new Error('help_web_token_invalid');
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { throw new Error('help_web_token_invalid'); }
  if (!Number.isFinite(Number(payload?.exp)) || Number(payload.exp) < Date.now()) throw new Error('help_web_token_expired');
  return {
    agent: normalizeAgent(payload?.agent || DEFAULT_AGENT),
    domain: normalizeHelpDomain(payload?.domain || ''),
    version: clean(payload?.version, 80),
    user: clean(payload?.user || 'WEB', 200)
  };
}

function helpWebRateAllowed(req) {
  const now = Date.now();
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const key = forwarded || String(req.ip || req.socket?.remoteAddress || 'unknown');
  let rec = _helpWebRate.get(key);
  if (!rec || now - rec.startedAt >= HELP_WEB_RATE_WINDOW_MS) rec = { startedAt: now, count: 0 };
  rec.count += 1;
  _helpWebRate.set(key, rec);
  if (_helpWebRate.size > 2000) {
    for (const [k,v] of _helpWebRate.entries()) if (now - Number(v?.startedAt || 0) > HELP_WEB_RATE_WINDOW_MS * 2) _helpWebRate.delete(k);
  }
  return rec.count <= HELP_WEB_RATE_MAX;
}

// Reutiliza exactamente la lógica del API sin exponer HELP_API_KEY.
async function executeHelpQueryInternal(payload = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let statusCode = 200;
    const req = { body: payload, query: {}, headers: {} };
    const res = {
      status(code) { statusCode = Number(code || 200) || 200; return this; },
      set() { return this; },
      json(body) { if (!done) { done = true; resolve({ statusCode, body }); } return this; }
    };
    Promise.resolve(handleHelpQuery(req, res)).catch(e => { if (!done) reject(e); });
  });
}

function helpWebFrameHeaders(res) {
  try { res.removeHeader('X-Frame-Options'); } catch {}
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; frame-src https://player.vimeo.com; frame-ancestors *; base-uri 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function renderHelpWebChat(config = {}) {
  const cfg = {
    title: clean(config.title || 'Ayuda Manager', 120),
    token: clean(config.token, 12000),
    windowName: clean(config.windowName || '', 300)
  };
  const cfgJson = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${cfg.title.replace(/[<>&"]/g,'')}</title>
<style>
:root{--bg:#f5f8fb;--card:#fff;--text:#10233f;--muted:#6b7b91;--line:#dce5ef;--brand:#0f4f78;--brand2:#158197;--user:#e8f3f6}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text)}
.shell{height:100%;min-height:420px;display:flex;flex-direction:column;background:#fff;overflow:hidden}.head{display:flex;align-items:center;gap:11px;padding:14px 16px;border-bottom:1px solid var(--line)}
.logo{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-weight:900;font-size:18px}.headText{min-width:0;flex:1}.title{font-weight:800;font-size:16px}.subtitle{color:var(--muted);font-size:12px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status{width:8px;height:8px;border-radius:50%;background:#18a874;box-shadow:0 0 0 4px rgba(24,168,116,.1)}
.messages{flex:1;overflow:auto;padding:18px 14px 10px;background:linear-gradient(180deg,#f8fafc,#f3f7fa)}.row{display:flex;margin:0 0 12px}.row.user{justify-content:flex-end}.bubble{max-width:min(84%,720px);padding:11px 13px;border-radius:15px;font-size:14px;line-height:1.48;white-space:pre-wrap;word-break:break-word;box-shadow:0 4px 14px rgba(15,47,75,.05)}.assistant .bubble{background:#fff;border:1px solid var(--line);border-bottom-left-radius:5px}.user .bubble{background:var(--user);border:1px solid #cfe5e9;border-bottom-right-radius:5px}
.typing{display:inline-flex;gap:5px}.typing i{width:6px;height:6px;background:#8aa0b5;border-radius:50%;animation:pulse 1.1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes pulse{0%,70%,100%{opacity:.28}35%{opacity:1;transform:translateY(-3px)}}
.videos{display:grid;gap:8px;margin:9px 0 14px;max-width:min(88%,760px)}.videoCard{background:#fff;border:1px solid var(--line);border-radius:13px;padding:10px 11px;box-shadow:0 4px 14px rgba(15,47,75,.05)}.videoTop{display:flex;gap:10px;align-items:center}.badge{min-width:26px;height:26px;padding:0 8px;border-radius:8px;display:grid;place-items:center;background:#eaf3f7;color:var(--brand);font-size:11px;font-weight:900}.videoTitle{font-size:13px;font-weight:750;line-height:1.3;flex:1}.watch{border:0;background:var(--brand);color:#fff;border-radius:9px;padding:7px 10px;font-size:12px;font-weight:750;cursor:pointer}.player{display:none;margin-top:10px;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:#0b1825}.player iframe{width:100%;height:100%;border:0}
.composer{padding:11px;border-top:1px solid var(--line)}.form{display:flex;gap:8px;align-items:flex-end}.inputWrap{flex:1;border:1px solid var(--line);border-radius:14px;padding:9px 11px}.inputWrap:focus-within{border-color:#8cb9c9;box-shadow:0 0 0 3px rgba(21,129,151,.08)}textarea{width:100%;min-height:24px;max-height:110px;border:0;outline:0;resize:none;padding:0;background:transparent;font:inherit;font-size:14px;color:var(--text)}.send{width:43px;height:43px;border:0;border-radius:13px;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-size:19px;font-weight:900;cursor:pointer}.send:disabled{opacity:.5}.foot{font-size:10px;color:#94a2b3;text-align:center;padding-top:6px}
@media(max-width:560px){.head{padding:11px 12px}.messages{padding:14px 10px 8px}.bubble{max-width:91%}.videos{max-width:94%}}
</style></head><body><div class="shell"><header class="head"><div class="logo">A</div><div class="headText"><div class="title" id="title"></div><div class="subtitle" id="ctx"></div></div><div class="status"></div></header><main class="messages" id="messages"></main><footer class="composer"><form class="form" id="form"><div class="inputWrap"><textarea id="input" rows="1" maxlength="4000" placeholder="¿En qué te puedo ayudar?"></textarea></div><button class="send" id="send" type="submit">➜</button></form><div class="foot">Ayuda contextual · Asisto</div></footer></div>
<script>(function(){'use strict';const CFG=${cfgJson};let currentWindow=CFG.windowName||'',busy=false;const m=document.getElementById('messages'),input=document.getElementById('input'),send=document.getElementById('send'),form=document.getElementById('form');document.getElementById('title').textContent=CFG.title||'Ayuda Manager';function context(){document.getElementById('ctx').textContent=currentWindow?'Ayuda contextual · '+currentWindow:'Asistente general de ayuda'}function scroll(){m.scrollTop=m.scrollHeight}function bubble(role,text,id){const r=document.createElement('div');r.className='row '+role;if(id)r.id=id;const b=document.createElement('div');b.className='bubble';b.textContent=String(text||'');r.appendChild(b);m.appendChild(r);scroll()}function typing(){const r=document.createElement('div');r.className='row assistant';r.id='typing';r.innerHTML='<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';m.appendChild(r);scroll()}function stopTyping(){const x=document.getElementById('typing');if(x)x.remove()}function videos(j){const a=Array.isArray(j&&j.vimeo_ids)?j.vimeo_ids:(Array.isArray(j&&j.videos)?j.videos:[]);return a.slice().sort((x,y)=>{const xi=Number(x&&x.importancia||0),yi=Number(y&&y.importancia||0);return(xi>0?xi:999)-(yi>0?yi:999)})}function addVideos(list){if(!list.length)return;const w=document.createElement('div');w.className='videos';list.forEach(v=>{const id=String(v&&v.vimeo_id||'').replace(/[^0-9]/g,'');if(!id)return;const c=document.createElement('div');c.className='videoCard';const top=document.createElement('div');top.className='videoTop';const badge=document.createElement('span');badge.className='badge';badge.textContent='#'+String(v.importancia||'-');const t=document.createElement('div');t.className='videoTitle';t.textContent=String(v.titulo||'Video de ayuda');const btn=document.createElement('button');btn.type='button';btn.className='watch';btn.textContent='Ver video';const p=document.createElement('div');p.className='player';btn.onclick=()=>{const open=p.style.display==='block';if(open){p.style.display='none';p.innerHTML='';btn.textContent='Ver video'}else{p.style.display='block';const f=document.createElement('iframe');f.src='https://player.vimeo.com/video/'+id;f.allow='autoplay; fullscreen; picture-in-picture';f.allowFullscreen=true;p.appendChild(f);btn.textContent='Cerrar';setTimeout(scroll,100)}};top.append(badge,t,btn);c.append(top,p);w.appendChild(c)});if(w.children.length){m.appendChild(w);scroll()}}async function ask(q){q=String(q||'').trim();if(!q||busy)return;busy=true;send.disabled=true;input.disabled=true;bubble('user',q);typing();try{const r=await fetch('/api/ext/ayuda/chat-web',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({token:CFG.token,consulta:q,ventana:currentWindow})});let j={};try{j=await r.json()}catch{}stopTyping();if(!r.ok){bubble('assistant',r.status===429?'Se realizaron demasiadas consultas. Probá nuevamente en unos minutos.':'No pude consultar la ayuda en este momento.');return}const a=String(j&&j.respuesta||'').trim();bubble('assistant',a&&a!=='S'&&a!=='N'?a:(a==='N'?'No encontré información suficiente para esa consulta.':'Encontré estos contenidos relacionados:'));addVideos(videos(j))}catch(e){stopTyping();bubble('assistant','No pude conectar con el servicio de ayuda.')}finally{busy=false;send.disabled=false;input.disabled=false;input.focus()}}form.onsubmit=e=>{e.preventDefault();const q=input.value;input.value='';input.style.height='auto';ask(q)};input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();form.requestSubmit()}};input.oninput=function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,110)+'px'};window.addEventListener('message',e=>{const d=e&&e.data;if(d&&d.type==='asisto-help-context'&&typeof d.ventana==='string'){currentWindow=d.ventana.trim().slice(0,300);context()}});context();bubble('assistant',currentWindow?'Hola. Puedo ayudarte con esta pantalla o con cualquier consulta sobre Manager.':'Hola. ¿Qué necesitás saber de Manager?');input.focus()})();</script></body></html>`;
}

function mountHelpTool(app) {
  if (!app) throw new Error('app_required');
  const json = express.json({ limit: '128kb' });

  // Web de chat embebible.
  app.get(['/ayuda/chat', '/help/chat'], async (req, res) => {
    try {
      if (!HELP_WEB_SIGNING_SECRET) return res.status(503).send('Chat de ayuda no configurado.');
      const agent = normalizeAgent(req.query?.agente || req.query?.agent || DEFAULT_AGENT);
      const domain = normalizeHelpDomain(req.query?.dominio || req.query?.domain || '');
      const version = clean(req.query?.version, 80);
      const user = clean(req.query?.usuario || req.query?.user || 'WEB', 200);
      const windowName = clean(req.query?.ventana || req.query?.window || '', 300);
      const title = clean(req.query?.titulo || req.query?.title || 'Ayuda Manager', 120);
      if (!domain || !version) return res.status(400).send('Faltan parámetros dominio y version.');
      const owner = await resolveHelpDomainByAgent(agent);
      if (!owner || !owner.domain || owner.enabled !== true) return res.status(404).send('La herramienta de ayuda no está habilitada.');
      const token = signHelpWebContext({ agent, domain, version, user, exp: Date.now() + HELP_WEB_TOKEN_TTL_MS });
      helpWebFrameHeaders(res);
      return res.type('html').send(renderHelpWebChat({ title, token, windowName }));
    } catch (e) {
      console.error('[help-web] render:', e?.message || e);
      return res.status(500).send('No se pudo abrir el chat de ayuda.');
    }
  });

  // Proxy interno: no expone HELP_API_KEY al navegador.
  app.post('/api/ext/ayuda/chat-web', json, async (req, res) => {
    try {
      if (!helpWebRateAllowed(req)) return res.status(429).json({ respuesta: 'Demasiadas consultas.', fecha: asistoDateParts().fechaHora, vimeo_ids: [] });
      const ctx = verifyHelpWebContext(req.body?.token);
      const query = clean(req.body?.consulta || req.body?.query || '', 4000);
      const windowName = clean(req.body?.ventana || req.body?.window || '', 300);
      if (!query) return res.status(400).json({ respuesta: 'consulta_required', fecha: asistoDateParts().fechaHora, vimeo_ids: [] });
      const result = await executeHelpQueryInternal({ agente: ctx.agent, ventana: windowName, version: ctx.version, dominio: ctx.domain, usuario: ctx.user, consulta: query });
      return res.status(result.statusCode || 200).json(result.body || {});
    } catch (e) {
      const message = String(e?.message || e || 'internal');
      const status = /token_invalid|token_expired/.test(message) ? 401 : /signing_secret/.test(message) ? 503 : 500;
      console.error('[help-web] query:', message);
      return res.status(status).json({ respuesta: 'No pude procesar la consulta.', fecha: asistoDateParts().fechaHora, vimeo_ids: [] });
    }
  });

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
      const owner = await resolveHelpDomainByAgent(agent, { force: true });
      return res.json({
        ok: true,
        agente: agent,
        dominio_asisto: owner?.domain || null,
        enabled: !!(owner?.domain && owner?.enabled === true),
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
  loadHelpDomainConfig,
  loadHelpDomainEnabled,
  resolveHelpDomainByAgent,
  saveHelpDomainEnabled,
  invalidateHelpDomainEnabledCache,
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
  executeHelpQueryInternal,
  signHelpWebContext,
  verifyHelpWebContext,
  renderHelpWebChat,
  googlePublicCsvUrl
};
