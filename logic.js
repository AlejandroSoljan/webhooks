// logic.js
// Lógica de negocio (sin Express): GPT, STT, helpers y comportamiento desde Mongo (multi-tenant)
// Incluye logs completos de OpenAI (payload y response).

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
const STORE_LAT = parseFloat(process.env.STORE_LAT || "0");
const STORE_LNG = parseFloat(process.env.STORE_LNG || "0");

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
    const obs = (it.observacion || "").trim();
    const base = `id ${i} - ${String(it.descripcion || "").trim()}. Precio: ${Number(precio || 0)}`;
    lines.push(obs ? `${base}. Observaciones: ${obs}` : `${base}.`);
    i++;
  }
  const text = lines.length
    ? `\n[CATALOGO]\n${lines.join("\n")}\n`
    : "\n[CATALOGO]\n( catálogo vacío )\n";

  _catalogCache.set(key, { text, at: Date.now() });
  return text;
}



// ================== Historial por número / sesión ==================
const chatHistories = {};       // standard mode: { [tenant-from]: [{role,content}, ...] }
const userOnlyHistories = {};   // minimal mode: { [tenant-from]: [{role:'user',content}, ...] }
const assistantPedidoSnapshot = {}; // minimal mode: { [tenant-from]: string(JSON del Pedido) }

function k(tenantId, from) { return `${tenantId}::${from}`; }

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
  endedSessions[id] = { endedAt: Date.now() };
}

// -------------------------------------------------------------------
// Persistencia de conversación y mensajes cuando estado=COMPLETED
// -------------------------------------------------------------------
async function _persistCompleted({ tenantId, waId, contactName, historyMsgs, assistantObj }) {
  try {
    const db = await getDb();
    const openedAt = new Date(Date.now() - Math.max(0, (historyMsgs?.length || 1) - 1) * 1000);
    const closedAt = new Date();
    const turns = historyMsgs?.length || 0;
    const summary = assistantObj?.Pedido ? { Pedido: assistantObj.Pedido } : {};
    const convDoc = {
      tenantId: tenantId || DEFAULT_TENANT_ID,
      waId: String(waId || ""),
      contactName: String(contactName || ""),
      status: "COMPLETED",
      processed: false,
      openedAt, closedAt, turns,
      summary,
      createdAt: new Date(), updatedAt: new Date()
    };
    const ins = await db.collection("conversations").insertOne(convDoc);
    const convId = ins.insertedId;
    const rows = (historyMsgs || []).map(m => ({
      conversationId: convId,
      tenantId: tenantId || DEFAULT_TENANT_ID,
      role: String(m.role || "user"),
      content: typeof m.content === "string" ? m.content : safeStringify(m.content),
      ts: new Date()
    }));
    // agrega el JSON final del assistant si no estuviera
    if (!rows.length || rows[rows.length - 1].role !== "assistant") {
      rows.push({
        conversationId: convId,
        tenantId: tenantId || DEFAULT_TENANT_ID,
        role: "assistant",
        content: safeStringify(assistantObj || {}),
        ts: new Date()
      });
    }
    if (rows.length) await db.collection("messages").insertMany(rows);
  } catch (e) {
    console.error("persistCompleted error:", e.message);
  }
}

/**
 * Normaliza el JSON de Pedido a un objeto “orden” simple para admin.
 * Exportado para /api/admin/order/:id
 */
