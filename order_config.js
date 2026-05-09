// order_config.js
// Configuración de reglas/validaciones de pedidos por dominio (tenant).
// Defaults 100% retrocompatibles: si no existe config en Mongo, el backend conserva el comportamiento actual.

const { getDb } = require("./db");

const ORDER_CONFIG_COLLECTION = "order_config";
const CACHE_TTL_MS = Number(process.env.ORDER_CONFIG_CACHE_TTL_MS || 30_000);
const cache = new Map();

const DEFAULT_ORDER_CONFIG = Object.freeze({
  version: 1,
  features: Object.freeze({
    backendGuards: true,
    productRules: true,
    milanesaMentionGuard: true,
    chickenCondimentGuard: true,
    milanesaNoReaskGuard: true,
    scheduleValidation: true,
    geocodeAddressValidation: true,
    paymentTransferFlow: true,
   transferReceiptAnalysis: true,
    transferMilanesaFinalAmount: true,
    forceSummaryBeforeClose: true,
    deliveryDistance: true,
    milanesaWeightLegend: true,
  }),
  requiredFields: Object.freeze({
    items: true,
    entrega: true,
    addressForDelivery: true,
    paymentForDelivery: true,
    hora: true,
    nombre: true,
  }),
  messages: Object.freeze({
   missingItems: "¿Qué te gustaría pedir? 😊",
    missingEntrega: "¿Lo retirás o te lo enviamos? 😊",
    missingAddress: "¿A qué dirección te lo enviamos? 😊",
    missingPayment: "¿Vas a pagar en efectivo o por transferencia? 😊",
    missingHora: "¿Para qué hora te gustaría hacer el pedido? 😊",
    missingNombre: "¿A nombre de quién hacemos el pedido? 😊",
    fallbackReady: "Perfecto 😊 ¿Querés confirmar o cambiar algo?",
  }),
  finalizationPolicy: Object.freeze({
    // 0 = comportamiento histórico: al cerrar COMPLETED, el próximo mensaje abre otra conversación.
    // >0 = durante esa ventana, los mensajes posteriores al pedido confirmado quedan en la misma conversación.
    postCompletionReuseMinutes: 0,
    politeFollowupReply: "¡Gracias! 😊 Cuando quieras hacemos otro pedido.",
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cfgId(tenantId) {
  return `order_config:${String(tenantId || "default").trim() || "default"}`;
}

function boolOrDefault(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["1", "true", "yes", "si", "sí", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return fallback;
}

function numberOrDefault(value, fallback, min = 0, max = 1440) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function stringOrDefault(value, fallback) {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function normalizeOrderConfig(input = {}, tenantId = "default") {
  const src = input && typeof input === "object" ? input : {};
  const out = clone(DEFAULT_ORDER_CONFIG);
  out.tenantId = String(src.tenantId || tenantId || "default").trim() || "default";

  const srcFeatures = src.features && typeof src.features === "object" ? src.features : {};
  for (const key of Object.keys(out.features)) {
    out.features[key] = boolOrDefault(srcFeatures[key], out.features[key]);
  }

  const srcRequired = src.requiredFields && typeof src.requiredFields === "object" ? src.requiredFields : {};
  for (const key of Object.keys(out.requiredFields)) {
    out.requiredFields[key] = boolOrDefault(srcRequired[key], out.requiredFields[key]);
  }

  const srcMessages = src.messages && typeof src.messages === "object" ? src.messages : {};
  for (const key of Object.keys(out.messages)) {
    const s = String(srcMessages[key] ?? "").trim();
    if (s) out.messages[key] = s;
  }

  const srcFinalization = src.finalizationPolicy && typeof src.finalizationPolicy === "object" ? src.finalizationPolicy : {};
  out.finalizationPolicy.postCompletionReuseMinutes = numberOrDefault(
    srcFinalization.postCompletionReuseMinutes,
    out.finalizationPolicy.postCompletionReuseMinutes,
    0,
    1440
  );
  out.finalizationPolicy.politeFollowupReply = stringOrDefault(
    srcFinalization.politeFollowupReply,
    out.finalizationPolicy.politeFollowupReply
  );

  return out;
}

function orderFeatureEnabled(config, key) {
  const cfg = normalizeOrderConfig(config || {});
  return cfg.features[key] !== false;
}

function orderRequiredEnabled(config, key) {
  const cfg = normalizeOrderConfig(config || {});
  return cfg.requiredFields[key] !== false;
}

function orderMessage(config, key) {
  const cfg = normalizeOrderConfig(config || {});
  return cfg.messages[key] || DEFAULT_ORDER_CONFIG.messages[key] || "";
}

function orderPostCompletionReuseMinutes(config) {
  const cfg = normalizeOrderConfig(config || {});
  return numberOrDefault(cfg.finalizationPolicy?.postCompletionReuseMinutes, 0, 0, 1440);
}

function orderPoliteFollowupReply(config) {
  const cfg = normalizeOrderConfig(config || {});
  return stringOrDefault(
    cfg.finalizationPolicy?.politeFollowupReply,
    DEFAULT_ORDER_CONFIG.finalizationPolicy.politeFollowupReply
  );
}

async function loadOrderConfig(tenantId = "default") {
  const tenant = String(tenantId || "default").trim() || "default";
  const key = cfgId(tenant);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let doc = null;
  try {
   const db = await getDb();
    doc = await db.collection(ORDER_CONFIG_COLLECTION).findOne({ _id: key });
  } catch (e) {
    console.warn("[order-config] load error:", e?.message || e);
  }

  const value = normalizeOrderConfig(doc || {}, tenant);
  cache.set(key, { value, expiresAt: Date.now() + Math.max(1000, CACHE_TTL_MS) });
  return value;
}

async function saveOrderConfig(tenantId, payload = {}, meta = {}) {
  const tenant = String(tenantId || payload?.tenantId || "default").trim() || "default";
  const normalized = normalizeOrderConfig({ ...payload, tenantId: tenant }, tenant);
  const now = new Date();
  const doc = {
    _id: cfgId(tenant),
    tenantId: tenant,
    version: normalized.version,
    features: normalized.features,
    requiredFields: normalized.requiredFields,
    messages: normalized.messages,
    finalizationPolicy: normalized.finalizationPolicy,
    updatedAt: now,
    updatedBy: String(meta.updatedBy || "").trim() || null,
  };

  const db = await getDb();
  await db.collection(ORDER_CONFIG_COLLECTION).updateOne(
    { _id: doc._id },
    { $set: doc, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  cache.delete(doc._id);
  return normalizeOrderConfig(doc, tenant);
}

async function listOrderConfigs(tenantFilter = "") {
  const db = await getDb();
  const q = {};
  const tenant = String(tenantFilter || "").trim();
  if (tenant) q.tenantId = tenant;
  const rows = await db.collection(ORDER_CONFIG_COLLECTION)
    .find(q)
    .sort({ tenantId: 1 })
    .limit(500)
    .toArray();
  return rows.map((r) => normalizeOrderConfig(r, r.tenantId));
}

module.exports = {
  DEFAULT_ORDER_CONFIG,
  ORDER_CONFIG_COLLECTION,
  cfgId,
  normalizeOrderConfig,
  orderFeatureEnabled,
  orderRequiredEnabled,
  orderMessage,
  orderPostCompletionReuseMinutes,
  orderPoliteFollowupReply,
  loadOrderConfig,
  saveOrderConfig,
  listOrderConfigs,
};