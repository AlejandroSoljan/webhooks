// logic.js
// Lógica de negocio (sin Express): GPT, STT, helpers y comportamiento desde Mongo (multi-tenant)

const axios = require("axios");
const OpenAI = require("openai");
let toFile = null;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHAT_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0.1) || 0.1;

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

const { getDb } = require("./db");

// ================== OpenAI client (para fallback STT) ==================
let openai = null;
try {
  if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    try { ({ toFile } = require("openai/uploads")); } catch {}
  }
} catch (e) {
  console.error("OpenAI init error:", e.message);
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
function buildNowBlock() {
  return [
    "[AHORA]",
    `Zona horaria: ${STORE_TZ}`,
    `Fecha y hora actuales (local): ${_nowLabelInTZ()}`
  ].join("\n");
}

// ================== Comportamiento desde Mongo (solo al inicio de conversación) ==================
/**
 * Cache en memoria por tenant { tenantId: { text, at } }
 * Se invalida por tenant con invalidateBehaviorCache(tenantId)
 */
const _behaviorCache = new Map();

function invalidateBehaviorCache(tenantId = DEFAULT_TENANT_ID) {
  _behaviorCache.delete(String(tenantId));
}

/**
 * Obtiene el texto de comportamiento para un tenant dado.
 * Guarda el resultado en cache por 5 minutos.
 */
// ---- Config de comportamiento + modo de historial desde Mongo ----
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

// Backward compat: función existente retorna solo el texto
async function loadBehaviorTextFromMongo(tenantId = DEFAULT_TENANT_ID) {
  const cfg = await loadBehaviorConfigFromMongo(tenantId);
  return cfg.text;
}


// ================== Historial por número / sesión ==================
const chatHistories = {}; // standard mode: { [tenant-from]: [{role,content}, ...] }
const userOnlyHistories = {}; // minimal mode: { [tenant-from]: [{role:'user',content}, ...] }
const assistantPedidoSnapshot = {}; // minimal mode: { [tenant-from]: string(JSON del Pedido) }
const endedSessions = {}; // { [tenant-from]: { endedAt } }

function k(tenantId, from) { return `${tenantId}::${from}`; }

// ================== Helpers de sesión ==================
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
  endedSessions[id] = { endedAt: Date.now() };
}

// ================== WhatsApp ==================
async function sendWhatsAppMessage(to, text) {
  try {
    const body = String(text ?? "").trim();
    if (!body) {
      console.error("WhatsApp: intento de envío con text.body vacío. Se omite el envío.");
      return;
    }
    await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, text: { body } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error enviando WhatsApp:", error.response?.data || error.message);
  }
}

