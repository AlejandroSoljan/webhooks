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

const ASSISTANT_CONVERSATIONAL_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["response", "lead", "action"],
  properties: {
    response: { type: "string" },
    lead: {
      type: "object",
      additionalProperties: false,
      required: [
        "capture",
        "type",
        "complete",
        "name",
        "company",
        "email",
        "origin",
        "destination",
        "cargo",
        "packages",
        "weight",
        "dimensions",
        "notes"
      ],
      properties: {
        capture: { type: "boolean" },
        type: { type: "string", enum: ["", "cotizacion", "contacto"] },
        complete: { type: "boolean" },
        name: { type: "string" },
        company: { type: "string" },
        email: { type: "string" },
        origin: { type: "string" },
        destination: { type: "string" },
        cargo: { type: "string" },
        packages: { type: "string" },
        weight: { type: "string" },
        dimensions: { type: "string" },
        notes: { type: "string" }
      }
    },
    action: {
      type: "object",
      additionalProperties: false,
      required: ["call", "name", "query"],
      properties: {
        call: { type: "boolean" },
        name: { type: "string" },
        query: { type: "string" }
      }
    }
  }
};

const ASSISTANT_CONVERSATIONAL_NO_LEAD_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["response", "action"],
  properties: {
    response: { type: "string" },
    action: {
      type: "object",
      additionalProperties: false,
      required: ["call", "name", "query"],
      properties: {
        call: { type: "boolean" },
        name: { type: "string" },
        query: { type: "string" }
      }
    }
  }
};

function buildStrictConversationalResponseFormat(leadCaptureEnabled = true) {
  return {
    type: "json_schema",
    json_schema: {
      name: leadCaptureEnabled ? "conversational_response" : "conversational_response_no_lead",
      strict: true,
      schema: leadCaptureEnabled
        ? ASSISTANT_CONVERSATIONAL_RESPONSE_SCHEMA
        : ASSISTANT_CONVERSATIONAL_NO_LEAD_RESPONSE_SCHEMA
    }
  };
}

