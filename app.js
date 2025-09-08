
const express = require("express");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ AHORA podés usar middleware como:
app.use('/public', express.static('public'));


const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
// server.js
require("dotenv").config();


const crypto = require("crypto");   
const OpenAI = require("openai");
const { google } = require("googleapis");

// --- MongoDB helpers
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");

// --- Node fetch (Node 18+ trae global fetch)


/* ======================= Body / firma ======================= */
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

function isValidSignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");
  if (!appSecret || !signature) return false;

  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(req.rawBody);
  const expected = "sha256=" + hmac.digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/* ======================= OpenAI ======================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHAT_MODEL =
  process.env.OPENAI_CHAT_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";
const CHAT_TEMPERATURE = Number.isFinite(parseFloat(process.env.OPENAI_TEMPERATURE))
  ? parseFloat(process.env.OPENAI_TEMPERATURE)
  : 0.2;

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms)
    )
  ]);
}

/* ======================= Helpers JSON robustos ======================= */
// Regex escape helper (safe for user-provided phone filters)
function escapeRegExp(s) { return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }

function coerceJsonString(raw) {
  if (raw == null) return null;
  let s = String(raw);

  // quita BOM y caracteres de control (excepto \n \t \r)
  s = s.replace(/^\uFEFF/, "")
       .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, " ")
       .trim();

  // quita fences ``` y etiquetas de código
  if (s.startsWith("```")) {
    s = s.replace(/^```(\w+)?/i, "").replace(/```$/i, "").trim();
  }

  // normaliza comillas tipográficas a comillas normales
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // si ya luce como JSON puro, retornalo
  if (s.startsWith("{") && s.endsWith("}")) return s;

  // intenta extraer el primer bloque { ... }
  const first = s.indexOf("{");
  const last  = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return s.slice(first, last + 1).trim();
  }

  return s;
}

async function safeJsonParseStrictOrFix(raw, { openai, model = "gpt-4o-mini" } = {}) {
  let s = coerceJsonString(raw);
  if (!s) return null;

  try {
    return JSON.parse(s);
  } catch (_) {}

  // reintento con “arreglador” (una sola vez)
  try {
    const fix = await openai.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Devuelve EXCLUSIVAMENTE un JSON válido, sin comentarios ni markdown." },
        { role: "user", content: `Convertí lo siguiente a JSON estricto (si falta llaves, completalas):\n\n${raw}` }
      ]
    });
    const fixed = fix.choices?.[0]?.message?.content || "";
    const fixedClean = coerceJsonString(fixed);
    return JSON.parse(fixedClean);
  } catch (e2) {
    try {
      return JSON.parse(s);
    } catch (e3) {
      const preview = (String(raw || "")).slice(0, 400);
      console.error("❌ No se pudo parsear JSON luego de fix:", e3.message, "\nRaw preview:", preview);
      return null;
    }
  }
}

/* ======================= WhatsApp / Media ======================= */
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "https://transcribegpt-569454200011.northamerica-northeast1.run.app").trim().replace(/\/+$/,"");
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10); // 5 min

// Cache binaria
const fileCache = new Map(); // id -> { buffer, mime, expiresAt }
function makeId(n = 16) { return crypto.randomBytes(n).toString("hex"); }
function getBaseUrl(req) {
  let base = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) {
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const host = req.headers.host;
    base = `${proto}://${host}`;
  }
  return base;
}
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
// 🧹 Limpiador periódico
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of fileCache.entries()) if (now > item.expiresAt) fileCache.delete(id);
}, 60 * 1000);

// Rutas públicas para servir cache
app.get("/cache/audio/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});
app.get("/cache/image/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});
app.get("/cache/tts/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});

async function getMediaInfo(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(`Media info error: ${resp.status} ${JSON.stringify(data)}`);
  }
  return resp.json();
}
async function downloadMediaBuffer(mediaUrl) {
  const token = process.env.WHATSAPP_TOKEN;
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Media download error: ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// OCR de imagen
async function transcribeImageWithOpenAI(publicImageUrl) {
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: "o4-mini",
    messages: [
      { role: "system", content: "Muestra solo el texto sin saltos de linea ni caracteres especiales que veas en la imagen" },
      { role: "user", content: [{ type: "image_url", image_url: { url: publicImageUrl } }] }
    ],
    temperature: 1
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`OpenAI vision error: ${resp.status} ${errTxt}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// Transcriptor externo (varias variantes)
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime, filename = "audio.ogg" }) {
  const base = TRANSCRIBE_API_URL;
  const paths = ["", "/transcribe", "/api/transcribe", "/v1/transcribe"];

  // 1) POST JSON { audio_url }
  for (const p of paths) {
    const url = `${base}${p}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_url: publicAudioUrl })
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      console.log("✅ Transcribe OK: POST JSON audio_url", url);
      return j;
    } else {
      const txt = await r.text().catch(() => "");
      console.warn("Transcribe POST JSON fallo:", r.status, url, txt);
    }
  }

  // 2) POST multipart con archivo
  if (buffer && buffer.length) {
    function buildMultipart(parts) {
      const boundary = "----NodeForm" + crypto.randomBytes(8).toString("hex");
      const chunks = [];
      for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (part.type === "file") {
          const headers =
            `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType || "application/octet-stream"}\r\n\r\n`;
          chunks.push(Buffer.from(headers), part.data, Buffer.from("\r\n"));
        } else {
          const headers = `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`;
          chunks.push(Buffer.from(headers), Buffer.from(String(part.value)), Buffer.from("\r\n"));
        }
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      return { body: Buffer.concat(chunks), boundary };
    }
    for (const p of paths) {
      const url = `${base}${p}`;
      const { body, boundary } = buildMultipart([
        { type: "file", name: "file", filename, contentType: mime || "application/octet-stream", data: buffer }
      ]);
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        console.log("✅ Transcribe OK: POST multipart file", url);
        return j;
      } else {
        const txt = await r.text().catch(() => "");
        console.warn("Transcribe POST multipart fallo:", r.status, url, txt);
      }
    }
  } else {
    console.warn("⚠️ No hay buffer de audio para multipart; se omite variante file.");
  }

  // 3) GET ?audio_url=
  for (const p of paths) {
    const url = `${base}${p}?audio_url=${encodeURIComponent(publicAudioUrl)}`;
    const g = await fetch(url);
    if (g.ok) {
      const j2 = await g.json().catch(() => ({}));
      console.log("✅ Transcribe OK: GET", url);
      return j2;
    } else {
      const txt = await g.text().catch(() => "");
      console.warn("Transcribe GET fallo:", g.status, url, txt);
    }
  }

  throw new Error("No hubo variantes válidas para el endpoint de transcripción.");
}

/* ======================= TTS ======================= */
async function synthesizeTTS(text) {
  const model = process.env.TTS_MODEL || "gpt-4o-mini-tts";
  const voice = process.env.TTS_VOICE || "alloy";
  const format = (process.env.TTS_FORMAT || "mp3").toLowerCase();

  const resp = await openai.audio.speech.create({
    model,
    voice,
    input: text,
    format // "mp3", "wav" o "opus"
  });

  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const mime =
    format === "wav" ? "audio/wav" :
    format === "opus" ? "audio/ogg" :
    "audio/mpeg"; // mp3

  return { buffer, mime };
}
async function sendAudioLink(to, publicUrl, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "audio",
    audio: { link: publicUrl }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!resp.ok) console.error("❌ Error WhatsApp sendAudioLink:", resp.status, data);
  else console.log("📤 Enviado AUDIO:", data);
  return data;
}

