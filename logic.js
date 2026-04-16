// logic.js
// Lógica de negocio (sin Express): GPT, STT, helpers y comportamiento desde Mongo (multi-tenant)
// Incluye logs completos de OpenAI (payload y response).

const axios = require("axios");
const OpenAI = require("openai");
let toFile = null;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-5.4";
const VISION_MODEL = process.env.VISION_MODEL || CHAT_MODEL;
const CHAT_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0.0) || 0.0;
const CHAT_MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS || process.env.CHAT_MAX_TOKENS || 0) || 0;
const TENANT_AI_CONFIG_CACHE_TTL_MS = Number(process.env.TENANT_AI_CONFIG_CACHE_TTL_MS || 300000);


const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v17.0";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();

const ENDED_SESSION_TTL_MINUTES = Number(process.env.ENDED_SESSION_TTL_MINUTES || 15);
const CALC_FIX_MAX_RETRIES = Number(process.env.CALC_FIX_MAX_RETRIES || 3);
const STORE_TZ = (process.env.STORE_TZ || "America/Argentina/Cordoba").trim();
const SIMULATED_NOW_ISO = (process.env.SIMULATED_NOW_ISO || "").trim();
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "").trim().replace(/\/+$/, "");
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10);
const TRANSCRIBE_MODEL = process.env.WHISPER_MODEL || process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || "";
const DEFAULT_TENANT_ID = (process.env.TENANT_ID || "default").trim();
  // 🔹 Coordenadas del negocio + API Key de Maps
const STORE_LAT = parseFloat(process.env.STORE_LAT || "");
const STORE_LNG = parseFloat(process.env.STORE_LNG || "");
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

const { getDb } = require("./db");
const { ObjectId } = require("mongodb");
// ================== OpenAI client (para fallback STT) ==================
let openai = null;
const openaiByKey = new Map();
try {
  if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    try { ({ toFile } = require("openai/uploads")); } catch {}
  }
} catch (e) {
  console.error("OpenAI init error:", e.message);
}

function getOpenAIClient(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return openai;
  if (key === OPENAI_API_KEY) return openai;
  const cached = openaiByKey.get(key);
  if (cached) return cached;
  try {
    const client = new OpenAI({ apiKey: key });
    openaiByKey.set(key, client);
    return client;
  } catch {
    return openai;
  }
}

// ================== Utils de serialización segura ==================
function circularReplacer() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  };
}
function safeStringify(value) {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value, circularReplacer());
  } catch {
    try { return String(value); } catch { return ""; }
  }
}
function sanitizeMessages(msgs) {
  return (msgs || []).map(m => ({
    role: String(m?.role || "user"),
    content: typeof m?.content === "string" ? m.content : safeStringify(m?.content)
  }));
}

const ASSISTANT_PEDIDO_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["response", "estado", "Pedido"],
  properties: {
    response: { type: "string" },
    estado: {
      type: "string",
      enum: ["IN_PROGRESS", "COMPLETED", "CANCELLED", "PENDIENTE"]
    },
    Pedido: {
      type: "object",
      additionalProperties: false,
      required: [
        "nombre_apellido",
        "Entrega",
        "Domicilio",
        "Pago",
        "fecha_pedido",
        "hora_pedido",
        "items",
        "total_pedido"
      ],
      properties: {
        nombre_apellido: { type: "string" },
        Entrega: { type: "string" },
        Domicilio: {
          type: "object",
          additionalProperties: false,
          required: ["direccion"],
          properties: {
            direccion: { type: "string" }
          }
        },
        Pago: { type: "string" },
        fecha_pedido: { type: "string" },
        hora_pedido: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "descripcion", "cantidad", "importe_unitario", "total"],
            properties: {
              id: { type: ["string", "number"] },
              descripcion: { type: "string" },
              cantidad: { type: "number" },
              importe_unitario: { type: "number" },
              total: { type: "number" }
            }
          }
        },
        total_pedido: { type: "number" }
      }
    }
  }
};

function buildStrictPedidoResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "pedido_response",
      strict: true,
      schema: ASSISTANT_PEDIDO_RESPONSE_SCHEMA
    }
  };
}

function extractChatCompletionContent(responseData) {
  const msg = responseData?.choices?.[0]?.message || {};
  const refusal = String(msg?.refusal || "").trim();
  if (refusal) {
    return JSON.stringify({
      response: "Perdón, no pude procesar ese mensaje. ¿Podés repetirlo? 😊",
      estado: "IN_PROGRESS",
      Pedido: {
        nombre_apellido: "",
        Entrega: "",
        Domicilio: {},
        Pago: "",
        fecha_pedido: "",
        hora_pedido: "",
        items: [],
        total_pedido: 0
      }
    });
  }
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    const joined = msg.content
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
        return "";
      })
      .join("")
      .trim();
    if (joined) return joined;
  }
  return "";
}

