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
  // 🔹 Coordenadas del negocio + API Key de Maps
const STORE_LAT = parseFloat(process.env.STORE_LAT || "");
const STORE_LNG = parseFloat(process.env.STORE_LNG || "");
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

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
   const items = (pedido.items || []).filter(it =>
     showEnvio ? true : !/env[ií]o/i.test(String(it?.descripcion || ""))
   );
  const lines = [
     "🧾 Resumen del pedido:",
     ...items.map(i => `- ${i.cantidad} ${i.descripcion}`),
     `💰 Total: ${Number(pedido.total_pedido || 0).toLocaleString("es-AR")}`,
     "¿Confirmamos el pedido? ✅"
   ];
   if (_hasMilanesas(pedido)) {
     lines.splice(lines.length - 1, 0,
       "*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega.*"
     );
   }
   return lines.join("\n");
 }
 function coalesceResponse(maybeText, _pedido, _opts = {}) {
   const s = String(maybeText || "").trim();
   if (s) return s;
   // Ya no hacemos autosummary acá.
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

// Permite setear el snapshot que se inyectará como rol assistant (solo minimal)
function setAssistantPedidoSnapshot(tenantId, from, pedidoObj, estado) {
  const id = k(tenantId, from);
  try {
    const content = JSON.stringify({ estado: estado || null, Pedido: pedidoObj || {} });
    assistantPedidoSnapshot[id] = content;
  } catch {}
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
    const hit = data?.results?.[0]?.geometry?.location;
    if (!hit) return null;
    return { lat: hit.lat, lon: hit.lng };
  } catch (e) {
    console.error("geocodeAddress error:", e?.response?.data || e.message);
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

    // ¿ya hay envío?
    const idx = (pedido.items || []).findIndex(i =>
      String(i?.descripcion || "").toLowerCase().includes("envio")
    );

    // Preparar dirección
    const DEF_CITY = process.env.DEFAULT_CITY || "Venado Tuerto";
    const DEF_PROVINCE = process.env.DEFAULT_PROVINCE || "Santa Fe";
    const DEF_COUNTRY = process.env.DEFAULT_COUNTRY || "Argentina";
    const domicilio = pedido?.Domicilio || {};
    const addrParts = [
      domicilio.direccion,
      [domicilio.calle, domicilio.numero].filter(Boolean).join(" "),
      domicilio.barrio,
      domicilio.ciudad || domicilio.localidad,
      domicilio.provincia,
      domicilio.cp
    ].filter(Boolean);
    let address = addrParts.join(", ").trim();
    if (address && !/,/.test(address)) {
      address = [address, DEF_CITY, DEF_PROVINCE, DEF_COUNTRY].filter(Boolean).join(", ");
    }

    // Geocoding + distancia
    const store = getStoreCoords?.();
    let distKm = null;
    if (store && address) {
      const geo = await geocodeAddress(address);
      if (geo) {
        const { lat, lon } = geo;
        pedido.Domicilio.lat = lat;
        pedido.Domicilio.lon = lon;
        distKm = calcularDistanciaKm(store.lat, store.lon, lat, lon);
        pedido.distancia_km = distKm;
        console.log(`[envio] ensureEnvioSmart address='${address}', distancia=${distKm} km`);
      } else {
        console.warn("[envio] ensureEnvioSmart: geocoding sin resultado");
      }
    }

    // Elegir producto de envío (por distancia si la hay; si no, fallback)
    const db = await getDb();
    const envioProd = await pickEnvioProductByDistance(db, tenantId || null, distKm ?? Infinity);
    if (!envioProd) return pedido;

    // Insertar o actualizar
    if (idx >= 0) {
      const cantidad = Number(pedido.items[idx].cantidad || 1);
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
  calcularDistanciaKm,
  geocodeAddress,
  getStoreCoords,
  pickEnvioProductByDistance,
  hydratePricesFromCatalog,
 ensureEnvioSmart,
};
