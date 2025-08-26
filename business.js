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

/* ======================= Google Sheets ======================= */
function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Faltan credenciales de Google (email/clave).");
  const auth = new google.auth.JWT(email, null, key, ["https://www.googleapis.com/auth/spreadsheets"]);
  return google.sheets({ version: "v4", auth });
}
function getSpreadsheetIdFromEnv() {
  const raw = (process.env.GOOGLE_SHEETS_ID || "").trim();
  if (!raw) throw new Error("Falta GOOGLE_SHEETS_ID.");
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw;
}
async function ensureHeaderIfEmpty({ sheetName, header }) {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const getResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!1:1` });
  const hasHeader = (getResp.data.values && getResp.data.values.length > 0);
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${sheetName}!A1`, valueInputOption: "RAW",
      requestBody: { values: [header] }
    });
  }
}
async function appendRow({ sheetName, values }) {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: `${sheetName}!A:A`,
    valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] }
  });
}

function headerPedido() {
  return [
    "wa_id","response","Fecha y hora de inicio de conversacion","Fecha y hora fin de conversacion",
    "Estado pedido","Motivo cancelacion","Pedido pollo","Pedido papas","Milanesas comunes","Milanesas Napolitanas",
    "Ensaladas","Bebidas","Monto","Nombre","Entrega","Domicilio","Fecha y hora de entrega","Hora"
  ];
}
function flattenPedido({ waId, response, pedido }) {
  const p = pedido || {};
  return [
    waId || "", response || "",
    p["Fecha y hora de inicio de conversacion"] || "",
    p["Fecha y hora fin de conversacion"] || "",
    p["Estado pedido"] || "", p["Motivo cancelacion"] || "",
    p["Pedido pollo"] || "", p["Pedido papas"] || "",
    p["Milanesas comunes"] || "", p["Milanesas Napolitanas"] || "",
    p["Ensaladas"] || "", p["Bebidas"] || "", p["Monto"] ?? "",
    p["Nombre"] || "", p["Entrega"] || "", p["Domicilio"] || "",
    p["Fecha y hora de entrega"] || "", p["Hora"] || ""
  ];
}
function headerBigdata() {
  return [
    "wa_id","Sexo","Estudios","Satisfaccion del cliente","Motivo puntaje satisfaccion",
    "Cuanto nos conoce el cliente","Motivo puntaje conocimiento","Motivo puntaje general",
    "Perdida oportunidad","Sugerencias","Flujo","Facilidad en el proceso de compras","Pregunto por bot"
  ];
}
function flattenBigdata({ waId, bigdata }) {
  const b = bigdata || {};
  return [
    waId || "", b["Sexo"] || "", b["Estudios"] || "",
    b["Satisfaccion del cliente"] ?? "", b["Motivo puntaje satisfaccion"] || "",
    b["Cuanto nos conoce el cliente"] ?? "", b["Motivo puntaje conocimiento"] || "",
    b["Motivo puntaje general"] || "", b["Perdida oportunidad"] || "",
    b["Sugerencias"] || "", b["Flujo"] || "",
    b["Facilidad en el proceso de compras"] ?? "", b["Pregunto por bot"] || ""
  ];
}
async function saveCompletedToSheets({ waId, data }) {
  const response = data?.response || "";
  const pedido = data?.Pedido || {};
  const bigdata = data?.Bigdata || {};

  const hPedido = headerPedido();
  const vPedido = flattenPedido({ waId, response, pedido });
  await ensureHeaderIfEmpty({ sheetName: "Hoja 1", header: hPedido });
  await appendRow({ sheetName: "Hoja 1", values: vPedido });

  const hBig = headerBigdata();
  const vBig = flattenBigdata({ waId, bigdata });
  await ensureHeaderIfEmpty({ sheetName: "BigData", header: hBig });
  await appendRow({ sheetName: "BigData", values: vBig });
}