// ================== Fecha/Hora local para el modelo ==================
function _nowLabelInTZ() {
  const base = SIMULATED_NOW_ISO ? new Date(SIMULATED_NOW_ISO) : new Date();
  const fmt = new Intl.DateTimeFormat("es-AR", {
    timeZone: STORE_TZ, hour12: false,
    weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(base).map(p => [p.type, p.value]));
  const weekday = String(parts.weekday || "").toLowerCase();
  return `${weekday}, ${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}
// Bloque [AHORA] reforzado: siempre 24h y JSON inequívoco para el LLM
function buildNowBlock() {
  const base = SIMULATED_NOW_ISO ? new Date(SIMULATED_NOW_ISO) : new Date();
  const tz = STORE_TZ;
  const fmt = new Intl.DateTimeFormat("es-AR", {
    timeZone: tz,
    hour12: false,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(base).map(p => [p.type, p.value]));
  const weekday = String(parts.weekday || "").toLowerCase();
  const dd = parts.day, mm = parts.month, yyyy = parts.year;
  const hh = String(parts.hour).padStart(2, "0");
  const min = String(parts.minute).padStart(2, "0");
  const minutes = Number(hh) * 60 + Number(min);
  const dateISO = `${yyyy}-${mm}-${dd}`;

  return [
    "[AHORA]",
    `Zona horaria: ${tz}`,
    `Fecha y hora actuales (local, 24h): ${weekday}, ${dd}/${mm}/${yyyy} ${hh}:${min}`,
    `NOW_JSON: {"date":"${dateISO}","time_24":"${hh}:${min}","minutes":${minutes},"tz":"${tz}"}`
  ].join("\n");
}

// ================== Comportamiento desde Mongo (solo al inicio de conversación) ==================
/**
 * Cache en memoria por tenant { tenantId: { text, history_mode, at } }
 * Se invalida por tenant con invalidateBehaviorCache(tenantId)
 */
const _behaviorCache = new Map();

async function loadBehaviorConfigFromMongo(tenantId = DEFAULT_TENANT_ID) {
  const key = String(tenantId);
  const cached = _behaviorCache.get(key);
  if (cached && (Date.now() - cached.at) < 5 * 60 * 1000) {
    return cached; // { text, history_mode, at }
  }
  const db = await getDb();
  const _id = `behavior:${key}`;
  const doc = await db.collection("settings").findOne({ _id }) || {};
  const fallbackEnv = process.env.COMPORTAMIENTO || "";
  const text = String(doc.text || fallbackEnv).trim();
  const history_mode = (doc.history_mode || process.env.HISTORY_MODE || "standard").trim();
  const cfg = { text, history_mode, at: Date.now() };
  _behaviorCache.set(key, cfg);
  return cfg;
}
async function loadBehaviorTextFromMongo(tenantId = DEFAULT_TENANT_ID) {
  const cfg = await loadBehaviorConfigFromMongo(tenantId);
  return cfg.text;
}
function invalidateBehaviorCache(tenantId = DEFAULT_TENANT_ID) {
  _behaviorCache.delete(String(tenantId));
}

const _tenantAiConfigCache = new Map();

function _tenantAiCacheKey(tenantId = DEFAULT_TENANT_ID) {
  return String(tenantId || DEFAULT_TENANT_ID || "default").trim() || "default";
}

function _pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const s = String(value ?? "").trim();
    if (s) return s;
  }
  return "";
}
function _pickFirstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function _normalizeTenantAiConfig(doc) {
  const cfg = (doc && typeof doc === "object" && !Array.isArray(doc)) ? doc : {};
  const openaiCfg = (cfg.openai && typeof cfg.openai === "object" && !Array.isArray(cfg.openai)) ? cfg.openai : {};

  const chatModel = _pickFirstNonEmptyString(
    openaiCfg.chat_model,
    openaiCfg.chatModel,
    cfg.CHAT_MODEL,
    cfg.chat_model,
    cfg.chatModel
  );

  const visionModel = _pickFirstNonEmptyString(
    openaiCfg.vision_model,
    openaiCfg.visionModel,
    cfg.VISION_MODEL,
    cfg.vision_model,
    cfg.visionModel
  );

  const transcribeModel = _pickFirstNonEmptyString(
    openaiCfg.transcribe_model,
    openaiCfg.transcribeModel,
    cfg.OPENAI_TRANSCRIBE_MODEL,
    cfg.TRANSCRIBE_MODEL,
    cfg.WHISPER_MODEL,
    cfg.transcribe_model,
    cfg.transcribeModel
 );

  const tempNum = _pickFirstFiniteNumber(
    openaiCfg.temperature,
    openaiCfg.chat_temperature,
    openaiCfg.chatTemperature,
    cfg.OPENAI_TEMPERATURE,
    cfg.chat_temperature,
    cfg.chatTemperature,
    cfg.openai_temperature
  );

  const chatMaxTokens = _pickFirstFiniteNumber(
    openaiCfg.max_tokens,
    openaiCfg.maxTokens,
    cfg.OPENAI_MAX_TOKENS,
    cfg.CHAT_MAX_TOKENS,
    cfg.max_tokens,
    cfg.maxTokens,
    cfg.chat_max_tokens,
    cfg.chatMaxTokens
  );

  return {
    chatModel: chatModel || null,
    visionModel: visionModel || null,
    transcribeModel: transcribeModel || null,
    chatTemperature: tempNum === null ? null : Math.max(0, Math.min(2, tempNum)),
    chatMaxTokens: chatMaxTokens === null ? null : Math.max(1, Math.trunc(chatMaxTokens)),
  };
}

async function loadTenantAiConfigFromMongo(tenantId = DEFAULT_TENANT_ID) {
  const key = _tenantAiCacheKey(tenantId);
  const cached = _tenantAiConfigCache.get(key);
  if (cached && (Date.now() - cached.at) < TENANT_AI_CONFIG_CACHE_TTL_MS) {
    return cached.value;
  }

  let value = {
    chatModel: null,
    visionModel: null,
    transcribeModel: null,
    chatTemperature: null,
    chatMaxTokens: null,
  };

  try {
    const db = await getDb();
    const doc = await db.collection("tenant_config").findOne({ _id: key }) || {};
    value = _normalizeTenantAiConfig(doc);
  } catch (e) {
    console.warn("[tenant-ai] loadTenantAiConfigFromMongo error:", e?.message || e);
  }

  _tenantAiConfigCache.set(key, { value, at: Date.now() });
  return value;
}

function invalidateTenantAiConfigCache(tenantId = DEFAULT_TENANT_ID) {
  _tenantAiConfigCache.delete(_tenantAiCacheKey(tenantId));
}

function modelUsesMaxCompletionTokens(modelName) {
  const m = String(modelName || "").trim().toLowerCase();
  return m.startsWith("gpt-5");
}

function applyModelTokenLimit(payload, modelName, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return payload;

  if (modelUsesMaxCompletionTokens(modelName)) {
    payload.max_completion_tokens = Math.trunc(n);
  } else {
    payload.max_tokens = Math.trunc(n);
  }
  return payload;
}

// ------------------ Catálogo dinámico desde Mongo ------------------
// Cache por tenant para evitar hits constantes (5 min)
const _catalogCache = new Map(); // { tenantId: { text, at } }

async function loadCatalogTextFromMongo(tenantId = DEFAULT_TENANT_ID) {
  const key = String(tenantId || "");
  const cached = _catalogCache.get(key);
  if (cached && (Date.now() - cached.at) < 5 * 60 * 1000) return cached.text;

  const db = await getDb();
  // Filtrado: solo activos; si hay tenant, lo aplicamos; si no, dejamos todo
  const filter = { active: { $ne: false } };
  if (key) filter.tenantId = key;
  const items = await db.collection("products").find(filter).sort({ descripcion: 1, createdAt: -1 }).toArray();

  // Armamos un bloque compatible con el comportamiento heredado
  // Formato: "id N - Descripción. Precio: 12345. Observaciones: ..."
  const lines = [];
  let i = 1;
  for (const it of items) {
    const precio = (typeof it.importe === "number") ? it.importe : Number(it.importe || 0);
    const tag = String(it.tag || "").trim();
    const obs = (it.observacion || "").trim();
    const qtyNum = (it.cantidad === undefined || it.cantidad === null) ? null : Number(it.cantidad);
    const qtyPart =
      (qtyNum !== null && Number.isFinite(qtyNum))
        ? `. Cantidad Máxima: ${qtyNum}`
        : "";
    const tagPart = tag ? `. Tag: ${tag}` : "";
    const base = `id ${i} - ${String(it.descripcion || "").trim()}. Precio: ${Number(precio || 0)}${qtyPart}${tagPart}`;
 
    lines.push(obs ? `${base}. Observaciones: ${obs}` : `${base}.`);
    i++;
  }
  const text = lines.length
    ? `\n[CATALOGO]\n${lines.join("\n")}\n`
    : "\n[CATALOGO]\n( catálogo vacío )\n";

  _catalogCache.set(key, { text, at: Date.now() });
  return text;
}




// ================== Horarios desde Mongo → bloque para el prompt ==================
async function loadStoreHoursBlockFromMongo(tenantId = DEFAULT_TENANT_ID) {
  try {
    const key = String(tenantId || "");
    const db = await getDb();
    const _id = `store_hours:${key}`;
    const doc = (await db.collection("settings").findOne({ _id })) || {};
    const hours = doc.hours || {};
    if (!hours || typeof hours !== "object") return "";

    const order = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    const labels = {
      monday: "Lunes",
      tuesday: "Martes",
      wednesday: "Miércoles",
      thursday: "Jueves",
      friday: "Viernes",
      saturday: "Sábado",
      sunday: "Domingo"
    };

    const lines = [];
    for (const dayKey of order) {
      const ranges = Array.isArray(hours[dayKey]) ? hours[dayKey] : [];
      if (!ranges.length) continue;
      const slots = ranges
        .map(r => {
          const from = String(r.from || "").trim();
          const to   = String(r.to   || "").trim();
          if (!from || !to) return null;
          return `${from} a ${to}`;
        })
        .filter(Boolean);
      if (!slots.length) continue;
      lines.push(`- ${labels[dayKey] || dayKey}: ${slots.join(" y ")}`);
    }

    if (!lines.length) return "";

    return [
      "[HORARIOS_LOCAL]",
      "Estos son los horarios de atención del local (hora local 24h).",
"Usá esta información solo para informar y sugerir horarios al cliente si pregunta.",
"NO debes decidir si un horario es válido o inválido ni rechazar pedidos por estar fuera de estas franjas.",
"Siempre que el cliente proponga una fecha y hora, copia esa fecha y hora al JSON tal cual (formato YYYY-MM-DD y HH:MM).",
   "",
      ...lines
    ].join("\n");
  } catch (e) {
    console.error("[hours] Error al armar bloque de horarios:", e?.message || e);
    return "";
  }
}
 


// ================== Historial por número / sesión ==================
const chatHistories = {};       // standard mode: { [tenant-from]: [{role,content}, ...] }
const userOnlyHistories = {};   // minimal mode: { [tenant-from]: [{role:'user',content}, ...] }
const assistantPedidoSnapshot = {}; // minimal mode: { [tenant-from]: string(JSON del Pedido) }
const currentConversationIds = {}; // { [tenant-from]: string(convId) }

function k(tenantId, from) { return `${tenantId}::${from}`; }

// ================== Helpers de sesión ==================
// ================== Helpers de sesión ==================
const endedSessions = {}; // { [tenant-from]: { endedAt } }
function hasActiveEndedFlag(tenantId, from) {
  const id = k(tenantId, from);
  const rec = endedSessions[id];
  if (!rec) return false;
  const ageMin = (Date.now() - rec.endedAt) / 60000;
  if (ageMin > ENDED_SESSION_TTL_MINUTES) {
    delete endedSessions[id];
    return false;
  }
  return true;
}

function markSessionEnded(tenantId, from) {
  const id = k(tenantId, from);
  delete chatHistories[id];
  delete userOnlyHistories[id];
  delete assistantPedidoSnapshot[id];
  delete currentConversationIds[id];
  endedSessions[id] = { endedAt: Date.now() };
}


/**
 * Sincroniza el historial en memoria con el conversationId actual.
 * Si el backend creó una conversación nueva (convId distinto), reseteamos
 * el historial de ChatGPT para que el próximo pedido arranque de cero.
 */
function syncSessionConversation(tenantId, from, convId) {
  try {
    if (!tenantId || !from || !convId) return;
    const id = k(tenantId, from);
    const curr = String(convId);
    const prev = currentConversationIds[id];

    if (prev && prev !== curr) {
      // 🔁 Conversación nueva => arrancar historial desde cero
      delete chatHistories[id];
      delete userOnlyHistories[id];
      delete assistantPedidoSnapshot[id];
      // Si quedó flag de sesión terminada, lo limpiamos
      delete endedSessions[id];
    }

    currentConversationIds[id] = curr;
  } catch {}
}

function clearEndedFlag(tenantId, from) {
  const id = k(tenantId, from);
  delete endedSessions[id];
}

 
async function hydrateSessionStateFromDb(tenantId, from, historyMode, fullSystem) {
  try {
    const id = k(tenantId, from);
    const convId = currentConversationIds[id];
    if (!convId) return false;

   const db = await getDb();
    const convObjectId = new ObjectId(String(convId));
    const tenant = String(tenantId || DEFAULT_TENANT_ID || "default");

    const conv = await db.collection("conversations").findOne({ _id: convObjectId, tenantId: tenant });
    const rows = await db.collection("messages")
      .find({ conversationId: convObjectId, tenantId: tenant })
      .sort({ ts: 1, _id: 1 })
      .limit(100)
      .toArray();
    if (String(historyMode || "").toLowerCase() === "minimal") {
      userOnlyHistories[id] = rows
        .filter(r => String(r?.role || "") === "user")
        .map(r => ({ role: "user", content: String(r?.content || "") }))
        .filter(r => r.content.trim());

      const snap = conv?.lastPedidoSnapshot;
      if (snap && typeof snap === "object") {
        try {
          assistantPedidoSnapshot[id] = JSON.stringify(snap);
        } catch {}
      } else if (!assistantPedidoSnapshot[id]) {
        assistantPedidoSnapshot[id] = JSON.stringify({ estado: "IN_PROGRESS", Pedido: { items: [], total_pedido: 0 } });
      }
      return true;
    }

    const restored = [{ role: "system", content: fullSystem }];
    for (const row of rows) {
      const role = String(row?.role || "");
      if (role !== "user" && role !== "assistant") continue;
      if (String(row?.type || "text") === "json") continue;
      const content = String(row?.content || "");
      if (!content.trim()) continue;
      restored.push({ role, content });
    }
    chatHistories[id] = restored;
    return true;
  } catch (e) {
    console.warn("[history] no se pudo rehidratar sesión desde Mongo:", e?.message || e);
    return false;
  }
}


// ================== WhatsApp ==================
async function sendWhatsAppMessage(to, text, opts = {}) {
  try {
    const body = String(text ?? "").trim();
    if (!body) {
      console.error("WhatsApp: intento de envío con text.body vacío. Se omite el envío.");
      return;
    }
    const pid = String(opts.phoneNumberId || PHONE_NUMBER_ID || "").trim();
    const token = String(opts.whatsappToken || WHATSAPP_TOKEN || "").trim();
    if (!pid) throw new Error("missing_phone_number_id");
    if (!token) throw new Error("missing_whatsapp_token");

    await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${pid}/messages`,
      { messaging_product: "whatsapp", to, text: { body } },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error enviando WhatsApp:", error.response?.data || error.message);
  }
}