function normalizeOrder(waId, contactName, Pedido) {
  const p = Pedido || {};
  const items = Array.isArray(p.items) ? p.items : [];
  return {
    name: String(contactName || ""),
    entrega: String(p.Entrega || ""),
    domicilio: typeof p.Domicilio === "string"
      ? p.Domicilio
      : (p.Domicilio && typeof p.Domicilio === "object"
          ? Object.values(p.Domicilio).filter(v => String(v||"").trim()).join(" ")
          : ""),
    items: items.map(it => ({
      descripcion: String(it.descripcion || ""),
      cantidad: Number(it.cantidad || 1),
      importe_unitario: Number(it.importe_unitario || 0),
      total: Number(it.total || 0)
    })),
    amount: Number(p.total_pedido || 0),
    fechaEntrega: String(p.Fecha || ""),
    hora: String(p.Hora || ""),
    estadoPedido: "CONFIRMADO"
  };
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

// Opción A con flag: por defecto requiere dirección; si ADD_ENVIO_WITHOUT_ADDRESS=1, agrega envío apenas sea 'domicilio'
/*function ensureEnvio(pedido) {
  const entrega = (pedido?.Entrega || "").toLowerCase();
  const allowWithoutAddress = String(process.env.ADD_ENVIO_WITHOUT_ADDRESS || "0") === "1";

  // ¿Hay dirección en el JSON?
  const hasAddress =
    pedido?.Domicilio &&
    typeof pedido.Domicilio === "object" &&
    Object.values(pedido.Domicilio).some(v => String(v || "").trim() !== "");

  if (entrega !== "domicilio") return;
  if (!allowWithoutAddress && !hasAddress) return;

  const tieneEnvio = (pedido.items || []).some(i => (i.descripcion || "").toLowerCase().includes("envio"));
  if (!tieneEnvio) {
    (pedido.items ||= []).push({ id: 6, descripcion: "Envio", cantidad: 1, importe_unitario: 1500, total: 1500 });
  }
}*/

// Validación de "Envio" según método de entrega
// - Si Entrega = domicilio  -> asegura que exista el ítem Envio
// - Si Entrega ≠ domicilio  -> elimina cualquier Envio residual
// Lee un único "Envio" genérico (backward-compat) cuando no usamos tramos
// Busca un "Envio" activo. Acepta "Envio", "Envio 1/2/3", etc.
// Si hay varios, devuelve el más barato (fallback sensato).
async function getEnvioItemFromCatalog(tenantId = DEFAULT_TENANT_ID) {
  try {
    const db = await getDb();
    const filter = { active: { $ne: false }, descripcion: { $regex: /^env[ií]o/i } };
    if (tenantId) filter.tenantId = String(tenantId);
    const list = await db.collection("products")
      .find(filter)
      .project({ _id:1, descripcion:1, importe:1 })
      .toArray();
    if (!list?.length) return null;
    const best = list
      .map(d => ({ _id:String(d._id||""), descripcion:String(d.descripcion||"Envio"), importe:Number(d.importe||0) }))
      .sort((a,b) => a.importe - b.importe)[0];
    return best || null;
  } catch { return null; }
}

// Coordenadas del local desde settings o ENV
async function getStoreCoords(tenantId = DEFAULT_TENANT_ID) {
  try {
    const db = await getDb();
    const set = await db.collection("settings").findOne({ _id: `store:${tenantId}:coords` });
    const lat = Number(set?.lat ?? STORE_LAT);
    const lng = Number(set?.lng ?? STORE_LNG);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) return { lat, lng };
  } catch {}
  return { lat: STORE_LAT, lng: STORE_LNG };
}