/* ======================= Productos (Sheet) ======================= */
// Productos!A nombre, B precio, C venta, D obs, E activo (S/N)
const PRODUCTS_CACHE_TTL_MS = parseInt(process.env.PRODUCTS_CACHE_TTL_MS || "300000", 10);
let productsCache = { at: 0, items: [] };

function looksActive(v) { return String(v || "").trim().toUpperCase() === "S"; }

async function loadProductsFromSheet() {
  const now = Date.now();
  if (now - productsCache.at < PRODUCTS_CACHE_TTL_MS && productsCache.items?.length) {
    return productsCache.items;
  }
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const range = "Productos!A2:E";
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = resp.data.values || [];

  const items = rows.map((r) => {
    const nombre = (r[0] || "").trim();
    const precioRaw = (r[1] || "").trim();
    const venta = (r[2] || "").trim();
    const obs = (r[3] || "").trim();
    const activo = r[4];
    if (!nombre) return null;
    if (!looksActive(activo)) return null;

    const maybeNum = Number(precioRaw.replace(/[^\d.,-]/g, "").replace(",", "."));
    const precio = Number.isFinite(maybeNum) ? maybeNum : precioRaw;
    return { nombre, precio, venta, obs };
  }).filter(Boolean);

  productsCache = { at: now, items };
  return items;
}
function buildCatalogText(items) {
  if (!items?.length) return "Catálogo de productos: (ninguno activo)";
  const lines = items.map(it => {
    const precioTxt = (typeof it.precio === "number") ? ` — $${it.precio}` : (it.precio ? ` — $${it.precio}` : "");
    const ventaTxt  = it.venta ? ` (${it.venta})` : "";
    const obsTxt    = it.obs ? ` | Obs: ${it.obs}` : "";
    return `- ${it.nombre}${precioTxt}${ventaTxt}${obsTxt}`;
  });
  return "Catálogo de productos (nombre — precio (modo de venta) | Obs: observaciones):\n" + lines.join("\n");
}

/* ======================= Comportamiento (ENV o Sheet) ======================= */
const BEHAVIOR_SOURCE = (process.env.BEHAVIOR_SOURCE || "sheet").toLowerCase(); // "env" | "sheet"
const COMPORTAMIENTO_CACHE_TTL_MS = 5 * 60 * 1000;
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

async function buildSystemPrompt({ force = false } = {}) {
  const now = Date.now();
  if (!force && (now - behaviorCache.at < COMPORTAMIENTO_CACHE_TTL_MS) && behaviorCache.text) {
    return behaviorCache.text;
  }

  // 1) Comportamiento desde ENV o desde Sheet
  const baseText = (BEHAVIOR_SOURCE === "env")
    ? await loadBehaviorTextFromEnv()
    : await loadBehaviorTextFromSheet();

  // 2) Catálogo SIEMPRE desde Sheet
  let catalogText = "";
  try {
    const products = await loadProductsFromSheet();
    catalogText = buildCatalogText(products);
  } catch (e) {
    console.warn("⚠️ No se pudo leer Productos:", e.message);
    catalogText = "Catálogo de productos: (error al leer)";
  }

  // 3) Reglas de uso de observaciones
  const reglasVenta =
    "Instrucciones de venta (OBLIGATORIAS):\n" +
    "- Usá las Observaciones para decidir qué ofrecer, sugerir complementos, aplicar restricciones o proponer sustituciones.\n" +
    "- Respetá limitaciones (stock/horarios/porciones/preparación) indicadas en Observaciones.\n" +
    "- Si sugerís bundles o combos, ofrecé esas opciones con precio estimado cuando corresponda.\n" +
    "- Si falta un dato (sabor/tamaño/cantidad), pedilo brevemente.\n";

  // 4) Esquema JSON
  const jsonSchema =
    "FORMATO DE RESPUESTA (OBLIGATORIO - SOLO JSON, sin ```):\n" +
    '{ "response": "texto para WhatsApp", "estado": "IN_PROGRESS|COMPLETED|CANCELLED", ' +
    '  "Pedido"?: { "Fecha y hora de inicio de conversacion": string, "Fecha y hora fin de conversacion": string, "Estado pedido": string, "Motivo cancelacion": string, "Pedido pollo": string, "Pedido papas": string, "Milanesas comunes": string, "Milanesas Napolitanas": string, "Ensaladas": string, "Bebidas": string, "Monto": number, "Nombre": string, "Entrega": string, "Domicilio": string, "Fecha y hora de entrega": string, "Hora": string }, ' +
    '  "Bigdata"?: { "Sexo": string, "Estudios": string, "Satisfaccion del cliente": number, "Motivo puntaje satisfaccion": string, "Cuanto nos conoce el cliente": number, "Motivo puntaje conocimiento": string, "Motivo puntaje general": string, "Perdida oportunidad": string, "Sugerencias": string, "Flujo": string, "Facilidad en el proceso de compras": number, "Pregunto por bot": string } }';

  const fullText = [
    "[COMPORTAMIENTO]\n" + baseText,
    "[REGLAS]\n" + reglasVenta,
    "[CATALOGO]\n" + catalogText,
    "[SALIDA]\n" + jsonSchema,
    "RECORDATORIOS: Respondé en español. No uses bloques de código. Devolvé SOLO JSON plano."
  ].join("\n\n").trim();

  behaviorCache = { at: now, text: fullText };
  return fullText;
}