async function sendInstagramMessage(to, text, opts = {}) {
  try {
    const body = String(text ?? "").trim();
    if (!body) {
      console.error("Instagram: intento de envío con text vacío. Se omite el envío.");
      return;
    }
    const pageId = String(opts.instagramPageId || "").trim();
    const token = String(opts.instagramAccessToken || "").trim();
    if (!pageId) throw new Error("missing_instagram_page_id");
    if (!token) throw new Error("missing_instagram_access_token");

    await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/messages`,
      {
        recipient: { id: String(to || "").trim() },
        messaging_type: "RESPONSE",
        message: { text: body }
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error enviando Instagram:", error.response?.data || error.message);
  }
}

async function sendChannelMessage(to, text, opts = {}) {
  const channelType = String(opts.channelType || "whatsapp").trim().toLowerCase();
  if (channelType === "instagram") {
    return sendInstagramMessage(to, text, opts);
  }
  return sendWhatsAppMessage(to, text, opts);
}

// ================== Media (audio) ==================
async function getMediaInfo(mediaId, opts = {}) {
  const token = String(opts.whatsappToken || WHATSAPP_TOKEN || "").trim();
  if (!token || !mediaId) throw new Error("media_info_missing");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const resp = await fetch(`${url}?fields=url,mime_type`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`media_info_failed_${resp.status}`);
  return resp.json();
}
async function downloadMediaBuffer(mediaUrl, opts = {}) {
  const token = String(opts.whatsappToken || WHATSAPP_TOKEN || "").trim();
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`download_media_failed_${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

// ================== STT (externo -> fallback OpenAI) ==================
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime, openaiApiKey, tenantId, transcribeModel } = {}) {
  const prefer = TRANSCRIBE_API_URL;
  if (prefer && publicAudioUrl) {
    try {
      const r = await fetch(`${prefer}/transcribe?url=${encodeURIComponent(publicAudioUrl)}`);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j && typeof j.text === "string" && j.text.trim()) {
          return { text: j.text, usage: j.tokens || j.usage || null, engine: "external" };
        }
      } else {
        console.warn("STT externo: HTTP", r.status);
      }
    } catch (e) {
      console.error("STT externo error:", e.message);
    }
  }
  try {
    const client = getOpenAIClient(openaiApiKey);
    if (!client) return { text: "" };
    let buf = buffer, mt = mime;
    if (!buf && publicAudioUrl) {
      const r2 = await fetch(publicAudioUrl);
      mt = r2.headers.get("content-type") || mime || "audio/ogg";
      const ab = await r2.arrayBuffer(); buf = Buffer.from(ab);
    }
    if (!buf) return { text: "" };
    const ext =
      (mt || "").includes("wav") ? "wav" :
      (mt || "").includes("mp3") ? "mp3" :
      ((mt || "").includes("ogg") || (mt || "").includes("opus")) ? "ogg" : "mp3";
    let fileObj = null;
    if (toFile) fileObj = await toFile(buf, `audio.${ext}`, { type: mt || "audio/ogg" });
    else {
      const FileCtor = global.File || require("node:buffer").Blob;
      fileObj = new FileCtor([buf], `audio.${ext}`, { type: mt || "audio/ogg" });
    }
        const tenantAiCfg = await loadTenantAiConfigFromMongo(tenantId);
    const model = String(
      transcribeModel ||
      tenantAiCfg.transcribeModel ||
      TRANSCRIBE_MODEL ||
      "whisper-1"
    ).trim();
    const r = await client.audio.transcriptions.create({ file: fileObj, model });
    const text = (r.text || "").trim();
    return { text, usage: r.usage || null, engine: "openai" };
  } catch (e) {
    console.error("STT OpenAI error:", e.message);
    return { text: "" };
  }
}