// Haversine (km)
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Geocode con Nominatim (OSM) — requiere User-Agent
async function geocodeAddressToCoords(address) {
  try {
    const q = encodeURIComponent(String(address || "").trim());
    if (!q) return null;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`;
    const r = await fetch(url, { headers: { "User-Agent": "caryco-bot/1.0 (+contacto)" } });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const { lat, lon } = arr[0];
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    return { lat: la, lng: lo };
  } catch { return null; }
}

// Selecciona el tramo de envío según distancia (min_km/max_km en products)
async function pickEnvioTierByDistance(tenantId, distanceKm) {
  try {
    const db = await getDb();
    const filter = { active: { $ne: false }, descripcion: { $regex: /^env[ií]o/i } };
    if (tenantId) filter.tenantId = String(tenantId);
    const list = await db.collection("products")
      .find(filter)
      .project({ _id: 1, descripcion: 1, importe: 1, min_km: 1, max_km: 1 })
      .toArray();
    if (!list.length) return null;
    // normaliza
    const tiers = list.map(d => ({
      _id: String(d._id),
      descripcion: String(d.descripcion || "Envio"),
      importe: Number(d.importe || 0),
      min_km: Number.isFinite(d.min_km) ? Number(d.min_km) : 0,
      max_km: Number.isFinite(d.max_km) ? Number(d.max_km) : Infinity
    })).sort((a,b) => a.max_km - b.max_km);
    const match = tiers.find(t => distanceKm >= t.min_km && distanceKm < t.max_km);
    return match || tiers[tiers.length - 1];
  } catch { return null; }
}

// A partir de Entrega=domicilio y un domicilio textual, calcula distancia y elige ítem
async function computeEnvioItemForPedido(tenantId, pedido) {
  const entrega = (pedido?.Entrega || "").toLowerCase();
  if (entrega !== "domicilio") return null;
  // Acepta Domicilio como string o como objeto con "direccion" (y variantes)
  let domicilioStr = null;
  if (typeof pedido?.Domicilio === "string") {
    domicilioStr = pedido.Domicilio;
  } else if (pedido?.Domicilio && typeof pedido.Domicilio === "object") {
    const d = pedido.Domicilio;
    domicilioStr = [
      d.direccion, d.calle, d.numero, d.piso, d.depto, d.barrio, d.localidad, d.ciudad, d.provincia, d.cp
    ].filter(v => String(v||"").trim()).join(" ");
  }
  if (!domicilioStr) return null;
  const store = await getStoreCoords(tenantId);
  if (!Number.isFinite(store.lat) || !Number.isFinite(store.lng)) return null;
  const dst = await geocodeAddressToCoords(domicilioStr);
  if (!dst) return null;
  const km = haversineKm(store.lat, store.lng, dst.lat, dst.lng);
  const tier = await pickEnvioTierByDistance(tenantId, km);
  if (!tier) return null;
  return { _id: tier._id, descripcion: tier.descripcion, importe: tier.importe };
}



// Opción A con flag: por defecto requiere dirección; si ADD_ENVIO_WITHOUT_ADDRESS=1, agrega envío apenas sea 'domicilio'
function ensureEnvio(pedido, envioItem) {
  const entrega = (pedido?.Entrega || "").toLowerCase();
  const allowWithoutAddress = String(process.env.ADD_ENVIO_WITHOUT_ADDRESS || "0") === "1";

  // Detecta si hay dirección (por si querés exigirla antes de cobrar envío)
  const hasAddress =
    pedido?.Domicilio &&
    typeof pedido.Domicilio === "object" &&
    Object.values(pedido.Domicilio).some(v => String(v || "").trim() !== "");

  // Normaliza estructura
  

  pedido.items ||= [];
  const isEnvio = (it) => (it?.descripcion || "").toLowerCase().includes("envio") ||
                          (envioItem && it?.id && String(it.id) === String(envioItem._id));
  const idx = pedido.items.findIndex(isEnvio);

  if (entrega === "domicilio") {
    if (!allowWithoutAddress && !hasAddress) return; // no agregamos hasta tener domicilio (a menos que flag)
    if (idx === -1) {
      if (envioItem) {
        const price = num(envioItem.importe);
        pedido.items.push({
          id: envioItem._id || 0,
          descripcion: envioItem.descripcion || "Envio",
          cantidad: 1,
          importe_unitario: price,
          total: price
        });
      }
    } else if (envioItem) {
      // Actualiza precio si cambió en catálogo
      const price = num(envioItem.importe);
      pedido.items[idx].importe_unitario = price;
      pedido.items[idx].total = num(pedido.items[idx].cantidad || 1) * price;
      // Normaliza descripción/id si está disponible
      if (envioItem._id) pedido.items[idx].id = envioItem._id;
      if (envioItem.descripcion) pedido.items[idx].descripcion = envioItem.descripcion;
    }
  } else {
    // Si no es domicilio, quitamos cualquier "Envio" residual
    if (idx !== -1) {
      pedido.items.splice(idx, 1);
    }
  }
    }

function buildBackendSummary(pedido) {
  return [
    "🧾 Resumen del pedido:",
    ...(pedido.items || []).map(i => `- ${i.cantidad} ${i.descripcion}`),
    `💰 Total: ${Number(pedido.total_pedido || 0).toLocaleString("es-AR")}`,
    "¿Confirmamos el pedido? ✅"
  ].join("\n");
}
function coalesceResponse(maybeText, pedidoObj) {
  const s = String(maybeText ?? "").trim();
  return s || ((pedidoObj?.items?.length || 0) > 0 ? buildBackendSummary(pedidoObj) : START_FALLBACK);
}
function recalcAndDetectMismatch(pedido, opts = {}) {
  const envioItem = opts.envioItem || null;
  pedido.items ||= [];
  const hasItems = pedido.items.length > 0;
  let mismatch = false;

  const beforeCount = pedido.items.length;
  ensureEnvio(pedido, envioItem);
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
  const cfg = await loadBehaviorConfigFromMongo(tenantId);
  const baseText = cfg.text;
  const historyMode = (cfg.history_mode || "standard").toLowerCase();

  // Bloque system inicial
  const catalogText = await loadCatalogTextFromMongo(tenantId);
  const fullSystem = [
    buildNowBlock(),
    "[COMPORTAMIENTO]\n" + baseText + catalogText
  ].join("\n\n").trim();

  let messages = [];

  if (historyMode === "minimal") {
    if (!userOnlyHistories[id]) userOnlyHistories[id] = [];
    if (!assistantPedidoSnapshot[id]) {
      assistantPedidoSnapshot[id] = JSON.stringify({ estado: "IN_PROGRESS", Pedido: { items: [], total_pedido: 0 } });
    }
    messages = [{ role: "system", content: fullSystem }];
    const asst = assistantPedidoSnapshot[id];
    if (asst) messages.push({ role: "assistant", content: asst });
    const seq = userOnlyHistories[id].concat([{ role: "user", content: userMessage }]);
    messages.push(...seq);
    userOnlyHistories[id].push({ role: "user", content: userMessage });

    console.log("[minimal] comportamiento =>\n" + baseText);
    console.log("[minimal] messages => " + safeStringify(messages));
    console.log("[minimal] userOnlyHistories => " + safeStringify(userOnlyHistories[id]));
  } else {
    if (!chatHistories[id]) chatHistories[id] = [{ role: "system", content: fullSystem }];
    chatHistories[id].push({ role: "user", content: userMessage });
    messages = chatHistories[id];

    console.log("[standard] comportamiento =>\n" + baseText);
    console.log("[standard] messages => " + safeStringify(messages));
  }

  try {
    const payload = {
      model: CHAT_MODEL,
      messages: sanitizeMessages(messages),
      temperature: CHAT_TEMPERATURE,
      response_format: { type: "json_object" }
    };
    console.log("[openai] message =>\n" + JSON.stringify(sanitizeMessages(messages), null, 2));

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" } }
    );

    try {
      const { id: oid, model, usage } = response.data || {};
    //  console.log("[openai] meta =>", { id: oid, model, usage });
      //console.log("[openai] response.data =>\n" + JSON.stringify(response.data, null, 2));
    } catch (e) {
      console.warn("[openai] no se pudo stringify la respuesta:", e?.message);
    }

    const reply = response.data.choices[0].message.content;
    console.log("[openai] assistant.content =>\n" + reply);

    if (historyMode === "standard") {
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

const { getDb, ObjectId } = require("./db");

// Persistencia auxiliar (por si querés llamarlo desde otros módulos)
async function appendMessage(conversationId, doc) {
  const db = await getDb();
  await db.collection("messages").insertOne({
    conversationId: typeof conversationId === "string" ? new ObjectId(conversationId) : conversationId,
    ts: new Date(),
    ...doc,
  });
}

async function finalizeConversationOnce(conversationId, json, status) {
  const db = await getDb();
  await db.collection("conversations").updateOne(
    { _id: typeof conversationId === "string" ? new ObjectId(conversationId) : conversationId },
    { $set: { status: status || (json?.estado ?? "COMPLETED"), closedAt: new Date(), lastPedido: json?.Pedido || null } }
  );
}

// Permite setear el snapshot que se inyectará como rol assistant (solo minimal)



// (se exportaba; ahora además dispara el guardado si el estado es COMPLETED)
function setAssistantPedidoSnapshot(tenantId, from, assistantJson, contactName) {
  try {
    if (!assistantJson) return;
    const id = k(tenantId, from);
    assistantPedidoSnapshot[id] = safeStringify(assistantJson?.Pedido || {});
    // Si el modelo cerró la conversación, persistimos conversación y mensajes.
    if (String(assistantJson?.estado || "").toUpperCase() === "COMPLETED") {
      // histórico (standard o minimal)
      const std = chatHistories[id] || [];
      const min = userOnlyHistories[id] || [];
      const merged = std.length ? std : (min.length
        ? [...min, { role: "assistant", content: safeStringify(assistantJson) }]
        : [{ role: "assistant", content: safeStringify(assistantJson) }]);
      // no bloqueamos el flujo: guardamos en background
      _persistCompleted({
        tenantId: tenantId || DEFAULT_TENANT_ID,
        waId: from,
        contactName: contactName || "",
        historyMsgs: merged,
        assistantObj: assistantJson
     });
    }
  } catch (e) { console.error("setAssistantPedidoSnapshot error:", e.message); }
}
module.exports = {
  // comportamiento
  loadBehaviorTextFromMongo,
  loadBehaviorConfigFromMongo,
  invalidateBehaviorCache,
  // catálogo
  loadCatalogTextFromMongo,

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
  // persistencia para admin
  appendMessage,
  finalizeConversationOnce,
  getEnvioItemFromCatalog,
  getStoreCoords,
  computeEnvioItemForPedido,
};