/* ======================= WhatsApp helpers de envío ======================= */
function getPhoneNumberId(value) {
  let id = value?.metadata?.phone_number_id;
  if (!id && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    id = process.env.WHATSAPP_PHONE_NUMBER_ID.trim();
  }
  return id || null;
}
async function sendText(to, body, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body } };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!resp.ok) console.error("❌ Error WhatsApp sendText:", resp.status, data);
  else console.log("📤 Enviado:", data);
  return data;
}
async function sendSafeText(to, body, value) {
  const phoneNumberId = getPhoneNumberId(value);
  if (!phoneNumberId) {
    console.error("❌ No hay phone_number_id ni en metadata ni en ENV. No se puede enviar WhatsApp.");
    return { error: "missing_phone_number_id" };
  }
  try {
    return await sendText(to, body, phoneNumberId);
  } catch (e) {
    console.error("❌ Error en sendSafeText:", e);
    return { error: e.message || "send_failed" };
  }
}


/* ======================= Tokens por conversación ======================= */
/**
 * Acumula contadores de tokens a nivel conversación.
 * Guarda:
 *  - counters.tokens_prompt_total
 *  - counters.tokens_completion_total
 *  - counters.tokens_total
 *  - counters.messages_total (+1)
 *  - counters.messages_assistant (+1 si role === "assistant")
 *  - last_usage (últimos tokens observados)
 *  - updatedAt (timestamp)
 */
async function bumpConversationTokenCounters(conversationId, tokens, role = "assistant") {
  try {
    const db = await getDb();
    const prompt = (tokens && typeof tokens.prompt === "number") ? tokens.prompt : 0;
    const completion = (tokens && typeof tokens.completion === "number") ? tokens.completion : 0;
    const total = (tokens && typeof tokens.total === "number") ? tokens.total : (prompt + completion);

    const inc = {
      "counters.messages_total": 1,
      "counters.tokens_prompt_total": prompt,
      "counters.tokens_completion_total": completion,
      "counters.tokens_total": total
    };
    if (role === "assistant") {
      inc["counters.messages_assistant"] = 1;
    } else if (role === "user") {
      inc["counters.messages_user"] = 1;
    }

    const set = { updatedAt: new Date() };
    if (tokens) set["last_usage"] = tokens;
    await db.collection("conversations").updateOne({ _id: conversationId }, { $inc: inc, $set: set });
  } catch (err) {
    console.warn("⚠️ bumpConversationTokenCounters error:", err?.message || err);
  }
}




async function markAsRead(messageId, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", status: "read", message_id: messageId };
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    console.warn("⚠️ markAsRead falló:", resp.status, data);
  }
}


/* ======================= Comportamiento (ENV, Sheet o Mongo) ======================= */
const BEHAVIOR_SOURCE = (process.env.BEHAVIOR_SOURCE || "sheet").toLowerCase(); // "env" | "sheet" | "mongo"
// Hacemos el TTL configurable por env (ms). Default: 5 minutos.
const COMPORTAMIENTO_CACHE_TTL_MS = Number(process.env.COMPORTAMIENTO_CACHE_TTL_MS || (5 * 60 * 1000));

let behaviorCache = { at: 0, text: null };

async function loadBehaviorTextFromEnv() {
  const txt = (process.env.COMPORTAMIENTO || "Sos un asistente claro, amable y conciso. Respondé en español.").trim();
  return txt;
}
async function loadBehaviorTextFromSheet() {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Comportamiento_API!A1:B100"
  });
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
// === Mongo: carga de catálogo ===
async function loadProductsFromMongo() {
  const db = await getDb();
  // Por defecto, sólo activos (compatible con /api/products)
  const docs = await db.collection("products")
    .find({ active: { $ne: false } })
    .sort({ createdAt: -1, descripcion: 1 })
    .toArray();

  // Normalizamos al shape usado por buildCatalogText
  function toNumber(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  return docs.map(d => {
    const importe =
      toNumber(d.importe ?? d.precio ?? d.price ?? d.monto);
    const descripcion =
      d.descripcion || d.description || d.nombre || d.title || "";
    const observacion =
      d.observacion || d.observaciones || d.nota || d.note || "";
    return {
      descripcion,
      importe,
      observacion,
      active: d.active !== false
    };
  });
}

// --- Construcción de texto de catálogo para el prompt del sistema
// Recibe [{ descripcion, importe, observacion, active }] y devuelve líneas legibles.
function buildCatalogText(products) {
  if (!Array.isArray(products) || !products.length) {
    return "No hay productos disponibles por el momento.";
  }
  // Sólo activos por las dudas (aunque ya vienen filtrados)
  const list = products.filter(p => p && p.active !== false);

  function fmtMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    // sin decimales si es entero, con 2 si no
    return "$" + (Number.isInteger(v) ? String(v) : v.toFixed(2));
  }

  const lines = [];
  for (const p of list) {
    const desc = String(p.descripcion || "").trim();
    const price = (p.importe != null) ? fmtMoney(p.importe) : "";
    const obs = String(p.observacion || "").trim();
    let line = `- ${desc}`;
    if (price) line += ` - ${price}`;
    if (obs) line += ` — Obs: ${obs}`;
    lines.push(line);
  }

  // Si después del filtrado no quedó nada:
  if (!lines.length) return "No hay productos activos en el catálogo.";
  return lines.join("\n");
}




async function loadBehaviorTextFromMongo() {
  const db = await getDb();
  const doc = await db.collection("settings").findOne({ _id: "behavior" });
  if (doc && typeof doc.text === "string" && doc.text.trim()) return doc.text.trim();
  const fallback = "Sos un asistente claro, amable y conciso. Respondé en español.";
  await db.collection("settings").updateOne(
    { _id: "behavior" },
    { $setOnInsert: { text: fallback, updatedAt: new Date() } },
    { upsert: true }
  );
  return fallback;
}
async function saveBehaviorTextToMongo(newText) {
  const db = await getDb();
  await db.collection("settings").updateOne(
    { _id: "behavior" },
    { $set: { text: String(newText || "").trim(), updatedAt: new Date() } },
    { upsert: true }
  );
  behaviorCache = { at: 0, text: null };
}
// Permite invalidar manualmente la caché de prompt (por ejemplo, tras CRUD de productos)
function invalidateBehaviorCache() {
  behaviorCache = { at: 0, text: null };
}
async function buildSystemPrompt({ force = false, conversation = null } = {}) {
  // Si querés congelar el prompt completo (comportamiento + catálogo), seteá FREEZE_FULL_PROMPT=true.
  const FREEZE_FULL_PROMPT = String(process.env.FREEZE_FULL_PROMPT || "false").toLowerCase() === "true";
  if (FREEZE_FULL_PROMPT && conversation && conversation.behaviorSnapshot && conversation.behaviorSnapshot.text) {
    return conversation.behaviorSnapshot.text;
  }

  const now = Date.now();
  if (!force && (now - behaviorCache.at < COMPORTAMIENTO_CACHE_TTL_MS) && behaviorCache.text) {
    return behaviorCache.text;
  }

  // 1) Comportamiento desde ENV o desde Sheet
  const baseText = (BEHAVIOR_SOURCE === "env")
    ? await loadBehaviorTextFromEnv()
    : (BEHAVIOR_SOURCE === "mongo")
      ? await loadBehaviorTextFromMongo()
      : await loadBehaviorTextFromSheet();

  // 2) Catálogo desde MongoDB (products) con fallback a Sheet si viniera vacío
  let catalogText = "";
  try {
    let products = await loadProductsFromMongo();
    if (!products || !products.length) {
      try { products = await loadProductsFromSheet(); } catch (_) {}
    }
    console.log("📦 Catálogo:", (products || []).length, "items",
                (products && products.length ? "(Mongo OK)" : "(fallback Sheet)"));
    catalogText = buildCatalogText(products || []);
  } catch (e) {
    console.warn("⚠️ No se pudo leer Productos (Mongo/Sheet):", e.message);
    catalogText = "Catálogo de productos: (error al leer)";
  }

  // 3) Reglas de uso de observaciones
  /*const reglasVenta =
    "Instrucciones de venta (OBLIGATORIAS):\n" +
    "- Usá las Observaciones para decidir qué ofrecer, sugerir complementos, aplicar restricciones o proponer sustituciones.\n" +
    "- Respetá limitaciones (stock/horarios/porciones/preparación) indicadas en Observaciones.\n" +
    "- Si sugerís bundles o combos, ofrecé esas opciones con precio estimado cuando corresponda.\n" +
    "- Si falta un dato (sabor/tamaño/cantidad), pedilo brevemente.\n";
*/
  // 4) Esquema JSON
  const jsonSchema =
    "FORMATO DE RESPUESTA (OBLIGATORIO - SOLO JSON, sin ```):\n" +
    '{ "response": "texto para WhatsApp", "estado": "IN_PROGRESS|COMPLETED|CANCELLED", ' +
    '  "Pedido"?: { "Fecha y hora de inicio de conversacion": string, "Fecha y hora fin de conversacion": string, "Estado pedido": string, "Motivo cancelacion": string, "Pedido pollo": string, "Pedido papas": string, "Milanesas comunes": string, "Milanesas Napolitanas": string, "Ensaladas": string, "Bebidas": string, "Monto": number, "Nombre": string, "Entrega": string, "Domicilio": string, "Fecha y hora de entrega": string, "Hora": string }, ' +
    '  "Bigdata"?: { "Sexo": string, "Estudios": string, "Satisfaccion del cliente": number, "Motivo puntaje satisfaccion": string, "Cuanto nos conoce el cliente": number, "Motivo puntaje conocimiento": string, "Motivo puntaje general": string, "Perdida oportunidad": string, "Sugerencias": string, "Flujo": string, "Facilidad en el proceso de compras": number, "Pregunto por bot": string } }';

  const fullText = [
    "[COMPORTAMIENTO]\n" + baseText,
   // "[REGLAS]\n" + reglasVenta,
    "[CATALOGO]\n" + catalogText,
    "[SALIDA]\n" + jsonSchema,
    "RECORDATORIOS: Respondé en español. No uses bloques de código. Devolvé SOLO JSON plano."
  ].join("\n\n").trim();

  behaviorCache = { at: now, text: fullText };
  return fullText;
}