/**
 * Analiza una imagen vía modelo con visión.
 * Uso principal: extraer info de comprobantes de pago.
 * NO confirma pago real; sólo OCR/lectura de datos visibles.
 *
 * @param {Object} params
 * @param {string} params.publicImageUrl
 * @param {string} params.mime
 * @param {string} params.purpose "payment-proof" | "generic"
 * @returns {{json: object|null, userText: string}}
 */
async function analyzeImageExternal({ publicImageUrl, mime, purpose = "generic", openaiApiKey, tenantId, visionModel, visionMaxTokens } = {}) {
  
  try {
    if (!publicImageUrl) {
      return { json: null, userText: "[imagen]" };
    }

    const system = [
      "Sos un asistente que analiza imágenes y extrae texto/datos clave.",
      "Si la imagen parece un comprobante de pago/transferencia:",
      "- Extraé monto, moneda, fecha, referencia/operación, banco/app, emisor/recipiente si aparecen.",
      "- NO afirmes que el pago está confirmado.",
      "Respondé exclusivamente en JSON."
    ].join("\n");

    const user = purpose === "payment-proof"
      ? "Analizá esta imagen que probablemente sea un comprobante de pago o transferencia. Extraé los datos visibles."
      : "Describí brevemente la imagen y extraé cualquier texto visible.";

    const client = getOpenAIClient(openaiApiKey);
    if (!client) throw new Error("openai_not_configured");

    const tenantAiCfg = await loadTenantAiConfigFromMongo(tenantId);
    const model = String(
      visionModel ||
      tenantAiCfg.visionModel ||
      VISION_MODEL ||
      CHAT_MODEL
    ).trim();
    const maxTokensNum = Number(visionMaxTokens);
    const maxTokens = Number.isFinite(maxTokensNum) && maxTokensNum > 0 ? Math.trunc(maxTokensNum) : 500;


        const payload = {
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: user },
            { type: "image_url", image_url: { url: publicImageUrl } }
          ]
        }
      ]
    };
    applyModelTokenLimit(payload, model, maxTokens);

    const resp = await client.chat.completions.create(payload);

    const content = resp?.choices?.[0]?.message?.content || "";
    let json = null;
    try { json = JSON.parse(content); } catch {}

    // Armamos un texto "usable" como input del chat principal
    if (purpose === "payment-proof") {
      const amount = json?.amount ?? json?.monto ?? null;
      const currency = json?.currency ?? json?.moneda ?? "";
      const date = json?.date ?? json?.fecha ?? "";
      const ref = json?.reference ?? json?.referencia ?? json?.operacion ?? "";
      const bank = json?.bank ?? json?.app ?? "";

      const parts = [];
      if (amount) parts.push(`monto ${amount}${currency ? " " + currency : ""}`);
      if (date) parts.push(`fecha ${date}`);
      if (ref) parts.push(`ref/operación ${ref}`);
      if (bank) parts.push(`entidad ${bank}`);

      const compact = parts.length ? parts.join(", ") : "datos no legibles";
      const userText =
        `El usuario envió una imagen de comprobante de pago/transferencia. ` +
        `Lectura preliminar: ${compact}.`;

      return { json, userText };
    }

    const extractedText = json?.extracted_text || json?.text || "";
    const userText = extractedText
      ? `El usuario envió una imagen. Texto detectado: ${String(extractedText).slice(0, 600)}`
      : "El usuario envió una imagen.";

    return { json, userText };
  } catch (e) {
    console.warn("[vision] analyzeImageExternal error:", e?.message || e);
    return { json: null, userText: "El usuario envió una imagen." };
  }
}




// ================== Detección de cortesía ==================
function isPoliteClosingMessage(textRaw) {
  const s = String(textRaw || "").trim().toLowerCase();
  if (!s) return false;
  // Solo cierres MUY cortos (sin más palabras ni números).
  // Incluimos "si/sí" exactos para absorber confirmaciones duplicadas
  // que puedan llegar DESPUÉS de haber cerrado la conversación.
  const shortExacts = [
    "si","sí","ok","dale","listo","gracias","muchas gracias","mil gracias",
    "👍","👌","🙌","🙏","🙂","😊","👏","✌️"
  ];
  if (shortExacts.includes(s)) return true;
  // Evitar capturar frases como "ok para las 21" o "perfecto, agendá".
  return false;
}

// ================== Cache simple binario (audio/imagenes/tts) ==================
const fileCache = new Map();
function makeId() { return Math.random().toString(36).slice(2, 10); }
function putInCache(buffer, mime) {
  const id = makeId();
  fileCache.set(id, { buffer, mime: mime || "application/octet-stream", expiresAt: Date.now() + CACHE_TTL_MS });
  return id;
}
function getFromCache(id) {
  const rec = fileCache.get(id);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) { fileCache.delete(id); return null; }
  return rec;
}

// ================== Reglas de negocio de pedido ==================
//const START_FALLBACK = "¡Hola! 👋 ¿Qué te gustaría pedir? Pollo (entero/mitad) y papas (2, 4 o 6).";

// ================== Reglas de negocio de pedido ==================
// Sin saludo por defecto: preservamos SIEMPRE el texto original del modelo.
// Si alguna vez quisieras reactivarlo, seteá START_FALLBACK en tu .env.
const START_FALLBACK = (process.env.START_FALLBACK || "").trim();



const num = v => Number(String(v).replace(/[^\d.-]/g, '') || 0);

// NUEVO: parser de cantidades (soporta "una", "dos", "x2", "2u", etc.)
const qty = (v) => {
  const s = String(v || "").trim().toLowerCase();

  // 1) Si hay dígitos explícitos, usar eso
  const onlyDigits = s.replace(/[^\d]/g, "");
  if (onlyDigits) return Number(onlyDigits);

  // 2) Patrones comunes: "x2", "2u", "2 uds", "2 unidades"
  const xMatch = s.match(/x\s*(\d+)/);
  if (xMatch) return Number(xMatch[1]);
  const tailMatch = s.match(/(\d+)\s*(u|ud|uds|unidad|unidades)\b/);
  if (tailMatch) return Number(tailMatch[1]);

  // 3) Palabras en español
  const words = {
    "un": 1, "uno": 1, "una": 1,
    "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5,
    "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10
  };
  if (words[s] != null) return words[s];

  // 4) Último recurso
  return 0;
};

function hasContext(pedido) {
  if (!pedido) return false;
  const hasItems =
    Array.isArray(pedido.items) && pedido.items.filter(Boolean).length > 0;
  const hasWhen = Boolean(pedido.fecha_pedido || pedido.Fecha) || Boolean(pedido.hora_pedido || pedido.Hora);
  return hasItems || hasWhen;
}

