// tenant_runtime.js
// Carga configuración runtime por tenant/canal (WhatsApp/OpenAI) desde Mongo.
// 100% retrocompatible: si no hay config en DB, se usa .env.

const { getDb } = require("./db");

const clampInt = (v, min, max) => Math.max(min, Math.min(max, Number.parseInt(v, 10) || 0));
const DEFAULT_CACHE_TTL_MS = Number(process.env.TENANT_RUNTIME_CACHE_TTL_MS || 30_000);

function normalizeWhatsappTransport(value) {
  const v = String(value || "api").trim().toLowerCase();
  if (["wweb", "whatsapp_web", "whatsappweb", "web"].includes(v)) return "wweb";
  return "api";
}

function normalizeWwebBotLogicMode(value) {
  const v = String(value || "api").trim().toLowerCase();
  if (["chatgpt", "gpt", "pedido", "pedidos", "asisto", "ia", "openai"].includes(v)) return "chatgpt";
  return "api";
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function phoneLooksSame(a, b) {
  const da = onlyDigits(a);
  const db = onlyDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.startsWith("549") && db.startsWith("54") && !db.startsWith("549")) return da === ("549" + db.slice(2));
  if (db.startsWith("549") && da.startsWith("54") && !da.startsWith("549")) return db === ("549" + da.slice(2));
  return false;
}

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
    channelType: String(doc.channelType || "whatsapp").trim().toLowerCase() || "whatsapp",
    phoneNumberId: String(doc.phoneNumberId || "").trim() || null,
    displayPhoneNumber: String(doc.displayPhoneNumber || "").trim() || null,
    instagramAccountId: String(doc.instagramAccountId || "").trim() || null,
    instagramPageId: String(doc.instagramPageId || "").trim() || null,
    isDefault: !!doc.isDefault,
    whatsappTransport: normalizeWhatsappTransport(doc.whatsappTransport ?? doc.whatsapp_transport ?? doc.transport ?? doc.provider ?? "api"),
    wwebBotLogicMode: normalizeWwebBotLogicMode(doc.wwebBotLogicMode ?? doc.wweb_bot_logic_mode ?? doc.botLogicMode ?? doc.bot_logic_mode ?? "api"),
    // NUEVO: debounce por canal (ms). 0 = sin espera (retrocompatible)
    messageDebounceMs: clampInt(doc.messageDebounceMs ?? doc.debounceMs ?? 0, 0, 30000),
    whatsappToken: String(doc.whatsappToken || "").trim() || null,
    instagramAccessToken: String(doc.instagramAccessToken || "").trim() || null,
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

async function getRuntimeByInstagramAccountId(instagramAccountId) {
  const igid = String(instagramAccountId || "").trim();
  if (!igid) return null;
  const ck = `instagram:${igid}`;
  const cached = _cacheGet(ck);
  if (cached) return cached;

  const db = await getDb();
  const doc = await db.collection("tenant_channels").findOne({
    $or: [
      { instagramAccountId: igid },
      { instagramPageId: igid },
    ],
  });
  const val = _normalizeRuntime(doc);
  if (val) _cacheSet(ck, val);
  return val;
}

async function getRuntimeByWwebPhone(tenantId, phoneNumber) {
  const tid = String(tenantId || "").trim();
  const phone = onlyDigits(phoneNumber);
  if (!tid || !phone) return null;

  const ck = `wwebphone:${tid}:${phone}`;
  const cached = _cacheGet(ck);
  if (cached) return cached;

  const db = await getDb();
  const rows = await db.collection("tenant_channels")
    .find({ tenantId: tid, channelType: "whatsapp" })
    .sort({ isDefault: -1, updatedAt: -1, createdAt: -1 })
    .limit(200)
    .toArray();

  const match = (rows || []).find((doc) => {
    if (normalizeWhatsappTransport(doc.whatsappTransport ?? doc.whatsapp_transport ?? doc.transport ?? "api") !== "wweb") return false;
    return phoneLooksSame(doc.displayPhoneNumber, phone) || phoneLooksSame(doc.phoneNumberId, phone);
  });

  const val = _normalizeRuntime(match);
  if (val) _cacheSet(ck, val);
  return val;
}

