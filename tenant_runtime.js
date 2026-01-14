// tenant_runtime.js
// Carga configuración runtime por tenant/canal (WhatsApp/OpenAI) desde Mongo.
// 100% retrocompatible: si no hay config en DB, se usa .env.

const { getDb } = require("./db");

const DEFAULT_CACHE_TTL_MS = Number(process.env.TENANT_RUNTIME_CACHE_TTL_MS || 30_000);

// cache simple: key -> { value, expiresAt }
const cache = new Map();

function _now() { return Date.now(); }

function _cacheGet(key) {
  const rec = cache.get(key);
  if (!rec) return null;
  if (rec.expiresAt <= _now()) {
    cache.delete(key);
    return null;
  }
  return rec.value || null;
}

function _cacheSet(key, value, ttlMs = DEFAULT_CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: _now() + Math.max(1_000, Number(ttlMs) || DEFAULT_CACHE_TTL_MS) });
}

function _normalizeRuntime(doc) {
  if (!doc || typeof doc !== "object") return null;
  return {
    tenantId: String(doc.tenantId || "").trim() || null,
    phoneNumberId: String(doc.phoneNumberId || "").trim() || null,
    displayPhoneNumber: String(doc.displayPhoneNumber || "").trim() || null,
    whatsappToken: String(doc.whatsappToken || "").trim() || null,
    verifyToken: String(doc.verifyToken || "").trim() || null,
    openaiApiKey: String(doc.openaiApiKey || "").trim() || null,
  };
}

async function getRuntimeByPhoneNumberId(phoneNumberId) {
  const pid = String(phoneNumberId || "").trim();
  if (!pid) return null;
  const ck = `phone:${pid}`;
  const cached = _cacheGet(ck);
  if (cached) return cached;

  const db = await getDb();
  const doc = await db.collection("tenant_channels").findOne({ phoneNumberId: pid });
  const val = _normalizeRuntime(doc);
  if (val) _cacheSet(ck, val);
  return val;
}

async function getRuntimeByTenantId(tenantId) {
  const tid = String(tenantId || "").trim();
  if (!tid) return null;
  const ck = `tenant:${tid}`;
  const cached = _cacheGet(ck);
  if (cached) return cached;

  const db = await getDb();
  // si un tenant tiene varios teléfonos, por defecto elegimos el más reciente
  const doc = await db.collection("tenant_channels")
    .find({ tenantId: tid })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(1)
    .next();

  const val = _normalizeRuntime(doc);
  if (val) _cacheSet(ck, val);
  return val;
}

async function findAnyByVerifyToken(verifyToken) {
  const tok = String(verifyToken || "").trim();
  if (!tok) return null;

  const ck = `verify:${tok}`;
  const cached = _cacheGet(ck);
  if (cached) return cached;

  const db = await getDb();
  const doc = await db.collection("tenant_channels").findOne({ verifyToken: tok });
  const val = _normalizeRuntime(doc);
  if (val) _cacheSet(ck, val);
  return val;
}

async function upsertTenantChannel(payload, { allowSecrets = true } = {}) {
  const p = payload || {};
  const tenantId = String(p.tenantId || "").trim();
  const phoneNumberId = String(p.phoneNumberId || "").trim();
  if (!tenantId) throw new Error("tenantId_required");
  if (!phoneNumberId) throw new Error("phoneNumberId_required");

  const update = {
    $setOnInsert: { tenantId, phoneNumberId, createdAt: new Date() },
    $set: { updatedAt: new Date() },
  };

  if (p.displayPhoneNumber !== undefined) update.$set.displayPhoneNumber = String(p.displayPhoneNumber || "").trim();

  if (allowSecrets) {
    if (p.whatsappToken !== undefined) update.$set.whatsappToken = String(p.whatsappToken || "").trim();
    if (p.verifyToken !== undefined) update.$set.verifyToken = String(p.verifyToken || "").trim();
    if (p.openaiApiKey !== undefined) update.$set.openaiApiKey = String(p.openaiApiKey || "").trim();
  }

  const db = await getDb();
  const r = await db.collection("tenant_channels").updateOne(
    { tenantId, phoneNumberId },
    update,
    { upsert: true }
  );

  // invalidar cache relacionado
  cache.delete(`tenant:${tenantId}`);
  cache.delete(`phone:${phoneNumberId}`);

  return { ok: true, upserted: !!r.upsertedId, modified: r.modifiedCount };
}

module.exports = {
  getRuntimeByPhoneNumberId,
  getRuntimeByTenantId,
  findAnyByVerifyToken,
  upsertTenantChannel,
};