// Opción A con flag: por defecto requiere dirección; si ADD_ENVIO_WITHOUT_ADDRESS=1, agrega envío apenas sea 'domicilio'
function ensureEnvio(pedido) {
  const entrega = (pedido?.Entrega || "").toLowerCase();
  const allowWithoutAddress = String(process.env.ADD_ENVIO_WITHOUT_ADDRESS || "0") === "1";

  // ¿Hay dirección en el JSON?
  const hasAddress =
    pedido?.Domicilio &&
    typeof pedido.Domicilio === "object" &&
    Object.values(pedido.Domicilio).some(v => String(v || "").trim() !== "");

  if (entrega !== "domicilio") return;
  if (!allowWithoutAddress && !hasAddress) return;

  const tieneEnvio = (pedido.items || []).some(i =>
    (i.descripcion || "").toLowerCase().includes("envio")
  );
  if (tieneEnvio) return;

  (async () => {
    try {
      const db = await getDb();
      let envioProd = null;
      let distanceKm = null;

      if (hasAddress) {
         // 🧭 Completar dirección con defaults si el usuario puso solo calle/numero
        const DEF_CITY = process.env.DEFAULT_CITY || "Venado Tuerto";
        const DEF_PROVINCE = process.env.DEFAULT_PROVINCE || "Santa Fe";
        const DEF_COUNTRY = process.env.DEFAULT_COUNTRY || "Argentina";
        const raw = String(pedido.Domicilio.direccion || "").trim();
        const addressFinal = /,/.test(raw) ? raw : [raw, DEF_CITY, DEF_PROVINCE, DEF_COUNTRY].filter(Boolean).join(", ");
        const coordsCliente = await geocodeAddress(addressFinal);
  
        const coordsStore = getStoreCoords();
        if (coordsCliente && coordsStore) {
          distanceKm = calcularDistanciaKm(
            coordsStore.lat, coordsStore.lon,
            coordsCliente.lat, coordsCliente.lon
          );
          envioProd = await pickEnvioProductByDistance(db, DEFAULT_TENANT_ID, distanceKm);
         console.log(`[envio] Dirección='${addressFinal}', distancia=${distanceKm} km, envioProd=${envioProd?.descripcion}`);
        }
      }

      if (!envioProd) {
        envioProd = await pickEnvioProductByDistance(db, DEFAULT_TENANT_ID, Infinity);
        console.log(`[envio] Fallback envioProd=${envioProd?.descripcion}`);
      }

      if (envioProd) {
        (pedido.items ||= []).push({
          id: envioProd.id || envioProd._id || 0,
          descripcion: envioProd.descripcion,
          cantidad: 1,
          importe_unitario: envioProd.importe || 0,
          total: envioProd.importe || 0,
        });
      }
    } catch (err) {
      console.error("[envio] Error al calcular envio:", err.message);
    }
  })();
}
 function _hasMilanesas(pedido) {
   try {
     return (pedido?.items || []).some(i =>
       String(i?.descripcion || "").toLowerCase().includes("milanesa")
     );
   } catch { return false; }
 }

 /**
  * buildBackendSummary(pedido, { showEnvio:boolean })
 * - Por defecto NO muestra el ítem “Envío”.
  * - Si showEnvio=true, lo incluye.
  * - Si hay milanesas, agrega la leyenda de pesado.
  */
