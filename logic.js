
// ========================= logic.js =========================
// Mueve TODA la lógica acá. Los endpoints en app.js importan desde este módulo.
// Mantiene firmas y comportamiento para no romper nada.

require("dotenv").config();

const crypto = require("crypto");
const OpenAI = require("openai");
const { google } = require("googleapis");
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
// --- Multi-tenant (empresa): usar process.env.TENANT_ID ---
const TENANT_ID = (process.env.TENANT_ID || "").trim() || null;

// ================== FECHA/HORA ACTUAL PARA EL MODELO ==================
// TZ por defecto del local (cámbiala si hace falta)
const STORE_TZ = (process.env.STORE_TZ || "America/Argentina/Cordoba").trim();
// (Opcional) Simular "ahora" en QA: ej. 2025-09-15T13:00:00-03:00
const SIMULATED_NOW_ISO = (process.env.SIMULATED_NOW_ISO || "").trim();

function _nowLabelInTZ() {
  const base = SIMULATED_NOW_ISO ? new Date(SIMULATED_NOW_ISO) : new Date();
  const fmt = new Intl.DateTimeFormat("es-AR", {
    timeZone: STORE_TZ,
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
  return `${weekday}, ${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

function buildNowBlock() {
  return [
    "[AHORA]",
    `Zona horaria: ${STORE_TZ}`,
    `Fecha y hora actuales (local): ${_nowLabelInTZ()}`
  ].join("\n");
}


// --- Debug logging para ver comportamiento + historial que enviamos a OpenAI ---
const LOG_OPENAI_PROMPT = String(process.env.LOG_OPENAI_PROMPT || "false").toLowerCase() === "true";
const LOG_OPENAI_MAX = parseInt(process.env.LOG_OPENAI_MAX || "8000", 10);

function previewForLog(s, n = LOG_OPENAI_MAX) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "… [truncated]" : s;
}

function redactForLogs(s) {
  return String(s ?? "")
    .replace(/Bearer\s+[A-Za-z0-9\-_.]+/g, "Bearer ***")   // tokens
    .replace(/\b\d{7,}\b/g, "***");                        // números largos (tel/orden)
}

function logOpenAIPayload(label, messages) {
  if (!LOG_OPENAI_PROMPT) return;
 try {
    const printable = (Array.isArray(messages) ? messages : []).map(m => {
      if (!m) return m;
      if (typeof m.content === "string") {
        return { role: m.role, content: previewForLog(redactForLogs(m.content)) };
      }
      if (Array.isArray(m.content)) {
        // multimodal: mostrar tipos de partes para no inundar logs
        const parts = m.content.map(p => p?.type || typeof p);
        return { role: m.role, content: `[${parts.join(", ")}]` };
      }
      return { role: m.role, content: "[non-string content]" };
    });
    console.log(`🛰️ ${label} → OpenAI messages\n${JSON.stringify(printable, null, 2)}`);
  } catch (e) {
    console.warn("logOpenAIPayload failed:", e?.message || e);
  }
}

function logSystemPrompt(waId, systemText) {
  if (!LOG_OPENAI_PROMPT) return;
  console.log(`🧠 SYSTEM PROMPT (behavior) para sesión ${waId}:\n${previewForLog(systemText)}`);
}


const OPENAI_MAX_TURNS = (() => {
  const n = parseInt(process.env.OPENAI_MAX_TURNS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

// ------- OpenAI -------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHAT_TEMPERATURE = Number.isFinite(parseFloat(process.env.OPENAI_TEMPERATURE))
  ? parseFloat(process.env.OPENAI_TEMPERATURE)
  : 0.2;

function withTimeout(promise, ms, label = "operation") {return new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${label||'operation'}_timeout_${ms}ms`)), ms);
  Promise.resolve(promise).then(
    (v) => { clearTimeout(t); resolve(v); },
    (e) => { clearTimeout(t); reject(e); }
  );
});}

