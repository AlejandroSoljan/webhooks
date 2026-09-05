// Asisto | Version: 5.00.041 | Fecha: 2026-09-04
// qr_product_web.js
// Ficha pública de producto por QR + asesor IA opcional.
// La carga inicial consulta únicamente la API de productos configurada: NO usa OpenAI.
// La IA comienza recién cuando el visitante toca "Mostrar más info" o envía un mensaje.

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { ObjectId } = require('mongodb');
const { getDb } = require('./db');
const {
  getGPTReply,
  syncSessionConversation,
  clearEndedFlag,
} = require('./logic');

const QR_BUILD = '2026-09-04-v6-fast-response';
const qrJson = express.json({ limit: '512kb' });
const rateState = new Map();
let lastRateCleanupAt = 0;


const QR_PRODUCT_CACHE_TTL_MS = Math.max(
  0,
  Math.min(300000, Number(process.env.QR_PRODUCT_CACHE_TTL_MS || 300000) || 300000)
);
const QR_PRODUCT_CACHE_MAX = Math.max(
  20,
  Math.min(2000, Number(process.env.QR_PRODUCT_CACHE_MAX || 500) || 500)
);
const qrProductCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function qrProductCacheKey(tenant, code) {
  return `${String(tenant || '').trim().toUpperCase()}|${String(code || '').trim()}`;
}

function getCachedQrProduct(tenant, code) {
  if (!QR_PRODUCT_CACHE_TTL_MS) return null;
  const key = qrProductCacheKey(tenant, code);
  const item = qrProductCache.get(key);
  if (!item) return null;
  if ((Date.now() - Number(item.at || 0)) > QR_PRODUCT_CACHE_TTL_MS) {
    qrProductCache.delete(key);
    return null;
  }
  return item.product || null;
}

function setCachedQrProduct(tenant, code, product) {
  if (!QR_PRODUCT_CACHE_TTL_MS || !product) return;
  const key = qrProductCacheKey(tenant, code);
  qrProductCache.set(key, { at: Date.now(), product });

  if (qrProductCache.size > QR_PRODUCT_CACHE_MAX) {
    const now = Date.now();
    for (const [k, item] of qrProductCache) {
      if ((now - Number(item?.at || 0)) > QR_PRODUCT_CACHE_TTL_MS) {
        qrProductCache.delete(k);
      }
    }
    while (qrProductCache.size > QR_PRODUCT_CACHE_MAX) {
      const oldestKey = qrProductCache.keys().next().value;
      if (!oldestKey) break;
      qrProductCache.delete(oldestKey);
    }
  }
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, Math.max(1, Number(max) || 500));
}
function digitsOrText(value, max = 160) {
  return clean(value, max).replace(/[\r\n\t]/g, ' ');
}
function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return !!fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(String(value).trim().toLowerCase());
}
function intValue(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
function safeTenant(value) {
  return clean(value, 100).replace(/[^a-zA-Z0-9_.-]/g, '').toUpperCase();
}
function safeSessionId(value) {
  const raw = clean(value, 96);
  if (/^[a-zA-Z0-9_-]{12,96}$/.test(raw)) return raw;
  return crypto.randomBytes(18).toString('hex');
}
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function safePublicImageUrl(value) {
  const url = clean(value, 3000);
  if (/^https?:\/\//i.test(url) || /^\/[a-zA-Z0-9_./-]+$/.test(url)) return url;
  return '';
}
function getPath(obj, path) {
  const p = String(path || '').trim();
  if (!p) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj || {}, p)) return obj[p];
  return p.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}
function firstDefined(obj, names) {
  for (const name of names) {
    const v = getPath(obj, name);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}
function firstProductPayload(payload) {
  if (Array.isArray(payload)) return payload[0] || null;
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['data', 'items', 'results', 'articulos', 'productos']) {
    const v = payload[key];
    if (Array.isArray(v)) return v[0] || null;
    if (v && typeof v === 'object') return v;
  }
  if (payload.product && typeof payload.product === 'object') return payload.product;
  if (payload.articulo && typeof payload.articulo === 'object') return payload.articulo;
  return payload;
}
function parseStock(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const n = Number(String(value).replace(',', '.'));
  if (Number.isFinite(n)) return n > 0;
  const s = String(value).trim().toLowerCase();
  if (['s', 'si', 'sí', 'true', 'disponible', 'stock', 'hay'].includes(s)) return true;
  if (['n', 'no', 'false', 'sin stock', 'agotado'].includes(s)) return false;
  return null;
}
function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim().replace(/\s/g, '');
  if (!raw) return null;
  let normalized = raw.replace(/[^0-9,.-]/g, '');
  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.lastIndexOf(',') > normalized.lastIndexOf('.')
      ? normalized.replace(/\./g, '').replace(',', '.')
      : normalized.replace(/,/g, '');
  } else if (normalized.includes(',')) {
    normalized = normalized.replace(',', '.');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseAdditionalPricesConfig(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map(line => {
      const parts = line.split('|').map(v => String(v || '').trim());
      const field = clean(parts[0], 120);
      if (!field) return null;
      if (parts.length >= 3) {
        return {
          field,
          label: clean(parts[1] || '', 80),
          note: clean(parts.slice(2).join('|') || '', 180),
        };
      }
      return {
        field,
        label: '',
        note: clean(parts[1] || '', 180),
      };
    })
    .filter(Boolean);
}

function normalizeProductImage(value, mimeType, apiUrl) {
  let raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length > 8 * 1024 * 1024) return '';

  if (/^https?:\/\//i.test(raw)) return raw;

  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(raw)) {
    return raw.replace(/\s+/g, '');
  }

  if (/^\//.test(raw)) {
    try { return new URL(raw, apiUrl).toString(); } catch {}
  }

  const compact = raw.replace(/\s+/g, '');
  if (compact.length >= 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    const mime = /^image\/[a-zA-Z0-9.+-]+$/i.test(String(mimeType || '').trim())
      ? String(mimeType).trim().toLowerCase()
      : 'image/jpeg';
    return `data:${mime};base64,${compact}`;
  }

  return '';

}
function replaceTemplateString(value, variables) {
  return String(value ?? '')
    .replace(/\{\{\s*codigo\s*\}\}/gi, String(variables.codigo || ''))
    .replace(/\{\{\s*tenant\s*\}\}/gi, String(variables.tenant || ''));
}
function replaceTemplateValue(value, variables) {
  if (Array.isArray(value)) return value.map(v => replaceTemplateValue(v, variables));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceTemplateValue(v, variables);
    return out;
  }
  return typeof value === 'string' ? replaceTemplateString(value, variables) : value;
}

async function loadQrConfig(db, tenant) {
  const doc = await db.collection('settings').findOne({ _id: `behavior:${tenant}` }) || {};
  const method = String(doc.qr_api_method || 'GET').trim().toUpperCase() === 'POST' ? 'POST' : 'GET';
  const webContext = String(doc.qr_ai_web_search_context_size || 'low').trim().toLowerCase();
  return {
    enabled: boolValue(doc.qr_enabled, false),
    pageTitle: clean(doc.qr_page_title || 'Información del producto', 120),
    pageSubtitle: clean(doc.qr_page_subtitle || 'Consultá precio, disponibilidad y más información.', 220),
    companyName: clean(doc.qr_company_name || '', 140),
    companyLogoUrl: safePublicImageUrl(doc.qr_company_logo_url || ''),
    buttonColor: /^#[0-9a-f]{6}$/i.test(String(doc.qr_button_color || '').trim()) ? String(doc.qr_button_color).trim() : '#0f766e',
    buttonTextColor: /^#[0-9a-f]{6}$/i.test(String(doc.qr_button_text_color || '').trim()) ? String(doc.qr_button_text_color).trim() : '#ffffff',
    currency: clean(doc.qr_currency || 'ARS', 10).toUpperCase(),
    apiUrl: clean(doc.qr_api_url, 3000),
    apiMethod: method,
    apiCodeParam: clean(doc.qr_api_code_param || 'codigo', 100),
    apiBodyTemplate: clean(doc.qr_api_body_template, 20000),
    apiAuthHeader: clean(doc.qr_api_auth_header, 200),
    apiAuthValue: clean(doc.qr_api_auth_value, 4000),
    apiTimeoutMs: intValue(doc.qr_api_timeout_ms, 45000, 5000, 120000),
    fieldCode: clean(doc.qr_field_code || 'Codigo', 120),
    fieldDescription: clean(doc.qr_field_description || 'Descripcion', 120),
    fieldPrice: clean(doc.qr_field_price || 'Precio_Lp1', 120),
    priceLabel: clean(doc.qr_price_label || 'Precio', 80),
    priceNote: clean(doc.qr_price_note || '', 180),
    additionalPricesRaw: clean(doc.qr_additional_prices || '', 8000),
    additionalPrices: parseAdditionalPricesConfig(doc.qr_additional_prices || ''),
    fieldStock: clean(doc.qr_field_stock || 'Stock', 120),
    fieldImage: clean(doc.qr_field_image || '', 120),
    imageMimeType: clean(doc.qr_image_mime_type || 'image/jpeg', 80),
    fieldBrand: clean(doc.qr_field_brand || '', 120),
    fieldCategory: clean(doc.qr_field_category || 'Desc_Rubro', 120),
    fieldSubcategory: clean(doc.qr_field_subcategory || 'Desc_Subrubro', 120),
    aiEnabled: boolValue(doc.qr_ai_enabled, true),
    aiUseSameBehavior: boolValue(doc.qr_ai_use_same_behavior, true),
    aiModel: clean(doc.qr_ai_model || doc.chat_model || '', 120),
    aiBehavior: clean(doc.qr_ai_behavior, 30000),
    aiWebSearchEnabled: boolValue(doc.qr_ai_web_search_enabled, true),
    aiWebSearchContextSize: ['low', 'medium', 'high'].includes(webContext) ? webContext : 'low',
    aiWebSearchTimeoutMs: intValue(doc.qr_ai_web_search_timeout_ms, 20000, 5000, 120000),
  };
}