async function getRuntimeByWwebPhoneAny(phoneNumber) {
  const phone = onlyDigits(phoneNumber);
  if (!phone) return null;

  const ck = `wwebphone:any:${phone}`;
  const cached = _cacheGet(ck);
  if (cached) return cached;

  const db = await getDb();
  const rows = await db.collection("tenant_channels")
    .find({ channelType: "whatsapp" })
    .sort({ isDefault: -1, updatedAt: -1, createdAt: -1 })
    .limit(500)
    .toArray();

  const match = (rows || []).find((doc) => {
    if (normalizeWhatsappTransport(doc.whatsappTransport ?? doc.whatsapp_transport ?? doc.transport ?? "api") !== "wweb") return false;
    return phoneLooksSame(doc.displayPhoneNumber, phone) || phoneLooksSame(doc.phoneNumberId, phone);
  });

  const val = _normalizeRuntime(match);
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
  // 1) si hay canal default, usarlo
  let doc = await db.collection("tenant_channels").findOne(
    { tenantId: tid, isDefault: true },
    { sort: { updatedAt: -1, createdAt: -1 } }
  );
  // 2) fallback: si un tenant tiene varios teléfonos, elegimos el más reciente
  if (!doc) {
    doc = await db.collection("tenant_channels")
      .find({ tenantId: tid })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(1)
      .next();
  }

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
  const channelType = String(p.channelType || "whatsapp").trim().toLowerCase() || "whatsapp";
  const phoneNumberId = String(p.phoneNumberId || "").trim();
  const instagramAccountId = String(p.instagramAccountId || "").trim();
  const instagramPageId = String(p.instagramPageId || "").trim();
  if (!tenantId) throw new Error("tenantId_required");
  if (channelType === "instagram") {
    if (!instagramAccountId) throw new Error("instagramAccountId_required");
  } else {
    if (!phoneNumberId) throw new Error("phoneNumberId_required");
  }
  const messageDebounceMs = clampInt(p.messageDebounceMs ?? p.debounceMs ?? 0, 0, 30000);
const whatsappTransport = normalizeWhatsappTransport(p.whatsappTransport ?? p.whatsapp_transport ?? p.transport ?? "api");
const wwebBotLogicMode = normalizeWwebBotLogicMode(p.wwebBotLogicMode ?? p.wweb_bot_logic_mode ?? p.botLogicMode ?? p.bot_logic_mode ?? "api");

  const selector = channelType === "instagram"
    ? { tenantId, channelType, instagramAccountId }
    : { tenantId, channelType, phoneNumberId };

  const update = {
    $setOnInsert: {
      tenantId,
            ...(channelType === "instagram"
        ? { instagramAccountId, createdAt: new Date() }
        : { phoneNumberId, createdAt: new Date() })
    },
    $set: { updatedAt: new Date(), channelType },
  };

 if (p.isDefault !== undefined) update.$set.isDefault = !!p.isDefault;
  if (p.displayPhoneNumber !== undefined) update.$set.displayPhoneNumber = String(p.displayPhoneNumber || "").trim();
  if (channelType === "whatsapp" && (p.whatsappTransport !== undefined || p.whatsapp_transport !== undefined || p.transport !== undefined)) {
    update.$set.whatsappTransport = whatsappTransport;
  }

  if (channelType === "whatsapp" && (p.wwebBotLogicMode !== undefined || p.wweb_bot_logic_mode !== undefined || p.botLogicMode !== undefined || p.bot_logic_mode !== undefined)) {
    update.$set.wwebBotLogicMode = wwebBotLogicMode;
  }
  if (p.instagramPageId !== undefined) update.$set.instagramPageId = instagramPageId;
  // NUEVO: persistir debounce ms (0..30000)
  if (p.messageDebounceMs !== undefined || p.debounceMs !== undefined) {
    update.$set.messageDebounceMs = messageDebounceMs;
  }

  if (allowSecrets) {
    if (p.whatsappToken !== undefined) update.$set.whatsappToken = String(p.whatsappToken || "").trim();
    if (p.instagramAccessToken !== undefined) update.$set.instagramAccessToken = String(p.instagramAccessToken || "").trim();
    if (p.verifyToken !== undefined) update.$set.verifyToken = String(p.verifyToken || "").trim();
    if (p.openaiApiKey !== undefined) update.$set.openaiApiKey = String(p.openaiApiKey || "").trim();
  }

  const db = await getDb();
  const r = await db.collection("tenant_channels").updateOne(
    selector,
    update,
    { upsert: true }
  );

  // invalidar cache relacionado
  cache.delete(`tenant:${tenantId}`);
  if (phoneNumberId) cache.delete(`phone:${phoneNumberId}`);
  for (const key of cache.keys()) {
    if (String(key).startsWith(`wwebphone:${tenantId}:`)) cache.delete(key);
  }
  if (instagramAccountId) cache.delete(`instagram:${instagramAccountId}`);
  if (instagramPageId) cache.delete(`instagram:${instagramPageId}`);

  return { ok: true, upserted: !!r.upsertedId, modified: r.modifiedCount };
}

module.exports = {
  getRuntimeByPhoneNumberId,
 getRuntimeByInstagramAccountId,
  getRuntimeByTenantId,
  getRuntimeByWwebPhone,
  getRuntimeByWwebPhoneAny,
  findAnyByVerifyToken,
  upsertTenantChannel,
  normalizeWhatsappTransport,
  normalizeWwebBotLogicMode,
};