// ------- JSON helpers -------
function escapeRegExp(s) { return String(s).replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"); }
function coerceJsonString(raw) {if (raw == null) return "";
let s = String(raw);


// En logic.js (arriba, junto a helpers)

// === Helper global: parser de dinero tolerante ($ 1.234,56 / 1,234.56 / 1234.56) ===
function parseMoneyLoose(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  let s = String(v || "").trim();
  if (!s) return 0;
  // dejar solo dígitos, separadores y signo
  s = s.replace(/[^\d.,-]/g, "");
  // Si tiene coma y punto, el último separador es el decimal
  if (s.includes(".") && s.includes(",")) {
    const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
    const dec = s[lastSep];
    const thou = dec === "," ? "." : ",";
    s = s.split(thou).join(""); // remover miles
    s = s.slice(0, lastSep) + "." + s.slice(lastSep + 1); // decimal -> punto
  } else if (s.includes(",")) {
    const parts = s.split(",");
    s = (parts[parts.length - 1].length <= 2) ? parts.join(".") : parts.join("");
  } else if (s.includes(".")) {
    const parts = s.split(".");
    s = (parts[parts.length - 1].length <= 2) ? parts.join(".") : parts.join("");
  }
 const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}



// strip BOM and control chars
s = s.replace(/^\uFEFF/, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, " ").trim();

// remove ``` fences
if (s.startsWith("```")) {
  s = s.replace(/^```(\w+)?/i, "").replace(/```$/i, "").trim();
}

// normalize quotes
s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

// extract outermost JSON object if there's noise
const first = s.indexOf("{");
const last = s.lastIndexOf("}");
if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);

// remove simple trailing commas
s = s.replace(/,\s*([}\]])/g, "$1");

return s.trim();}
async function safeJsonParseStrictOrFix(raw, { openaiClient = openai, model = "gpt-4o-mini" } = {}) {
// Intento directo estricto
try {
  return JSON.parse(coerceJsonString(raw));
} catch (_) {}

// Heurística: buscar el bloque {...} más grande
try {
  const s = String(raw || "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const sliced = s.slice(first, last + 1);
    return JSON.parse(coerceJsonString(sliced));
  }
} catch (_) {}

// Último recurso: pedir al modelo que devuelva SOLO JSON válido
try {
  const fix = await withTimeout(
    openaiClient.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Devolvé EXCLUSIVAMENTE un JSON válido. Sin explicaciones." },
        { role: "user", content: `Arreglá este JSON o convertí a JSON válido:\n${String(raw).slice(0, 12000)}` }
      ]
    }),
    parseInt(process.env.OPENAI_TIMEOUT_MS || "12000", 10),
    "openai_json_fix"
  );
  const fixed = fix?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(coerceJsonString(fixed));
} catch (e) {
  return null;
}
}

// ------- WhatsApp / media / cache -------
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "https://transcribegpt-569454200011.northamerica-northeast1.run.app").trim().replace(/\/+$/, "");
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10);