/* ======================= Mongo: conversaciones, mensajes, orders ======================= */
async function ensureOpenConversation(waId, { contactName = null } = {}) {
  const db = await getDb();
  let conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
  if (!conv) {
    const doc = {
      waId,
      status: "OPEN",         // OPEN | COMPLETED | CANCELLED
      finalized: false,       // idempotencia para Sheets/orden
      contactName: contactName || null,
      openedAt: new Date(),
      closedAt: null,
      lastUserTs: null,
      lastAssistantTs: null,
      turns: 0
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
    const systemText = await buildSystemPrompt({ force: true }); // al iniciar conversación
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
    const systemText = await buildSystemPrompt({ force: true });
    session.messages[0] = { role: "system", content: systemText };
  } catch (e) {
    console.warn("⚠️ No se pudo refrescar system:", e.message);
  }

  pushMessage(session, "user", userText);

  let content = "";
  try {
    const completion = await openaiChatWithRetries([ ...session.messages ], { model, temperature });
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
  return { response: responseText, estado, raw: data || {} };
}

/* ======================= Rutas básicas ======================= */




/* ======================= Webhook WhatsApp ======================= */


/* ======================= Admin UI ======================= */
/**
 * /admin -> HTML con tabla de conversaciones + acciones
 * /api/admin/conversations -> JSON de conversaciones
 * /api/admin/messages/:conversationId -> HTML simple con el hilo
 * /api/admin/order/:conversationId -> JSON normalizado de la orden (para modal)
 * /api/admin/order/:conversationId/process -> POST marca orden como procesada
 */



// JSON de conversaciones para Admin


// HTML con mensajes


// JSON del pedido normalizado


// marcar pedido como procesado



// Impresión ticket térmico 80mm / 58mm

/* ======================= Seguridad global de errores ======================= */
process.on("unhandledRejection", (reason) => {
  console.error("🧨 UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🧨 UncaughtException:", err);
});

/* ======================= Start ======================= */

module.exports = {
  appendMessage,
  chatWithHistoryJSON,
  closeModal,
  downloadMediaBuffer,
  ensureOpenConversation,
  esc,
  escapeRegExp,
  finalizeConversationOnce,
  getBaseUrl,
  getFromCache,
  getMediaInfo,
  getPhoneNumberId,
  isValidSignature,
  loadConversations,
  markAsRead,
  markProcessed,
  normalizeOrder,
  openMessages,
  openModal,
  openOrder,
  printTicketOpt,
  putInCache,
  renderOrder,
  resetSession,
  sendAudioLink,
  sendSafeText,
  synthesizeTTS,
  transcribeAudioExternal,
  transcribeImageWithOpenAI
};