// ================== Media (audio) ==================
async function getMediaInfo(mediaId) {
  const token = WHATSAPP_TOKEN;
  if (!token || !mediaId) throw new Error("media_info_missing");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const resp = await fetch(`${url}?fields=url,mime_type`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`media_info_failed_${resp.status}`);
  return resp.json();
}
async function downloadMediaBuffer(mediaUrl) {
  const token = WHATSAPP_TOKEN;
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`download_media_failed_${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

// ================== STT (externo -> fallback OpenAI) ==================
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime }) {
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
    if (!openai) return { text: "" };
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
    const r = await openai.audio.transcriptions.create({ file: fileObj, model: TRANSCRIBE_MODEL });
    const text = (r.text || "").trim();
    return { text, usage: r.usage || null, engine: "openai" };
  } catch (e) {
    console.error("STT OpenAI error:", e.message);
    return { text: "" };
  }
}

// ================== Detección de cortesía ==================
function isPoliteClosingMessage(textRaw) {
  const text = String(textRaw || "").trim().toLowerCase();
  if (!text) return false;
  const exacts = [
    "gracias","muchas gracias","mil gracias","ok","oka","okey","dale","listo",
    "genial","perfecto","buenas","buenas noches","buen dia","buen día",
    "👍","👌","🙌","🙏","🙂","😊","👏","✌️"
  ];
  if (exacts.includes(text)) return true;
  if (/^(gracias+!?|ok+|dale+|listo+|genial+|perfecto+)\b/.test(text)) return true;
  if (/(saludos|abrazo)/.test(text) && text.length <= 40) return true;
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
const START_FALLBACK = "¡Hola! 👋 ¿Qué te gustaría pedir? Pollo (entero/mitad) y papas (2, 4 o 6).";
const num = v => Number(String(v).replace(/[^\d.-]/g, '') || 0);

/*function ensureEnvio(pedido) {
  const entrega = (pedido?.Entrega || "").toLowerCase();
  const tieneEnvio = (pedido.items || []).some(i => (i.descripcion || "").toLowerCase().includes("envio"));
  if (entrega === "domicilio" && !tieneEnvio) {
    (pedido.items ||= []).push({ descripcion: "Envio", cantidad: 1, importe_unitario: 1500, total: 1500 });
  }
}*/

 // Opción A: solo agregar "Envio" si hay dirección informada
 function ensureEnvio(pedido) {
   const entrega = (pedido?.Entrega || "").toLowerCase();
   // Consideramos "hay domicilio" si Pedido.Domicilio tiene algún campo no vacío
   const hasAddress =
     pedido?.Domicilio &&
     typeof pedido.Domicilio === "object" &&
     Object.values(pedido.Domicilio).some(v => String(v || "").trim() !== "");

   // Si no es a domicilio o aún no hay dirección, no agregamos "Envio"
   if (entrega !== "domicilio" || !hasAddress) return;

   const tieneEnvio = (pedido.items || []).some(i => (i.descripcion || "").toLowerCase().includes("envio"));
   if (!tieneEnvio) {
     (pedido.items ||= []).push({ descripcion: "Envio", cantidad: 1, importe_unitario: 1500, total: 1500 });
   }
 }
function buildBackendSummary(pedido) {
  return [
    "🧾 Resumen del pedido:",
    ...(pedido.items || []).map(i => `- ${i.cantidad} ${i.descripcion}`),
    `💰 Total: ${Number(pedido.total_pedido || 0).toLocaleString("es-AR")}`
  ].join("\n");
}
function coalesceResponse(maybeText, pedidoObj) {
  const s = String(maybeText ?? "").trim();
  return s || ((pedidoObj?.items?.length || 0) > 0 ? buildBackendSummary(pedidoObj) : START_FALLBACK);
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
    const cantidad = num(it.cantidad);
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

// ================== Chat con historial (inyecta comportamiento de Mongo al inicio) ==================
async function getGPTReply(tenantId, from, userMessage) {
  const id = k(tenantId, from);
  

    // Cargamos config (comportamiento + modo)
  const cfg = await loadBehaviorConfigFromMongo(tenantId);
  const baseText = cfg.text;
  const historyMode = (cfg.history_mode || "standard").toLowerCase();

  // Bloque system inicial
  const fullSystem = [
    buildNowBlock(),
    "[COMPORTAMIENTO]\n" + baseText
  ].join("\n\n").trim();

  let messages = [];

  if (historyMode === "minimal") {
    // Inicialización de contenedores
    if (!userOnlyHistories[id]) userOnlyHistories[id] = [];
    if (!assistantPedidoSnapshot[id]) {
      // Snapshot vacío para dar contexto estructurado desde el primer turno
      assistantPedidoSnapshot[id] = JSON.stringify({ estado: "IN_PROGRESS", Pedido: { items: [], total_pedido: 0 } });
    }
    // Construimos mensajes "on the fly"
    messages = [{ role: "system", content: fullSystem }];
    const asst = assistantPedidoSnapshot[id];
    if (asst) messages.push({ role: "assistant", content: asst });
    // Agregamos histórico de usuario + el mensaje actual
    const seq = userOnlyHistories[id].concat([{ role: "user", content: userMessage }]);
    messages.push(...seq);
    // Persistimos user msg
    userOnlyHistories[id].push({ role: "user", content: userMessage });
    
    console.log("[minimal] messages =>", JSON.stringify(messages));
   // console.log("[minimal] userOnlyHistories =>", JSON.stringify(userOnlyHistories[id]));
  
    } else {
    // standard = historial completo
    if (!chatHistories[id]) chatHistories[id] = [{ role: "system", content: fullSystem }];
    chatHistories[id].push({ role: "user", content: userMessage });
    messages = chatHistories[id];
  }

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: CHAT_MODEL, messages, temperature: CHAT_TEMPERATURE, response_format: { type: "json_object" } },
     { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" } }
    );
    const reply = response.data.choices[0].message.content;
    //console.log("Response: "+JSON.stringify(response));
    if (historyMode === "standard") {
      chatHistories[id].push({ role: "assistant", content: reply });
      console.log(JSON.stringify(chatHistories[id]));
    }
    return reply;
  } catch (error) {
    console.error("Error OpenAI:", error.response?.data || error.message);
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


module.exports = {
  // comportamiento
  loadBehaviorTextFromMongo,
  loadBehaviorConfigFromMongo,
  invalidateBehaviorCache,

  // chat
  getGPTReply,

  // session
  hasActiveEndedFlag,
  markSessionEnded,
  isPoliteClosingMessage,

  // whatsapp + media + stt
  sendWhatsAppMessage,
  getMediaInfo,
  downloadMediaBuffer,
  transcribeAudioExternal,

  // cache público
  putInCache,
  getFromCache,
  fileCache,

  // negocio pedido
  START_FALLBACK,
  buildBackendSummary,
  coalesceResponse,
  recalcAndDetectMismatch,

  // constants needed by endpoints (optional export)
  GRAPH_VERSION,

  // exports auxiliares
  DEFAULT_TENANT_ID,
  setAssistantPedidoSnapshot,
};