const fileCache = new Map(); // id -> { buffer, mime, expiresAt }
function makeId(n = 16) { return crypto.randomBytes(n).toString("hex"); }
function putInCache(buffer, mime) {
  const id = makeId();
  fileCache.set(id, { buffer, mime: mime || "application/octet-stream", expiresAt: Date.now() + CACHE_TTL_MS });
  return id;
}
function getFromCache(id) {
  const item = fileCache.get(id);
  if (!item) return null;
  if (Date.now() > item.expiresAt) { fileCache.delete(id); return null; }
  return item;
}
function getPhoneNumberId(value) {
  let id = value?.metadata?.phone_number_id;
  if (!id && process.env.WHATSAPP_PHONE_NUMBER_ID) id = process.env.WHATSAPP_PHONE_NUMBER_ID.trim();
  return id || null;
}
async function sendText(to, body, phoneNumberId) {const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
phoneNumberId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
if (!token || !phoneNumberId) throw new Error("whatsapp_not_configured");
const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
const payload = { messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body: String(body||"").slice(0,4096) } };
const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
if (!resp.ok) throw new Error(`whatsapp_send_failed_${resp.status}`);
return resp.json().catch(() => ({ ok: true }));}
async function sendSafeText(to, body, value) {try {
  const phoneNumberId = getPhoneNumberId(value);
  return await sendText(to, body, phoneNumberId);
} catch (e) {
  console.warn("sendSafeText warn:", e?.message || e);
  return null;
}}
async function markAsRead(messageId, phoneNumberId) {const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
phoneNumberId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
if (!token || !phoneNumberId || !messageId) return;
const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
const payload = { messaging_product: "whatsapp", status: "read", message_id: messageId };
await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(()=>{});}
async function getMediaInfo(mediaId) {const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
if (!token || !mediaId) throw new Error("media_info_missing");
const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
const resp = await fetch(`${url}?fields=url,mime_type`, { headers: { Authorization: `Bearer ${token}` } });
if (!resp.ok) throw new Error(`media_info_failed_${resp.status}`);
return resp.json();}
async function downloadMediaBuffer(mediaUrl) {const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
if (!resp.ok) throw new Error(`download_media_failed_${resp.status}`);
const ab = await resp.arrayBuffer();
return Buffer.from(ab);}
async function transcribeImageWithOpenAI(publicImageUrl) {try {
  const r = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: "Extraé el texto visible de la imagen (si hay)." },
      { role: "user", content: `Imagen: ${publicImageUrl}` }
    ]
  });
  return r.choices?.[0]?.message?.content?.trim() || "";
} catch { return ""; }}
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime, filename = "audio.ogg" }) {
try {
  // 1) Preferir servicio externo si está configurado y hay URL pública
  const prefer = (process.env.TRANSCRIBE_API_URL || "").trim();
  if (prefer && publicAudioUrl) {
    try {
      const r = await fetch(`${prefer}/transcribe?url=${encodeURIComponent(publicAudioUrl)}`);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j && typeof j.text === "string") return { text: j.text, usage: j.tokens || j.usage || null };
      }
    } catch (_) {}
  }

  // 2) Fallback OpenAI: usar buffer directo o bajar la URL pública
  let buf = buffer, mt = mime;
  if (!buf && publicAudioUrl) {
    try {
      const r2 = await fetch(publicAudioUrl);
      mt = r2.headers.get("content-type") || mime || "audio/ogg";
      const ab = await r2.arrayBuffer();
      buf = Buffer.from(ab);
    } catch (_) {}
  }
  if (!buf) return { text: "" };

  const model = process.env.WHISPER_MODEL || process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
  const ext = (mt||"").includes("wav") ? "wav"
            : ((mt||"").includes("mpeg") || (mt||"").includes("mp3")) ? "mp3"
            : ((mt||"").includes("ogg") || (mt||"").includes("opus")) ? "ogg"
            : "mp3";

  // Node 18+ expone File/Blob
  const file = new File([buf], `audio.${ext}`, { type: mt || "audio/ogg" });
  const resp = await openai.audio.transcriptions.create({ file, model });
  const text = resp?.text || resp?.data?.text || "";
  return { text };
} catch (e) {
  console.error("transcribeAudioExternal fallback error:", e?.message || e);
  return { text: "" };
}
}
async function synthesizeTTS(text) {try {
  const model = process.env.TTS_MODEL || "gpt-4o-mini-tts";
  const voice = process.env.TTS_VOICE || "alloy";
  const format = (process.env.TTS_FORMAT || "mp3").toLowerCase();
  const resp = await openai.audio.speech.create({ model, voice, input: String(text||"").slice(0, 1000), format });
  const ab = await resp.arrayBuffer();
  const buffer = Buffer.from(ab);
  const mime = format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg";
  return { buffer, mime };
} catch { return null; }}

async function sendAudioLink(to, publicUrl, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const pnid = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !pnid) return null;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pnid}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "audio", audio: { link: publicUrl } };
  const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return resp.json().catch(()=>null);
}

// ------- Comportamiento y Catálogo -------
const BEHAVIOR_SOURCE = (process.env.BEHAVIOR_SOURCE || "sheet").toLowerCase();
const COMPORTAMIENTO_CACHE_TTL_MS = Number(process.env.COMPORTAMIENTO_CACHE_TTL_MS || (5 * 60 * 1000));
let behaviorCache = { at: 0, text: null };