function normalizeBotMode(value) {
  const v = String(value || "pedidos").trim().toLowerCase();
  if (["conversacional", "conversation", "conversational", "chat", "general", "libre", "test", "pruebas"].includes(v)) {
    return "conversacional";
  }
  return "pedidos";
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
  // Retrocompatibilidad total: si el campo no existe, sigue funcionando como bot de pedidos.
  const bot_mode = normalizeBotMode(doc.bot_mode || doc.botMode || process.env.BOT_MODE || "pedidos");
  const leadCaptureRaw =
    doc.lead_capture_enabled ??
    doc.leadCaptureEnabled ??
    process.env.LEAD_CAPTURE_ENABLED ??
    false;
 const lead_capture_enabled = leadCaptureRaw === true ||
    ["1", "true", "yes", "si", "sí", "on"].includes(String(leadCaptureRaw || "").trim().toLowerCase());

  const externalApiEnabledRaw =
    doc.external_api_enabled ??
    doc.externalApiEnabled ??
    process.env.EXTERNAL_API_ENABLED ??
    false;
  const external_api_enabled = externalApiEnabledRaw === true ||
    ["1", "true", "yes", "si", "sí", "on"].includes(String(externalApiEnabledRaw || "").trim().toLowerCase());
  const external_api_action_name = String(doc.external_api_action_name || doc.externalApiActionName || "consulta_externa").trim() || "consulta_externa";
  const external_api_description = String(doc.external_api_description || doc.externalApiDescription || "Consultar información actualizada en una API externa.").trim();
 const external_api_url = String(doc.external_api_url || doc.externalApiUrl || "").trim();
  const external_api_method = String(doc.external_api_method || doc.externalApiMethod || "GET").trim().toUpperCase() === "POST" ? "POST" : "GET";
  const external_api_query_param = String(doc.external_api_query_param || doc.externalApiQueryParam || "buscar").trim();
  const external_api_body_template = String(doc.external_api_body_template || doc.externalApiBodyTemplate || process.env.EXTERNAL_API_BODY_TEMPLATE || "").trim();
  const external_api_auth_header = String(doc.external_api_auth_header || doc.externalApiAuthHeader || "").trim();
  const external_api_auth_value = String(doc.external_api_auth_value || doc.externalApiAuthValue || "").trim();
  const external_api_result_instructions = String(doc.external_api_result_instructions || doc.externalApiResultInstructions || "").trim();
  const external_api_timeout_ms = Math.max(1000, Math.min(30000, Number(doc.external_api_timeout_ms || doc.externalApiTimeoutMs || 10000) || 10000));
  const external_api_max_chars = Math.max(2000, Math.min(100000, Number(doc.external_api_max_chars || doc.externalApiMaxChars || 30000) || 30000));

  // Ficha pública de producto por QR. La consulta inicial usa esta API sin IA;
  // OpenAI interviene recién cuando el visitante abre "Mostrar más info"/chat.
  const qr_enabled = doc.qr_enabled === true || ["1","true","yes","si","sí","on"].includes(String(doc.qr_enabled || "").trim().toLowerCase());
  const qr_page_title = String(doc.qr_page_title || "Información del producto").trim();
  const qr_page_subtitle = String(doc.qr_page_subtitle || "Consultá precio, disponibilidad y más información.").trim();
  const qr_company_name = String(doc.qr_company_name || "").trim();
  const qr_company_logo_url = String(doc.qr_company_logo_url || "").trim();
  const qr_button_color = String(doc.qr_button_color || "#0f766e").trim() || "#0f766e";
  const qr_button_text_color = String(doc.qr_button_text_color || "#ffffff").trim() || "#ffffff";
  const qr_currency = String(doc.qr_currency || "ARS").trim().toUpperCase() || "ARS";
  const qr_api_url = String(doc.qr_api_url || "").trim();
  const qr_api_method = String(doc.qr_api_method || "GET").trim().toUpperCase() === "POST" ? "POST" : "GET";
  const qr_api_code_param = String(doc.qr_api_code_param || "codigo").trim();
  const qr_api_body_template = String(doc.qr_api_body_template || "").trim();
  const qr_api_auth_header = String(doc.qr_api_auth_header || "").trim();
  const qr_api_auth_value = String(doc.qr_api_auth_value || "").trim();
  const qr_api_timeout_ms = Math.max(1000, Math.min(30000, Number(doc.qr_api_timeout_ms || 12000) || 12000));
  const qr_field_code = String(doc.qr_field_code || "Codigo").trim();
  const qr_field_description = String(doc.qr_field_description || "Descripcion").trim();
  const qr_field_price = String(doc.qr_field_price || "Precio_Lp1").trim();
  const qr_field_stock = String(doc.qr_field_stock || "Stock").trim();
  const qr_field_image = String(doc.qr_field_image || "").trim();
  const qr_field_brand = String(doc.qr_field_brand || "").trim();
  const qr_field_category = String(doc.qr_field_category || "Desc_Rubro").trim();
  const qr_field_subcategory = String(doc.qr_field_subcategory || "Desc_Subrubro").trim();
  const qr_ai_enabled = doc.qr_ai_enabled === undefined ? true : (doc.qr_ai_enabled === true || ["1","true","yes","si","sí","on"].includes(String(doc.qr_ai_enabled || "").trim().toLowerCase()));
  const qr_ai_use_same_behavior = doc.qr_ai_use_same_behavior === undefined ? true : (doc.qr_ai_use_same_behavior === true || ["1","true","yes","si","sí","on"].includes(String(doc.qr_ai_use_same_behavior || "").trim().toLowerCase()));
  const qr_ai_behavior = String(doc.qr_ai_behavior || "").trim();
  const qr_ai_web_search_enabled = doc.qr_ai_web_search_enabled === undefined ? true : (doc.qr_ai_web_search_enabled === true || ["1","true","yes","si","sí","on"].includes(String(doc.qr_ai_web_search_enabled || "").trim().toLowerCase()));
  const _qrWebCtx = String(doc.qr_ai_web_search_context_size || "medium").trim().toLowerCase();
  const qr_ai_web_search_context_size = ["low","medium","high"].includes(_qrWebCtx) ? _qrWebCtx : "medium";
  // La búsqueda web vía Responses puede tardar más de 30 s. Se configura aparte
  // del timeout del API comercial del QR para no mezclar ambos recorridos.
  const qr_ai_web_search_timeout_ms = Math.max(10000, Math.min(120000, Number(doc.qr_ai_web_search_timeout_ms || 90000) || 90000));


  // Nuevo formato: varias acciones externas por comportamiento. Si todavía no existe
  // external_actions, se transforma virtualmente la API única histórica para mantener
  // compatibilidad con configuraciones ya guardadas.
  const external_actions = normalizeConversationalExternalActionsConfig({
    ...doc,
    external_api_enabled,
    external_api_action_name,
    external_api_description,
    external_api_url,
    external_api_method,
    external_api_query_param,
    external_api_body_template,
    external_api_auth_header,
    external_api_auth_value,
    external_api_result_instructions,
    external_api_timeout_ms,
    external_api_max_chars
  });


  const cfg = {
    text,
    history_mode,
    bot_mode,
    lead_capture_enabled,
    external_api_enabled,
    external_api_action_name,
    external_api_description,
   external_api_url,
    external_api_method,
    external_api_query_param,
    external_api_body_template,
    external_api_auth_header,
    external_api_auth_value,
    external_api_result_instructions,
    external_api_timeout_ms,
    external_api_max_chars,
    external_actions,
    qr_enabled,
    qr_page_title,
    qr_page_subtitle,
    qr_company_name,
    qr_company_logo_url,
    qr_button_color,
    qr_button_text_color,
    qr_currency,
    qr_api_url,
    qr_api_method,
    qr_api_code_param,
    qr_api_body_template,
    qr_api_auth_header,
    qr_api_auth_value,
    qr_api_timeout_ms,
    qr_field_code,
    qr_field_description,
    qr_field_price,
    qr_field_stock,
    qr_field_image,
    qr_field_brand,
    qr_field_category,
    qr_field_subcategory,
    qr_ai_enabled,
    qr_ai_use_same_behavior,
    qr_ai_behavior,
    qr_ai_web_search_enabled,
    qr_ai_web_search_context_size,
    qr_ai_web_search_timeout_ms,
    at: Date.now()
  };
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


async function recordTokenUsage(entry = {}) {
  try {
    const tenant = String(entry.tenantId || DEFAULT_TENANT_ID || "default").trim() || "default";
    const kind = String(entry.kind || "").trim().toLowerCase();
    if (!tenant || !kind) return null;

    const inputTokens = Number(entry.inputTokens);
    const outputTokens = Number(entry.outputTokens);
    let totalTokens = Number(entry.totalTokens);

    const safeInput = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
    const safeOutput = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
    if (!Number.isFinite(totalTokens)) totalTokens = safeInput + safeOutput;
    totalTokens = Math.max(0, totalTokens);
    const meta = (entry.meta && typeof entry.meta === "object") ? entry.meta : null;
    const conversationId = String(entry.conversationId || meta?.conversationId || "").trim();
    const waId = String(entry.waId || entry.contact || entry.from || meta?.waId || "").trim();
    const channelType = String(entry.channelType || meta?.channelType || "").trim().toLowerCase();
    const usageTraceId = String(entry.usageTraceId || meta?.usageTraceId || "").trim();

    const db = await getDb();
    await db.collection("ai_token_usage_log").insertOne({
      tenantId: tenant,
      kind,
      provider: String(entry.provider || "openai").trim() || "openai",
      model: String(entry.model || "").trim() || null,
      inputTokens: safeInput,
      outputTokens: safeOutput,
      totalTokens,
      ...(conversationId ? { conversationId } : {}),
      ...(waId ? { waId } : {}),
      ...(channelType ? { channelType } : {}),
      ...(usageTraceId ? { usageTraceId } : {}),
      meta,
      createdAt: new Date()
    });
    return true;
  } catch (e) {
    console.warn("[tokens] recordTokenUsage error:", e?.message || e);
    return null;
  }
}

function parseTokenUsagePair(usage, fallbackKind = "message") {
  if (usage == null) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  if (typeof usage === "number") {
    const total = Number.isFinite(usage) ? Math.max(0, usage) : 0;
    if (fallbackKind === "audio") {
      return { inputTokens: total, outputTokens: 0, totalTokens: total };
    }
    return { inputTokens: total, outputTokens: 0, totalTokens: total };
  }

  const u = (usage && typeof usage === "object") ? usage : {};
  const inputTokens = Number(
    u.input_tokens ??
    u.prompt_tokens ??
    u.audio_tokens ??
    u.tokens ??
    0
  );
  const outputTokens = Number(
    u.output_tokens ??
    u.completion_tokens ??
    u.text_tokens ??
    0
  );
  const totalTokensRaw = Number(
    u.total_tokens ??
    u.total ??
    (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0)
  );

  const safeInput = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const safeOutput = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
  const safeTotal = Number.isFinite(totalTokensRaw) ? Math.max(0, totalTokensRaw) : (safeInput + safeOutput);
  return { inputTokens: safeInput, outputTokens: safeOutput, totalTokens: safeTotal };
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

// Historial conversacional compacto: conserva contexto reciente sin reenviar
// indefinidamente toda la conversación. 20 entradas = hasta 10 intercambios
// user/assistant, suficiente para mantener referencias recientes y combos.
const CONVERSATIONAL_COMPACT_MAX_MESSAGES = 20;

function trimConversationalHistoryInPlace(id, fullSystem) {
  const arr = Array.isArray(chatHistories[id]) ? chatHistories[id] : [];
  const recent = arr
    .filter((m, idx) => idx > 0 && String(m?.role || "") !== "system")
    .slice(-CONVERSATIONAL_COMPACT_MAX_MESSAGES);
  chatHistories[id] = [{ role: "system", content: fullSystem }, ...recent];
  return chatHistories[id];
}

function conversationalAssistantHistoryContent(reply) {
  const raw = String(reply || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const response = String(parsed?.response || "").trim();
    if (response) return response;
  } catch {}
  return raw;
}


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

    const normalizedHistoryMode = String(historyMode || "").toLowerCase();
    let rows;
    if (normalizedHistoryMode === "compact") {
      rows = await db.collection("messages")
        .find({ conversationId: convObjectId, tenantId: tenant })
        .sort({ ts: -1, _id: -1 })
        .limit(CONVERSATIONAL_COMPACT_MAX_MESSAGES)
        .toArray();
      rows.reverse();
    } else {
      rows = await db.collection("messages")
        .find({ conversationId: convObjectId, tenantId: tenant })
        .sort({ ts: 1, _id: 1 })
        .limit(100)
        .toArray();
    }
    if (normalizedHistoryMode === "minimal") {
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
function splitWhatsAppText(text, maxChars = 3900) {
  let remaining = String(text ?? "").trim();
  const chunks = [];
  const max = Math.max(500, Math.min(4096, Number(maxChars) || 3900));

  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < Math.floor(max * 0.55)) cut = remaining.lastIndexOf("\n", max);
    if (cut < Math.floor(max * 0.55)) cut = remaining.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;

    const part = remaining.slice(0, cut).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

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

    const chunks = splitWhatsAppText(body, 3900);
    if (chunks.length > 1) {
      console.log(`[whatsapp] respuesta larga: ${body.length} caracteres -> ${chunks.length} mensajes`);
    }

    for (let i = 0; i < chunks.length; i++) {
      await axios.post(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${pid}/messages`,
        { messaging_product: "whatsapp", to, text: { body: chunks[i] } },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
      );
    }
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
  const body = String(text ?? "").trim();

  // Modo WhatsApp Web: el endpoint procesa la lógica y devuelve la respuesta
  // al script app_asisto_ws.js. El envío real lo hace WhatsApp Web en la PC
 // que tiene la sesión/QR, no la Cloud API.
  if (Array.isArray(opts.returnReplies)) {
    if (body) opts.returnReplies.push({ to: String(to || "").trim(), text: body });
   return;
  }

  const channelType = String(opts.channelType || "whatsapp").trim().toLowerCase();
  if (channelType === "instagram") {
    return sendInstagramMessage(to, body, opts);
  }
  return sendWhatsAppMessage(to, body, opts);
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
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime, openaiApiKey, tenantId, transcribeModel, conversationId, waId, channelType, usageTraceId } = {}) {
  const prefer = TRANSCRIBE_API_URL;
  if (prefer && publicAudioUrl) {
    try {
      const r = await fetch(`${prefer}/transcribe?url=${encodeURIComponent(publicAudioUrl)}`);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j && typeof j.text === "string" && j.text.trim()) {
          const usageInfo = parseTokenUsagePair(j.tokens || j.usage || null, "audio");
          await recordTokenUsage({
            tenantId,
            kind: "audio",
            provider: "external",
           model: "external-transcribe",
            inputTokens: usageInfo.inputTokens,
            outputTokens: usageInfo.outputTokens,
            totalTokens: usageInfo.totalTokens,
            conversationId,
            waId,
            channelType,
            usageTraceId,
            meta: { engine: "external" }
         });
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
    const usageInfo = parseTokenUsagePair(r.usage || null, "audio");
    await recordTokenUsage({
      tenantId,
      kind: "audio",
      provider: "openai",
      model,
      inputTokens: usageInfo.inputTokens,
      outputTokens: usageInfo.outputTokens,
      totalTokens: usageInfo.totalTokens,
      conversationId,
      waId,
      channelType,
      usageTraceId,
      meta: { engine: "openai" }
    });
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

function normalizeConversationalExternalActionName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeConversationalExternalActionType(value) {
  const v = String(value || "api").trim().toLowerCase();
  return ["web", "web_search", "internet", "buscar_web"].includes(v) ? "web" : "api";
}

function normalizeConversationalExternalActionEntry(raw = {}, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const type = normalizeConversationalExternalActionType(raw.type ?? raw.action_type ?? raw.actionType ?? "api");
  const name = normalizeConversationalExternalActionName(
    raw.name ?? raw.action_name ?? raw.actionName ?? raw.external_api_action_name ?? `accion_${index + 1}`
  );
  if (!name) return null;

  const enabledRaw = raw.enabled ?? raw.habilitada ?? raw.active ?? raw.external_api_enabled ?? true;
  const enabled = enabledRaw === true || ["1", "true", "yes", "si", "sí", "on"].includes(String(enabledRaw || "").trim().toLowerCase());
  const timeoutMaxMs = type === "web" ? 120000 : 60000;
  const timeoutMs = Math.max(1000, Math.min(timeoutMaxMs, Number(raw.timeout_ms ?? raw.timeoutMs ?? raw.external_api_timeout_ms ?? 10000) || 10000));
  const maxChars = Math.max(2000, Math.min(100000, Number(raw.max_chars ?? raw.maxChars ?? raw.external_api_max_chars ?? 30000) || 30000));
  const webContextRaw = String(raw.web_search_context_size ?? raw.webSearchContextSize ?? raw.search_context_size ?? "medium").trim().toLowerCase();
  const webSearchContextSize = ["low", "medium", "high"].includes(webContextRaw) ? webContextRaw : "medium";
  // max_chars solo recorta el texto DESPUÉS de recibirlo. Para controlar TPM hay que
  // limitar explícitamente los tokens que Responses API puede generar.
  const webMaxOutputTokens = Math.max(600, Math.min(6000, Number(
    raw.web_max_output_tokens ?? raw.webMaxOutputTokens ?? raw.max_output_tokens ?? raw.maxOutputTokens ?? 2500
  ) || 2500));

  return {
    id: String(raw.id || raw.action_id || raw.actionId || name || `accion_${index + 1}`).trim().slice(0, 120),
    type,
    enabled,
    name,
    description: String(raw.description ?? raw.descripcion ?? raw.external_api_description ?? "").trim().slice(0, 1500),
    result_instructions: String(raw.result_instructions ?? raw.resultInstructions ?? raw.external_api_result_instructions ?? "").trim().slice(0, 6000),
    timeout_ms: timeoutMs,
    max_chars: maxChars,

    // API HTTP
    url: String(raw.url ?? raw.external_api_url ?? "").trim().slice(0, 3000),
    method: String(raw.method ?? raw.external_api_method ?? "GET").trim().toUpperCase() === "POST" ? "POST" : "GET",
    query_param: String(raw.query_param ?? raw.queryParam ?? raw.external_api_query_param ?? "buscar").trim().slice(0, 100),
    body_template: String(raw.body_template ?? raw.bodyTemplate ?? raw.external_api_body_template ?? "").trim().slice(0, 20000),
    auth_header: String(raw.auth_header ?? raw.authHeader ?? raw.external_api_auth_header ?? "").trim().replace(/[\r\n]/g, "").slice(0, 200),
    auth_value: String(raw.auth_value ?? raw.authValue ?? raw.external_api_auth_value ?? "").trim().replace(/[\r\n]/g, "").slice(0, 4000),

    // Búsqueda web mediante OpenAI Responses API.
    web_model: String(raw.web_model ?? raw.webModel ?? "").trim().slice(0, 120),
    web_search_context_size: webSearchContextSize,
    web_max_output_tokens: webMaxOutputTokens
  };
}

function normalizeConversationalExternalActionsConfig(cfg = {}) {
  const rawList = Array.isArray(cfg?.external_actions)
    ? cfg.external_actions
    : (Array.isArray(cfg?.externalActions) ? cfg.externalActions : null);

  let source = rawList;
  if (!source || !source.length) {
    const legacyHasData = !!(
      cfg?.external_api_enabled || cfg?.externalApiEnabled ||
      String(cfg?.external_api_url || cfg?.externalApiUrl || "").trim()
    );
    source = legacyHasData ? [{
      id: "legacy_external_api",
      type: "api",
      enabled: cfg?.external_api_enabled ?? cfg?.externalApiEnabled ?? false,
      name: cfg?.external_api_action_name ?? cfg?.externalApiActionName ?? "consulta_externa",
      description: cfg?.external_api_description ?? cfg?.externalApiDescription ?? "Consultar información actualizada en una API externa.",
      url: cfg?.external_api_url ?? cfg?.externalApiUrl ?? "",
      method: cfg?.external_api_method ?? cfg?.externalApiMethod ?? "GET",
      query_param: cfg?.external_api_query_param ?? cfg?.externalApiQueryParam ?? "buscar",
      body_template: cfg?.external_api_body_template ?? cfg?.externalApiBodyTemplate ?? "",
      auth_header: cfg?.external_api_auth_header ?? cfg?.externalApiAuthHeader ?? "",
      auth_value: cfg?.external_api_auth_value ?? cfg?.externalApiAuthValue ?? "",
      timeout_ms: cfg?.external_api_timeout_ms ?? cfg?.externalApiTimeoutMs ?? 10000,
      max_chars: cfg?.external_api_max_chars ?? cfg?.externalApiMaxChars ?? 30000,
      result_instructions: cfg?.external_api_result_instructions ?? cfg?.externalApiResultInstructions ?? ""
    }] : [];
  }
  const out = [];
  const names = new Set();
  for (let i = 0; i < source.length && out.length < 20; i++) {
    const item = normalizeConversationalExternalActionEntry(source[i], i);
    if (!item || names.has(item.name)) continue;
    names.add(item.name);
    out.push(item);
  }
  return out;
}

function getUsableConversationalExternalActions(cfg) {
  return normalizeConversationalExternalActionsConfig(cfg).filter((item) => {
    if (!item.enabled || !item.name) return false;
    if (item.type === "web") return true;
    return /^https?:\/\//i.test(String(item.url || "").trim());
  });
}

// Se conserva el nombre histórico porque otras partes del archivo ya lo usan,
// pero ahora significa "hay al menos una acción externa utilizable".
function conversationalExternalApiIsUsable(cfg) {
  return getUsableConversationalExternalActions(cfg).length > 0;
}

function findConversationalExternalAction(cfg, requestedName) {
  const wanted = normalizeConversationalExternalActionName(requestedName || "");
  if (!wanted) return null;
  return getUsableConversationalExternalActions(cfg).find((item) => item.name === wanted) || null;
}

function externalApiTemplateValue(value, variables) {
  if (Array.isArray(value)) return value.map((item) => externalApiTemplateValue(item, variables));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = externalApiTemplateValue(item, variables);
    }
    return out;
  }
  if (typeof value !== "string") return value;

  return value
    .replace(/\{\{\s*telefono_cliente\s*\}\}/gi, String(variables.telefono_cliente || ""))
    .replace(/\{\{\s*telefono_qr\s*\}\}/gi, String(variables.telefono_qr || ""))
    .replace(/\{\{\s*consulta\s*\}\}/gi, String(variables.consulta || ""));
}

async function executeConversationalHttpApi(actionCfg, action = {}, context = {}) {
  const query = String(action?.query || "").trim().slice(0, 1000);

  const url = String(actionCfg.url || "").trim();
  const method = String(actionCfg.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const queryParam = String(actionCfg.query_param || "").trim();
  const bodyTemplate = String(actionCfg.body_template || "").trim();
  const templateVariables = {
    telefono_cliente: String(context?.telefono_cliente || "").replace(/\D/g, ""),
    telefono_qr: String(context?.telefono_qr || "").replace(/\D/g, ""),
    consulta: query
  };
  const timeout = Math.max(1000, Math.min(60000, Number(actionCfg.timeout_ms || 10000) || 10000));
  const maxChars = Math.max(2000, Math.min(100000, Number(actionCfg.max_chars || 30000) || 30000));
  const maxOutputTokens = Math.max(600, Math.min(6000, Number(actionCfg.web_max_output_tokens || 2500) || 2500));
  const headers = { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" };

  const authHeader = String(actionCfg.auth_header || "").trim();
  const authValue = String(actionCfg.auth_value || "").trim();
  if (authHeader && authValue && !/[\r\n]/.test(authHeader + authValue)) {
    headers[authHeader] = authValue;
  }

  const request = {
    method,
    url,
    headers,
    timeout,
    maxRedirects: 3,
    maxContentLength: 1024 * 1024,
    maxBodyLength: 1024 * 1024,
    responseType: "text",
    transformResponse: [(data) => data],
    validateStatus: () => true,
  };

  if (method === "POST" && bodyTemplate) {
    request.headers["Content-Type"] = "application/json";
    try {
      const parsedTemplate = JSON.parse(bodyTemplate);
      const renderedBody = externalApiTemplateValue(parsedTemplate, templateVariables);
      request.data = JSON.stringify(renderedBody);
    } catch (e) {
      return {
        ok: false,
        error: "external_api_body_template_invalid_json",
        detail: String(e?.message || e).slice(0, 300),
      };
    }
  } else if (queryParam && query) {
    if (method === "POST") {
      request.headers["Content-Type"] = "application/json";
      request.data = JSON.stringify({ [queryParam]: query });
    } else {
      request.params = { [queryParam]: query };
    }
  } else if (method === "POST") {
    request.headers["Content-Type"] = "application/json";
    request.data = "{}";
  }

  const startedAt = Date.now();
  try {
    const resp = await axios.request(request);
    const status = Number(resp?.status || 0);
    const raw = typeof resp?.data === "string" ? resp.data : safeStringify(resp?.data);
    const clipped = String(raw || "").slice(0, maxChars);
    const contentType = String(resp?.headers?.["content-type"] || "").trim();

    console.log("[external-api] response.meta =>", {
      action: actionCfg.name,
      method,
      status,
      durationMs: Date.now() - startedAt,
      chars: clipped.length,
      truncated: String(raw || "").length > clipped.length,
      contentType: contentType || null,
    });

    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: `external_api_http_${status || "error"}`,
        status,
        body: clipped,
      };
    }

    return {
      ok: true,
      status,
      body: clipped,
      contentType,
      truncated: String(raw || "").length > clipped.length,
      query,
    };
  } catch (e) {
    console.warn("[external-api] request error:", e?.message || e);
    return {
      ok: false,
      error: e?.code === "ECONNABORTED" ? "external_api_timeout" : "external_api_request_failed",
      detail: String(e?.message || e).slice(0, 500),
    };
  }
}

function extractResponsesApiText(data) {
  const direct = String(data?.output_text || "").trim();
  if (direct) return direct;
  const parts = [];
  for (const item of (Array.isArray(data?.output) ? data.output : [])) {
    if (item?.type !== "message" || !Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      const text = String(content?.text || content?.output_text || "").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function extractResponsesWebSources(data) {
  const out = [];
  const seen = new Set();
  const add = (url, title = "") => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, title: String(title || "").trim().slice(0, 300) });
  };

  for (const item of (Array.isArray(data?.output) ? data.output : [])) {
    if (item?.type === "web_search_call") {
      for (const src of (Array.isArray(item?.action?.sources) ? item.action.sources : [])) {
        add(src?.url, src?.title || src?.name || "");
      }
    }
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const content of item.content) {
        for (const ann of (Array.isArray(content?.annotations) ? content.annotations : [])) {
          add(ann?.url || ann?.url_citation?.url, ann?.title || ann?.url_citation?.title || "");
        }
      }
    }
  }
  return out.slice(0, 30);
}

function webSearchRetryDelayMs(resp, detail = "", retryIndex = 0) {
  try {
    const headerRaw = resp?.headers?.["retry-after"] ?? resp?.headers?.get?.("retry-after");
    const headerSeconds = Number(headerRaw);
    if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
      return Math.max(1000, Math.min(15000, Math.ceil(headerSeconds * 1000) + 250));
    }
  } catch {}

  const match = String(detail || "").match(/try again in\s+([0-9.]+)s/i);
  if (match) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.max(1000, Math.min(15000, Math.ceil(seconds * 1000) + 250));
    }
  }

  return Math.min(8000, 1500 * Math.pow(2, Math.max(0, retryIndex)));
}


async function executeConversationalWebSearch(actionCfg, action = {}, context = {}) {
  const query = String(action?.query || "").trim().slice(0, 1500);
  if (!query) return { ok: false, error: "web_search_query_required" };

  const apiKey = String(context?.openaiApiKey || "").trim();
  if (!apiKey) return { ok: false, error: "web_search_openai_key_missing" };

  const model = String(actionCfg.web_model || context?.chatModel || "gpt-5.6-luna").trim() || "gpt-5.6-luna";
  const searchContextSize = ["low", "medium", "high"].includes(String(actionCfg.web_search_context_size || "medium"))
    ? String(actionCfg.web_search_context_size || "medium")
    : "medium";
  const timeout = Math.max(10000, Math.min(120000, Number(actionCfg.timeout_ms || 90000) || 90000));
  const maxChars = Math.max(2000, Math.min(100000, Number(actionCfg.max_chars || 30000) || 30000));
  const input = [
    "Buscá en Internet información técnica y pública verificable para responder esta consulta:",
    query,
    "Priorizá el sitio oficial del fabricante, manuales, fichas técnicas y documentación primaria. Si el nombre comercial parece contener una variante o error ortográfico, buscá también la variante más probable. No inventes datos.",
  ].join("\n");
  const startedAt = Date.now();
  const attempts = [
    { toolType: "web_search", includeSources: true },
    // Compatibilidad con cuentas/endpoints que todavía exponen el nombre preview.
    { toolType: "web_search_preview", includeSources: false },
  ];
  let lastFailure = null;

  try {
    for (const attempt of attempts) {
      // 429 no cambia el tipo de herramienta: esperamos lo indicado por OpenAI y
      // reintentamos como máximo dos veces. Evita fallos transitorios sin bucles.
      for (let rateTry = 0; rateTry < 3; rateTry++) {
        const payload = {
          model,
          tools: [{ type: attempt.toolType, search_context_size: searchContextSize }],
          tool_choice: { type: attempt.toolType },
          input,
          // CRÍTICO: sin este límite Responses API puede reservar una salida muy
          // grande para TPM aunque la respuesta final sea corta.
          max_output_tokens: maxOutputTokens,
          max_tool_calls: 1,
          reasoning: { effort: "low" },
        };
        if (attempt.includeSources) payload.include = ["web_search_call.action.sources"];

        const resp = await axios.post(
         "https://api.openai.com/v1/responses",
          payload,
          {
            timeout,
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            validateStatus: () => true,
          }
        );

        const status = Number(resp?.status || 0);
        if (status < 200 || status >= 300) {
          const detail = String(resp?.data?.error?.message || resp?.data?.error?.code || resp?.statusText || "").slice(0, 1200);
          lastFailure = { status, detail, toolType: attempt.toolType };
          console.warn("[web-search] HTTP error", {
            action: actionCfg.name,
            model,
            toolType: attempt.toolType,
            status,
           detail,
            maxOutputTokens,
            rateTry: rateTry + 1,
          });

          if (status === 429 && rateTry < 2) {
            const waitMs = webSearchRetryDelayMs(resp, detail, rateTry);
            console.warn(`[web-search] 429; reintento en ${waitMs}ms (${rateTry + 1}/2)`);
            await sleep(waitMs);
            continue;
          }

          // Solo probamos el alias preview si el endpoint rechaza el nombre de la
          // herramienta. Auth/rate-limit/servidor no deben duplicar solicitudes.
          break;
        }
        const text = extractResponsesApiText(resp?.data);
        const clipped = String(text || "").slice(0, maxChars);
        const sources = extractResponsesWebSources(resp?.data);
        if (!clipped) {
          lastFailure = { status, detail: "responses_empty_web_search", toolType: attempt.toolType };
          console.warn("[web-search] respuesta vacía", {
            action: actionCfg.name,
            model,
            toolType: attempt.toolType,
            status,
            outputItems: Array.isArray(resp?.data?.output) ? resp.data.output.length : 0,
            maxOutputTokens,
          });
          break;
        }

        console.log("[web-search] response.meta =>", {
          action: actionCfg.name,
          model: resp?.data?.model || model,
          toolType: attempt.toolType,
          status,
          durationMs: Date.now() - startedAt,
          chars: clipped.length,
          sources: sources.length,
          truncated: String(text || "").length > clipped.length,
          maxOutputTokens,
          usage: resp?.data?.usage || null,
        });

        return {
          ok: true,
          provider: "openai_web_search",
          status,
          body: clipped,
          sources,
          truncated: String(text || "").length > clipped.length,
          query,
          model: resp?.data?.model || model,
          usage: resp?.data?.usage || null,
          toolType: attempt.toolType,
        };
      }

      // Solo pasar a preview ante incompatibilidad del tipo de tool.
      if (![400, 404, 422].includes(Number(lastFailure?.status || 0))) break;
    }


    return {
      ok: false,
      error: lastFailure?.status ? `web_search_http_${lastFailure.status}` : "web_search_empty_response",
      status: lastFailure?.status || 0,
      detail: String(lastFailure?.detail || "La búsqueda web no devolvió contenido.").slice(0, 1000),
    };
  } catch (e) {
    console.warn("[web-search] request error:", {
      message: e?.message || String(e),
      code: e?.code || "",
      timeoutMs: timeout,
      durationMs: Date.now() - startedAt,
      maxOutputTokens,
      model,
      action: actionCfg.name || ""
    });
    return {
      ok: false,
      error: e?.code === "ECONNABORTED" ? "web_search_timeout" : "web_search_request_failed",
      detail: String(e?.message || e).slice(0, 500),
    };
  }
}

// Ejecuta una búsqueda web directa para la ficha QR sin una llamada previa a
// Chat Completions para decidir la acción. Se usa al tocar "Mostrar más info".
// Así el primer acceso con IA necesita solo: Responses/Web Search + una llamada
// final de Chat Completions para redactar la respuesta.
async function runQrDirectWebSearch(options = {}) {
  const tenantId = String(options.tenantId || DEFAULT_TENANT_ID || "default").trim() || "default";
  const apiKey = String(options.openaiApiKey || "").trim();
  const query = String(options.query || "").trim().slice(0, 1500);
  if (!apiKey) return { ok: false, error: "web_search_openai_key_missing" };
  if (!query) return { ok: false, error: "web_search_query_required" };

  let model = String(options.model || "").trim();
  if (!model) {
    try {
      const tenantAiCfg = await loadTenantAiConfigFromMongo(tenantId);
      model = String(tenantAiCfg?.chatModel || "").trim();
    } catch {}
  }
  if (!model) model = "gpt-5.6-luna";

  const contextRaw = String(options.searchContextSize || "low").trim().toLowerCase();
  const searchContextSize = ["low", "medium", "high"].includes(contextRaw) ? contextRaw : "low";
  const timeoutMs = Math.max(10000, Math.min(120000, Number(options.timeoutMs || 90000) || 90000));
  const maxChars = Math.max(2000, Math.min(12000, Number(options.maxChars || 8000) || 8000));
  const maxOutputTokens = Math.max(600, Math.min(4000, Number(options.maxOutputTokens || 2500) || 2500));

  const result = await executeConversationalWebSearch({
    id: "qr_direct_web_search",
    type: "web",
    enabled: true,
    name: "buscar_web_qr",
    web_model: model,
    web_search_context_size: searchContextSize,
    web_max_output_tokens: maxOutputTokens,
    timeout_ms: timeoutMs,
    max_chars: maxChars,
  }, { query }, {
    openaiApiKey: apiKey,
    chatModel: model,
  });

  if (result?.provider === "openai_web_search" && result?.usage) {
    try {
      const usageInfo = parseTokenUsagePair(result.usage, "message");
      await recordTokenUsage({
        tenantId,
        kind: "web_search",
        provider: "openai",
        model: result?.model || model,
        inputTokens: usageInfo.inputTokens,
        outputTokens: usageInfo.outputTokens,
        totalTokens: usageInfo.totalTokens,
        conversationId: String(options.conversationId || "").trim(),
        waId: String(options.waId || "").trim(),
        channelType: String(options.channelType || "qr_web").trim().toLowerCase(),
        usageTraceId: String(options.usageTraceId || "").trim(),
        meta: {
          directQrSearch: true,
          searchContextSize,
          timeoutMs,
          maxOutputTokens,
        }
      });
    } catch (e) {
      console.warn("[tokens] direct qr web_search usage error:", e?.message || e);
    }
  }

  return result;
}


async function executeConversationalExternalApi(cfg, action = {}, context = {}) {
  const requestedName = normalizeConversationalExternalActionName(action?.name || "");
  const actionCfg = findConversationalExternalAction(cfg, requestedName);
  if (!actionCfg) {
    return { ok: false, error: "external_action_not_allowed", action: requestedName || null, actionConfig: null };
  }

  const result = actionCfg.type === "web"
    ? await executeConversationalWebSearch(actionCfg, action, context)
    : await executeConversationalHttpApi(actionCfg, action, context);

  return {
    ...result,
    actionConfig: {
      id: actionCfg.id,
      type: actionCfg.type,
      name: actionCfg.name,
      description: actionCfg.description,
      result_instructions: actionCfg.result_instructions
    }
  };
}


function buildConversationalExternalResultBlock(cfg, action, result) {
  const actionCfg = result?.actionConfig || findConversationalExternalAction(cfg, action?.name) || {};
  const actionName = normalizeConversationalExternalActionName(actionCfg?.name || action?.name || "consulta_externa");
  const actionType = normalizeConversationalExternalActionType(actionCfg?.type || "api");
  const instructions = String(actionCfg?.result_instructions || "").trim();
  const lines = [
    actionType === "web" ? "[RESULTADO DE BUSQUEDA WEB]" : "[RESULTADO DE API EXTERNA]",
    `Acción ejecutada: ${actionName}`,
    `Consulta solicitada: ${String(action?.query || "").trim() || "(sin filtro)"}`,
  ];

  if (result?.ok) {
    lines.push("Estado: OK");
    if (result.truncated) lines.push("Aviso: la respuesta fue truncada por límite de tamaño.");
    if (instructions) lines.push(`Instrucciones de interpretación: ${instructions}`);
    if (actionType === "web") {
      lines.push("Hallazgos obtenidos mediante búsqueda web:");
      lines.push(String(result.body || "").trim() || "(respuesta vacía)");
      if (Array.isArray(result.sources) && result.sources.length) {
        lines.push("Fuentes recuperadas:");
        for (const src of result.sources.slice(0, 12)) {
          lines.push(`- ${String(src?.title || "Fuente").trim()}: ${String(src?.url || "").trim()}`);
        }
      }
      lines.push("Usá estos hallazgos para asesoramiento general/técnico. No los uses para afirmar precios, stock, promociones ni disponibilidad comercial del negocio salvo que otra acción comercial lo confirme.");
    } else {
      lines.push("Datos devueltos por la API:");
      lines.push(String(result.body || "").trim() || "(respuesta vacía)");
      lines.push("Usá estos datos como fuente de verdad para esta respuesta dentro del alcance de esta acción. No inventes valores que no aparezcan en el resultado.");
    }
  } else {
    lines.push(`Estado: ERROR (${String(result?.error || "external_action_error")})`);
    if (result?.status) lines.push(`HTTP: ${result.status}`);
    if (result?.detail) lines.push(`Detalle técnico resumido: ${String(result.detail).slice(0, 500)}`);
    lines.push("No inventes el dato que esta acción debía obtener. Respondé con lo que sí esté confirmado o indicá brevemente que esa información no pudo consultarse.");

  }

  lines.push("No vuelvas a pedir exactamente la misma acción con la misma consulta en este turno.");
  lines.push("Si todavía necesitás OTRA acción disponible para completar la respuesta, podés solicitarla ahora. Si ya tenés información suficiente, devolvé action.call=false, action.name=\"\" y action.query=\"\".");
  lines.push("Conservá o actualizá el objeto lead según la conversación.");
  return lines.join("\n");
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
  const baseCfg = await loadBehaviorConfigFromMongo(tenantId);
  // Algunos canales públicos (por ejemplo la ficha QR) necesitan reutilizar el
  // motor conversacional con un comportamiento específico y/o acciones extra,
  // sin modificar la configuración general del dominio.
  const additionalExternalActions = Array.isArray(opts.additionalExternalActions)
    ? opts.additionalExternalActions
    : [];
  const cfg = additionalExternalActions.length
    ? { ...baseCfg, external_actions: [...(Array.isArray(baseCfg.external_actions) ? baseCfg.external_actions : []), ...additionalExternalActions] }
    : baseCfg;
  const baseText = opts.behaviorTextOverride !== undefined
    ? String(opts.behaviorTextOverride || '').trim()
    : cfg.text;
  const botMode = normalizeBotMode(opts.botModeOverride || cfg.bot_mode || "pedidos");
  const leadCaptureEnabled = botMode === "conversacional" && (
    opts.leadCaptureOverride !== undefined
      ? opts.leadCaptureOverride === true
      : cfg.lead_capture_enabled === true
  );
  const externalActions = (botMode === "conversacional" && opts.disableExternalActions !== true)
    ? getUsableConversationalExternalActions(cfg)
    : [];
  const externalApiEnabled = externalActions.length > 0;
 const configuredHistoryMode = String(opts.historyModeOverride || cfg.history_mode || "standard").toLowerCase();
  // "minimal" sigue siendo exclusivo del flujo de pedidos porque depende del snapshot
  // Pedido. Para bots conversacionales se admite "compact" además de "standard".
  // Si una configuración vieja dejó "minimal" en un conversacional, usamos compact.
  const historyMode = botMode === "conversacional"
    ? (configuredHistoryMode === "compact" || configuredHistoryMode === "minimal" ? "compact" : "standard")
    : configuredHistoryMode;

  // Bloque system inicial. En modo conversacional NO se inyectan catálogo ni horarios
  // de pedidos: la respuesta queda gobernada por el Comportamiento cargado para el dominio.
  const catalogText = botMode === "pedidos" ? await loadCatalogTextFromMongo(tenantId) : "";
  const storeHoursBlock = botMode === "pedidos" ? await loadStoreHoursBlockFromMongo(tenantId) : "";
  const modeBlock = botMode === "conversacional"
    ? "[MODO BOT]\nConversacional. Respondé según [COMPORTAMIENTO] y el historial. No generes Pedido, estado de pedido, totales ni confirmaciones salvo que el propio comportamiento te lo pida explícitamente."
    : "[MODO BOT]\nPedidos. Conservá el flujo estructurado de pedidos configurado para este dominio.";
  const leadBlock = botMode === "conversacional"
    ? (
        leadCaptureEnabled
          ? [
              "[CAPTURA DE LEADS]",
              "La captura automática está ACTIVADA.",
              "En cada respuesta completá el objeto lead del JSON.",
              "Usá lead.capture=true cuando el usuario pida cotización, presupuesto, precio para un servicio, quiera enviar/transportar algo, solicite contacto comercial o siga aportando datos de una consulta comercial iniciada previamente.",
              "Para una cotización usá lead.type=\"cotizacion\".",
              "Extraé solo datos que el usuario haya dado explícitamente en esta conversación. No inventes.",
              "Campos disponibles: name, company, email, origin, destination, cargo, packages, weight, dimensions y notes.",
              "Si faltan datos relevantes, pedilos naturalmente en response y mantené lead.capture=true con los datos conocidos.",
              "Usá lead.complete=true solamente cuando ya haya información suficiente para que una persona continúe la gestión comercial; para transporte, como mínimo origen, destino y qué se transporta.",
              "Cuando no sea una consulta comercial, devolvé lead.capture=false, lead.type=\"\", lead.complete=false y los demás campos como string vacío."
            ].join("\n")
          : ""
      )
    : "";

    const externalApiBlock = botMode === "conversacional"
    ? (
        externalApiEnabled
          ? [
              "[ACCIONES EXTERNAS DISPONIBLES]",
              "Podés solicitar UNA acción por respuesta usando action.call=true, action.name con el nombre exacto y action.query con una consulta breve.",
              "El backend puede ejecutar varias acciones en secuencia (hasta 4 pasos) dentro del mismo turno. Después de recibir un resultado, si necesitás otra acción, pedila en la respuesta siguiente.",
              ...externalActions.map((item) => {
                const typeLabel = item.type === "web" ? "BUSQUEDA WEB" : "API";
                return `- ${item.name} [${typeLabel}]: ${String(item.description || (item.type === "web" ? "Buscar información pública y actualizada en Internet." : "Consultar información actualizada en una API externa.")).trim()}`;
              }),
              "Para una acción API, action.query puede ser vacío si esa API no necesita filtro.",
              "Para una acción de búsqueda web, action.query debe describir concretamente qué información investigar.",
              "No inventes resultados de ninguna acción. El backend ejecutará la acción antes de enviar la respuesta final al cliente.",
              "Si solicitás una acción, dejá response vacío; redactá la respuesta al cliente recién después de recibir el resultado.",
              "La búsqueda web sirve para conocimiento y asesoramiento; nunca confirma por sí sola precios, stock, promociones ni disponibilidad comercial del negocio.",
              'Cuando no necesites ninguna acción, devolvé action.call=false, action.name="" y action.query="".'
            ].join("\n")
          : [
              "[ACCIONES EXTERNAS]",
              "No hay acciones externas habilitadas para este dominio.",
              'Devolvé siempre action.call=false, action.name="" y action.query="".'
            ].join("\n")
      )
    : "";

  const fullSystem = [
    modeBlock,
    leadBlock,
    externalApiBlock,
    storeHoursBlock,
    "[COMPORTAMIENTO]\n" + baseText + catalogText,
    // Mantener el bloque variable al final ayuda al prompt caching: el prefijo
    // estático (comportamiento + reglas) permanece idéntico entre turnos.
    buildNowBlock()
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
    if (historyMode === "compact") {
      trimConversationalHistoryInPlace(id, fullSystem);
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
      response_format: botMode === "conversacional"
        ? buildStrictConversationalResponseFormat(leadCaptureEnabled)
        : buildStrictPedidoResponseFormat()
    };
    applyModelTokenLimit(payload, model, maxTokens);
    console.log("[openai] request.meta =>", {
      model,
      temperature,
      token_limit_param: maxTokens
        ? (modelUsesMaxCompletionTokens(model) ? "max_completion_tokens" : "max_tokens")
        : null,
      token_limit_value: maxTokens || null,
      response_format: botMode === "conversacional" ? "json_schema_conversational" : "json_schema_pedido"
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
        const usageInfo = parseTokenUsagePair(usage, "message");
       await recordTokenUsage({
        tenantId,
        kind: "message",
        provider: "openai",
        model: responseModel || model,
        inputTokens: usageInfo.inputTokens,
        outputTokens: usageInfo.outputTokens,
        totalTokens: usageInfo.totalTokens,
        conversationId: String(opts.conversationId || currentConversationIds[id] || "").trim(),
        waId: String(opts.waId || from || "").trim(),
        channelType: String(opts.channelType || "whatsapp").trim().toLowerCase(),
        usageTraceId: String(opts.usageTraceId || "").trim(),
        meta: { temperature, maxTokens: maxTokens || null }
      });
      //console.log("[openai] response.data =>\n" + JSON.stringify(response.data, null, 2));
    } catch (e) {
      console.warn("[openai] no se pudo stringify la respuesta:", e?.message);
    }

    //const reply = response.data.choices[0].message.content;
    //console.log("[openai] assistant.content =>\n" + reply);
    let reply = extractChatCompletionContent(response.data);
    if (!reply) {
      throw new Error("openai_empty_structured_reply");
    }

    // En modo conversacional el modelo puede pedir acciones externas configuradas.
    // Se permite encadenar hasta 4 acciones dentro del mismo turno (por ejemplo:
    // primero consultar productos/precios y luego buscar información técnica en web).
    // El flujo de pedidos nunca entra en este bloque.
    if (botMode === "conversacional" && externalApiEnabled) {
      let actionMessages = sanitizeMessages(messages);
      const executedActionSignatures = new Set();
      const executedWebActionNames = new Set();
      const MAX_EXTERNAL_ACTION_STEPS = 4;

      for (let actionStep = 0; actionStep < MAX_EXTERNAL_ACTION_STEPS; actionStep++) {
        let parsedPayload = null;
        try { parsedPayload = JSON.parse(reply); } catch {}
        if (parsedPayload?.action?.call !== true) break;

        const action = parsedPayload.action || {};
        const actionName = normalizeConversationalExternalActionName(action?.name || "");
        const actionQuery = String(action?.query || "").trim();
        const signature = `${actionName}|${actionQuery.toLowerCase()}`;

        let externalResult;
        const requestedActionCfg = findConversationalExternalAction(cfg, actionName);
        const isWebAction = requestedActionCfg?.type === "web";
        if (executedActionSignatures.has(signature)) {
          externalResult = {
            ok: false,
            error: "external_action_duplicate_call",
            actionConfig: requestedActionCfg
          };
        } else if (isWebAction && executedWebActionNames.has(actionName)) {
          // Una búsqueda web por acción y por turno. Cambiar apenas la consulta no
          // debe disparar otra llamada costosa en la misma respuesta.
          externalResult = {
            ok: false,
            error: "external_web_action_already_executed",
            detail: "La búsqueda web ya se ejecutó en este turno; respondé con el resultado disponible.",
            actionConfig: requestedActionCfg
          };
        } else {
          executedActionSignatures.add(signature);
          if (isWebAction) executedWebActionNames.add(actionName);
          externalResult = await executeConversationalExternalApi(cfg, action, {
            telefono_cliente: opts?.externalApiContext?.telefono_cliente || from,
            telefono_qr: opts?.externalApiContext?.telefono_qr || "",
            openaiApiKey: apiKey,
            chatModel: model
          });

          // La búsqueda web es otra llamada OpenAI (Responses API); registrar también
          // sus tokens cuando el endpoint devuelve usage.
          if (externalResult?.provider === "openai_web_search" && externalResult?.usage) {
            try {
              const webUsage = parseTokenUsagePair(externalResult.usage, "message");
              await recordTokenUsage({
                tenantId,
                kind: "web_search",
                provider: "openai",
                model: externalResult?.model || model,
                inputTokens: webUsage.inputTokens,
                outputTokens: webUsage.outputTokens,
                totalTokens: webUsage.totalTokens,
                conversationId: String(opts.conversationId || currentConversationIds[id] || "").trim(),
                waId: String(opts.waId || from || "").trim(),
                channelType: String(opts.channelType || "whatsapp").trim().toLowerCase(),
                usageTraceId: String(opts.usageTraceId || "").trim(),
                meta: { externalAction: actionName, actionStep: actionStep + 1 }
              });
            } catch (e) {
              console.warn("[tokens] web_search usage error:", e?.message || e);
            }
          }
        }

        actionMessages = actionMessages.concat([
          { role: "assistant", content: reply },
          { role: "system", content: buildConversationalExternalResultBlock(cfg, action, externalResult) }
        ]);

        const followupPayload = {
          model,
          messages: actionMessages,
          temperature,
          response_format: buildStrictConversationalResponseFormat(leadCaptureEnabled)
        };
        applyModelTokenLimit(followupPayload, model, maxTokens);

        const followupResponse = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          followupPayload,
          { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
        );

        try {
         const usageInfo2 = parseTokenUsagePair(followupResponse?.data?.usage, "message");
          await recordTokenUsage({
            tenantId,
            kind: "message",
            provider: "openai",
            model: followupResponse?.data?.model || model,
            inputTokens: usageInfo2.inputTokens,
            outputTokens: usageInfo2.outputTokens,
            totalTokens: usageInfo2.totalTokens,
            conversationId: String(opts.conversationId || currentConversationIds[id] || "").trim(),
            waId: String(opts.waId || from || "").trim(),
            channelType: String(opts.channelType || "whatsapp").trim().toLowerCase(),
            usageTraceId: String(opts.usageTraceId || "").trim(),
            meta: { temperature, maxTokens: maxTokens || null, externalAction: actionName, actionStep: actionStep + 1 }
          });
        } catch (e) {
          console.warn("[tokens] external follow-up usage error:", e?.message || e);
        }

        const nextReply = extractChatCompletionContent(followupResponse?.data);
        if (!nextReply) break;
        reply = nextReply;
      }

      // Si el modelo todavía intenta pedir una quinta acción, forzamos una última
      // respuesta usando todo lo ya obtenido. Así nunca se envía al cliente un JSON
      // intermedio con action.call=true o response vacío por alcanzar el límite.
      let afterLimitPayload = null;
      try { afterLimitPayload = JSON.parse(reply); } catch {}
      if (afterLimitPayload?.action?.call === true) {
        const finalMessages = actionMessages.concat([
          { role: "assistant", content: reply },
          {
            role: "system",
            content: [
              "[LIMITE DE ACCIONES DEL TURNO]",
              "Ya se alcanzó el máximo de acciones externas para este turno.",
              "No solicites más acciones ahora. Respondé al usuario con la mejor información confirmada disponible.",
              'Devolvé action.call=false, action.name="" y action.query="".'
            ].join("\n")
          }
        ]);
        const finalPayload = {
          model,
          messages: finalMessages,
          temperature,
          response_format: buildStrictConversationalResponseFormat(leadCaptureEnabled)
        };
        applyModelTokenLimit(finalPayload, model, maxTokens);
        const finalResponse = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          finalPayload,
          { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
        );
        try {
          const finalUsage = parseTokenUsagePair(finalResponse?.data?.usage, "message");
          await recordTokenUsage({
            tenantId, kind: "message", provider: "openai", model: finalResponse?.data?.model || model,
            inputTokens: finalUsage.inputTokens, outputTokens: finalUsage.outputTokens, totalTokens: finalUsage.totalTokens,
            conversationId: String(opts.conversationId || currentConversationIds[id] || "").trim(),
            waId: String(opts.waId || from || "").trim(),
            channelType: String(opts.channelType || "whatsapp").trim().toLowerCase(),
            usageTraceId: String(opts.usageTraceId || "").trim(),
            meta: { temperature, maxTokens: maxTokens || null, externalAction: "limit_final" }
          });
        } catch (e) {
          console.warn("[tokens] external limit final usage error:", e?.message || e);
        }
        const finalReply = extractChatCompletionContent(finalResponse?.data);
        if (finalReply) reply = finalReply;
      }
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
    if (historyMode === "standard" || historyMode === "compact") {
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
      const historyAssistantContent = botMode === "conversacional"
        ? conversationalAssistantHistoryContent(reply)
        : reply;
      if (historyAssistantContent) {
        chatHistories[id].push({ role: "assistant", content: historyAssistantContent });
      }
      if (historyMode === "compact") {
        trimConversationalHistoryInPlace(id, fullSystem);
      }
    }
    return reply;
  } catch (error) {
    if (error?.response?.data) {
      console.error("Error OpenAI:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error("Error OpenAI:", error?.message || error);
    }
    if (botMode === "conversacional") {
      if (!leadCaptureEnabled) {
        return '{"response":"Lo siento, ocurrió un error. Intenta nuevamente.","action":{"call":false,"name":"","query":""}}';
      }
      return '{"response":"Lo siento, ocurrió un error. Intenta nuevamente.","lead":{"capture":false,"type":"","complete":false,"name":"","company":"","email":"","origin":"","destination":"","cargo":"","packages":"","weight":"","dimensions":"","notes":""},"action":{"call":false,"name":"","query":""}}';
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
  normalizeBotMode,
  invalidateTenantAiConfigCache,
  // catálogo
  loadCatalogTextFromMongo,

  // chat
  getGPTReply,
  runQrDirectWebSearch,

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