// Endpoint para refrescar caché manualmente (útil tras cambios de catálogo)
app.post("/api/behavior/refresh-cache", async (_req, res) => {
  try {
    invalidateBehaviorCache();
    res.json({ ok: true, cache: "invalidated" });
  } catch (e) {
    console.error("⚠️ refresh-cache error:", e);
    res.status(500).json({ error: "internal" });
  }
});

/* ======================= Mongo: conversaciones, mensajes, orders ======================= */
async function ensureOpenConversation(waId, { contactName = null } = {}) {
  const db = await getDb();
  let conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
  if (!conv) {
    // ⚡ Al iniciar una conversación: recargo comportamiento (ignora caché)
    const behaviorText = await buildSystemPrompt({ force: true });
    const doc = {
      waId,
      status: "OPEN",         // OPEN | COMPLETED | CANCELLED
      finalized: false,       // idempotencia para Sheets/orden
      contactName: contactName || null,
      openedAt: new Date(),
      closedAt: null,
      lastUserTs: null,
      lastAssistantTs: null,
      turns: 0,
      behaviorSnapshot: {
        text: behaviorText,
        source: (process.env.BEHAVIOR_SOURCE || "sheet").toLowerCase(),
        savedAt: new Date()
      }
    };
    const ins = await db.collection("conversations").insertOne(doc);
    conv = { _id: ins.insertedId, ...doc };
  } else if (contactName && !conv.contactName) {
    await db.collection("conversations").updateOne(
      { _id: conv._id },
      { $set: { contactName } }
    );
    conv.contactName = contactName;
  }
  return conv;
}

async function appendMessage(conversationId, {
  role,
  content,
  type = "text",
  meta = {},
  ttlDays = null
}) {
  const db = await getDb();
  const doc = {
    conversationId: new ObjectId(conversationId),
    role, content, type, meta,
    ts: new Date()
  };
  if (ttlDays && Number.isFinite(ttlDays)) {
    doc.expireAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  }
  await db.collection("messages").insertOne(doc);

  const upd = { $inc: { turns: 1 }, $set: {} };
  if (role === "user") upd.$set.lastUserTs = doc.ts;
  if (role === "assistant") upd.$set.lastAssistantTs = doc.ts;
  await db.collection("conversations").updateOne({ _id: new ObjectId(conversationId) }, upd);
}

// Normalizar “Pedido” a estructura de order
function normalizeOrder(waId, contactName, pedido) {
  const entrega = pedido?.["Entrega"] || "";
  const domicilio = pedido?.["Domicilio"] || "";
  const monto = Number(pedido?.["Monto"] ?? 0) || 0;

  // Intentar construir items a partir de los campos del pedido
  const items = [];
  const mappedFields = [
    "Pedido pollo",
    "Pedido papas",
    "Milanesas comunes",
    "Milanesas Napolitanas",
    "Ensaladas",
    "Bebidas"
  ];
  for (const key of mappedFields) {
    const val = (pedido?.[key] || "").toString().trim();
    if (val && val.toUpperCase() !== "NO") {
      items.push({ name: key, selection: val });
    }
  }

  // Otros datos que puedan servir
  const name = pedido?.["Nombre"] || contactName || "";
  const fechaEntrega = pedido?.["Fecha y hora de entrega"] || "";
  const hora = pedido?.["Hora"] || "";
  const estadoPedido = pedido?.["Estado pedido"] || "";

  return {
    waId,
    name,
    entrega,
    domicilio,
    items,
    amount: monto,
    estadoPedido,
    fechaEntrega,
    hora,
    createdAt: new Date(),
    processed: false
  };
}

// Cierre idempotente + guardado en Sheets y en orders
async function finalizeConversationOnce(conversationId, finalPayload, estado) {
  const db = await getDb();
  const res = await db.collection("conversations").findOneAndUpdate(
    { _id: new ObjectId(conversationId), finalized: { $ne: true } },
    {
      $set: {
        status: estado || "COMPLETED",
        finalized: true,
        closedAt: new Date(),
        summary: {
          response: finalPayload?.response || "",
          Pedido: finalPayload?.Pedido || null,
          Bigdata: finalPayload?.Bigdata || null
        }
      }
    },
    { returnDocument: "after" }
  );

  const didFinalize = !!res?.value?.finalized;
  if (!didFinalize) {
    return { didFinalize: false };
  }

  const conv = res.value;
  try {
    // Guardar en Sheets
    await saveCompletedToSheets({
      waId: conv.waId,
      data: finalPayload || {}
    });
  } catch (e) {
    console.error("⚠️ Error guardando en Sheets tras finalizar:", e);
  }

  // Si hay Pedido, guardamos en orders con normalización
  try {
    if (finalPayload?.Pedido) {
      // si el nombre vino del pedido y no lo teníamos, sincronizamos
      const pedidoNombre = finalPayload.Pedido["Nombre"];
      if (pedidoNombre && !conv.contactName) {
        await db.collection("conversations").updateOne(
          { _id: conv._id },
          { $set: { contactName: pedidoNombre } }
        );
        conv.contactName = pedidoNombre;
      }

      const orderDoc = normalizeOrder(conv.waId, conv.contactName, finalPayload.Pedido);
      orderDoc.conversationId = conv._id;
      await db.collection("orders").insertOne(orderDoc);
    }
  } catch (e) {
    console.error("⚠️ Error guardando order:", e);
  }

  return { didFinalize: true };
}

/* ======================= Sesiones (historial) ======================= */
const sessions = new Map(); // waId -> { messages, updatedAt }