async function fetchQrProduct(cfg, tenant, code) {
  if (!cfg.enabled) throw Object.assign(new Error('qr_disabled'), { statusCode: 404 });
  if (!/^https?:\/\//i.test(cfg.apiUrl)) throw Object.assign(new Error('qr_api_not_configured'), { statusCode: 503 });
  const codigo = digitsOrText(code, 180);
  if (!codigo) throw Object.assign(new Error('codigo_required'), { statusCode: 400 });

  const cached = getCachedQrProduct(tenant, codigo);
  if (cached) {
    console.log(`[qr] product cache hit tenant=${tenant} sku=${codigo}`);
    return cached;
  }

  const variables = { codigo, tenant };
  let url = replaceTemplateString(cfg.apiUrl, variables);
  const headers = { Accept: 'application/json' };
  if (cfg.apiAuthHeader && cfg.apiAuthValue) headers[cfg.apiAuthHeader] = cfg.apiAuthValue;

  const baseRequest = {
    method: cfg.apiMethod,
    url,
    headers,
    timeout: cfg.apiTimeoutMs,
    validateStatus: () => true,
 };

  if (cfg.apiMethod === 'GET') {
    if (!/\{\{\s*codigo\s*\}\}/i.test(cfg.apiUrl) && cfg.apiCodeParam) {
      baseRequest.params = { [cfg.apiCodeParam]: codigo };
    }
  } else {
    let body = null;
    if (cfg.apiBodyTemplate) {
      try {
        body = replaceTemplateValue(JSON.parse(cfg.apiBodyTemplate), variables);
      } catch {
        throw Object.assign(new Error('qr_api_body_template_invalid'), { statusCode: 500 });
      }
    }
    if (!body) body = { [cfg.apiCodeParam || 'codigo']: codigo };
    request.data = body;
    baseRequest.data = body;
    baseRequest.headers = { ...headers, 'Content-Type': 'application/json' };
  }

  // GET es idempotente: ante timeout/error de red/502-504 hacemos un único
  // reintento. POST no se reintenta automáticamente para evitar duplicar efectos
  // en APIs que no sean estrictamente de consulta.
  const maxAttempts = cfg.apiMethod === 'GET' ? 2 : 1;
  let resp = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      console.log(
        `[qr] product api attempt=${attempt}/${maxAttempts} tenant=${tenant} sku=${codigo} ` +
        `timeoutMs=${cfg.apiTimeoutMs}`
      );

      resp = await axios({ ...baseRequest });

      const durationMs = Date.now() - startedAt;
      console.log(
        `[qr] product api response attempt=${attempt}/${maxAttempts} tenant=${tenant} sku=${codigo} ` +
        `status=${resp.status} durationMs=${durationMs}`
      );

      if (resp.status >= 200 && resp.status < 300) break;

      const retryableStatus = [502, 503, 504].includes(Number(resp.status));
      if (retryableStatus && attempt < maxAttempts) {
        await sleep(500);
        continue;
      }

      throw Object.assign(new Error(`qr_api_http_${resp.status}`), { statusCode: 502 });
    } catch (e) {
      lastError = e;
      const durationMs = Date.now() - startedAt;
     const codeValue = String(e?.code || '').toUpperCase();
      const message = String(e?.message || e);
      const timeout =
        codeValue === 'ECONNABORTED' ||
        codeValue === 'ETIMEDOUT' ||
        /\btimeout\b/i.test(message);

      const network =
        timeout ||
        ['ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(codeValue);

      console.warn(
        `[qr] product api error attempt=${attempt}/${maxAttempts} tenant=${tenant} sku=${codigo} ` +
        `code=${codeValue || '-'} durationMs=${durationMs} message=${message}`
      );

      if (network && attempt < maxAttempts) {
        await sleep(500);
        continue;
      }

      if (timeout) {
        throw Object.assign(new Error('product_api_timeout'), {
          statusCode: 504,
          publicDetail: 'El servidor de productos demoró demasiado. Reintentá en unos segundos.',
        });
      }

      if (e?.statusCode) throw e;

      throw Object.assign(new Error('product_api_unavailable'), {
        statusCode: 502,
        publicDetail: 'No pudimos comunicarnos con el servidor de productos. Reintentá en unos segundos.',
      });
    }
  }

  if (!resp) {
    const codeValue = String(lastError?.code || '').toUpperCase();
    const timeout =
      codeValue === 'ECONNABORTED' ||
      codeValue === 'ETIMEDOUT' ||
      /\btimeout\b/i.test(String(lastError?.message || ''));
    throw Object.assign(new Error(timeout ? 'product_api_timeout' : 'product_api_unavailable'), {
      statusCode: timeout ? 504 : 502,
      publicDetail: timeout
        ? 'El servidor de productos demoró demasiado. Reintentá en unos segundos.'
        : 'No pudimos comunicarnos con el servidor de productos. Reintentá en unos segundos.',
    });
  }

  const raw = firstProductPayload(resp.data);
  if (!raw || typeof raw !== 'object') {
    throw Object.assign(new Error('product_not_found'), { statusCode: 404 });
  }

  const productCode =
    firstDefined(raw, [cfg.fieldCode, 'Codigo', 'codigo', 'code', 'sku', 'SKU']) ?? codigo;
  const description =
    firstDefined(raw, [cfg.fieldDescription, 'Descripcion', 'descripcion', 'description', 'nombre', 'name']);

  if (!description) {
    throw Object.assign(new Error('product_not_found'), { statusCode: 404 });
  }
  const priceRaw = firstDefined(raw, [cfg.fieldPrice, 'Precio', 'precio', 'Precio_Lp1', 'price']);
  const stockRaw = firstDefined(raw, [cfg.fieldStock, 'Stock', 'stock', 'disponible', 'availability']);
  const image = cfg.fieldImage
    ? firstDefined(raw, [cfg.fieldImage, 'Imagen', 'imagen', 'image', 'imageUrl', 'url_imagen'])
    : firstDefined(raw, ['Imagen', 'imagen', 'image', 'imageUrl', 'url_imagen']);
  const brand = cfg.fieldBrand
    ? firstDefined(raw, [cfg.fieldBrand, 'Marca', 'marca', 'brand'])
    : firstDefined(raw, ['Marca', 'marca', 'brand']);
  const category = firstDefined(raw, [cfg.fieldCategory, 'Desc_Rubro', 'rubro', 'category']);
  const subcategory = firstDefined(raw, [cfg.fieldSubcategory, 'Desc_Subrubro', 'subrubro', 'subcategory']);
  const primaryPrice = parseNumber(priceRaw);
  const prices = [{
    field: cfg.fieldPrice,
    label: cfg.priceLabel || 'Precio',
    note: cfg.priceNote || '',
    value: primaryPrice,
    primary: true,
  }];

  for (const item of cfg.additionalPrices || []) {
    const value = parseNumber(firstDefined(raw, [item.field]));
    if (value == null) continue;
    prices.push({
      field: item.field,
      label: item.label || '',
      note: item.note || '',
      value,
      primary: false,
    });
  }

  const product = {
    code: clean(productCode, 180),
    description: clean(description, 600),
    price: primaryPrice,
    prices,
    available: parseStock(stockRaw),
    image: normalizeProductImage(image, cfg.imageMimeType, cfg.apiUrl),
    brand: clean(brand, 180),
    category: clean(category, 180),
    subcategory: clean(subcategory, 180),
  };

  setCachedQrProduct(tenant, codigo, product);
  return product;
}

async function resolveOpenAiKey(db, tenant) {
  const channels = await db.collection('tenant_channels')
    .find({ tenantId: tenant })
    .sort({ isDefault: -1, updatedAt: -1, createdAt: -1 })
    .limit(100)
    .toArray()
    .catch(() => []);
  const channel = channels.find(c => c?.isDefault === true && String(c?.openaiApiKey || '').trim())
    || channels.find(c => String(c?.openaiApiKey || '').trim())
    || null;
  return String(channel?.openaiApiKey || process.env.OPENAI_API_KEY || '').trim();
}