function buildBackendSummary(pedido, opts = {}) {
  const showEnvio = !!opts.showEnvio;
  const showTotal = !!opts.showTotal;
  const askConfirmation = opts.askConfirmation !== false;
  const intro = String(opts.intro || "🧾 Resumen del pedido:").trim();
  const items = (pedido.items || []).filter(it =>
    showEnvio ? true : !/env[ií]o/i.test(String(it?.descripcion || ""))
  );

  // Nombre del cliente
  const nombre = String(pedido.nombre_apellido || pedido.nombre || "").trim();

  // Fecha y hora del pedido (nuevo esquema y fallback a claves viejas)
  const fechaRaw = String(
    pedido.fecha_pedido || pedido.fecha || pedido.Fecha || ""
  ).trim();
  const horaRaw = String(
    pedido.hora_pedido || pedido.hora || pedido.Hora || ""
  ).trim();

  let diaLabel = "";
  let fechaLabel = "";
 if (/^\d{4}-\d{2}-\d{2}$/.test(fechaRaw)) {
    try {
      const baseDate = new Date(`${fechaRaw}T${horaRaw || "12:00"}:00`);
      const fmt = new Intl.DateTimeFormat("es-AR", {
        timeZone: STORE_TZ,
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
      const parts = Object.fromEntries(fmt.formatToParts(baseDate).map(p => [p.type, p.value]));
      const weekday = String(parts.weekday || "").toLowerCase();
      diaLabel = weekday.charAt(0).toUpperCase() + weekday.slice(1);
      fechaLabel = `${parts.day}/${parts.month}/${parts.year}`;
    } catch {}
 }

  // Modalidad / entrega
  const entregaRaw = String(pedido.Entrega || "").trim();
  let modalidadLabel = "";
  if (/^domicilio$/i.test(entregaRaw)) {
    let dir = "";
    if (typeof pedido.Domicilio === "string") {
      dir = pedido.Domicilio.trim();
    } else if (pedido.Domicilio && typeof pedido.Domicilio === "object") {
      dir = String(
        pedido.Domicilio.direccion ||
        pedido.Domicilio.calle ||
        ""
      ).trim();
    }
    modalidadLabel = dir ? `Envío (${dir})` : "Envío";
  } else if (/^retiro$/i.test(entregaRaw)) {
    modalidadLabel = "Retiro";
  } else if (entregaRaw) {
    // Ej: "Envío (Moreno 2862)" ya armado por el modelo
    modalidadLabel = entregaRaw;
  }

  const lines = [
    ...(intro ? [intro] : []),
    ...(nombre ? [`*Nombre:* ${nombre}`] : []),
    ...((diaLabel || fechaLabel)
      ? [`*Día:* ${[diaLabel, fechaLabel].filter(Boolean).join(" ")}`]
      : []),
    ...(horaRaw ? [`*Hora de entrega:* ${horaRaw}`] : []),
    ...(modalidadLabel ? [`*Modalidad:* ${modalidadLabel}`] : []),
    "*Productos:*",
    ...items.map(i => `- ${i.cantidad} ${i.descripcion}`),
    ...(showTotal ? [`*Total:* $${Number(pedido.total_pedido || 0).toLocaleString("es-AR")}`] : []),
    ...(askConfirmation ? ["¿Confirmamos el pedido? ✅"] : [])
  ];

  if (_hasMilanesas(pedido)) {
    lines.splice(lines.length - 1, 0,
      "*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega.*"
    );
  }

  return lines.join("\n");
}
 function coalesceResponse(maybeText, pedido, _opts = {}) {
  const s = String(maybeText || "").trim();
  if (s) return s; // el modelo trajo algo útil

  // Si ya hay contexto, NO resetees al saludo inicial.
  if (hasContext(pedido)) {
    // Texto neutro y breve para no perder continuidad.
    return "Perfecto, sigo acá. ¿Querés confirmar o cambiar algo?";
  }

  // Sin contexto: sí usamos el saludo inicial.
  return START_FALLBACK;
 }
function recalcAndDetectMismatch(pedido) {
  pedido.items ||= [];
  const hasItems = pedido.items.length > 0;
  let mismatch = false;

  const beforeCount = pedido.items.length;
  ensureEnvio(pedido);
  if (pedido.items.length !== beforeCount && hasItems) mismatch = true;

  let totalCalc = 0;
  pedido.items = pedido.items.map(it => {
        // USAR qty() en lugar de num() para interpretar texto tipo "una", "dos", etc.
    const cantidad = qty(it.cantidad);
    const unit = num(it.importe_unitario);
    const totalOk = cantidad * unit;
    const totalIn = it.total != null ? num(it.total) : null;
    if (hasItems && (totalIn === null || totalIn !== totalOk)) mismatch = true;
    totalCalc += totalOk;
    return { ...it, cantidad, importe_unitario: unit, total: totalOk };
  });

  const totalModelo = (pedido.total_pedido == null) ? null : num(pedido.total_pedido);
  if (hasItems && (totalModelo === null || totalModelo !== totalCalc)) mismatch = true;

  pedido.total_pedido = totalCalc;
  return { pedidoCorr: pedido, mismatch, hasItems };
}


// ================== Normalización de precios desde catálogo ==================
function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // sin tildes
    .replace(/[^a-z0-9\s]/g, " ")                    // sin símbolos
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Completa precios de items desde Mongo por coincidencia de descripcion (robusta).
 * - Si el ítem parece una milanesa, NO reemplaza precio (deja 0).
 * - Para el resto (pollo, papas, bebidas, etc.), pisa el unitario si está vacío/0 o si viene mal.
 */
async function hydratePricesFromCatalog(pedido, tenantId) {
  try {
    if (!pedido || !Array.isArray(pedido.items) || !pedido.items.length) return pedido;
    const db = await getDb();
    const filter = { active: { $ne: false } };
    if (tenantId) filter.tenantId = tenantId;
    const products = await db.collection("products").find(filter).toArray();
    if (!products.length) return pedido;

    // índice por descripción normalizada
    const map = new Map();
    for (const p of products) {
      const key = _norm(p.descripcion);
      if (key) map.set(key, p);
    }

    const looksLikeMilanesa = (txt) => /\bmilanesa(s)?\b|\bnapolitana(s)?\b/.test(_norm(txt));

    pedido.items = (pedido.items || []).map(it => {
      const desc = String(it?.descripcion || "");
      if (!desc) return it;

      // Si es milanesa, respetamos regla de $0
      if (looksLikeMilanesa(desc)) {
        return { ...it, importe_unitario: 0, total: 0 };
      }

      const key = _norm(desc);
      let unit = Number(String(it.importe_unitario ?? "").replace(/[^\d.-]/g, "")) || 0;
      const hit = map.get(key);

      // Reemplazar cuando no tenga precio o venga 0/erróneo
      if (hit && typeof hit.importe === "number" && (!Number.isFinite(unit) || unit <= 0)) {
        unit = Number(hit.importe);
      }
      const cantidad = Number(String(it.cantidad ?? "1").replace(/[^\d.-]/g, "")) || 0;
      const total = cantidad * (Number.isFinite(unit) ? unit : 0);
      return { ...it, importe_unitario: unit, total };
    });
    return pedido;
  } catch {
    return pedido;
  }
}





// ================== Chat con historial (inyecta comportamiento de Mongo al inicio) ==================
async function getGPTReply(tenantId, from, userMessage, opts = {}) {
  // Limpieza defensiva: cuando el cliente manda varios mensajes juntos (debounce),
  // a veces llega el primer segmento repetido al final (ej: 'hola, ..., hola').
  // Evitamos que eso se propague al historial y al panel de conversaciones.
  try {
    const _raw = String(userMessage ?? '').trim();
    if (_raw.includes(',')) {
      const parts = _raw.split(',').map(p => p.trim()).filter(Boolean);
      const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      // si el primer y último segmento son iguales (ignorando puntuación/espacios), quitamos el último
      if (parts.length >= 2 && norm(parts[0]) && norm(parts[0]) === norm(parts[parts.length - 1])) {
        parts.pop();
      }
      // también evitamos duplicado exacto consecutivo al final
      if (parts.length >= 2 && norm(parts[parts.length - 2]) && norm(parts[parts.length - 2]) == norm(parts[parts.length - 1])) {
        parts.pop();
      }
      userMessage = parts.join(', ');
    } else {
      userMessage = _raw;
    }
  } catch {}

  const id = k(tenantId, from);
  const cfg = await loadBehaviorConfigFromMongo(tenantId);
  const baseText = cfg.text;
  const historyMode = (cfg.history_mode || "standard").toLowerCase();

  // Bloque system inicial
  const catalogText = await loadCatalogTextFromMongo(tenantId);
  const storeHoursBlock = await loadStoreHoursBlockFromMongo(tenantId);
  const fullSystem = [
    buildNowBlock(),
    storeHoursBlock,
    "[COMPORTAMIENTO]\n" + baseText + catalogText
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  let messages = [];

  if (historyMode === "minimal") {
    if ((!userOnlyHistories[id] || !assistantPedidoSnapshot[id]) && currentConversationIds[id]) {
      await hydrateSessionStateFromDb(tenantId, from, historyMode, fullSystem);
    }
    if (!userOnlyHistories[id]) userOnlyHistories[id] = [];
    if (!assistantPedidoSnapshot[id]) {
      assistantPedidoSnapshot[id] = JSON.stringify({ estado: "IN_PROGRESS", Pedido: { items: [], total_pedido: 0 } });
    }
    messages = [{ role: "system", content: fullSystem }];
    const asst = assistantPedidoSnapshot[id];
    if (asst) messages.push({ role: "assistant", content: asst });
    const alreadySeededCurrentUser = (() => {
      const last = userOnlyHistories[id]?.[userOnlyHistories[id].length - 1];
      return last && last.role === "user" && String(last.content || "") === String(userMessage || "");
    })();
    const seq = alreadySeededCurrentUser
      ? userOnlyHistories[id].slice()
      : userOnlyHistories[id].concat([{ role: "user", content: userMessage }]);
    messages.push(...seq);
    if (!alreadySeededCurrentUser) {
      userOnlyHistories[id].push({ role: "user", content: userMessage });
    }

   // console.log("[minimal] comportamiento =>\n" + baseText);
   // console.log("[minimal] messages => " + safeStringify(messages));
    //console.log("[minimal] userOnlyHistories => " + safeStringify(userOnlyHistories[id]));
  } else {
    // --- standard history: si se perdió memoria, rehidratar desde Mongo usando la conversación actual ---
    if (!chatHistories[id] && currentConversationIds[id]) {
      await hydrateSessionStateFromDb(tenantId, from, historyMode, fullSystem);
    }

    // --- standard history: refrescar siempre el primer system con [AHORA] actualizado ---
    if (!chatHistories[id]) {
      chatHistories[id] = [{ role: "system", content: fullSystem }];
    } else {
      // 🔁 Refresh del bloque system para que [AHORA] sea siempre el del turno actual
      chatHistories[id][0] = { role: "system", content: fullSystem };
    }
    const lastMsg = chatHistories[id][chatHistories[id].length - 1];
    const alreadySeededCurrentUser = lastMsg && lastMsg.role === "user" && String(lastMsg.content || "") === String(userMessage || "");
    if (!alreadySeededCurrentUser) {
      chatHistories[id].push({ role: "user", content: userMessage });
    }
    messages = chatHistories[id];
  }

  try {
    const apiKey = String(opts.openaiApiKey || OPENAI_API_KEY || "").trim();
    const tenantAiCfg = await loadTenantAiConfigFromMongo(tenantId);
    const model = String(
      opts.chatModel ||
      tenantAiCfg.chatModel ||
      CHAT_MODEL ||
      "gpt-5.4"
    ).trim();
    const temperatureRaw = opts.chatTemperature ?? tenantAiCfg.chatTemperature;
    const temperature = Number.isFinite(Number(temperatureRaw))
      ? Math.max(0, Math.min(2, Number(temperatureRaw)))
      : CHAT_TEMPERATURE;
    const maxTokensRaw = opts.chatMaxTokens ?? tenantAiCfg.chatMaxTokens;
    const maxTokens = Number.isFinite(Number(maxTokensRaw)) && Number(maxTokensRaw) > 0
      ? Math.trunc(Number(maxTokensRaw))
      : (CHAT_MAX_TOKENS > 0 ? Math.trunc(CHAT_MAX_TOKENS) : null);
    const payload = {
      model,
      messages: sanitizeMessages(messages),
      temperature,
      response_format: buildStrictPedidoResponseFormat()
    };
    applyModelTokenLimit(payload, model, maxTokens);
    console.log("[openai] request.meta =>", {
      model,
      temperature,
      token_limit_param: maxTokens
        ? (modelUsesMaxCompletionTokens(model) ? "max_completion_tokens" : "max_tokens")
        : null,
      token_limit_value: maxTokens || null,
      response_format: "json_schema_strict"
    });
    console.log("[openai] message =>\n" + JSON.stringify(sanitizeMessages(messages), null, 2));

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );

    try {
      const { id: oid, model: responseModel, usage } = response.data || {};
      console.log("[openai] response.meta =>", {
        id: oid,
        model: responseModel || model,
        temperature,
         max_tokens: maxTokens || null,
        usage
      });
      //console.log("[openai] response.data =>\n" + JSON.stringify(response.data, null, 2));
    } catch (e) {
      console.warn("[openai] no se pudo stringify la respuesta:", e?.message);
    }

    //const reply = response.data.choices[0].message.content;
    //console.log("[openai] assistant.content =>\n" + reply);
    const reply = extractChatCompletionContent(response.data);
    if (!reply) {
      throw new Error("openai_empty_structured_reply");
    }
    // Si el modelo devuelve {"error":"..."} lo logueamos como warn (regla de negocio, no falla técnica)
    {
      let _log = console.log;
      try {
        const _j = JSON.parse(reply);
        if (typeof _j?.error === "string" && _j.error.trim()) _log = console.warn;
      } catch {}
      _log("[openai] assistant.content =>\n" + reply);
    }
    if (historyMode === "standard") {
      // Si otra request cerró la sesión mientras esperábamos a OpenAI,
      // recreamos el historial mínimo para evitar "Cannot read properties of undefined (reading 'push')".
      // La sesión puede haberse limpiado mientras esperábamos a OpenAI
      // (por ejemplo, cierre de conversación o cambio de convId).
      if (!Array.isArray(chatHistories[id])) {
        chatHistories[id] = [{ role: "system", content: fullSystem }];
      } else if (!chatHistories[id].length) {
        chatHistories[id].push({ role: "system", content: fullSystem });
      }

      if (!chatHistories[id]) {
        chatHistories[id] = [{ role: "system", content: fullSystem }];
      }
      chatHistories[id].push({ role: "assistant", content: reply });
    }
    return reply;
  } catch (error) {
    if (error?.response?.data) {
      console.error("Error OpenAI:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error("Error OpenAI:", error?.message || error);
    }
    return '{"response":"Lo siento, ocurrió un error. Intenta nuevamente.","estado":"IN_PROGRESS","Pedido":{"items":[],"total_pedido":0}}';
  }
}

// Permite setear el snapshot que se inyectará como rol assistant (solo minimal)
function setAssistantPedidoSnapshot(tenantId, from, pedidoObj, estado) {
  const id = k(tenantId, from);
  try {
    const content = JSON.stringify({ estado: estado || null, Pedido: pedidoObj || {} });
    assistantPedidoSnapshot[id] = content;
  } catch {}
}

function replaceLastAssistantHistory(tenantId, from, assistantContent) {
  const id = k(tenantId, from);
  const content = String(assistantContent || "").trim();
  if (!content) return false;
  try {
    if (!Array.isArray(chatHistories[id]) || !chatHistories[id].length) return false;
    for (let i = chatHistories[id].length - 1; i >= 0; i--) {
      if (String(chatHistories[id][i]?.role || "") === "assistant") {
        chatHistories[id][i] = { role: "assistant", content };
        return true;
      }
    }
    chatHistories[id].push({ role: "assistant", content });
    return true;
  } catch {
    return false;
  }
}


// ================== Distancia Haversine ==================
function calcularDistanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return +(R * c).toFixed(2);
}


// ================== Geocoding por dirección (Google) ==================
async function geocodeAddress(address) {
  try {
    if (!GOOGLE_MAPS_API_KEY || !address) return null;
    const url = "https://maps.googleapis.com/maps/api/geocode/json";
    const { data } = await axios.get(url, { params: { address, key: GOOGLE_MAPS_API_KEY } });


    const result0 = data?.results?.[0];
    const hit = result0?.geometry?.location;
    if (!hit) return null;

    // Google Geocoding puede devolver resultados aproximados.
    // ✅ Regla nueva:
    // - Válida si es ROOFTOP (siempre)
    // - O válida si NO es partial_match y el tipo sugiere dirección puntual (street_address/premise/subpremise)
    const locationType = String(result0?.geometry?.location_type || "").toUpperCase();
    const partialMatch = Boolean(result0?.partial_match);
    const types = Array.isArray(result0?.types) ? result0.types.map(String) : [];
    const isAddressType = types.some(t =>
      ["street_address", "premise", "subpremise"].includes(String(t || ""))
    );
    const exactByMatch = isAddressType && !partialMatch;
    const exact = (locationType === "ROOFTOP") || exactByMatch;

    return {
      lat: hit.lat,
      lon: hit.lng,
      exact,
      location_type: locationType || null,
      partial_match: partialMatch,
      formatted_address: result0?.formatted_address || null,
      place_id: result0?.place_id || null,
      types,
      status: data?.status || null,
    };
  } catch (e) {
    console.error("geocodeAddress error:", e?.response?.data || e.message);
    return null;
  }
}

// ================== Reverse Geocoding por coordenadas (Google) ==================
// Útil cuando el usuario comparte ubicación (lat/lon) en WhatsApp.
async function reverseGeocode(lat, lon) {
  try {
    const la = Number(lat);
    const lo = Number(lon);
    if (!GOOGLE_MAPS_API_KEY || !Number.isFinite(la) || !Number.isFinite(lo)) return null;

    const url = "https://maps.googleapis.com/maps/api/geocode/json";
    const { data } = await axios.get(url, { params: { latlng: `${la},${lo}`, key: GOOGLE_MAPS_API_KEY } });

    const result0 = data?.results?.[0];
    if (!result0) return null;

    const comps = Array.isArray(result0.address_components) ? result0.address_components : [];
    const pick = (type) => {
      const c = comps.find(x => Array.isArray(x?.types) && x.types.includes(type));
      return c?.long_name || null;
    };

    // Algunos países no devuelven "locality" siempre, por eso agregamos fallbacks.
   const locality = pick("locality") || pick("administrative_area_level_2") || null;
    const province = pick("administrative_area_level_1") || null;

    return {
      lat: la,
      lon: lo,
      formatted_address: result0?.formatted_address || null,
      place_id: result0?.place_id || null,
      types: Array.isArray(result0?.types) ? result0.types.map(String) : [],
      status: data?.status || null,
      // componentes útiles para completar Domicilio
      street: pick("route"),
      street_number: pick("street_number"),
      barrio: pick("sublocality") || pick("neighborhood") || null,
      ciudad: locality,
      provincia: province,
      cp: pick("postal_code"),
      country: pick("country"),
    };
  } catch (e) {
    console.error("reverseGeocode error:", e?.response?.data || e.message);
    return null;
  }
}



function getStoreCoords() {
  // Devuelve null si no están configuradas para no romper el flujo
  if (!Number.isFinite(STORE_LAT) || !Number.isFinite(STORE_LNG)) return null;
  return { lat: STORE_LAT, lon: STORE_LNG };
}

// ================== Selección de Envío desde catálogo por distancia ==================
/**
 * Busca productos activos del tenant cuya descripción contenga 'Envio' (case-insensitive),
 * intenta parsear rangos de km en la descripción y elige el que matchee la distancia.
 * Ejemplos soportados:
 *  - "Envio 0-3km", "Envio 3 - 6 km", "Envio hasta 3 km", "Envio >6km", "Envio 6+ km"
 * Fallback: si no hay rangos, retorna el primer "Envio".
 */
async function pickEnvioProductByDistance(db, tenantId, distanceKm) {
  const filter = { active: { $ne: false }, descripcion: { $regex: /envio/i } };
  if (tenantId) filter.tenantId = tenantId;
  const productos = await db.collection("products").find(filter).toArray();
  if (!productos.length) return null;

 const norm = (s) => String(s || "").toLowerCase();
  const parsed = productos.map(p => {
    const d = norm(p.descripcion);
    // intentamos extraer min/max en km
    // 1) Rango "a-b km"
    let min = null, max = null;
    const m1 = d.match(/(\d+(?:[\.,]\d+)?)\s*-\s*(\d+(?:[\.,]\d+)?)\s*km/);
    if (m1) { min = parseFloat(m1[1].replace(",", ".")); max = parseFloat(m1[2].replace(",", ".")); }
    // 2) "hasta X km"
    const m2 = !m1 && d.match(/hasta\s*(\d+(?:[\.,]\d+)?)\s*km/);
    if (m2) { min = 0; max = parseFloat(m2[1].replace(",", ".")); }
    // 3) ">X km" o "X+ km"
    const m3 = !m1 && !m2 && d.match(/(?:>\s*|(^|\s))(\d+(?:[\.,]\d+)?)\s*\+?\s*km/);
    if (m3) { min = parseFloat(m3[2].replace(",", ".")); max = Infinity; }
    return { prod: p, min, max };
  });

  const candidates = parsed.filter(x => x.min !== null || x.max !== null);
  if (candidates.length) {
    const hit = candidates.find(x => {
      const lo = x.min ?? 0;
      const hi = x.max ?? Infinity;
      return distanceKm >= lo && distanceKm <= hi;
    });
    if (hit) return hit.prod;
    // si no matchea, tomamos el de mayor max < distancia o el de mayor rango
    const withMax = candidates.filter(x => Number.isFinite(x.max));
    if (withMax.length) {
      const nearestBelow = withMax
        .filter(x => x.max < distanceKm)
        .sort((a,b) => b.max - a.max)[0];
      if (nearestBelow) return nearestBelow.prod;
    }
  }
  // fallback: primer producto "Envio"
  return productos[0];
}


// ================== Envío inteligente (awaitable) ==================
/**
 * Inserta/ajusta el item "Envio" según:
 *  - Entrega = domicilio
 *  - Geocoding de la dirección (si hay)
 *  - Distancia con STORE_LAT/LNG
 *  - Selección de producto de envío por rango
 *
 * Seguro para llamar antes de recálculos. No duplica ítem.
 */
async function ensureEnvioSmart(pedido, tenantId) {
  try {
    if (!pedido) return pedido;
    const entrega = String(pedido?.Entrega || "").toLowerCase();
    if (entrega !== "domicilio") return pedido;

    // Helper: detectar items de envío, tolerando "envío" con tilde
    const isEnvioItem = (i) => {
      const raw = String(i?.descripcion || "").toLowerCase();
      const norm = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // quita tildes
      return norm.includes("envio");
    };

    // ¿ya hay envío? (puede haber más de uno; vamos a dejar uno solo)
    const itemsArr = Array.isArray(pedido.items) ? pedido.items : [];
    const envioIdxs = [];
    for (let k = 0; k < itemsArr.length; k++) {
      if (isEnvioItem(itemsArr[k])) envioIdxs.push(k);
    }

    // Si hay más de un envío, eliminar extras (de atrás hacia adelante)
    if (envioIdxs.length > 1) {
      for (let n = envioIdxs.length - 1; n >= 1; n--) {
        itemsArr.splice(envioIdxs[n], 1);
      }
    }
    const idx = envioIdxs.length ? envioIdxs[0] : -1;

        // Preparar dirección
    const DEF_CITY = process.env.DEFAULT_CITY || "Venado Tuerto";
    const DEF_PROVINCE = process.env.DEFAULT_PROVINCE || "Santa Fe";
    const DEF_COUNTRY = process.env.DEFAULT_COUNTRY || "Argentina";
    const rawDomicilio = pedido?.Domicilio || {};
    const domicilio = (typeof rawDomicilio === "string")
      ? { direccion: rawDomicilio }
      : rawDomicilio;
    // normalizamos para que siempre sea objeto
    pedido.Domicilio = domicilio;

    // Si ya tenemos coords (por ubicación compartida), preferimos eso y evitamos geocoding.
    const store = getStoreCoords?.();
    const domLat = Number(domicilio?.lat);
    const domLon = Number(domicilio?.lon);
    const hasCoords = Number.isFinite(domLat) && Number.isFinite(domLon);
    let distKm = null;
    if (store && hasCoords) {
      pedido.Domicilio.lat = domLat;
      pedido.Domicilio.lon = domLon;
      distKm = calcularDistanciaKm(store.lat, store.lon, domLat, domLon);
      pedido.distancia_km = distKm;
      console.log(`[envio] ensureEnvioSmart coords lat=${domLat}, lon=${domLon}, distancia=${distKm} km`);
    }

    const addrParts = [
      domicilio.direccion,
      [domicilio.calle, domicilio.numero].filter(Boolean).join(" "),
      domicilio.barrio,
      domicilio.ciudad || domicilio.localidad,
      domicilio.provincia,
      domicilio.cp
    ].filter(Boolean);
    let address = addrParts.join(", ").trim();
    if (!address && !hasCoords) {
      console.log("[envio] ensureEnvioSmart: sin dirección ni coords, no ajusto el envío por distancia");
      return pedido;
    }
    if (!/,/.test(address)) {
      address = [address, DEF_CITY, DEF_PROVINCE, DEF_COUNTRY].filter(Boolean).join(", ");
    }

    
     // Geocoding + distancia (solo si NO había coords)
    if (store && address && !hasCoords) {
      const geo = await geocodeAddress(address);
      if (geo && geo.exact) {
        const { lat, lon } = geo;
        pedido.Domicilio.lat = lat;
        pedido.Domicilio.lon = lon;
        distKm = calcularDistanciaKm(store.lat, store.lon, lat, lon);
        pedido.distancia_km = distKm;
        console.log(`[envio] ensureEnvioSmart address='${address}', distancia=${distKm} km`);
      } else {
        // Si hay resultado pero no es exacto, no fijamos coords ni distancia.
       // De esta forma el envío queda por fallback (Infinity) y el endpoint puede pedir reintento.
        const reason = geo ? `inexacto (partial=${geo.partial_match}, type=${geo.location_type})` : "sin resultado";
        console.warn(`[envio] ensureEnvioSmart: geocoding ${reason}`);
      }
    }

    // Elegir producto de envío (por distancia si la hay; si no, fallback)
    const db = await getDb();
    const envioProd = await pickEnvioProductByDistance(db, tenantId || null, distKm ?? Infinity);
    if (!envioProd) return pedido;

    // Insertar o actualizar
    if (idx >= 0) {
      //const cantidad = Number(pedido.items[idx].cantidad || 1);
      // Envío siempre debe ser 1 unidad (evita que se acumule por errores previos)
      const cantidad = 1;
      pedido.items[idx].id = envioProd._id || pedido.items[idx].id || 0;
      pedido.items[idx].descripcion = envioProd.descripcion;
      pedido.items[idx].importe_unitario = Number(envioProd.importe || 0);
      pedido.items[idx].total = cantidad * Number(envioProd.importe || 0);
      console.log(`[envio] ensureEnvioSmart ajustado a '${envioProd.descripcion}' @ ${envioProd.importe}`);
    } else {
      (pedido.items ||= []).push({
        id: envioProd._id || 0,
        descripcion: envioProd.descripcion,
        cantidad: 1,
        importe_unitario: Number(envioProd.importe || 0),
        total: Number(envioProd.importe || 0),
      });
      console.log(`[envio] ensureEnvioSmart insertado '${envioProd.descripcion}' @ ${envioProd.importe}`);
    }
    return pedido;
  } catch (e) {
    console.error("[envio] ensureEnvioSmart error:", e?.message);
    return pedido;
  }
}


module.exports = {
  // comportamiento
  loadBehaviorTextFromMongo,
  loadBehaviorConfigFromMongo,
  invalidateBehaviorCache,
  invalidateTenantAiConfigCache,
  // catálogo
  loadCatalogTextFromMongo,

  // chat
  getGPTReply,

  // session
  hasActiveEndedFlag,
  markSessionEnded,
  syncSessionConversation,
  isPoliteClosingMessage,

  // whatsapp + media + stt
  sendWhatsAppMessage,
  sendInstagramMessage,
  sendChannelMessage,
  getMediaInfo,
  downloadMediaBuffer,
  transcribeAudioExternal,
  analyzeImageExternal,
  // cache público
  putInCache,
  getFromCache,
  fileCache,

  // negocio pedido
  START_FALLBACK,
  buildBackendSummary,
  coalesceResponse,
  recalcAndDetectMismatch,
    clearEndedFlag,

  // constants needed by endpoints (optional export)
  GRAPH_VERSION,

  // exports auxiliares
  DEFAULT_TENANT_ID,
  setAssistantPedidoSnapshot,
  replaceLastAssistantHistory,
  calcularDistanciaKm,
  geocodeAddress,
  reverseGeocode,
  getStoreCoords,
  pickEnvioProductByDistance,
  hydratePricesFromCatalog,
  hasContext,
 ensureEnvioSmart,
};