async function getSession(waId) {
  if (!sessions.has(waId)) {
        const db = await getDb();
    const conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
    const systemText = await buildSystemPrompt({ conversation: conv || null });
// al iniciar conversación
    sessions.set(waId, {
      messages: [{ role: "system", content: systemText }],
      updatedAt: Date.now()
    });
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

// OpenAI chat call with retries & backoff (retriable on timeouts / 429 / reset)






async function openaiChatWithRetries(messages, { model, temperature }) {
  const maxRetries = parseInt(process.env.OPENAI_RETRY_COUNT || "2", 10);
  const baseDelay  = parseInt(process.env.OPENAI_RETRY_BASE_MS || "600", 10);
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(
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
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) ? e.message : String(e);
      const retriable = /timeout/i.test(msg) || e?.status === 429 || e?.code === "ETIMEDOUT" || e?.code === "ECONNRESET";
      if (attempt < maxRetries && retriable) {
        const jitter = Math.floor(Math.random() * 250);
        const delay = baseDelay * Math.pow(2, attempt) + jitter;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error("openai_chat_failed");
}
/* ======================= Chat (historial + parser robusto) ======================= */
async function chatWithHistoryJSON(
  waId,
  userText,
  model = CHAT_MODEL,
  temperature = CHAT_TEMPERATURE
) {
  const session = await getSession(waId);

  // refrescar system en cada turno
  try {
        const db = await getDb();
    const conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
    const systemText = await buildSystemPrompt({ conversation: conv || null });
    session.messages[0] = { role: "system", content: systemText };
} catch (e) {
    console.warn("⚠️ No se pudo refrescar system:", e.message);
  }

  pushMessage(session, "user", userText);

  let content = "";
  let usage = null;
  try {
    const completion = await openaiChatWithRetries([ ...session.messages ], { model, temperature });
    usage = completion.usage || null;
    content = completion.choices?.[0]?.message?.content || "";
  } catch (e) {
    console.error("❌ OpenAI error/timeout:", e.message || e);
    const fallback = {
      response: "Perdón, tuve un inconveniente para responder ahora mismo. ¿Podés repetir o reformular tu mensaje?",
      estado: "IN_PROGRESS"
    };
    pushMessage(session, "assistant", fallback.response);
    return { response: fallback.response, estado: fallback.estado, raw: fallback };
  }

  const data = await safeJsonParseStrictOrFix(content, { openai, model }) || null;

  const responseText =
    (data && typeof data.response === "string" && data.response.trim()) ||
    (typeof content === "string" ? content.trim() : "") ||
    "Perdón, no pude generar una respuesta. ¿Podés reformular?";

  const estado =
    (data && typeof data.estado === "string" && data.estado.trim().toUpperCase()) || "IN_PROGRESS";

  pushMessage(session, "assistant", responseText);
  //return { response: responseText, estado, raw: data || {} };
  return { response: responseText, estado, raw: data || {}, usage };
}

/* ======================= Rutas básicas ======================= */
app.get("/", (_req, res) => res.status(200).send("WhatsApp Webhook up ✅"));

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Verificación fallida");
  return res.sendStatus(403);
});


/* ======================= UI y API para editar comportamiento ======================= */
app.get("/comportamiento", async (_req, res) => {
  try {
    const text = (BEHAVIOR_SOURCE === "env")
      ? await loadBehaviorTextFromEnv()
      : (BEHAVIOR_SOURCE === "mongo")
        ? await loadBehaviorTextFromMongo()
        : await loadBehaviorTextFromSheet();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Comportamiento del Bot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; max-width: 960px; }
    textarea { width: 100%; min-height: 360px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace; font-size: 14px; }
    .row { display:flex; gap:8px; align-items:center; }
    .hint { color:#666; font-size: 12px; }
    .tag { padding:2px 6px; border:1px solid #ccc; border-radius:4px; font-size:12px; }
  </style>
</head>
<body>
  <h1>Comportamiento del Bot</h1>
  <p class="hint">Fuente actual: <span class="tag">${BEHAVIOR_SOURCE}</span>. ${BEHAVIOR_SOURCE !== "mongo" ? 'Para editar aquí, seteá <code>BEHAVIOR_SOURCE=mongo</code> y reiniciá.' : ''}</p>
  <div class="row">
    <button id="btnReload">Recargar</button>
    ${BEHAVIOR_SOURCE === "mongo" ? '<button id="btnSave">Guardar</button>' : ''}
  </div>
  <p></p>
  <textarea id="txt"></textarea>
  <script>
    async function load() {
      const r = await fetch('/api/behavior');
      const j = await r.json();
      document.getElementById('txt').value = j.text || '';
    }
    ${BEHAVIOR_SOURCE === "mongo" ? `
    async function save() {
      const v = document.getElementById('txt').value || '';
      const r = await fetch('/api/behavior', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: v })
      });
      if (r.ok) alert('Guardado ✅'); else alert('Error al guardar');
    }
    document.getElementById('btnSave').addEventListener('click', save);
    ` : ``}
    document.getElementById('btnReload').addEventListener('click', load);
    load();
  </script>
</body>
</html>`);
  } catch (e) {
    console.error("⚠️ /comportamiento error:", e);
    res.status(500).send("internal");
  }
});

app.get("/api/behavior", async (_req, res) => {
  try {
    const text = (BEHAVIOR_SOURCE === "env")
      ? await loadBehaviorTextFromEnv()
      : (BEHAVIOR_SOURCE === "mongo")
        ? await loadBehaviorTextFromMongo()
        : await loadBehaviorTextFromSheet();
    res.json({ source: BEHAVIOR_SOURCE, text });
  } catch (e) {
    res.status(500).json({ error: "internal" });
  }
});
app.post("/api/behavior", async (req, res) => {
  try {
    if (BEHAVIOR_SOURCE !== "mongo") {
      return res.status(400).json({ error: "behavior_source_not_mongo" });
    }
    const text = String(req.body?.text || "").trim();
    await saveBehaviorTextToMongo(text);
    res.json({ ok: true });
  } catch (e) {
    console.error("⚠️ POST /api/behavior error:", e);
    res.status(500).json({ error: "internal" });
  }
});
/* ======================= Webhook WhatsApp ======================= */
app.post("/webhook", async (req, res) => {
  try {
    if (process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) {
      console.warn("❌ Firma inválida");
      return res.sendStatus(403);
    }
    const body = req.body;
    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(404);
    }
    res.sendStatus(200); // responder rápido

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const messages = value.messages || [];
        const contactName = value?.contacts?.[0]?.profile?.name || null;

        if (!messages.length) continue;

        for (const msg of messages) {
          const from = msg.from; // E.164 sin '+'
          const type = msg.type;
          const messageId = msg.id;

          // markAsRead
          const phoneNumberIdForRead = getPhoneNumberId(value);
          if (messageId && phoneNumberIdForRead) {
            markAsRead(messageId, phoneNumberIdForRead).catch(() => {});
          }

          // normalizar entrada
          let userText = "";
          let userMeta = {};
          try {
            if (type === "text") {
              userText = msg.text?.body || "";
            } else if (type === "interactive") {
              const it = msg.interactive;
              if (it?.type === "button_reply") userText = it.button_reply?.title || "";
              if (it?.type === "list_reply")   userText = it.list_reply?.title || "";
              if (!userText) userText = "Seleccionaste una opción. ¿En qué puedo ayudarte?";
            } else if (type === "audio") {
              const mediaId = msg.audio?.id;
              if (!mediaId) {
                userText = "Recibí un audio, pero no pude obtenerlo. ¿Podés escribir tu consulta?";
              } else {
                const info = await getMediaInfo(mediaId); // { url, mime_type }
                const buffer = await downloadMediaBuffer(info.url);
                const id = putInCache(buffer, info.mime_type);
                const baseUrl = getBaseUrl(req);
                const publicUrl = `${baseUrl}/cache/audio/${id}`;
                userMeta.mediaUrl = publicUrl;

                try {
                  const trData = await transcribeAudioExternal({ publicAudioUrl: publicUrl, buffer, mime: info.mime_type, filename: "audio.ogg" });
                  const transcript = trData.text || trData.transcript || trData.transcription || trData.result || "";
                  if (transcript) {
                    userMeta.transcript = transcript;
                    userText = `Transcripción del audio del usuario: "${transcript}"`;
                  } else {
                    userText = "No obtuve texto de la transcripción. ¿Podés escribir tu consulta?";
                  }
                } catch (e) {
                  console.error("❌ Transcribe API error:", e.message);
                  userText = "No pude transcribir tu audio. ¿Podés escribir tu consulta?";
                }
              }
            } else if (type === "image") {
              const mediaId = msg.image?.id;
              if (!mediaId) {
                userText = "Recibí una imagen pero no pude descargarla. ¿Podés describir lo que dice?";
              } else {
                const info = await getMediaInfo(mediaId);
                const buffer = await downloadMediaBuffer(info.url);
                const id = putInCache(buffer, info.mime_type);
                const baseUrl = getBaseUrl(req);
                const publicUrl = `${baseUrl}/cache/image/${id}`;
                userMeta.mediaUrl = publicUrl;

                const text = await transcribeImageWithOpenAI(publicUrl);
                if (text) {
                  userMeta.ocrText = text;
                  userText = `Texto detectado en la imagen: "${text}"`;
                } else {
                  userText = "No pude detectar texto en la imagen. ¿Podés escribir lo que dice?";
                }
              }
            } else if (type === "document") {
              userText = "Recibí un documento. Pegá el texto relevante o contame tu consulta.";
            } else {
              userText = "Hola 👋 ¿Podés escribir tu consulta en texto?";
            }
          } catch (e) {
            console.error("⚠️ Error normalizando entrada:", e);
            userText = "Hola 👋 ¿Podés escribir tu consulta en texto?";
          }

          console.log("📩 IN:", { from, type, preview: (userText || "").slice(0, 120) });
         // tokens de OpenAI
        
/*
          // tokens de OpenAI (usage) capturados más arriba en el flujo
          const _usage = (raw && raw.usage) || (out && out.usage) || null;
          const _tokens = _usage ? {
            prompt: _usage.prompt_tokens || 0,
            completion: _usage.completion_tokens || 0,
            total: _usage.total_tokens || 0
          } : null

*/
          // persistencia usuario: aseguro conv abierta y guardo nombre si viene
          const conv = await ensureOpenConversation(from, { contactName });
          await appendMessage(conv._id, {
            role: "user",
            content: userText,
            type,
            meta: userMeta
          });

          // modelo
          let responseText = "Perdón, no pude generar una respuesta. ¿Podés reformular?";
          let estado = "IN_PROGRESS";
          let raw = null;
          let out = null;
          try {
            out = await chatWithHistoryJSON(from, userText);
            responseText = out.response || responseText;
            estado = (out.estado || "IN_PROGRESS").toUpperCase();
            raw = out.raw || null;
            console.log("✅ modelo respondió, estado:", estado);
          } catch (e) {
            console.error("❌ OpenAI error:", e);
          }

          // enviar siempre con fallback a phone_number_id
          await sendSafeText(from, responseText, value);
          console.log("OUT →", from, "| estado:", estado);

          // tokens de OpenAI (usage) a partir de la salida real del modelo
          const _usage = out?.usage || null;
          const _tokens = _usage ? {
            prompt: _usage.prompt_tokens || 0,
            completion: _usage.completion_tokens || 0,
            total: _usage.total_tokens || 0
          } : null;

          // persistencia assistant
          await appendMessage(conv._id, {
            role: "assistant",
            content: responseText,
            type: "text",
            meta: { estado, tokens: _tokens }
          });
           // acumular tokens a nivel conversación
          if (conv && conv._id) {
            await bumpConversationTokenCounters(conv._id, _tokens, "assistant");
          }

          // TTS si el usuario envió audio
          if (type === "audio" && (process.env.ENABLE_TTS_FOR_AUDIO || "true").toLowerCase() === "true") {
            try {
              const { buffer, mime } = await synthesizeTTS(responseText);
              const ttsId = putInCache(buffer, mime || "audio/mpeg");
              const baseUrl = getBaseUrl(req);
              const ttsUrl = `${baseUrl}/cache/tts/${ttsId}`;
              const phoneId = getPhoneNumberId(value);
              if (phoneId) await sendAudioLink(from, ttsUrl, phoneId);
            } catch (e) {
              console.error("⚠️ Error generando/enviando TTS:", e);
            }
          }

          // cierre + Sheets + order (idempotente)
          const shouldFinalize =
            (estado && estado !== "IN_PROGRESS") ||
            ((raw?.Pedido?.["Estado pedido"] || "").toLowerCase().includes("cancel"));

          if (shouldFinalize) {
            try {
              const result = await finalizeConversationOnce(conv._id, raw, estado);
              if (result.didFinalize) {
                resetSession(from); // limpia historial en memoria
                console.log("🔁 Historial reiniciado para", from, "| estado:", estado);
              } else {
                console.log("ℹ️ Ya estaba finalizada; no se guarda en Sheets de nuevo.");
              }
            } catch (e) {
              console.error("⚠️ Error al finalizar conversación:", e);
            }
          }

          console.log("⏹ end task", from, "msg:" + (messageId || ""));
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error en webhook:", err);
  }
});

/* ======================= Admin UI ======================= */
/**
 * /admin -> HTML con tabla de conversaciones + acciones
 * /api/admin/conversations -> JSON de conversaciones
 * /api/admin/messages/:conversationId -> HTML simple con el hilo
 * /api/admin/order/:conversationId -> JSON normalizado de la orden (para modal)
 * /api/admin/order/:conversationId/process -> POST marca orden como procesada
 */

app.get("/admin", async (req, res) => {
  // HTML minimal con fetch al endpoint JSON
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Admin - Conversaciones</title>
  <style>
    body { font-family: system-ui, -apple-system, Arial, sans-serif; margin: 24px; }
    h1 { margin-top: 0; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { background: #f6f6f6; text-align: left; }
    tr:nth-child(even) { background: #fafafa; }
    .btn { padding: 6px 10px; border: 1px solid #333; background: #fff; cursor: pointer; border-radius: 4px; font-size: 12px; }
    .btn + .btn { margin-left: 6px; }
    .printmenu { display:inline-flex; gap:6px; align-items:center; }
    .muted { color: #666; }
    .tag { display:inline-block; padding:2px 6px; border-radius: 4px; font-size: 12px; }
    .tag.OPEN { background: #e7f5ff; color: #1971c2; }
    .tag.COMPLETED { background: #e6fcf5; color: #2b8a3e; }
    .tag.CANCELLED { background: #fff0f6; color: #c2255c; }
    /* modal */
    .modal-backdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); align-items:center; justify-content:center; }
    .modal { background:#fff; width: 720px; max-width: calc(100% - 32px); border-radius:8px; overflow:hidden; }
    .modal header { padding:12px 16px; background:#f6f6f6; display:flex; align-items:center; justify-content:space-between;}
    .modal header h3{ margin:0; font-size:16px;}
    .modal .content { padding:16px; max-height:70vh; overflow:auto; }
    .modal .actions { padding:12px 16px; text-align:right; border-top:1px solid #eee;}
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace; font-size: 12px; }
    .printable { background: #fff; color: #000; }
    @media print {
      .no-print { display: none; }
      .printable { padding: 0; }
    }
  </style>
</head>
<body>
  <h1>Admin - Conversaciones</h1>
  <div class="muted">Actualiza la página para refrescar.</div>
  <div class="no-print" id="filterBar" style="margin:8px 0 12px;">
  <label>Filtrar: </label>
  <select id="filterProcessed" class="btn" onchange="loadConversations()">
    <option value="">Todas</option>
    <option value="false">No procesadas</option>
    <option value="true">Procesadas</option>
  </select>
</div>
<table id="tbl">
    <thead>
      <tr>
        <th>wa_id</th>
        <th>Nombre</th>
        <th>Estado</th>
        <th>Abierta</th>
        <th>Cerrada</th>
        <th>Turnos</th>
        <th>Procesado</th>
        <th>Acciones</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal">
      <header>
        <h3>Pedido</h3>
        <button class="btn no-print" onclick="closeModal()">✕</button>
      </header>
      <div class="content" id="modalContent"></div>
      <div class="actions no-print">
        <button class="btn" onclick="window.print()">Imprimir</button>
        <button class="btn" onclick="closeModal()">Cerrar</button>
      </div>
    </div>
  </div>

  <script>
    async function loadConversations() {
      
      const sel = document.getElementById('filterProcessed');
      const p = sel ? sel.value : '';
      const url = p ? ('/api/admin/conversations?processed=' + p) : '/api/admin/conversations';
      const r = await fetch(url);

      const data = await r.json();
      const tb = document.querySelector("#tbl tbody");
      tb.innerHTML = "";
      for (const row of data) {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${row.waId}</td>
          <td>\${row.contactName || ""}</td>
          <td><span class="tag \${row.status}">\${row.status}</span></td>
          <td>\${row.openedAt ? new Date(row.openedAt).toLocaleString() : ""}</td>
          <td>\${row.closedAt ? new Date(row.closedAt).toLocaleString() : ""}</td>
          <td>\${row.turns ?? 0}</td>
          <td>\${row.processed ? '✅' : '—'}</td>
          <td>
            <button class="btn" onclick="openMessages('\${row._id}')">Mensajes</button>
            <button class="btn" onclick="openOrder('\${row._id}')">Pedido</button>
            <button class="btn" onclick="markProcessed('\${row._id}')">Procesado</button>
            <div class="printmenu">
              <select id="pm-\${row._id}" class="btn">
                <option value="kitchen">Cocina</option>
                <option value="client">Cliente</option>
              </select>
              <button class="btn" onclick="printTicketOpt('\${row._id}')">Imprimir</button>
            </div>
          </td>
        \`;
        tb.appendChild(tr);
      }
    }

    function openMessages(id) {
      window.open('/api/admin/messages/' + id, '_blank');
    }

    async function openOrder(id) {
      const r = await fetch('/api/admin/order/' + id);
      const data = await r.json();
      const root = document.getElementById('modalContent');
      root.innerHTML = renderOrder(data);
      openModal();
    }

    async function markProcessed(id) {
      const r = await fetch('/api/admin/order/' + id + '/process', { method: 'POST' });
      if (r.ok) {
        alert('Pedido marcado como procesado.');
      } else {
        alert('No se pudo marcar como procesado.');
      }
    }

    function renderOrder(o) {
      if (!o || !o.order) return '<div class="mono">No hay pedido para esta conversación.</div>';
      const ord = o.order;
      const itemsHtml = (ord.items || []).map(it => \`<li>\${it.name}: <strong>\${it.selection}</strong></li>\`).join('') || '<li>(sin ítems)</li>';
      const rawHtml = o.rawPedido ? '<pre class="mono">' + JSON.stringify(o.rawPedido, null, 2) + '</pre>' : '';
      return \`
        <div class="printable">
          <h2>Pedido</h2>
          <p><strong>Cliente:</strong> \${ord.name || ''} <span class="muted">(\${o.waId})</span></p>
          <p><strong>Entrega:</strong> \${ord.entrega || ''}</p>
          <p><strong>Domicilio:</strong> \${ord.domicilio || ''}</p>
          <p><strong>Monto:</strong> \${(ord.amount!=null)?('$'+ord.amount):''}</p>
          <p><strong>Estado pedido:</strong> \${ord.estadoPedido || ''}</p>
          <p><strong>Fecha/Hora entrega:</strong> \${ord.fechaEntrega || ''} \${ord.hora || ''}</p>
          <h3>Ítems</h3>
          <ul>\${itemsHtml}</ul>
          <h3>Detalle crudo del Pedido</h3>
          \${rawHtml}
        </div>
      \`;
    }

    function openModal() {
      document.getElementById('modalBackdrop').style.display = 'flex';
    }
    function closeModal() {
      document.getElementById('modalBackdrop').style.display = 'none';
    }

    function printTicketOpt(id) {
      const sel = document.getElementById('pm-' + id);
      const v = sel ? sel.value : 'kitchen';
      window.open('/admin/print/' + id + '?v=' + encodeURIComponent(v), '_blank');
    }

    loadConversations();
  </script>
</body>
</html>
  `);
});

// JSON de conversaciones para Admin
app.get("/api/admin/conversations", async (req, res) => {
  try {
    const db = await getDb();
    const q = {};
    const { processed, phone, status, date_field, from, to } = req.query;

    if (typeof processed === "string") {
      if (processed === "true") q.processed = true;
      else if (processed === "false") q.processed = { $ne: true };
    }

    if (phone && String(phone).trim()) {
      const esc = escapeRegExp(String(phone).trim());
      q.waId = { $regex: esc, $options: "i" };
    }

    if (status && String(status).trim()) {
      q.status = String(status).trim().toUpperCase();
    }

    const field = (date_field === "closed") ? "closedAt" : "openedAt";
    const range = {};
    if (from) {
      const d1 = new Date(`${from}T00:00:00.000Z`);
      if (!isNaN(d1)) range.$gte = d1;
    }
    if (to) {
      const d2 = new Date(`${to}T23:59:59.999Z`);
      if (!isNaN(d2)) range.$lte = d2;
    }
    if (Object.keys(range).length) q[field] = range;

    const convs = await db.collection("conversations")
      .find(q, { sort: { openedAt: -1 } })
      .project({ waId:1, status:1, openedAt:1, closedAt:1, turns:1, contactName:1, processed:1 })
      .limit(500)
      .toArray();

    const out = convs.map(c => ({
      _id: c._id && c._id.toString ? c._id.toString() : String(c._id),
      waId: c.waId,
      contactName: c.contactName || "",
      status: c.status || "OPEN",
      openedAt: c.openedAt,
      closedAt: c.closedAt,
      turns: typeof c.turns === "number" ? c.turns : 0,
      processed: !!c.processed
    }));
    res.json(out);
  } catch (e) {
    console.error("⚠️ /api/admin/conversations error:", e);
    res.status(200).json([]);
  }
});

// HTML con mensajes
app.get("/api/admin/messages/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const db = await getDb();
    const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
    if (!conv) return res.status(404).send("Conversation not found");

    const msgs = await db.collection("messages")
      .find({ conversationId: new ObjectId(id) })
      .sort({ ts: 1 })
      .toArray();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Mensajes - ${conv.waId}</title>
  <style>
    body { font-family: system-ui, -apple-system, Arial, sans-serif; margin: 24px; }
    .msg { margin-bottom: 12px; }
    .role { font-weight: bold; }
    .meta { color: #666; font-size: 12px; }
    pre { background:#f6f6f6; padding:8px; border-radius:4px; overflow:auto; }
  </style>
</head>
<body>
  <h2>Mensajes - ${conv.contactName ? (conv.contactName + " • ") : ""}${conv.waId}</h2>
  <div>
    ${msgs.map(m => `
      <div class="msg">
        <div class="role">${m.role.toUpperCase()} <span class="meta">(${new Date(m.ts).toLocaleString()})</span></div>
        <pre>${(m.content || "").replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>
        ${m.meta && Object.keys(m.meta).length ? `<div class="meta">meta: <code>${JSON.stringify(m.meta)}</code></div>` : ""}
      </div>
    `).join("")}
  </div>
</body>
</html>
    `);
  } catch (e) {
    console.error("⚠️ /api/admin/messages error:", e);
    res.status(500).send("internal");
  }
});

// JSON del pedido normalizado
app.get("/api/admin/order/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const db = await getDb();
    const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
    if (!conv) return res.status(404).json({ error: "not_found" });

    // Buscar order por conversationId si existe
    let order = await db.collection("orders").findOne({ conversationId: new ObjectId(id) });
    if (!order && conv.summary?.Pedido) {
      // normalizar on the fly si no se grabó orders (backfill)
      order = normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
    }

    res.json({
      waId: conv.waId,
      order: order ? {
        name: order.name || conv.contactName || "",
        entrega: order.entrega || "",
        domicilio: order.domicilio || "",
        items: order.items || [],
        amount: order.amount ?? null,
        estadoPedido: order.estadoPedido || "",
        fechaEntrega: order.fechaEntrega || "",
        hora: order.hora || "",
        processed: !!order.processed
      } : null,
      rawPedido: conv.summary?.Pedido || null
    });
  } catch (e) {
    console.error("⚠️ /api/admin/order error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// marcar pedido como procesado
app.post("/api/admin/order/:id/process", async (req, res) => {
  try {
    const id = req.params.id;
    const db = await getDb();
    const convId = new ObjectId(id);

    const upd = await db.collection("orders").updateOne(
      { conversationId: convId },
      { $set: { processed: true, processedAt: new Date() } }
    );
    if (!upd.matchedCount) {
      // si no hay order, intentamos construirla desde summary y crearla procesada
      const conv = await db.collection("conversations").findOne({ _id: convId });
      if (!conv || !conv.summary?.Pedido) return res.status(404).json({ error: "order_not_found" });
      const orderDoc = normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
      orderDoc.conversationId = convId;
      orderDoc.processed = true;
      orderDoc.processedAt = new Date();
      await db.collection("orders").insertOne(orderDoc);
    }
    await db.collection("conversations").updateOne({ _id: convId }, { $set: { processed: true } });
    res.json({ ok: true });
  } catch (e) {
    console.error("⚠️ /api/admin/order/:id/process error:", e);
    res.status(500).json({ error: "internal" });
  }
});


// Impresión ticket térmico 80mm / 58mm
app.get("/admin/print/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const v = String(req.query.v || "kitchen").toLowerCase(); // kitchen | client
    const db = await getDb();
    const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
    if (!conv) return res.status(404).send("Conversación no encontrada");
    let order = await db.collection("orders").findOne({ conversationId: new ObjectId(id) });
    if (!order && conv.summary?.Pedido) {
      order = normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
    }
    const negocio = process.env.BUSINESS_NAME || "NEGOCIO";
    const direccionNegocio = process.env.BUSINESS_ADDRESS || "";
    const telNegocio = process.env.BUSINESS_PHONE || "";

    const cliente = (order?.name || conv.contactName || "") + " (" + (conv.waId || "") + ")";
    const domicilio = order?.domicilio || "";
    const pago = order?.pago || order?.payment || "";
    const monto = (order?.amount != null) ? Number(order.amount) : null;

    const items = Array.isArray(order?.items) ? order.items : [];
    function esc(s){ return String(s==null? "": s); }

    const itemLines = items.map(it => {
      const name = esc(it.name || it.nombre || it.producto || it.title || "Item");
      const sel = esc(it.selection || it.seleccion || it.detalle || it.toppings || "");
      return sel ? (name + " - " + sel) : name;
    }).join("\n");

    const showPrices = (v === "client");
    const totalHtml = showPrices && (monto != null) ? `<div class="row big"><span>TOTAL</span><span>$${monto.toFixed(2)}</span></div>` : "";

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Ticket</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  body { margin: 0; }
  .ticket { width: 80mm; padding: 6px 8px; font-family: monospace; font-size: 12px; }
  .center { text-align: center; }
  .row { display: flex; justify-content: space-between; }
  .hr { border-top: 1px dashed #000; margin: 6px 0; }
  .big { font-size: 14px; font-weight: bold; }
  @media print { .noprint { display: none; } }
</style>
</head>
<body>
  <div class="ticket">
    <div class="center big">${esc(negocio)}</div>
    ${direccionNegocio ? `<div class="center">${esc(direccionNegocio)}</div>` : ""}
    ${telNegocio ? `<div class="center">${esc(telNegocio)}</div>` : ""}
    <div class="hr"></div>
    <div>Cliente: ${esc(cliente)}</div>
    ${domicilio ? `<div>Dirección: ${esc(domicilio)}</div>` : ""}
    ${showPrices && pago ? `<div>Pago: ${esc(pago)}</div>` : ""}
    <div class="hr"></div>
    <div>Pedido:</div>
    <pre>${esc(itemLines)}</pre>
    <div class="hr"></div>
    ${totalHtml}
    <div class="hr"></div>
    <div>${new Date().toLocaleString()}</div>
    <div class="center">${showPrices ? "¡Gracias por su compra!" : "TICKET COCINA"}</div>
    <div class="hr"></div>
    <button class="noprint" onclick="window.print()">Imprimir</button>
  </div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  } catch (e) {
    console.error("⚠️ /admin/print error:", e);
    res.status(500).send("internal");
  }
});


/* ======================= Seguridad global de errores ======================= */
process.on("unhandledRejection", (reason) => {
  console.error("🧨 UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🧨 UncaughtException:", err);
});

/* ======================= Start ======================= */


// GET lista (activos por defecto, ?all=true para todos)
app.get("/api/products", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const q = req.query.all === "true" ? {} : { active: { $ne: false } };
    const items = await database.collection("products")
      .find(q).sort({ createdAt: -1, descripcion: 1 }).toArray();

    res.json(items.map(it => ({ ...it, _id: String(it._id) })));
  } catch (e) {
    console.error("GET /api/products error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// POST crear
app.post("/api/products", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    let { descripcion, importe, observacion, active } = req.body || {};
    descripcion = String(descripcion || "").trim();
    observacion = String(observacion || "").trim();
    if (typeof active !== "boolean") active = !!active;

    let imp = null;
    if (typeof importe === "number") imp = importe;
    else if (typeof importe === "string") {
      const n = Number(importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      imp = Number.isFinite(n) ? n : null;
    }
    if (!descripcion) return res.status(400).json({ error: "descripcion requerida" });

    const now = new Date();
    const doc = { descripcion, observacion, active, createdAt: now, updatedAt: now };
    if (imp !== null) doc.importe = imp;

    const ins = await database.collection("products").insertOne(doc);
     invalidateBehaviorCache();
    res.json({ ok: true, _id: String(ins.insertedId) });
  } catch (e) {
    console.error("POST /api/products error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// PUT actualizar
app.put("/api/products/:id", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const { id } = req.params;
    const upd = {};
    ["descripcion","observacion","active","importe"].forEach(k => {
      if (req.body[k] !== undefined) upd[k] = req.body[k];
    });
    if (upd.importe !== undefined) {
      const v = upd.importe;
      if (typeof v === "string") {
        const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", "."));
        upd.importe = Number.isFinite(n) ? n : undefined;
      }
    }
    if (Object.keys(upd).length === 0) return res.status(400).json({ error: "no_fields" });
    upd.updatedAt = new Date();

    const result = await database.collection("products").updateOne(
      { _id: new ObjectId(String(id)) },
      { $set: upd }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    
    invalidateBehaviorCache();
    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /api/products/:id error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// DELETE borrar
app.delete("/api/products/:id", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const { id } = req.params;
    const result = await database.collection("products").deleteOne({ _id: new ObjectId(String(id)) });
    if (!result.deletedCount) return res.status(404).json({ error: "not_found" });
    rinvalidateBehaviorCache();
   res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/products/:id error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// Inactivar
app.post("/api/products/:id/inactivate", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const { id } = req.params;
    const result = await database.collection("products").updateOne(
      { _id: new ObjectId(String(id)) },
      { $set: { active: false, updatedAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    invalidateBehaviorCache();
   res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/products/:id/inactivate error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// Reactivar
app.post("/api/products/:id/reactivate", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const { id } = req.params;
    const result = await database.collection("products").updateOne(
      { _id: new ObjectId(String(id)) },
      { $set: { active: true, updatedAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    invalidateBehaviorCache();
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/products/:id/reactivate error:", e);
    res.status(500).json({ error: "internal" });
  }
});
// === Vista /productos (UI CRUD) ===
// 🔧 REEMPLAZA SOLO ESTA RUTA /productos
// /productos con CRUD (SSR para ver datos + UI con fetch)
app.get("/productos", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    if (!database) throw new Error("DB no inicializada");

    const verTodos = req.query.all === "true";
    const filtro = verTodos ? {} : { active: { $ne: false } };

    const productos = await database
      .collection("products")
      .find(filtro)
      .sort({ createdAt: -1 })
      .toArray();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Productos</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:1100px}
    table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
    th{background:#f5f5f5;text-align:left}
    input[type="text"],input[type="number"],textarea{width:100%;box-sizing:border-box}
    textarea{min-height:56px}
    .row{display:flex;gap:8px;align-items:center}
    .muted{color:#666;font-size:12px}.pill{border:1px solid #ccc;border-radius:999px;padding:2px 8px;font-size:12px}
    .btn{padding:6px 10px;border:1px solid #333;background:#fff;border-radius:4px;cursor:pointer}
    .btn + .btn{margin-left:6px}
  </style>
</head>
<body>
  <h1>Productos</h1>
  <p class="muted">Fuente: <span class="pill">MongoDB (colección <code>products</code>)</span></p>

  <div class="row">
    <a class="btn" href="/productos${verTodos ? "" : "?all=true"}">${verTodos ? "Ver solo activos" : "Ver todos"}</a>
    <button id="btnAdd" class="btn">Agregar</button>
    <button id="btnReload" class="btn">Recargar</button>
  </div>
  <p></p>

  <table id="tbl">
    <thead>
      <tr>
        <th>Descripción</th><th>Importe</th><th>Observación</th><th>Activo</th><th>Acciones</th>
      </tr>
    </thead>
    <tbody>
      ${
        productos.length ? productos.map(p => `
          <tr data-id="${p._id}">
            <td><input type="text" class="descripcion" value="${(p.descripcion ?? "").toString().replace(/"/g,'&quot;')}" /></td>
            <td><input type="number" class="importe" step="0.01" value="${typeof p.importe==='number'?p.importe:(p.importe??'')}" /></td>
            <td><textarea class="observacion">${(p.observacion ?? "").toString().replace(/</g,'&lt;')}</textarea></td>
            <td style="text-align:center;"><input type="checkbox" class="active" ${p.active!==false?"checked":""} /></td>
            <td>
              <button class="btn save">Guardar</button>
              <button class="btn del">Eliminar</button>
              <button class="btn toggle">${p.active!==false?"Inactivar":"Reactivar"}</button>
            </td>
          </tr>
        `).join("") : `<tr><td colspan="5" style="text-align:center;color:#666">Sin productos para mostrar</td></tr>`
      }
    </tbody>
  </table>

  <template id="row-tpl">
    <tr>
      <td><input type="text" class="descripcion" placeholder="Ej: Pollo entero" /></td>
      <td><input type="number" class="importe" step="0.01" placeholder="0.00" /></td>
      <td><textarea class="observacion" placeholder="Observaciones / reglas"></textarea></td>
      <td style="text-align:center;"><input type="checkbox" class="active" checked /></td>
      <td>
        <button class="btn save">Guardar</button>
        <button class="btn del">Eliminar</button>
        <button class="btn toggle">Inactivar</button>
      </td>
    </tr>
  </template>

  <script>
    function q(sel, ctx){ return (ctx||document).querySelector(sel) }
    function all(sel, ctx){ return Array.from((ctx||document).querySelectorAll(sel)) }

    async function j(url, opts){
      const r = await fetch(url, opts||{});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const ct = r.headers.get('content-type')||'';
      return ct.includes('application/json') ? r.json() : r.text();
    }

    async function reload(){
      const url = new URL(location.href);
      const allFlag = url.searchParams.get('all') === 'true';
      const data = await j('/api/products' + (allFlag ? '?all=true' : ''));
      const tb = q('#tbl tbody');
      tb.innerHTML = '';
      for (const it of data){
        const tr = q('#row-tpl').content.firstElementChild.cloneNode(true);
        tr.dataset.id = it._id || '';
        q('.descripcion', tr).value = it.descripcion || '';
        q('.importe', tr).value = typeof it.importe==='number' ? it.importe : (it.importe||'');
        q('.observacion', tr).value = it.observacion || '';
        q('.active', tr).checked = it.active !== false;
        q('.toggle', tr).textContent = (it.active !== false) ? 'Inactivar' : 'Reactivar';

        bindRow(tr);
        tb.appendChild(tr);
      }
      if (!data.length){
        const r = document.createElement('tr');
        r.innerHTML = '<td colspan="5" style="text-align:center;color:#666">Sin productos para mostrar</td>';
        tb.appendChild(r);
      }
    }

    async function saveRow(tr){
      const id = tr.dataset.id;
      const payload = {
        descripcion: q('.descripcion', tr).value.trim(),
        importe: q('.importe', tr).value.trim(),
        observacion: q('.observacion', tr).value.trim(),
        active: q('.active', tr).checked
      };
      if (!payload.descripcion){ alert('Descripción requerida'); return; }
      if (id){
        await j('/api/products/'+encodeURIComponent(id), {
          method:'PUT',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
      } else {
        await j('/api/products', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
      }
      await reload();
    }

    async function deleteRow(tr){
      const id = tr.dataset.id;
      if (!id) { tr.remove(); return; }
      if (!confirm('¿Eliminar definitivamente?')) return;
      await j('/api/products/'+encodeURIComponent(id), { method:'DELETE' });
      await reload();
    }

    async function toggleRow(tr){
      const id = tr.dataset.id;
      if (!id) { alert('Primero guardá el nuevo producto.'); return; }
      const active = q('.active', tr).checked;
      const path = active ? '/api/products/'+encodeURIComponent(id)+'/inactivate'
                          : '/api/products/'+encodeURIComponent(id)+'/reactivate';
      await j(path, { method:'POST' });
      await reload();
    }

    function bindRow(tr){
      q('.save', tr).addEventListener('click', ()=> saveRow(tr));
      q('.del', tr).addEventListener('click', ()=> deleteRow(tr));
      q('.toggle', tr).addEventListener('click', ()=> toggleRow(tr));
    }

    // Bind inicial a filas SSR
    all('#tbl tbody tr').forEach(bindRow);

    // Botones generales
    q('#btnAdd').addEventListener('click', ()=>{
      const tb = q('#tbl tbody');
      const tr = q('#row-tpl').content.firstElementChild.cloneNode(true);
      bindRow(tr);
      tb.prepend(tr);
      q('.descripcion', tr).focus();
    });
    q('#btnReload').addEventListener('click', reload);
  </script>
</body>
</html>`);
  } catch (err) {
    console.error("❌ /productos error:", err);
    res.status(500).send("Error al obtener productos");
  }
});





app.get("/productos.json", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;
    const data = await database.collection("products").find({}).limit(50).toArray();
    res.json(data);
  } catch (e) {
    console.error(e); res.status(500).json({ error: String(e) });
  }
});


/* ======================= Seguridad global de errores ======================= */
process.on("unhandledRejection", (reason) => {
  console.error("🧨 UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🧨 UncaughtException:", err);
});

/* ======================= Start ======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));