function qrSessionFrom(sessionId, productCode) {
  return `__asisto_qr__:${safeSessionId(sessionId)}:${clean(productCode, 80).replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

async function ensureQrConversation(db, tenant, sessionId, product, req) {
  const sid = safeSessionId(sessionId);
  let conv = await db.collection('conversations').findOne({
    tenantId: tenant,
    qrSessionId: sid,
    qrProductCode: product.code,
    channelType: 'qr_web',
    botMode: 'conversacional',
    finalized: { $ne: true },
  }, { sort: { updatedAt: -1, openedAt: -1 } });
  if (conv) return conv;

  const now = new Date();
  const doc = {
    tenantId: tenant,
    waId: `QRWEB:${sid}`,
    contactName: `QR · ${clean(product.description, 80)}`,
    channelType: 'qr_web',
    botMode: 'conversacional',
    qrSessionId: sid,
    qrProductCode: product.code,
    qrProductDescription: product.description,
    status: 'OPEN',
    finalized: false,
    manualOpen: false,
    openedAt: now,
    createdAt: now,
    updatedAt: now,
    source: 'qr_web',
    meta: {
      qr: true,
      userAgent: clean(req.headers['user-agent'], 300),
    },
  };
  const result = await db.collection('conversations').insertOne(doc);
  doc._id = result.insertedId;
  return doc;
}

async function saveQrMessage(db, { tenant, conversationId, waId, role, content, product, meta = {} }) {
  const now = new Date();
  await db.collection('messages').insertOne({
    tenantId: tenant,
    conversationId: conversationId instanceof ObjectId ? conversationId : new ObjectId(String(conversationId)),
    waId,
    role,
    type: 'text',
    content: clean(content, 20000),
    ts: now,
    createdAt: now,
    meta: {
      from: 'qr_web',
      qrProductCode: product.code,
      qrProductDescription: product.description,
      ...meta,
    },
  });
  const set = { updatedAt: now };
  if (role === 'user') set.lastUserTs = now;
  if (role === 'assistant') set.lastAssistantTs = now;
  await db.collection('conversations').updateOne({ _id: conversationId }, { $set: set });
}

function productContext(product, cfg) {
  return [
    '[CONTEXTO DEL PRODUCTO ESCANEADO POR QR]',
    `SKU/Código: ${product.code}`,
    `Descripción: ${product.description}`,
    product.brand ? `Marca: ${product.brand}` : '',
    product.category ? `Rubro: ${product.category}` : '',
    product.subcategory ? `Subrubro: ${product.subcategory}` : '',
    'El servidor agregará precio y disponibilidad después de tu respuesta usando exclusivamente la API del negocio.',
    'No menciones, copies, calcules ni reformules precio, stock o disponibilidad en tu respuesta.',
  ].filter(Boolean).join('\n');
}

function formatQrCommercialMoney(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return 'Consultar';
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: currency || 'ARS',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `$ ${Number(value).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

function stripModelCommercialClaims(value) {
  const blockedClaim = /(?:datos\s+comerciales|[$€]\s*[\d?]|\bprecio\b[^.!?\n]*\d|\b(?:tenemos|hay|con|sin)\s+(?:stock|disponibilidad)\b|\b(?:est[aá]|se\s+encuentra)\s+(?:disponible|agotado)\b)/i;
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line
      .split(/(?<=[.!?])\s+/)
      .filter(sentence => !blockedClaim.test(sentence))
      .join(' ')
      .trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripCommercialDeferrals(value) {
  const deferral = /(?:prefiero\s+no\s+pasarte|no\s+puedo\s+confirmar|asesor[^.!?\n]*verifi|necesito[^.!?\n]*sku|indicame[^.!?\n]*sku)/i;
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.split(/(?<=[.!?])\s+/).filter(sentence => !deferral.test(sentence)).join(' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function stripUnexpectedScripts(value) {
  return String(value || '')
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function compactMobileReply(value, maxUnits, maxChars) {
  const units = String(value || '')
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map(item => item.trim())
    .filter(Boolean);
  const selected = [];
  for (const unit of units) {
    if (selected.length >= maxUnits) break;
    const candidate = [...selected, unit].join('\n');
    if (candidate.length > maxChars) {
      if (!selected.length) {
        const clipped = unit.slice(0, maxChars - 1).replace(/\s+\S*$/, '').trim();
        if (clipped) selected.push(`${clipped}…`);
      }
      break;
    }
    selected.push(unit);
  }
  return selected.join('\n').trim();
}

function requestsCatalogData(value) {
  return /(?:\bsimilar(?:es)?\b|\balternativ(?:a|as)\b|\botr(?:o|os|a|as)\b|\bopci(?:[oó]n|ones)\b|\bcat[aá]logo\b|qu[eé]\s+(?:m[aá]s|otros?)\s+(?:tienen|hay)|m[aá]s\s+potencia|m[aá]s\s+(?:econ[oó]mic|barat)|menor\s+precio)/i.test(String(value || ''));
}

function requestsCatalogFollowUp(value) {
  return /(?:cu[aá]l(?:es)?\s+(?:me\s+)?recomend|qu[eé]\s+(?:me\s+)?recomend|cu[aá]l\s+(?:me\s+)?conviene|cu[aá]l\s+es\s+(?:el\s+)?mejor|de\s+esos|entre\s+esos|m[aá]s\s+(?:econ[oó]mic|barat)|menor\s+precio|m[aá]s\s+potencia)/i.test(String(value || ''));
}
function catalogCodesFromText(value) {
  const codes=[], seen=new Set(), pattern=/\bSKU\s*:?\s*([A-Z0-9][A-Z0-9.-]{1,39})\b/gi; let match;
  while ((match=pattern.exec(String(value||'')))!==null) { const code=String(match[1]||'').trim().toUpperCase(); if(code&&!seen.has(code)){seen.add(code);codes.push(code);} }
  return codes;
}
async function activeCatalogProducts(db, tenant, conversation, currentCode) {
  const confirmed=Array.isArray(conversation?.qrConfirmedCommercialProducts)?conversation.qrConfirmedCommercialProducts:[];
  let codes=Array.isArray(conversation?.qrLastShownCatalogCodes)?conversation.qrLastShownCatalogCodes.map(code=>String(code||'').trim().toUpperCase()).filter(Boolean):[];
  if(!codes.length){const recent=await db.collection('messages').find({tenantId:tenant,conversationId:conversation._id,role:'assistant'}).sort({ts:-1,createdAt:-1}).limit(8).project({content:1}).toArray();const msg=recent.find(item=>/Precios informados por el cat[aá]logo/i.test(String(item?.content||'')));if(msg)codes=catalogCodesFromText(msg.content);}
  const current=String(currentCode||'').trim().toUpperCase();
  return codes.map(code=>confirmed.find(item=>String(item?.code||'').trim().toUpperCase()===code)).filter(item=>item&&String(item.code||'').trim().toUpperCase()!==current&&Number(item.price)>0).slice(0,4);
}
function catalogFollowUpReply(products, message, cfg) {
  const text=String(message||'');
  if(/(?:m[aá]s\s+(?:econ[oó]mic|barat)|menor\s+precio)/i.test(text)){const selected=[...products].sort((a,b)=>Number(a.price)-Number(b.price))[0];return clean(selected.description,120)+' (SKU: '+clean(selected.code,80)+') es la opción de menor precio entre las mostradas.\n\n'+authoritativeCommercialBlock(selected,cfg);}
  if(/m[aá]s\s+potencia/i.test(text)){const ranked=products.map(product=>({product,hp:Number(String(product.description||'').match(/(\d+(?:[.,]\d+)?)\s*HP\b/i)?.[1]?.replace(',','.'))})).filter(item=>Number.isFinite(item.hp)).sort((a,b)=>b.hp-a.hp);if(ranked.length){const selected=ranked[0].product;return clean(selected.description,150)+' (SKU: '+clean(selected.code,80)+') es la de mayor potencia confirmada entre las mostradas.';}}
  return '¿Qué priorizás: menor precio, potencia o comodidad de uso? También podés decirme si es para un espacio chico, mediano o grande.';
}

function requestsLeadCapture(value) {
  return /(?:quiero\s+(?:comprar|reservar|encargar)|\bcompr(?:ar|o|amos)\b|\breserv(?:ar|a|o)\b|\bcotiz|\bpresupuesto\b|\bcontact(?:ar|o)\b|\bhablar\s+con\s+(?:un\s+)?asesor\b|\bque\s+me\s+llamen\b)/i.test(String(value || ''));
}

function stripPrematureContactRequest(value) {
  const contactRequest = /(?:pasame|decime|dejame|necesito)[^.!?\n]*(?:nombre|tel[eé]fono|whatsapp|contacto)|(?:asesor|vendedor)[^.!?\n]*(?:contacte|llame|contin[uú]e)/i;
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.split(/(?<=[.!?])\s+/).filter(sentence => !contactRequest.test(sentence)).join(' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function requestsCommercialData(value) {
  return /(?:\bprecio(?:s)?\b|\bcu[aá]nto\s+(?:sale|cuesta|vale)\b|\bcosto\b|\bvalor\b|\bstock\b|disponib|\bhay\s+(?:unidades|existencia)\b|transferencia|dep[oó]sito|cuotas?|oferta|promoci[oó]n)/i.test(String(value || ''));
}

function refersToCurrentQrProduct(value, product) {
  const text = String(value || '');
  const code = String(product?.code || '').trim();
  if (code && text.toUpperCase().includes(code.toUpperCase())) return true;
  return /(?:producto\s+(?:original|escaneado|de\s+la\s+ficha)|\b(?:original|escaneado)\b)/i.test(text);
}

function alternativeProductCodes(messages, currentCode) {
  const current = String(currentCode || '').trim().toUpperCase();
  const seen = new Set();
  const codes = [];
  const pattern = /\b(?=[A-Z0-9.-]{5,40}\b)(?=[A-Z0-9.-]*[A-Z])(?=[A-Z0-9.-]*\d)[A-Z0-9]+(?:[-.][A-Z0-9]+)+\b/gi;
  for (const item of messages || []) {
    const matches = String(item?.content || '').match(pattern) || [];
    for (const match of matches) {
      const code = match.toUpperCase();
      if (code === current || seen.has(code)) continue;
      seen.add(code);
      codes.push(match);
    }
  }
  return codes.slice(0, 5);
}

function externalProductRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'items', 'results', 'articulos', 'productos']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = externalProductRows(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [payload];
}

function commercialProductsFromExternalResult(result, cfg) {
  if (!result?.ok || !result?.body) return [];
  let payload;
  try { payload = typeof result.body === 'string' ? JSON.parse(result.body) : result.body; } catch { return []; }
  return externalProductRows(payload).slice(0, 1000).map(raw => {
    const code = firstDefined(raw, [cfg.fieldCode, 'Codigo', 'codigo', 'code', 'sku', 'SKU']);
    const description = firstDefined(raw, [cfg.fieldDescription, 'Descripcion', 'descripcion', 'description', 'nombre', 'name']);
    if (!code || !description) return null;
    const primaryPrice = parseNumber(firstDefined(raw, [cfg.fieldPrice, 'Precio', 'precio', 'Precio_Lp1', 'price']));
    const prices = [{
      field: cfg.fieldPrice,
      label: cfg.priceLabel || 'Precio',
      note: cfg.priceNote || '',
      value: primaryPrice,
      primary: true,
    }];
    for (const item of cfg.additionalPrices || []) {
      const value = parseNumber(firstDefined(raw, [item.field]));
      if (value == null) continue;
      prices.push({ field: item.field, label: item.label || '', note: item.note || '', value, primary: false });
    }
    return {
      code: clean(code, 180),
      description: clean(description, 600),
      price: primaryPrice,
      prices,
      available: parseStock(firstDefined(raw, [cfg.fieldStock, 'Stock', 'stock', 'disponible', 'availability'])),
      category: clean(firstDefined(raw, [cfg.fieldCategory, 'Desc_Rubro', 'rubro', 'category']), 180),
      subcategory: clean(firstDefined(raw, [cfg.fieldSubcategory, 'Desc_Subrubro', 'subrubro', 'subcategory']), 180),
    };
  }).filter(product => product?.code);
}

function mergeConfirmedCommercialProducts(existing, incoming) {
  const byCode = new Map();
  for (const product of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const code = String(product?.code || '').trim().toUpperCase();
    if (code) byCode.set(code, product);
  }
  return [...byCode.values()].slice(-500);
}

function catalogProductsMentionedInReply(reply, products, currentCode) {
  const text = String(reply || '').toUpperCase();
  const current = String(currentCode || '').trim().toUpperCase();
  const seen = new Set();
  return (Array.isArray(products) ? products : []).filter(product => {
    const code = String(product?.code || '').trim().toUpperCase();
    if (!code || code === current || seen.has(code)) return false;
    const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactCode = new RegExp(`(^|[^A-Z0-9])${escapedCode}(?=$|[^A-Z0-9])`, 'i');
    if (!exactCode.test(text)) return false;
    seen.add(code);
    return true;
  });
}

function selectConfirmedCatalogProducts(reply, products, currentProduct, message) {
  const currentCode = String(currentProduct?.code || '').trim().toUpperCase();
  const unique = mergeConfirmedCommercialProducts([], products)
    .filter(item => String(item?.code || '').trim().toUpperCase() !== currentCode)
    .filter(item => Number(item?.price) > 0);
  const mentioned = catalogProductsMentionedInReply(reply, unique, currentProduct?.code);
  let candidates = mentioned.length ? mentioned : unique;
  const currentSubcategory = String(currentProduct?.subcategory || '').trim().toUpperCase();
  const sameSubcategory = currentSubcategory
    ? candidates.filter(item => String(item?.subcategory || '').trim().toUpperCase() === currentSubcategory)
    : [];
  if (!mentioned.length && currentSubcategory) candidates = sameSubcategory;
  if (/(?:m[aá]s\s+(?:econ[oó]mic|barat)|menor\s+precio)/i.test(String(message || ''))) {
    candidates = candidates.filter(item => Number(item.price) < Number(currentProduct?.price || 0));
    candidates.sort((a, b) => Number(b.price) - Number(a.price));
  } else {
    candidates.sort((a, b) => Math.abs(Number(a.price) - Number(currentProduct?.price || 0)) - Math.abs(Number(b.price) - Number(currentProduct?.price || 0)));
  }
  return candidates.slice(0, 4);
}

function deterministicCatalogNarrative(products, message) {
  if (!products.length) {
    return /(?:m[aá]s\s+(?:econ[oó]mic|barat)|menor\s+precio)/i.test(String(message || ''))
      ? 'No encontré una alternativa más económica confirmada en el catálogo actual.'
      : 'No encontré otra alternativa comparable confirmada en el catálogo actual.';
  }
  return products.map(product =>
    `• ${clean(product.description, 105)} (SKU: ${clean(product.code, 80)})`
  ).join('\n');
}

function authoritativeCatalogPricesBlock(products, cfg) {
  const rows = [];
  for (const product of products || []) {
    const validPrices = (Array.isArray(product?.prices) ? product.prices : []).filter(item => item?.value != null);
    if (!validPrices.length) continue;
    const priceParts = validPrices.map((item, index) => {
      const label = clean(item.label || (index === 0 ? cfg.priceLabel : '') || item.note || `Precio ${index + 1}`, 80);
      return `${label}: ${formatQrCommercialMoney(item.value, cfg.currency)}`;
    });
    rows.push(`- SKU ${clean(product.code, 80)}: ${priceParts.join(' | ')}`);
  }
  return rows.length ? ['Precios informados por el catálogo:', ...rows].join('\n') : '';
}

async function resolveRequestedCommercialProduct(db, cfg, tenant, conversation, message, currentProduct) {
  if (!requestsCommercialData(message)) return { requested: false, product: null, unresolved: false };
  if (refersToCurrentQrProduct(message, currentProduct)) {
    return { requested: true, product: currentProduct, unresolved: false };
  }

  const recentAssistantMessages = await db.collection('messages')
    .find({ tenantId: tenant, conversationId: conversation._id, role: 'assistant' })
    .sort({ ts: -1, createdAt: -1 })
    .limit(8)
    .project({ content: 1 })
    .toArray();
  const candidates = alternativeProductCodes(recentAssistantMessages, currentProduct?.code);
  const confirmedProducts = Array.isArray(conversation?.qrConfirmedCommercialProducts)
    ? conversation.qrConfirmedCommercialProducts
    : [];
  for (const candidate of candidates) {
    const confirmed = confirmedProducts.find(item => String(item?.code || '').toUpperCase() === candidate.toUpperCase());
    if (confirmed) return { requested: true, product: confirmed, unresolved: false };
  }
  const alternativeDiscussed = recentAssistantMessages.some(item =>
    /(?:alternativ|similar|otra\s+opci[oó]n|otro\s+producto|recomendar[ií]a|m[aá]s\s+potencia)/i.test(String(item?.content || ''))
  );

  for (const candidate of candidates) {
    try {
      const resolved = await fetchQrProduct(cfg, tenant, candidate);
      if (resolved?.code) return { requested: true, product: resolved, unresolved: false };
    } catch (e) {
      console.warn(`[qr] alternative commercial lookup tenant=${tenant} sku=${candidate} error=${e?.message || e}`);
    }
  }

  if (alternativeDiscussed && confirmedProducts.length === 1) {
    return { requested: true, product: confirmedProducts[0], unresolved: false };
  }
  if (candidates.length || alternativeDiscussed) return { requested: true, product: null, unresolved: true };
  return { requested: true, product: currentProduct, unresolved: false };
}

function authoritativeCommercialBlock(product, cfg) {
  const prices = Array.isArray(product.prices) ? product.prices.filter(item => item?.value != null) : [];
  const lines = ['Datos comerciales del producto:'];
  if (!prices.length) {
    lines.push('- Precio: Consultar');
  } else {
    prices.forEach((item, index) => {
      const label = clean(item.label || (index === 0 ? cfg.priceLabel : '') || item.note || `Precio ${index + 1}`, 80);
      const note = item.note && item.note !== label ? ` (${clean(item.note, 180)})` : '';
      lines.push(`- ${label}: ${formatQrCommercialMoney(item.value, cfg.currency)}${note}`);
    });
  }
  const availability = product.available === true ? 'Disponible' : (product.available === false ? 'Sin disponibilidad' : 'Consultar');
  lines.push(`- Disponibilidad: ${availability}`);
  return lines.join('\n');
}

function qrDirectWebSearchQuery(product) {
  const parts = [];
  const description = clean(product?.description, 600);
  const brand = clean(product?.brand, 180);
  if (description) parts.push(description);
  if (brand && !description.toLowerCase().includes(brand.toLowerCase())) parts.push(brand);
  return parts.join(' ').trim().slice(0, 1200);
}

function qrCatalogAlternativeHint(product) {
  const description = clean(product?.description, 400);
  const category = clean(product?.category, 120);
  const subcategory = clean(product?.subcategory, 120);

  const words = String(subcategory || description || '')
    .toUpperCase()
    .replace(/[^A-ZÁÉÍÓÚÜÑ0-9]+/g, ' ')
    .split(/\s+/)
    .map(v => v.trim())
    .filter(v => v.length >= 4);

  const variants = [];
  for (const word of words.slice(0, 4)) {
    if (!variants.includes(word)) variants.push(word);
    let singular = word;
    if (word.endsWith('ES') && word.length > 5) singular = word.slice(0, -2);
    else if (word.endsWith('S') && word.length > 4) singular = word.slice(0, -1);
    if (singular.length >= 4 && !variants.includes(singular)) variants.push(singular);
  }

  const broadExamples = variants.slice(0, 4).map(v => `%${v}%`);

  return [
    '[REGLA DE BÚSQUEDA DE ALTERNATIVAS EN EL CATÁLOGO]',
    'Si el visitante pide "otro", "similar", "alternativa", "qué otros tienen" o un producto relacionado que el negocio podría vender, usá consulta_articulos.',
    'No busques únicamente con la descripción completa del producto QR ni con especificaciones demasiado restrictivas.',
    'Empezá con el patrón amplio sugerido para el tipo o subrubro; después refiná sólo si hace falta. No reutilices alternativas mencionadas en turnos anteriores si no aparecen en el resultado actual.',
    'Podés hacer hasta tres búsquedas distintas antes de concluir que no hay alternativas.',
    'La última búsqueda debe ser amplia por tipo/subrubro del producto.',
    subcategory ? `Subrubro del producto actual: ${subcategory}.` : '',
    category ? `Rubro del producto actual: ${category}.` : '',
    description ? `Descripción del producto actual: ${description}.` : '',
    broadExamples.length ? `Patrones amplios sugeridos para intentar si hace falta: ${broadExamples.join(', ')}.` : '',
    'No concluyas que el negocio no tiene alternativas si una búsqueda específica devolvió vacío. Solo podés afirmarlo después de haber probado una búsqueda amplia razonable con consulta_articulos.',
    'Internet no confirma productos del negocio: para nombre, SKU, precio y disponibilidad, la fuente válida sigue siendo consulta_articulos.',
    'Al presentar alternativas, mostrales primero únicamente los datos devueltos por consulta_articulos. No solicites búsqueda web ni agregues características externas en este turno.',
    'Mostrá como máximo 4 opciones, una línea breve por producto, e incluí siempre su SKU exacto. El servidor agregará los precios confirmados.',
    'Si después el visitante pide características de una opción concreta, recién en ese turno podés solicitar búsqueda web y responder de forma breve.'
  ].filter(Boolean).join('\n');
}

function qrWebResultContext(result) {
  if (result?.ok && result?.body) {
    const sourceLines = (Array.isArray(result.sources) ? result.sources : [])
      .slice(0, 5)
      .map((src, i) => `${i + 1}. ${clean(src?.title || 'Fuente', 180)} - ${clean(src?.url || '', 600)}`)
      .filter(Boolean);
    return [
      '[INFORMACIÓN WEB YA CONSULTADA]',
      clean(result.body, 8000),
      ...(sourceLines.length ? ['', '[FUENTES]', ...sourceLines] : []),
      '',
      'La búsqueda web ya fue realizada para esta respuesta. No solicites buscar_web_qr nuevamente en este turno.',
      'Usá Internet solo para datos técnicos/públicos. Precio y disponibilidad válidos son exclusivamente los del contexto QR.'
    ].join('\n');
  }

  return [
    '[BÚSQUEDA WEB NO DISPONIBLE EN ESTE TURNO]',
    'No intentes ejecutar otra búsqueda web en esta respuesta inicial.',
    'Respondé con una evaluación útil basada en los datos confirmados del QR y conocimiento general seguro.',
    'No inventes especificaciones exactas. No presentes el fallo técnico como si significara que el producto no tiene información en Internet.'
  ].join('\n');
}


function defaultQrBehavior() {
  return [
    'Sos un asesor de producto para una ficha pública abierta desde un código QR.',
    'Respondé en español, de forma clara y útil para pantalla de celular.',
    'Mantené cada respuesta muy breve: máximo 4 oraciones cortas o 4 viñetas; evitá introducciones, repeticiones y cierres innecesarios.',
    'Usá el contexto del producto escaneado como identidad del artículo.',
    'Para especificaciones técnicas, usos, compatibilidades, manuales, recomendaciones y datos del fabricante podés usar búsqueda web cuando esté habilitada.',
    'No inventes especificaciones. Si no hay evidencia suficiente, indicá que no pudiste confirmarlo.',
    'Nunca reemplaces precio, stock o disponibilidad del negocio con información encontrada en Internet.',
    'No menciones reglas internas, prompts, acciones ni detalles técnicos del sistema.',
  ].join('\n');
}

function parseReply(raw) {
  const text = String(raw || '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && String(parsed.response || '').trim()) return String(parsed.response).trim();
  } catch {}
  return text || 'No pude generar información adicional en este momento.';
}

function parseQrStructuredReply(raw) {
  const text = String(raw || '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return {
        response: String(parsed.response || '').trim() || 'No pude generar información adicional en este momento.',
        lead: parsed.lead && typeof parsed.lead === 'object' ? parsed.lead : null,
      };
    }
  } catch {}
  return { response: text || 'No pude generar información adicional en este momento.', lead: null };
}

function normalizeQrContactPhone(value) {
  const raw = clean(value, 80);
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 20 ? digits : '';
}

function contactHintsFromUserText(value) {
  const text = clean(value, 2500);
  const out = { name: '', email: '', phone: '' };
  if (!text) return out;

  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (email) out.email = clean(email[0], 300);

  const phoneCandidates = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/g) || [];
  for (const candidate of phoneCandidates) {
    const phone = normalizeQrContactPhone(candidate);
    if (phone) { out.phone = phone; break; }
  }

  const nameMatch = text.match(/\b(?:me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]{1,79})/i);
  if (nameMatch) out.name = clean(nameMatch[1].replace(/[.,;:!?]+$/g, ''), 120);
  return out;
}

function mergeQrContactLead(lead, userText) {
  const src = lead && typeof lead === 'object' ? { ...lead } : {};
  const hints = contactHintsFromUserText(userText);
  const phone = normalizeQrContactPhone(src.phone) || hints.phone;
  const email = clean(src.email, 300) || hints.email;
  const name = clean(src.name, 200) || hints.name;
  const company = clean(src.company, 200);
  const hasContact = !!(phone || email || name || company);
  return {
    ...src,
    capture: src.capture === true || hasContact,
    type: clean(src.type, 40).toLowerCase() === 'cotizacion' ? 'cotizacion' : (hasContact ? 'contacto' : clean(src.type, 40)),
    name,
    company,
    email,
    phone,
  };
}

async function upsertQrContactLead(db, { tenant, conversationId, waId, lead, userText }) {
  const normalized = mergeQrContactLead(lead, userText);
  if (normalized.capture !== true) return null;

  const now = new Date();
  const oid = conversationId instanceof ObjectId ? conversationId : new ObjectId(String(conversationId));
  const leadType = String(normalized.type || '').toLowerCase() === 'cotizacion' ? 'cotizacion' : 'contacto';
  const filter = { tenantId: tenant, source: 'qr_web', conversationId: oid };
  const set = {
    tenantId: tenant,
    source: 'qr_web',
    conversationId: oid,
    channelType: 'qr_web',
    waId: clean(waId, 120),
    leadType,
    status: 'open',
    updatedAt: now,
    lastMessage: clean(userText, 2000),
  };

  for (const [key, max] of Object.entries({ name: 200, company: 200, email: 300 })) {
    const value = clean(normalized[key], max);
    if (value) set[key] = value;
  }
  const phone = normalizeQrContactPhone(normalized.phone);
  if (phone) set.phone = phone;

  const quote = {
    origin: clean(normalized.origin, 300),
    destination: clean(normalized.destination, 300),
    cargo: clean(normalized.cargo, 800),
    packages: clean(normalized.packages, 300),
    weight: clean(normalized.weight, 300),
    dimensions: clean(normalized.dimensions, 500),
    notes: clean(normalized.notes, 1000),
  };
  for (const [key, value] of Object.entries(quote)) if (value) set[`quote.${key}`] = value;

  const result = await db.collection('leads').findOneAndUpdate(
    filter,
    {
      $set: set,
      $setOnInsert: {
        createdAt: now,
        message: clean(userText, 2000),
        quoteReady: false,
        page: 'bot/qr_web',
      },
    },
    { upsert: true, returnDocument: 'after' }
  );
  let doc = result?.value || result || null;
  if (!doc?._id) doc = await db.collection('leads').findOne(filter).catch(() => null);

  const leadId = doc?._id || null;
  const convSet = { hasLead: true, leadType, leadUpdatedAt: now };
  if (leadId) convSet.leadId = leadId;
  if (set.name) convSet.contactName = set.name;
  if (phone) convSet.contactPhone = phone;
  if (set.email) convSet.contactEmail = set.email;

  await db.collection('conversations').updateOne(
    { _id: oid, tenantId: tenant },
    { $set: convSet }
  );

  console.log(`[qr] contacto guardado tenant=${tenant} conv=${String(oid)} name=${set.name ? 'si' : 'no'} phone=${phone ? 'si' : 'no'} email=${set.email ? 'si' : 'no'}`);
  return doc;
}

function cleanupRateState(now, windowMs) {
  if (now - lastRateCleanupAt < 60000 && rateState.size < 5000) return;
  lastRateCleanupAt = now;
  for (const [key, state] of rateState) {
    if (!state || now - Number(state.start || 0) > windowMs) rateState.delete(key);
  }
  while (rateState.size > 10000) rateState.delete(rateState.keys().next().value);
}

function allowAiRequest(req, sessionId) {
  const ip = clean(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '', 120).split(',')[0].trim();
  const key = `${ip}|${safeSessionId(sessionId)}`;
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const max = 30;
  cleanupRateState(now, windowMs);
  const state = rateState.get(key);
  if (!state || now - state.start > windowMs) {
    rateState.set(key, { start: now, count: 1 });
    return true;
  }
  state.count += 1;
  return state.count <= max;
}

function qrPublicBranding(cfg) {
  return {
    pageTitle: cfg.pageTitle,
    pageSubtitle: cfg.pageSubtitle,
    companyName: cfg.companyName,
    companyLogoUrl: cfg.companyLogoUrl,
    buttonColor: cfg.buttonColor,
    buttonTextColor: cfg.buttonTextColor,
  };
}

function pageHtml({ tenant, code, branding = {} }) {
  return String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Producto</title>
<style>
:root{--bg:#f1f5f7;--card:#fff;--text:#10243e;--muted:#667085;--line:#d8e2e8;--primary:#0e6b66;--primary2:#095853;--soft:#e8f5f3;--danger:#b42318;--shadow:0 10px 28px rgba(16,24,40,.10)}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text)}button,textarea{font:inherit}.page{max-width:760px;margin:0 auto;padding:14px 12px 28px}.brand{display:flex;align-items:center;gap:9px;padding:4px 3px 12px}.brandMark{width:38px;height:38px;border-radius:10px;background:var(--primary);color:var(--buttonText);display:grid;place-items:center;font-weight:900;flex:0 0 auto}.brandLogo{width:46px;height:46px;object-fit:contain;border-radius:8px;background:#fff;flex:0 0 auto}.brandText{min-width:0}.brandText b{display:block;font-size:16px;line-height:1.15}.brandText span{display:block;font-size:11px;color:var(--muted);margin-top:2px}.brandText small{display:block;font-size:10px;color:var(--muted);margin-top:2px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}.hero{display:none;max-height:330px;background:#fff;border-bottom:1px solid var(--line);align-items:center;justify-content:center}.hero img{display:block;width:100%;max-height:330px;object-fit:contain;padding:14px}.content{padding:18px}.eyebrow{font-size:11px;color:var(--primary);font-weight:850;text-transform:uppercase;letter-spacing:.06em}.title{font-size:24px;line-height:1.15;margin:6px 0 8px}.productMeta{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px}.sku{font-size:12px;color:var(--muted)}.availabilityBadge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:800;line-height:1.2}.availabilityBadge.available{color:#067647;background:#ecfdf3;border:1px solid #abefc6}.availabilityBadge.unavailable{color:#b42318;background:#fef3f2;border:1px solid #fecdca}.availabilityBadge.unknown{color:#475467;background:#f2f4f7;border:1px solid #eaecf0}.facts{display:grid;grid-template-columns:1fr 1fr;gap:10px}.fact{background:#f8fafb;border:1px solid #e7edf0;border-radius:12px;padding:11px}.fact label{display:block;color:var(--muted);font-size:10px;font-weight:750;text-transform:uppercase}.fact b{display:block;margin-top:3px;font-size:15px}.priceFact{grid-column:1/-1}.priceMain{font-size:19px;font-weight:850;margin-top:4px}.priceMainNote{font-size:12px;color:#475467;margin-top:2px}.priceExtra{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px;margin-top:5px;font-size:13px;color:#344054}.priceExtra strong{font-size:14px;color:var(--text)}.priceExtraLabel{font-weight:700;color:#667085}.actions{display:grid;grid-template-columns:1fr;gap:9px;margin-top:16px}.btn{border:1px solid var(--line);background:#fff;border-radius:12px;padding:12px 14px;font-weight:800;cursor:pointer;color:var(--text)}.btnPrimary{background:var(--primary);border-color:var(--primary);color:var(--buttonText)}.btnPrimary:active{filter:brightness(.9)}.btnWithLogo{display:flex;align-items:center;justify-content:center;gap:10px}.btnWithLogo img{width:22px;height:22px;object-fit:contain;background:#fff;border-radius:6px;padding:2px}.btn:disabled{opacity:.55;cursor:default}.error{padding:24px;text-align:center;color:var(--danger)}.loading{padding:26px;text-align:center;color:var(--muted)}.chat{display:none;margin-top:14px;background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}.chat.open{display:flex;flex-direction:column}.chatHead{padding:12px 14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:8px}.chatHead b{font-size:14px}.chatHead span{font-size:10px;color:var(--muted)}.chatBody{min-height:250px;max-height:52vh;overflow:auto;padding:13px;background:#f7f9fa}.msg{display:flex;margin:8px 0}.msg.user{justify-content:flex-end}.bubble{max-width:88%;padding:10px 11px;border-radius:13px;font-size:13px;line-height:1.45;overflow-wrap:anywhere}.msg.user .bubble{background:#dff6e9;border:1px solid #c5ead5;border-bottom-right-radius:4px}.msg.bot .bubble{background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}.meta{display:block;font-size:9px;color:#98a2b3;margin-top:5px}.composer{padding:10px;border-top:1px solid var(--line);background:#fff}.composeRow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.composer textarea{width:100%;min-height:54px;max-height:130px;resize:vertical;border:1px solid var(--line);border-radius:11px;padding:10px;outline:none}.send{height:54px;min-width:86px}.typing{display:inline-flex;gap:4px}.typing i{width:5px;height:5px;background:#98a2b3;border-radius:50%;animation:pulse 1.1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes pulse{0%,80%,100%{opacity:.3}40%{opacity:1}}.footer{text-align:center;color:#98a2b3;font-size:10px;padding:18px 4px 8px}.powered{margin-top:9px;display:flex;align-items:center;justify-content:center;gap:5px;font-size:11px;color:#667085}.powered img{width:18px;height:18px;object-fit:contain}.powered a{color:var(--primary);text-decoration:none;font-weight:700}.hidden{display:none!important}
 @media(max-width:520px){.page{padding:8px 8px 20px}.content{padding:15px}.title{font-size:21px}.facts{grid-template-columns:1fr}.chatBody{max-height:48vh}.composeRow{grid-template-columns:1fr}.send{height:42px}.bubble{max-width:94%}}
.lookup{margin-bottom:14px}.lookupForm{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:12px}.lookupForm input{width:100%;min-width:0;border:1px solid var(--line);border-radius:11px;padding:12px;outline:none;font:inherit}.scanner{margin-top:12px}.scanner video{display:block;width:100%;max-height:360px;object-fit:cover;border-radius:12px;background:#101828}.scanStatus{font-size:12px;color:var(--muted);margin:8px 0}
</style>
</head>
<body>
<div class="page">
  <div class="brand"><div class="brandMark" id="brandMark">A</div><img class="brandLogo hidden" id="companyLogo" alt="Logo de la empresa"/><div class="brandText"><b id="companyName">Información del producto</b><span id="pageTitle">Información del producto</span><small id="pageSubtitle">Cargando ficha…</small></div></div>
  <section class="card lookup" id="lookup"><div class="content"><div class="eyebrow">Buscar producto</div><h1 class="title">Escaneá o ingresá el código</h1><button class="btn btnPrimary" id="scanBtn" type="button">Abrir cámara</button><div class="lookupForm"><input id="codeInput" type="text" maxlength="180" autocomplete="off" placeholder="Código, SKU o código de barras"/><button class="btn" id="lookupBtn" type="button">Buscar</button></div><div class="scanner hidden" id="scanner"><video id="scanVideo" playsinline muted></video><div class="scanStatus" id="scanStatus">Apuntá al QR o al código de barras.</div><button class="btn" id="stopScanBtn" type="button">Cerrar cámara</button></div></div></section>
  <section class="card" id="productCard"><div class="loading">Consultando producto…</div></section>
  <section class="chat" id="chat">
    <div class="chatHead"><div><b>Asistente del producto</b><br/><span id="chatProduct"></span></div><button class="btn" id="closeChat" type="button">Cerrar</button></div>
    <div class="chatBody" id="chatBody"></div>
    <div class="composer"><div class="composeRow"><textarea id="message" maxlength="2500" placeholder="Preguntá sobre uso, características, compatibilidad…"></textarea><button class="btn btnPrimary send" id="sendBtn" type="button">Enviar</button></div></div>
  </section>
 <div class="footer"><div>Información comercial obtenida del sistema del negocio. La información ampliada puede utilizar IA y fuentes públicas de Internet.</div><div class="powered">Powered by <img src="/static/logo.png" alt="Asisto"/><strong>Asisto</strong> · <a href="https://www.asistobot.com.ar" target="_blank" rel="noopener">www.asistobot.com.ar</a></div></div>
</div>
<script>
const TENANT=${JSON.stringify(tenant)};
const BRANDING=${JSON.stringify(branding)};
let CODE=${JSON.stringify(code)};
let PRODUCT=null, AI_ENABLED=false, sending=false, started=false, conversationId='', pollTimer=null, unchangedPolls=0, lastMessagesSignature='', scanStream=null, scanFrame=0, scanCandidate='', scanHits=0, scanCandidateAt=0;
const el=id=>document.getElementById(id);
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function sessionId(){let s=sessionStorage.getItem('asistoQrSession');if(!s){try{s=crypto.randomUUID().replace(/-/g,'_')}catch(_){s='qr_'+Date.now()+'_'+Math.random().toString(36).slice(2)}sessionStorage.setItem('asistoQrSession',s)}return s}
function money(v,currency){if(v==null||v==='')return 'Consultar';try{return new Intl.NumberFormat('es-AR',{style:'currency',currency:currency||'ARS',maximumFractionDigits:2}).format(Number(v))}catch{return '$ '+Number(v).toLocaleString('es-AR',{maximumFractionDigits:2})}}
function richText(s){let x=esc(s);x=x.replace(/\*([^*\n]+)\*/g,'<strong>$1</strong>');x=x.replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');return x.replace(/\n/g,'<br>')}
function now(){return new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}
function msgTime(v){if(!v)return now();const d=new Date(v);return isNaN(d)?now():d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}
function addMsg(role,text,typing=false,label='',at='',autoScroll=true){const row=document.createElement('div');row.className='msg '+(role==='user'?'user':'bot');if(typing)row.id='typing';const who=label||(role==='user'?'Vos':'Asisto');row.innerHTML='<div class="bubble">'+(typing?'<span class="typing"><i></i><i></i><i></i></span>':richText(text))+'<span class="meta">'+esc(who)+' · '+esc(msgTime(at))+'</span></div>';const body=el('chatBody');body.appendChild(row);if(autoScroll)body.scrollTop=body.scrollHeight}
function removeTyping(){const n=el('typing');if(n)n.remove()}
function renderServerMessages(items){
  const body=el('chatBody');
  const list=Array.isArray(items)?items:[];
  const signature=JSON.stringify(list.map(m=>[String(m._id||m.id||''),String(m.role||''),String(m.content||''),String(m.createdAt||''),m.fromOperator===true]));
  if(signature===lastMessagesSignature)return false;

  const hadMessages=body.children.length>0;
  const previousTop=body.scrollTop;
  const distanceFromBottom=body.scrollHeight-body.scrollTop-body.clientHeight;
  const wasNearBottom=!hadMessages||distanceFromBottom<=80;

  body.innerHTML='';
  for(const m of list){
    const role=String(m.role||'')==='user'?'user':'bot';
    const label=role==='user'?'Vos':(m.fromOperator?'Asesor':'Asisto');
    addMsg(role,m.content||'',false,label,m.createdAt,false);
  }
  lastMessagesSignature=signature;
  if(wasNearBottom)body.scrollTop=body.scrollHeight;
  else body.scrollTop=previousTop;
  return true;
}
async function syncChatMessages(force=false){if(sending&&!force)return false;try{const u=new URL('/api/ext/qr/chat/messages',location.origin);u.searchParams.set('tenant',TENANT);u.searchParams.set('codigo',CODE);u.searchParams.set('sessionId',sessionId());const j=await jsonFetch(u.toString());if(j.conversationId)conversationId=j.conversationId;return Array.isArray(j.items)?renderServerMessages(j.items):false}catch(_){return false}}
function scheduleChatPoll(delay){if(pollTimer)return;pollTimer=setTimeout(runChatPoll,delay)} async function runChatPoll(){pollTimer=null;let changed=false;const active=started&&el('chat').classList.contains('open')&&!sending&&!document.hidden;if(active)changed=await syncChatMessages(false);unchangedPolls=changed?0:Math.min(unchangedPolls+1,20);const delay=document.hidden?30000:(!active?15000:(unchangedPolls<2?3000:(unchangedPolls<6?7000:15000)));scheduleChatPoll(delay)} function startChatPolling(){scheduleChatPoll(3000)}
async function jsonFetch(url,opts={}){const r=await fetch(url,{cache:'no-store',...opts});const text=await r.text();let j={};try{j=text?JSON.parse(text):{}}catch{}if(!r.ok)throw new Error(j.detail||j.error||('HTTP '+r.status));return j}
function safeColor(v,fallback){const x=String(v||'').trim();return /^#[0-9a-f]{6}$/i.test(x)?x:fallback}
function applyBranding(j){const company=String(j.companyName||'').trim()||j.pageTitle||'Información del producto';el('companyName').textContent=company;el('pageTitle').textContent=j.pageTitle||'Información del producto';el('pageSubtitle').textContent=j.pageSubtitle||'';document.documentElement.style.setProperty('--primary',safeColor(j.buttonColor,'#0f766e'));document.documentElement.style.setProperty('--buttonText',safeColor(j.buttonTextColor,'#ffffff'));const logo=el('companyLogo'),mark=el('brandMark');if(j.companyLogoUrl){logo.src=j.companyLogoUrl;logo.classList.remove('hidden');mark.classList.add('hidden');logo.onerror=()=>{logo.classList.add('hidden');mark.classList.remove('hidden')}}else{logo.classList.add('hidden');mark.classList.remove('hidden')}mark.textContent=(company.trim().charAt(0)||'A').toUpperCase()}
function renderPrices(p,currency){
  const prices=Array.isArray(p.prices)&&p.prices.length?p.prices:[{label:'Precio',note:'',value:p.price,primary:true}];
  const valid=prices.filter(x=>x&&x.value!==null&&x.value!==undefined&&x.value!=='');
  if(!valid.length)return '<div class="priceMain">Consultar</div>';
  const first=valid[0];
  let html='<div class="priceMain">'+esc(money(first.value,currency))+'</div>';
  if(first.note)html+='<div class="priceMainNote">'+esc(first.note)+'</div>';
  for(let i=1;i<valid.length;i++){
    const item=valid[i];
    html+='<div class="priceExtra">'+(item.label?'<span class="priceExtraLabel">'+esc(item.label)+':</span>':'')+'<strong>'+esc(money(item.value,currency))+'</strong>'+(item.note?'<span>'+esc(item.note)+'</span>':'')+'</div>';
  }
  return html;
}
function renderProduct(j){
  PRODUCT=j.product;
  AI_ENABLED=j.aiEnabled===true;
  document.title=PRODUCT.description||'Producto';

  applyBranding(j);

  const p=PRODUCT;
  const availability=p.available===true
    ? '<span class="availabilityBadge available">Disponible</span>'
    : (p.available===false
      ? '<span class="availabilityBadge unavailable">Sin disponibilidad</span>'
      : '<span class="availabilityBadge unknown">Consultar disponibilidad</span>');

  const imageHtml=p.image
    ? '<div class="hero" style="display:flex"><img src="'+esc(p.image)+'" alt="'+esc(p.description)+'"/></div>'
    : '';

  el('productCard').innerHTML=imageHtml+
    '<div class="content">'+
      '<div class="eyebrow">Ficha del producto</div>'+
      '<h1 class="title">'+esc(p.description)+'</h1>'+
      '<div class="productMeta"><span class="sku">(SKU: '+esc(p.code)+')</span>'+availability+'</div>'+
      '<div class="facts">'+
        '<div class="fact priceFact"><label>Precio</label>'+renderPrices(p,j.currency)+'</div>'+
        (p.brand?'<div class="fact"><label>Marca</label><b>'+esc(p.brand)+'</b></div>':'')+
        (p.subcategory?'<div class="fact"><label>Categoría</label><b>'+esc(p.subcategory)+'</b></div>':'')+
      '</div>'+
      (AI_ENABLED?'<div class="actions"><button class="btn btnPrimary btnWithLogo" id="moreBtn" type="button"><span>Mostrar más info</span></button></div>':'')+
      '<div class="actions"><button class="btn" id="otherProductBtn" type="button">Escanear o ingresar otro producto</button></div>'+
    '</div>';

  el('chatProduct').textContent=p.description+' · SKU '+p.code;
  if(AI_ENABLED&&el('moreBtn'))el('moreBtn').addEventListener('click',startAi);
  el('otherProductBtn').addEventListener('click',openScannerPanel);
}
function normalizedCode(value){let code=String(value||'').trim();if(!code)return '';try{const u=new URL(code,location.origin);if(/^https?:/i.test(code)){const extracted=u.searchParams.get('codigo')||((u.pathname.match(/^\/qr\/[^/]+\/(.+)$/)||[])[1]);if(!extracted)return '' ;code=extracted}}catch(_){}try{code=decodeURIComponent(code).trim()}catch(_){}return code} function openCode(value){const code=normalizedCode(value);if(!code)return;stopScanner();location.href='/qr/'+encodeURIComponent(TENANT)+'?codigo='+encodeURIComponent(code)} function openScannerPanel(){el('lookup').classList.remove('hidden');el('lookup').scrollIntoView({behavior:'smooth',block:'start'});startScanner()}
function stopScanner(hide=true){if(scanFrame)cancelAnimationFrame(scanFrame);scanFrame=0;if(scanStream){for(const track of scanStream.getTracks())track.stop();scanStream=null}el('scanBtn').classList.remove('hidden');if(hide)el('scanner').classList.add('hidden')}
async function startScanner(){stopScanner(false);el('scanBtn').classList.add('hidden');const status=el('scanStatus'),video=el('scanVideo');el('scanner').classList.remove('hidden');video.classList.remove('hidden');scanCandidate='';scanHits=0;scanCandidateAt=0;status.textContent='Apuntá al QR o al código de barras.';if(!navigator.mediaDevices?.getUserMedia){status.textContent='La cámara no está disponible en este navegador. Ingresá el código manualmente.';el('scanBtn').classList.remove('hidden');return}if(!('BarcodeDetector' in window)){status.textContent='Este navegador no admite lectura automática. Ingresá el código manualmente.';el('scanBtn').classList.remove('hidden');return}try{const supported=await BarcodeDetector.getSupportedFormats();const wanted=['qr_code','ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf','codabar'].filter(x=>supported.includes(x));const detector=new BarcodeDetector({formats:wanted});scanStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});video.srcObject=scanStream;await video.play();const detect=async()=>{if(!scanStream)return;try{const found=await detector.detect(video);const code=normalizedCode(found[0]?.rawValue);if(code){if(code===scanCandidate){scanHits+=1}else{scanCandidate=code;scanHits=1;scanCandidateAt=Date.now()}status.textContent='Leyendo: '+code;if(scanHits>=4&&Date.now()-scanCandidateAt>=350){el('codeInput').value=code;stopScanner(false);video.classList.add('hidden');status.textContent='Código detectado: '+code+'. Buscando producto…';setTimeout(()=>openCode(code),450);return}}else{scanCandidate='';scanHits=0}}catch(_){}scanFrame=requestAnimationFrame(detect)};detect()}catch(_){stopScanner(false);video.classList.add('hidden');status.textContent='No se pudo abrir la cámara. Podés ingresar el código manualmente.'}}
async function loadProduct(){try{el('productCard').innerHTML='<div class="loading">Consultando producto...</div>';const u=new URL('/api/ext/qr/product',location.origin);u.searchParams.set('tenant',TENANT);u.searchParams.set('codigo',CODE);renderProduct(await jsonFetch(u.toString()))}catch(e){el('productCard').innerHTML='<div class="error"><b>No encontramos este producto.</b><br/><span>Código consultado: '+esc(CODE)+'</span><br/><span>'+esc(e.message)+'</span><div class="actions"><button class="btn btnPrimary" id="rescanProductBtn" type="button">Escanear o ingresar otro código</button></div></div>';const sb=el('rescanProductBtn');if(sb)sb.addEventListener('click',openScannerPanel)}}
 async function callAi(message,initial=false){if(sending)return;sending=true;const btn=el('sendBtn');if(btn)btn.disabled=true;if(message&&!initial)addMsg('user',message);addMsg('bot','',true);try{const j=await jsonFetch('/api/ext/qr/chat',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({tenant:TENANT,codigo:CODE,sessionId:sessionId(),message:message||'',initial})});removeTyping();if(j.conversationId)conversationId=j.conversationId;started=true;await syncChatMessages(true);startChatPolling()}catch(e){removeTyping();addMsg('bot','No pude obtener información adicional en este momento. '+e.message)}finally{sending=false;if(btn)btn.disabled=false}}
async function startAi(){el('chat').classList.add('open');el('chat').scrollIntoView({behavior:'smooth',block:'start'});if(!started){const b=el('moreBtn');if(b)b.disabled=true;await callAi('',true);if(b)b.disabled=false}else{await syncChatMessages(true);startChatPolling();el('message').focus()}}
async function send(){const box=el('message');const msg=String(box.value||'').trim();if(!msg||sending)return;box.value='';await callAi(msg,false);box.focus()}
el('sendBtn').addEventListener('click',send);el('message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});el('closeChat').addEventListener('click',()=>el('chat').classList.remove('open'));el('scanBtn').addEventListener('click',startScanner);el('stopScanBtn').addEventListener('click',stopScanner);el('lookupBtn').addEventListener('click',()=>openCode(el('codeInput').value));el('codeInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();openCode(e.currentTarget.value)}});window.addEventListener('pagehide',stopScanner);document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(pollTimer){clearTimeout(pollTimer);pollTimer=null}if(started)scheduleChatPoll(0)}});applyBranding(BRANDING);if(CODE){el('lookup').classList.add('hidden');loadProduct()}else{el('productCard').classList.add('hidden');if(!BRANDING.pageSubtitle)el('pageSubtitle').textContent='Escaneá un QR, un código de barras o ingresá el código manualmente.'}
</script>
</body>
</html>`;
}

function mountQrProductWeb(app) {
  if (!app || app.__asistoQrProductWebMounted) return;
  app.__asistoQrProductWebMounted = true;

  // Índices defensivos. No bloquean el arranque si Mongo todavía no está disponible.
  setImmediate(async () => {
    try {
      const db = await getDb();
      await Promise.all([
        db.collection('conversations').createIndex({ tenantId: 1, qrSessionId: 1, qrProductCode: 1, finalized: 1, updatedAt: -1 }),
        db.collection('messages').createIndex({ tenantId: 1, conversationId: 1, ts: 1 }),
      ]);
    } catch (e) {
      console.warn('[qr] indexes:', e?.message || e);
    }
  });

  // Formato recomendado para imprimir: /qr/DOMINIO?codigo=SKU
  // También se mantiene /qr/DOMINIO/SKU para códigos simples.
  app.get('/qr/:tenant', async (req, res) => {
    const tenant = safeTenant(req.params.tenant);
    const code = digitsOrText(req.query?.codigo, 180);
    if (!tenant) return res.status(404).send('Dominio inválido');
    const db = await getDb();
    const cfg = await loadQrConfig(db, tenant);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(pageHtml({ tenant, code, branding: qrPublicBranding(cfg) }));
  });

  app.get('/qr/:tenant/:codigo', async (req, res) => {
    const tenant = safeTenant(req.params.tenant);
    const code = digitsOrText(req.params.codigo, 180);
    if (!tenant || !code) return res.status(404).send('QR inválido');
    const db = await getDb();
    const cfg = await loadQrConfig(db, tenant);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(pageHtml({ tenant, code, branding: qrPublicBranding(cfg) }));
  });

  app.get('/api/ext/qr/product', async (req, res) => {
    try {
      const tenant = safeTenant(req.query?.tenant);
      const code = digitsOrText(req.query?.codigo, 180);
      if (!tenant || !code) return res.status(400).json({ ok: false, error: 'tenant_codigo_required' });
      const db = await getDb();
      const cfg = await loadQrConfig(db, tenant);
      const product = await fetchQrProduct(cfg, tenant, code);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        ok: true,
        build: QR_BUILD,
        tenant,
        currency: cfg.currency,
        pageTitle: cfg.pageTitle,
        pageSubtitle: cfg.pageSubtitle,
        companyName: cfg.companyName,
        companyLogoUrl: cfg.companyLogoUrl,
        buttonColor: cfg.buttonColor,
        buttonTextColor: cfg.buttonTextColor,
        aiEnabled: cfg.aiEnabled,
        product,
      });
    } catch (e) {
      const status = intValue(e?.statusCode, 500, 400, 599);
      console.error('[qr] product:', e?.message || e);
      return res.status(status).json({
        ok: false,
        error: clean(e?.message || 'internal', 200),
        detail: clean(e?.publicDetail || e?.message || 'internal', 300),
      });
    }
  });

  app.get('/api/ext/qr/chat/messages', async (req, res) => {
    try {
      const tenant = safeTenant(req.query?.tenant);
      const code = digitsOrText(req.query?.codigo, 180);
      const sid = safeSessionId(req.query?.sessionId);
      if (!tenant || !code || !sid) return res.status(400).json({ ok: false, error: 'tenant_codigo_session_required' });
      const db = await getDb();
      const conv = await db.collection('conversations').findOne(
        { tenantId: tenant, qrSessionId: sid, qrProductCode: code, channelType: 'qr_web', botMode: 'conversacional' },
        { sort: { updatedAt: -1, openedAt: -1 } }
      );
      if (!conv) return res.json({ ok: true, conversationId: '', manualOpen: false, items: [] });

      const messages = await db.collection('messages')
        .find({ tenantId: tenant, conversationId: conv._id })
        .sort({ ts: 1, createdAt: 1 })
        .limit(500)
        .toArray();

      return res.json({
        ok: true,
        conversationId: String(conv._id),
        manualOpen: conv.manualOpen === true,
        items: messages.map(m => ({
          _id: String(m._id),
          role: m.role,
          content: clean(m.content, 20000),
          createdAt: m.ts || m.createdAt,
          fromOperator: ['operator','admin'].includes(String(m?.meta?.from || '').toLowerCase()),
        })),
      });
    } catch (e) {
      console.error('[qr] chat messages:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.post('/api/ext/qr/chat', qrJson, async (req, res) => {
    const startedAt = Date.now();
    try {
      const tenant = safeTenant(req.body?.tenant);
      const code = digitsOrText(req.body?.codigo, 180);
      const sessionId = safeSessionId(req.body?.sessionId);
      const initial = req.body?.initial === true;
      const message = clean(req.body?.message, 2500);
      if (!tenant || !code) return res.status(400).json({ ok: false, error: 'tenant_codigo_required' });
      if (!initial && !message) return res.status(400).json({ ok: false, error: 'message_required' });
      if (!allowAiRequest(req, sessionId)) return res.status(429).json({ ok: false, error: 'rate_limit' });

      const db = await getDb();
      const cfg = await loadQrConfig(db, tenant);
      if (!cfg.enabled || !cfg.aiEnabled) return res.status(404).json({ ok: false, error: 'qr_ai_disabled' });
      const [product, apiKey] = await Promise.all([
        fetchQrProduct(cfg, tenant, code),
        resolveOpenAiKey(db, tenant),
      ]);
      if (!apiKey) return res.status(503).json({ ok: false, error: 'ai_not_configured' });

      const priorDifferentProduct = initial
        ? await db.collection('conversations').findOne({
            tenantId: tenant,
            qrSessionId: safeSessionId(sessionId),
            qrProductCode: { $ne: product.code },
            channelType: 'qr_web',
          }, { projection: { _id: 1 } })
        : null;
      const conv = await ensureQrConversation(db, tenant, sessionId, product, req);
      const convId = conv._id;
      const shownCatalogProducts = initial ? [] : await activeCatalogProducts(db, tenant, conv, product.code);
      const catalogFollowUp = !initial && shownCatalogProducts.length > 0 && requestsCatalogFollowUp(message);
      const waId = conv.waId || `QRWEB:${sessionId}`;
      let commercialResolution = priorDifferentProduct
        ? { requested: true, product, unresolved: false }
        : await resolveRequestedCommercialProduct(db, cfg, tenant, conv, message, product);
      const from = qrSessionFrom(sessionId, product.code);
      syncSessionConversation(tenant, from, String(convId));
      clearEndedFlag(tenant, from);

      const visibleUserText = initial
        ? `Solicitó más información sobre ${product.description} (SKU: ${product.code})`
        : message;
      await saveQrMessage(db, { tenant, conversationId: convId, waId, role: 'user', content: visibleUserText, product, meta: { initial } });

      if (conv.manualOpen === true) {
        return res.json({ ok: true, conversationId: String(convId), manual: true, reply: '' });
      }

      if (catalogFollowUp) {
        const reply = catalogFollowUpReply(shownCatalogProducts, message, cfg);
        await saveQrMessage(db, { tenant, conversationId: convId, waId, role: 'assistant', content: reply, product, meta: { catalogFollowUp: true } });
        console.log(`[qr] catalog follow-up tenant=${tenant} sku=${product.code} conv=${String(convId)} ms=${Date.now() - startedAt}`);
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ ok: true, conversationId: String(convId), reply, contactCaptured: false });
      }

      const ctx = productContext(product, cfg);
      const catalogRequest = !initial && requestsCatalogData(message);
      const behaviorOverride = cfg.aiUseSameBehavior
        ? undefined
        : (cfg.aiBehavior || defaultQrBehavior());

      // El primer turno evita búsquedas web para reducir drásticamente la latencia.
      const hiddenInstruction = initial
        ? [
            ctx,
            '',
            '[SOLICITUD DEL VISITANTE]',
            'El visitante tocó "Mostrar más info".',
            'Mostrá 4 viñetas breves: 2 datos técnicos concretos de la ficha y 2 aportes útiles que expliquen su beneficio práctico, uso recomendado o aspecto operativo. Podés repetir sólo las cifras técnicas esenciales; no copies la descripción completa. Escribí únicamente en español, sin introducción, despedida ni frases como "si querés". No busques en Internet; hacé sólo inferencias prudentes y no inventes especificaciones.',
            '',
            'Redactá directamente la respuesta final. No pidas una acción web en este turno.'          ].join('\n')
        : [
            ctx,
            '',
            '[PREGUNTA DEL VISITANTE]',
            message,
            '',
            qrCatalogAlternativeHint(product),
            '',
            'La respuesta debe ser breve para celular: máximo 4 oraciones cortas o 4 viñetas.',
            catalogRequest
              ? 'Este turno es una consulta de catálogo: usá únicamente consulta_articulos, no busques en Internet y mostrá primero hasta 4 resultados comerciales confirmados.'
              : (cfg.aiWebSearchEnabled
                  ? 'Si el visitante pide características técnicas concretas que no estén confirmadas en el catálogo ni en el historial, podés usar buscar_web_qr. Respondé con poco texto y no uses Internet para precio o disponibilidad.'
                  : 'Respondé brevemente con la información confirmada disponible. No inventes datos externos.'),
          ].join('\n');

      // La búsqueda web queda disponible sólo para preguntas posteriores que
      // realmente necesiten información técnica externa.
      const extraActions = (!initial && !catalogRequest && cfg.aiWebSearchEnabled) ? [{
        id: 'qr_web_search',
        type: 'web',
        enabled: true,
        name: 'buscar_web_qr',
       description: 'Buscar en Internet información técnica y pública del producto escaneado por QR: fabricante, ficha técnica, manual, usos, compatibilidades y recomendaciones. Buscar principalmente por descripción, marca y modelo; el SKU puede ser interno. Probar variantes razonables del nombre si hace falta. No usar para precio ni stock del negocio.',
        web_search_context_size: cfg.aiWebSearchContextSize,
        timeout_ms: cfg.aiWebSearchTimeoutMs,
        web_max_output_tokens: 1200,
        max_chars: 5000,
        result_instructions: 'Priorizá fuentes del fabricante, manuales y documentación técnica. Diferenciá claramente los datos obtenidos en Internet de los datos comerciales del negocio. Si la búsqueda falla o vence el tiempo de espera, no lo interpretes como que no existe información del producto: respondé igual con una evaluación general basada únicamente en los datos confirmados del QR y aclarando solo las especificaciones exactas que no pudieron verificarse.',
      }] : [];

      if (!initial && !catalogRequest && cfg.aiWebSearchEnabled) {
        console.log(`[qr] web-search action enabled tenant=${tenant} sku=${product.code} timeoutMs=${cfg.aiWebSearchTimeoutMs} context=${cfg.aiWebSearchContextSize}`);
      }


      const observedCommercialProducts = [];
      const raw = await getGPTReply(tenant, from, hiddenInstruction, {
        tenantId: tenant,
        openaiApiKey: apiKey,
        chatModel: cfg.aiModel || undefined,
        chatMaxTokens: 700,
        waId,
        conversationId: String(convId),
        channelType: 'qr_web',
        usageTraceId: `qr:${tenant}:${String(convId)}:${Date.now()}`,
        botModeOverride: 'conversacional',
        historyModeOverride: 'compact',
        behaviorTextOverride: behaviorOverride,
        leadCaptureOverride: requestsLeadCapture(message),
        disableExternalActions: initial === true,
        additionalExternalActions: extraActions,
        disabledExternalActionTypes: catalogRequest ? ['web'] : [],
        externalApiContext: {
          telefono_cliente: waId,
          telefono_qr: product.code,
          consulta: message || product.description,
        },
        onExternalActionResult: async ({ actionName, result }) => {
          if (actionName !== 'consulta_articulos') return;
          observedCommercialProducts.push(...commercialProductsFromExternalResult(result, cfg));
        },
      });
      const parsedReply = parseQrStructuredReply(raw);
      if (observedCommercialProducts.length) {
        const mergedProducts = mergeConfirmedCommercialProducts(
          conv.qrConfirmedCommercialProducts,
          observedCommercialProducts
        );
        conv.qrConfirmedCommercialProducts = mergedProducts;
        await db.collection('conversations').updateOne(
          { _id: convId },
          { $set: { qrConfirmedCommercialProducts: mergedProducts, updatedAt: new Date() } }
        );
        if (commercialResolution.requested && !commercialResolution.product) {
          const replyCandidates = alternativeProductCodes([{ content: parsedReply.response }], product.code);
          const selected = replyCandidates
            .map(candidate => mergedProducts.find(item => String(item?.code || '').toUpperCase() === candidate.toUpperCase()))
            .find(Boolean);
          if (selected) commercialResolution = { requested: true, product: selected, unresolved: false };
        }
      }
      let narrativeReply = stripUnexpectedScripts(stripModelCommercialClaims(parsedReply.response));
      if (commercialResolution.product) narrativeReply = stripCommercialDeferrals(narrativeReply);
      if (!requestsLeadCapture(message)) narrativeReply = stripPrematureContactRequest(narrativeReply);
      narrativeReply = compactMobileReply(
        narrativeReply,
        initial ? 4 : (catalogRequest ? 4 : 6),
        initial ? 520 : (catalogRequest ? 520 : 900)
      );
      const mentionedCatalogProducts = catalogProductsMentionedInReply(
        parsedReply.response,
        observedCommercialProducts,
        product.code
      );
      const confirmedCatalogProducts = catalogRequest
        ? selectConfirmedCatalogProducts(parsedReply.response, observedCommercialProducts, product, message)
        : mentionedCatalogProducts;
      if (catalogRequest) {
        const shownCodes = confirmedCatalogProducts.map(item => String(item?.code || '').trim()).filter(Boolean);
        await db.collection('conversations').updateOne(
          { _id: convId },
          shownCodes.length ? { $set: { qrLastShownCatalogCodes: shownCodes, qrLastShownCatalogAt: new Date(), updatedAt: new Date() } } : { $unset: { qrLastShownCatalogCodes: '', qrLastShownCatalogAt: '' }, $set: { updatedAt: new Date() } }
        );
      }
      if (catalogRequest) narrativeReply = deterministicCatalogNarrative(confirmedCatalogProducts, message);
      const catalogPricesBlock = authoritativeCatalogPricesBlock(confirmedCatalogProducts, cfg);
      const commercialBlock = commercialResolution.product
        ? authoritativeCommercialBlock(commercialResolution.product, cfg)
        : '';
      const unresolvedNotice = commercialResolution.unresolved
        ? 'No puedo confirmar el precio ni la disponibilidad del producto alternativo sin identificarlo en la API comercial. Indicame su SKU exacto para consultarlo.'
        : '';
      const safeParts = [narrativeReply, catalogPricesBlock, commercialBlock, unresolvedNotice].filter(Boolean);
      const reply = safeParts.join('\n\n') || 'No pude generar información adicional en este momento.';
      const capturedLead = await upsertQrContactLead(db, {
        tenant,
        conversationId: convId,
        waId,
        lead: parsedReply.lead,
        userText: visibleUserText,
      });
      await saveQrMessage(db, {
        tenant,
        conversationId: convId,
        waId,
        role: 'assistant',
        content: reply,
        product,
        meta: { ai: true, leadId: capturedLead?._id ? String(capturedLead._id) : null },
      });

      console.log(`[qr] ai tenant=${tenant} sku=${product.code} conv=${String(convId)} ms=${Date.now() - startedAt}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, conversationId: String(convId), reply, contactCaptured: !!capturedLead });
    } catch (e) {
      console.error('[qr] chat:', e?.response?.data || e?.message || e);
      return res.status(500).json({ ok: false, error: 'qr_ai_failed', detail: clean(e?.message || 'No se pudo obtener respuesta', 500) });
    }
  });
}

module.exports = { mountQrProductWeb };