async function loadBehaviorTextFromEnv() {
  return (process.env.COMPORTAMIENTO || "Sos un asistente claro, amable y conciso. Respondé en español.").trim();
}
function getSpreadsheetIdFromEnv() {
  const id = (process.env.SPREADSHEET_ID || "").trim();
  if (!id) throw new Error("SPREADSHEET_ID no configurado");
  return id;
}
function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return google.sheets({ version: "v4", auth });
}
async function loadBehaviorTextFromSheet() {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Comportamiento_API!A1:B100" });
  const rows = resp.data.values || [];
  const parts = rows
    .map(r => {
      const a = (r[0] || "").replace(/\s+/g, " ").trim();
      const b = (r[1] || "").replace(/\s+/g, " ").trim();
      const line = [a, b].filter(Boolean).join(" ").trim();
      return line;
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : "Sos un asistente claro, amable y conciso. Respondé en español.";
}
async function loadBehaviorTextFromMongo() {
  const db = await getDb();
  const key = TENANT_ID ? `behavior:${TENANT_ID}` : "behavior";
  // 1) Intentar doc del tenant
  let doc = await db.collection("settings").findOne({ _id: key });
  if (doc && typeof doc.text === "string" && doc.text.trim()) return doc.text.trim();
  // 2) Fallback al global (compatibilidad hacia atrás)
  if (key !== "behavior") {
    const globalDoc = await db.collection("settings").findOne({ _id: "behavior" });
    if (globalDoc && typeof globalDoc.text === "string" && globalDoc.text.trim()) return globalDoc.text.trim();
  }
  // 3) Si no existe, sembrar fallback en el doc del tenant (o global)
  const fallback = "Sos un asistente claro, amable y conciso. Respondé en español.";
  await db.collection("settings").updateOne(
    { _id: key },
    { $setOnInsert: { text: fallback, updatedAt: new Date() } },
    { upsert: true }
  );
  return fallback;
}
async function saveBehaviorTextToMongo(newText) {
  const db = await getDb();
  const key = TENANT_ID ? `behavior:${TENANT_ID}` : "behavior";
  await db.collection("settings").updateOne(
    { _id: key },
    { $set: { text: String(newText || "").trim(), updatedAt: new Date() } },
    { upsert: true }
  );
  behaviorCache = { at: 0, text: null };
}
async function loadProductsFromMongo() {
  const db = await getDb();
  const filter = { active: { $ne: false } };
  if (TENANT_ID) filter.tenantId = TENANT_ID;
  const docs = await db.collection("products").find(filter).sort({ createdAt: -1, descripcion: 1 }).toArray();
   function toNumber(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") { const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; }
    return null;
  }
  return docs.map(d => ({
    descripcion: d.descripcion || d.description || d.nombre || d.title || "",
    importe: toNumber(d.importe ?? d.precio ?? d.price ?? d.monto),
    observacion: d.observacion || d.observaciones || d.nota || d.note || "",
    active: d.active !== false
  }));
}
async function loadProductsFromSheet() {return [];}
function buildCatalogText(products) {if (!Array.isArray(products) || !products.length) return "No hay productos disponibles por el momento.";
const list = products.filter(p => p && p.active !== false);
function fmtMoney(n) { const v = Number(n); if (!Number.isFinite(v)) return ""; return "$" + (Number.isInteger(v) ? String(v) : v.toFixed(2)); }
const lines = [];
for (const p of list) {
  const desc = String(p.descripcion || "").trim();
  const price = (p.importe != null) ? fmtMoney(p.importe) : "";
  const obs = String(p.observacion || "").trim();
  let line = `- ${desc}`; if (price) line += ` - ${price}`; if (obs) line += ` — Obs: ${obs}`; lines.push(line);
}
return lines.length ? lines.join("\n") : "No hay productos activos en el catálogo.";}
function invalidateBehaviorCache() { behaviorCache = { at: 0, text: null }; }
async function buildSystemPrompt({ force = false, conversation = null } = {}) {
  const FREEZE_FULL_PROMPT = String(process.env.FREEZE_FULL_PROMPT || "false").toLowerCase() === "true";
  if (FREEZE_FULL_PROMPT && conversation && conversation.behaviorSnapshot && conversation.behaviorSnapshot.text) {
    return conversation.behaviorSnapshot.text;
  }
  const now = Date.now();
  if (!force && (now - behaviorCache.at < COMPORTAMIENTO_CACHE_TTL_MS) && behaviorCache.text) return behaviorCache.text;
  const baseText = (BEHAVIOR_SOURCE === "env") ? await loadBehaviorTextFromEnv() : (BEHAVIOR_SOURCE === "mongo") ? await loadBehaviorTextFromMongo() : await loadBehaviorTextFromSheet();
  let catalogText = "";
  try {
    let products = await loadProductsFromMongo();
    if (!products || !products.length) { try { products = await loadProductsFromSheet(); } catch (_) {} }
    catalogText = buildCatalogText(products || []);
  } catch (e) {
    console.warn("⚠️ No se pudo leer Productos (Mongo/Sheet):", e.message);
    catalogText = "Catálogo de productos: (error al leer)";
  }
  const jsonSchema =
    "FORMATO DE RESPUESTA (OBLIGATORIO - SOLO json, sin ```):\n" +
        '{ "response": "texto para WhatsApp",' +
    '  "estado": "IN_PROGRESS|COMPLETED|CANCELLED",' +
    '  "Pedido": {' +
    '     "Nombre": string,' +
    '     "Entrega": string,' +
    '     "Domicilio": string,' +
    '     "Fecha y hora de entrega": string,' +
    '     "Hora": string,' +
    '     "Estado pedido": string,' +
    '     "Motivo cancelacion": string,' +
    '     "items": [' +
    '        { "descripcion": string,' +
    '          "cantidad": number,' +
    '          "importe_unitario": number,' +
    '          "total": number }' +
    '     ],' +
    '     "Monto": number' +
    '  },' +
    '  "Bigdata"?: { "Sexo": string, "Estudios": string, "Satisfaccion del cliente": number, "Motivo puntaje satisfaccion": string, "Cuanto nos conoce el cliente": number, "Motivo puntaje conocimiento": string, "Motivo puntaje general": string, "Perdida oportunidad": string, "Sugerencias": string, "Flujo": string, "Facilidad en el proceso de compras": number, "Pregunto por bot": string } }' +
    '\nREGLAS:\n- Incluir SIEMPRE "Pedido" en todas las respuestas, incluso con "estado":"IN_PROGRESS".' +
    '\n- Cada ítem debe incluir cantidad, importe_unitario y total (total = cantidad * importe_unitario).' +
    '\n- "Monto" debe ser la suma de los totales de los ítems.' +
    '\nPRIVACIDAD/UX:\n- "response" NO debe incluir el detalle del Pedido (items ni precios). Solo mencioná el total si el usuario lo pide explícitamente.';
   const fullText = [
    buildNowBlock(),    
    "[COMPORTAMIENTO]\n" + baseText,
    "[CATALOGO]\n" + catalogText,
    "[SALIDA]\n" + jsonSchema
    //"RECORDATORIOS: Respondé en español. No uses bloques de código. Devolvé SOLO JSON plano."
  ].join("\n\n").trim();
  behaviorCache = { at: now, text: fullText };
  return fullText;
}

// ------- Conversaciones / mensajes / órdenes -------
async function bumpConversationTokenCounters(conversationId, tokens, role = "assistant") {try {
  const db = await getDb();
  const prompt = (tokens && typeof tokens.prompt_tokens === "number") ? tokens.prompt_tokens : 0;
  const completion = (tokens && typeof tokens.completion_tokens === "number") ? tokens.completion_tokens : 0;
  const total = prompt + completion;
  const inc = { "counters.messages_total": 0, "counters.tokens_prompt_total": prompt, "counters.tokens_completion_total": completion, "counters.tokens_total": total };
  if (role === "assistant") inc["counters.messages_assistant"] = 1; else if (role === "user") inc["counters.messages_user"] = 1;
  const set = { updatedAt: new Date() };
  await db.collection("conversations").updateOne({ _id: new ObjectId(conversationId) }, { $inc: inc, $set: set });
} catch (err) { console.warn("bumpConversationTokenCounters warn:", err?.message || err); }}



async function ensureOpenConversation(waId, { contactName = null } = {}) {
  const db = await getDb();
  
  const __tenant = TENANT_ID;
  let conv = await db.collection("conversations").findOne(
    __tenant ? { waId, status: "OPEN", tenantId: __tenant } : { waId, status: "OPEN" }
  );

  if (!conv) {
    
    const behaviorText = await buildSystemPrompt({ force: true });
    logSystemPrompt(waId, behaviorText);


    const doc = { tenantId: TENANT_ID || null, waId, status: "OPEN", finalized: false, contactName: contactName || null,
                   openedAt: new Date(), closedAt: null, lastUserTs: null, lastAssistantTs: null,
                   turns: 0,
                   behaviorSnapshot: { text: behaviorText, source: (process.env.BEHAVIOR_SOURCE || "sheet").toLowerCase(), savedAt: new Date() } };
  //const doc = { waId, status: "OPEN", finalized: false, contactName: contactName || null, openedAt: new Date(), closedAt: null, lastUserTs: null, lastAssistantTs: null, turns: 0, behaviorSnapshot: { text: behaviorText, source: (process.env.BEHAVIOR_SOURCE || "sheet").toLowerCase(), savedAt: new Date() } };
    const ins = await db.collection("conversations").insertOne(doc);
    conv = { _id: ins.insertedId, ...doc };
  } else if (contactName && !conv.contactName) {
    await db.collection("conversations").updateOne({ _id: conv._id }, { $set: { contactName } });
    conv.contactName = contactName;
  }
  return conv;
}

async function appendMessage(conversationId, { role, content, type = "text", meta = {}, ttlDays = null }) {
const db = await getDb();
const doc = {
  tenantId: TENANT_ID || null,
  conversationId: (conversationId instanceof ObjectId) ? conversationId : new ObjectId(conversationId),
  role, content: String(content || ""), type, meta: meta || {},
  ts: new Date()
};
if (ttlDays && Number(ttlDays) > 0) {
  const exp = new Date(Date.now() + Number(ttlDays) * 24 * 3600 * 1000);
  doc.expireAt = exp; // si hay TTL index configurado
}
await db.collection("messages").insertOne(doc);

// --- Actualizar conversación: timestamps y turns ---
try {
  const set = { updatedAt: new Date() };
  if (role === "user") set.lastUserTs = doc.ts;
  if (role === "assistant") set.lastAssistantTs = doc.ts;
  const upd = { $set: set };
  if (role === "assistant") { upd.$inc = { turns: 1 }; }
  await db.collection("conversations").updateOne(
    { _id: doc.conversationId },
    upd
  );
} catch (e) {
  console.warn("appendMessage: no se pudo actualizar conversation.turns/ts:", e?.message || e);
}
}
function normalizeOrder(waId, contactName, pedido) {
  const entrega = pedido?.["Entrega"] || "";
  const domicilio = pedido?.["Domicilio"] || "";
  const monto = parseMoneyLoose(pedido?.["Monto"]);

  // Items: si viene el array moderno con importes, lo normalizamos; si no, fallback legacy
  let items = [];
  if (Array.isArray(pedido?.items) && pedido.items.length) {
    items = pedido.items.map(_normItem); // {descripcion,cantidad,importe_unitario,total}
  } else {
    const legacyKeys = ["Pedido pollo","Pedido papas","Milanesas comunes","Milanesas Napolitanas","Ensaladas","Bebidas"];
    for (const key of legacyKeys) {
      const val = (pedido?.[key] || "").toString().trim();
      if (val && val.toUpperCase() !== "NO") items.push({ name: key, selection: val });
    }
  }

  const name = pedido?.["Nombre"] || contactName || "";
  const fechaEntrega = pedido?.["Fecha y hora de entrega"] || "";
  const hora = pedido?.["Hora"] || "";
  const estadoPedido = pedido?.["Estado pedido"] || "";
  const sum = _sumItems(items);
  const amount = sum > 0 ? sum : monto;
  return { waId, name, entrega, domicilio, items, amount, estadoPedido, fechaEntrega, hora, createdAt: new Date(), processed: false };
}

 
// === Helpers para mergear el Pedido con importes (definir ANTES de module.exports) ===
function _normItem(it = {}) {
  const desc = String(it.descripcion ?? it.name ?? "").trim();
  const cantidad = Number(it.cantidad ?? 0) || 0;
  const iu = parseMoneyLoose(it.importe_unitario);
  const tot = parseMoneyLoose(it.total);
  const total = Number.isFinite(tot) && tot > 0
    ? tot
    : (Number.isFinite(iu) && cantidad > 0 ? iu * cantidad : 0);
  return { descripcion: desc, cantidad, importe_unitario: iu || 0, total };
}

function _mergeItems(prev = [], next = []) {
  const byKey = new Map();
  const key = (s) => String(s || "").toLowerCase().trim();
 for (const p of prev) {
    const n = _normItem(p);
    if (!n.descripcion) continue;
    byKey.set(key(n.descripcion), n);
  }
  for (const p of next) {
    const n = _normItem(p);
    if (!n.descripcion) continue;
    const k = key(n.descripcion);
    const old = byKey.get(k) || { descripcion: n.descripcion, cantidad: 0, importe_unitario: 0, total: 0 };
    const cantidad = (Number.isFinite(n.cantidad) && n.cantidad > 0) ? n.cantidad : old.cantidad;
    const iu = (Number.isFinite(n.importe_unitario) && n.importe_unitario > 0) ? n.importe_unitario : old.importe_unitario;
    const total = (Number.isFinite(n.total) && n.total > 0)
      ? n.total
      : ((Number.isFinite(iu) && cantidad > 0) ? iu * cantidad : old.total);
    byKey.set(k, { descripcion: old.descripcion, cantidad, importe_unitario: iu, total });
  }
  return Array.from(byKey.values()).filter(x => x.descripcion);
}

function _sumItems(items = []) {
  return items.reduce((acc, it) => acc + (Number(it.total) || 0), 0);
}

/**
 * Fusiona el Pedido previo con el nuevo parcial, respetando importes.
 * - Campos de texto: pisa con el valor nuevo si viene no vacío.
 * - Items: upsert por descripcion; conserva o pisa importes según lo nuevo.
 * - Monto: suma de items si hay items; si no, toma el nuevo/previo parseado.
 */
function mergePedido(prev = {}, nuevo = {}) {
  const base = { ...(prev || {}) };
  const claves = ["Nombre","Entrega","Domicilio","Fecha y hora de entrega","Hora","Estado pedido","Motivo cancelacion"];
  for (const k of claves) {
    const nv = (nuevo?.[k] ?? "").toString().trim();
    if (nv) base[k] = nv;
  }
  const itemsPrev = Array.isArray(prev?.items) ? prev.items : [];
  const itemsNext = Array.isArray(nuevo?.items) ? nuevo.items : [];
  const items = _mergeItems(itemsPrev, itemsNext);
   let monto = items.length ? _sumItems(items) : parseMoneyLoose(nuevo?.["Monto"]);
  if (!Number.isFinite(monto) || monto <= 0) {
    const prevMonto = parseMoneyLoose(prev?.["Monto"]);
    monto = Number.isFinite(prevMonto) && prevMonto > 0 ? prevMonto : 0;
  }
  return { ...base, items, "Monto": monto };
}



async function saveCompletedToSheets({ waId, data }) {
}
async function finalizeConversationOnce(conversationId, finalPayload, estado) {
  const db = await getDb();
  const res = await db.collection("conversations").findOneAndUpdate(
    { _id: new ObjectId(conversationId), finalized: { $ne: true } },
    { $set: { status: estado || "COMPLETED", finalized: true, closedAt: new Date(), summary: { response: finalPayload?.response || "", Pedido: finalPayload?.Pedido || null, Bigdata: finalPayload?.Bigdata || null } } },
    { returnDocument: "after" }
  );
  const didFinalize = !!res?.value?.finalized;
  if (!didFinalize) return { didFinalize: false };
  const conv = res.value;
  try { await saveCompletedToSheets({ waId: conv.waId, data: finalPayload || {} }); } catch (e) { console.error("⚠️ Error guardando en Sheets tras finalizar:", e); }
  try {
    if (finalPayload?.Pedido) {
      const pedidoNombre = finalPayload.Pedido["Nombre"];
      if (pedidoNombre && !conv.contactName) {
        await db.collection("conversations").updateOne({ _id: conv._id }, { $set: { contactName: pedidoNombre } });
        conv.contactName = pedidoNombre;
      }
      const orderDoc = normalizeOrder(conv.waId, conv.contactName, finalPayload.Pedido);
      orderDoc.conversationId = conv._id;
      await db.collection("orders").insertOne(orderDoc);
    }
  } catch (e) { console.error("⚠️ Error guardando order:", e); }
  return { didFinalize: true };
}

// ------- Sesiones y chat -------
const sessions = new Map(); // waId -> { messages, updatedAt }
async function getSession(waId) {
  if (!sessions.has(waId)) {
    const db = await getDb();
    const conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
    const systemText = await buildSystemPrompt({ conversation: conv || null });
    logSystemPrompt(waId, systemText);


    sessions.set(waId, { messages: [{ role: "system", content: systemText }], updatedAt: Date.now() });
  }
  return sessions.get(waId);
}
function resetSession(waId) { sessions.delete(waId); }
function pushMessage(session, role, content, maxTurns = 20) {
  session.messages.push({ role, content });
  const system = session.messages[0];
  const tail = session.messages.slice(-2 * maxTurns);
  session.messages = [system, ...tail];
  session.updatedAt = Date.now();
}


async function openaiChatWithRetries(messages, { model, temperature }) {
  const maxRetries = parseInt(process.env.OPENAI_RETRY_COUNT || "2", 10);
  const baseDelay = parseInt(process.env.OPENAI_RETRY_BASE_MS || "600", 10);
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Log del historial que se envía a OpenAI
      logOpenAIPayload("REQUEST", messages);

      const result = await withTimeout(
        openai.chat.completions.create({
          model,
          response_format: { type: "json_object" },
          temperature,
          top_p: 1,
          messages
        }),
        parseInt(process.env.OPENAI_TIMEOUT_MS || "12000", 10),
        "openai_chat"
      );

      if (LOG_OPENAI_PROMPT) {
        const out = result?.choices?.[0]?.message?.content ?? "";
        console.log("⬅️ OpenAI response (assistant):\n" + previewForLog(out));
      }
      return result;
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) ? e.message : String(e);
      const retriable = /timeout/i.test(msg) || e?.status === 429 || e?.code === "ETIMEDOUT" || e?.code === "ECONNRESET";
      if (attempt < maxRetries && retriable) {
        const jitter = Math.floor(Math.random() * 400);
        const delay = baseDelay * Math.pow(2, attempt) + jitter;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error("openai_chat_failed");
}



async function chatWithHistoryJSON(waId, userText, model = CHAT_MODEL, temperature = CHAT_TEMPERATURE) {
  const session = await getSession(waId);
  try { const db = await getDb(); const conv = await db.collection("conversations").findOne({ waId, status: "OPEN" }); if (conv) session.messages[0] = { role: "system", content: await buildSystemPrompt({ conversation: conv }) }; } catch {}
  pushMessage(session, "user", userText);
  const resp = await openaiChatWithRetries((()=>{const __m=Number.isFinite(OPENAI_MAX_TURNS)&&OPENAI_MAX_TURNS>0; if(!__m) return session.messages; const __mm=session.messages; const __sys=__mm[0]; const __tail=__mm.slice(-2*OPENAI_MAX_TURNS); return [__sys, ...__tail];})(), { model, temperature });
  const msg = resp.choices?.[0]?.message?.content || "";
  const usage = resp.usage || null;
  const parsed = await safeJsonParseStrictOrFix(msg, { openaiClient: openai, model });
   // ⬇️ MUY IMPORTANTE: guardar la respuesta del asistente en el historial en memoria
  //pushMessage(session, "assistant", msg);

// return { content: msg, json: parsed, usage };



  // ⬇️ En historial, guardamos SOLO el texto “para WhatsApp”, no el JSON completo
  const assistantTextForHistory =
    (parsed && typeof parsed === "object" && parsed.response)
      ? String(parsed.response)
      : String(msg || "");
  // recorte defensivo para no inflar tokens
  //pushMessage(session, "assistant", assistantTextForHistory.slice(0, 4096));
    pushMessage(session, "assistant", assistantTextForHistory.slice(0, 4096));
//pushMessage(session, "assistant", msg);
  return { content: msg, json: parsed, usage };
}

module.exports = {
  // OpenAI + chat
  CHAT_MODEL, CHAT_TEMPERATURE, openai, withTimeout,
  safeJsonParseStrictOrFix, coerceJsonString,
  // WhatsApp helpers
  GRAPH_VERSION, TRANSCRIBE_API_URL,
  fileCache, putInCache, getFromCache,
  getPhoneNumberId, sendText, sendSafeText, markAsRead,
  getMediaInfo, downloadMediaBuffer,
  transcribeImageWithOpenAI, transcribeAudioExternal,
  synthesizeTTS, sendAudioLink,
  // Comportamiento / catálogo
  BEHAVIOR_SOURCE, COMPORTAMIENTO_CACHE_TTL_MS,
  loadBehaviorTextFromEnv, loadBehaviorTextFromSheet, loadBehaviorTextFromMongo, saveBehaviorTextToMongo,
  loadProductsFromMongo, loadProductsFromSheet, buildCatalogText, invalidateBehaviorCache, buildSystemPrompt,
  // Conversaciones / mensajes / órdenes
  escapeRegExp,
  bumpConversationTokenCounters, ensureOpenConversation, appendMessage, normalizeOrder, finalizeConversationOnce, mergePedido,
  // Sesiones + chat
  sessions, getSession, resetSession, pushMessage, openaiChatWithRetries, chatWithHistoryJSON,
  // Sheets helpers (exportados por si un endpoint los necesita)
  getSpreadsheetIdFromEnv, getSheetsClient, saveCompletedToSheets,
  ObjectId,
  ensureMessageOnce
};


// --- Idempotencia de mensajes entrantes ---
async function ensureMessageOnce(messageId) {
  if (!messageId) return true;
  const db = await getDb();
  try {
    await db.collection("processed_messages").insertOne({ _id: String(messageId), at: new Date() });
    return true; // primera vez
  } catch (e) {
    // 11000 = duplicate key
    if (e && (e.code === 11000 || String(e.message||'').includes('E11000'))) return false;
    throw e;
  }
}
