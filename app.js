// server.js (órdenes + panel + gráficos + filtros por producto + CSV)
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai");
const { google } = require("googleapis");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();

/* ===================== Body / firma ===================== */
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
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
  catch { return false; }
}

/* ===================== OpenAI ===================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHAT_TEMPERATURE = Number.isFinite(parseFloat(process.env.OPENAI_TEMPERATURE))
  ? parseFloat(process.env.OPENAI_TEMPERATURE) : 0.2;

/* ===================== Utils ===================== */
function fmt(d) {
  if (!d) return "";
  return new Date(d).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}
function fmtMoney(v) {
  if (v === undefined || v === null) return "";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(Number(v) || 0);
}
function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/* ===================== JSON robusto ===================== */
function coerceJsonString(raw) {
  if (raw == null) return null;
  let s = String(raw);
  s = s.replace(/^\uFEFF/, "")
       .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, " ")
       .trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(\w+)?/i, "").replace(/```$/i, "").trim();
  }
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  if (s.startsWith("{") && s.endsWith("}")) return s;
  const first = s.indexOf("{");
  const last  = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return s.slice(first, last + 1).trim();
  return s;
}
async function safeJsonParseStrictOrFix(raw) {
  let s = coerceJsonString(raw);
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) {}
  try {
    const fix = await openai.chat.completions.create({
      model: CHAT_MODEL,
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
    try { return JSON.parse(s); }
    catch (e3) {
      const preview = (String(raw || "")).slice(0, 400);
      console.error("❌ No se pudo parsear JSON luego de fix:", e3.message, "\nRaw preview:", preview);
      return null;
    }
  }
}

/* ===================== WhatsApp / Media ===================== */
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "https://transcribegpt-569454200011.northamerica-northeast1.run.app").trim().replace(/\/+$/,"");
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10); // 5 min

const fileCache = new Map();
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
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of fileCache.entries()) if (now > item.expiresAt) fileCache.delete(id);
}, 60 * 1000);

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

// Visión (OCR simple)
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

// Transcriptor externo
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime, filename = "audio.ogg" }) {
  const base = TRANSCRIBE_API_URL;
  const paths = ["", "/transcribe", "/api/transcribe", "/v1/transcribe"];
  for (const p of paths) {
    const url = `${base}${p}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_url: publicAudioUrl })
    });
    if (r.ok) return r.json().catch(() => ({}));
  }
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
      if (r.ok) return r.json().catch(() => ({}));
    }
  }
  for (const p of paths) {
    const url = `${base}${p}?audio_url=${encodeURIComponent(publicAudioUrl)}`;
    const g = await fetch(url);
    if (g.ok) return g.json().catch(() => ({}));
  }
  throw new Error("No hubo variantes válidas para el endpoint de transcripción.");
}

/* ===================== TTS ===================== */
async function synthesizeTTS(text) {
  const model = process.env.TTS_MODEL || "gpt-4o-mini-tts";
  const voice = process.env.TTS_VOICE || "alloy";
  const format = (process.env.TTS_FORMAT || "mp3").toLowerCase();
  const resp = await openai.audio.speech.create({ model, voice, input: text, format });
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mime = format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg";
  return { buffer, mime };
}
async function sendAudioLink(to, publicUrl, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "audio", audio: { link: publicUrl } };
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

/* ===================== Google Sheets helpers ===================== */
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

/* ===================== Productos + Comportamiento ===================== */
function looksActive(v) { return String(v || "").trim().toUpperCase() === "S"; }
async function loadProductsFromSheetFull() {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Productos!A2:E" });
  const rows = resp.data.values || [];
  return rows
    .map(r => {
      const activo = looksActive(r[4]);
      if (!activo) return null;
      const nombre = (r[0] || "").trim();
      if (!nombre) return null;
      const precioRaw = (r[1] || "").trim();
      const venta = (r[2] || "").trim();
      const obs = (r[3] || "").trim();
      const maybeNum = Number(precioRaw.replace(/[^\d.,-]/g, "").replace(",", "."));
      const precio = Number.isFinite(maybeNum) ? maybeNum : precioRaw;
      return { nombre, precio, venta, obs };
    })
    .filter(Boolean);
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

const BEHAVIOR_SOURCE = (process.env.BEHAVIOR_SOURCE || "sheet").toLowerCase(); // env | sheet
const COMPORTAMIENTO_CACHE_TTL_MS = 5 * 60 * 1000;
let behaviorCache = { at: 0, text: null };

async function loadBehaviorTextFromEnv() {
  return (process.env.COMPORTAMIENTO || "Sos un asistente claro, amable y conciso. Respondé en español.").trim();
}
async function loadBehaviorTextFromSheet() {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: "Comportamiento_API!A1:B100"
  });
  const rows = resp.data.values || [];
  const parts = rows
    .map(r => {
      const a = (r[0] || "").replace(/\s+/g, " ").trim();
      const b = (r[1] || "").replace(/\s+/g, " ").trim();
      return [a, b].filter(Boolean).join(" ").trim();
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : "Sos un asistente claro, amable y conciso. Respondé en español.";
}
async function buildSystemPrompt({ force = false } = {}) {
  const now = Date.now();
  if (!force && (now - behaviorCache.at < COMPORTAMIENTO_CACHE_TTL_MS) && behaviorCache.text) {
    return behaviorCache.text;
  }

  const baseText = (BEHAVIOR_SOURCE === "env")
    ? await loadBehaviorTextFromEnv()
    : await loadBehaviorTextFromSheet();

  let catalogText = "";
  try {
    const products = await loadProductsFromSheetFull();
    catalogText = buildCatalogText(products);
  } catch (e) {
    console.warn("⚠️ No se pudo leer Productos:", e.message);
    catalogText = "Catálogo de productos: (error al leer)";
  }

  const reglasVenta =
    "Instrucciones de venta (OBLIGATORIAS):\n" +
    "- Usá las Observaciones para decidir qué ofrecer, sugerir complementos, aplicar restricciones o proponer sustituciones.\n" +
    "- Respetá limitaciones (stock/horarios/porciones/preparación) indicadas en Observaciones.\n" +
    "- Si sugerís bundles o combos, ofrecé esas opciones con precio estimado cuando corresponda.\n" +
    "- Si falta un dato (sabor/tamaño/cantidad), pedilo brevemente.\n";

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

/* ===================== MongoDB ===================== */
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB  || "whatsapp_bot";
let mongoClient;
let mongoDb;
let didEnsureIndexes = false;

async function getDb() {
  if (mongoDb) return mongoDb;
  if (!MONGODB_URI) throw new Error("Falta MONGODB_URI en variables de entorno.");
  mongoClient = new MongoClient(MONGODB_URI, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    maxPoolSize: 20, connectTimeoutMS: 20000, socketTimeoutMS: 45000
  });
  await mongoClient.connect();
  mongoDb = mongoClient.db(MONGODB_DB);
  await ensureIndexes();
  return mongoDb;
}
async function ensureIndexes() {
  if (didEnsureIndexes) return;
  const db = mongoDb;
  await db.collection("conversations").createIndexes([
    { key: { waId: 1, status: 1 } },
    { key: { openedAt: -1 } },
    { key: { closedAt: -1 } }
  ]);
  await db.collection("messages").createIndexes([
    { key: { conversationId: 1, ts: 1 } },
    { key: { expireAt: 1 }, expireAfterSeconds: 0 }
  ]);
  await db.collection("orders").createIndexes([
    { key: { createdAt: -1 } },
    { key: { estado: 1, createdAt: -1 } },
    { key: { waId: 1, createdAt: -1 } },
    { key: { conversationId: 1 } }
  ]);
  didEnsureIndexes = true;
}

/* ===================== Persistencia conversaciones ===================== */
async function ensureOpenConversation(waId) {
  const db = await getDb();
  let conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
  if (!conv) {
    const doc = {
      waId,
      status: "OPEN",
      finalized: false,
      openedAt: new Date(),
      closedAt: null,
      lastUserTs: null,
      lastAssistantTs: null,
      turns: 0
    };
    const ins = await db.collection("conversations").insertOne(doc);
    conv = { _id: ins.insertedId, ...doc };
  }
  return conv;
}
async function appendMessage(conversationId, { role, content, type = "text", meta = {}, ttlDays = null }) {
  const db = await getDb();
  const doc = { conversationId: new ObjectId(conversationId), role, content, type, meta, ts: new Date() };
  if (ttlDays && Number.isFinite(ttlDays)) doc.expireAt = new Date(Date.now() + ttlDays * 86400000);
  await db.collection("messages").insertOne(doc);
  const upd = { $inc: { turns: 1 }, $set: {} };
  if (role === "user") upd.$set.lastUserTs = doc.ts;
  if (role === "assistant") upd.$set.lastAssistantTs = doc.ts;
  await db.collection("conversations").updateOne({ _id: new ObjectId(conversationId) }, upd);
}

// Inserción de orden final
async function insertFinalOrderDocument({ waId, conversationId, responseText, pedido, bigdata, estado }) {
  const db = await getDb();
  const doc = {
    waId, conversationId, estado,
    response: responseText || "",
    pedido: pedido || {},
    bigdata: bigdata || {},
    createdAt: new Date()
  };
  await db.collection("orders").insertOne(doc);
}

// Finalización idempotente + Sheets + Orden en Mongo
// === NUEVA versión: cierre idempotente que solo finaliza SI Sheets se guardó bien ===
async function finalizeConversationOnce(conversationId, finalPayload, estado) {
  const db = await getDb();

  // 1) Leemos la conv para ver si ya está finalizada
  const conv = await db.collection("conversations").findOne({ _id: new ObjectId(conversationId) });
  if (!conv) {
    console.warn("⚠️ finalizeConversationOnce: conversación no encontrada:", conversationId);
    return { didFinalize: false, reason: "not_found" };
  }
  if (conv.finalized === true) {
    // Ya finalizada: no repetimos guardado para evitar duplicados.
    return { didFinalize: false, reason: "already_finalized" };
  }

  // 2) Intentamos guardar en Google Sheets primero (si falla, no finalizamos)
  try {
    await saveCompletedToSheets({
      waId: conv.waId,
      data: finalPayload || {}
    });
  } catch (e) {
    console.error("❌ Sheets guardado FALLÓ; NO finalizo para reintentar luego:", e?.message);
    return { didFinalize: false, reason: "sheets_failed", sheetsError: e?.message };
  }

  // 3) Si Sheets OK, recién ahora marcamos finalizada (idempotente)
  const updRes = await db.collection("conversations").updateOne(
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
        },
        sheetsSaved: true
      }
    }
  );

  if (updRes.modifiedCount === 1) {
    return { didFinalize: true };
  } else {
    // Otra carrera en milisegundos: alguien finalizó entre el paso 1 y 3
    return { didFinalize: false, reason: "raced_already_finalized" };
  }
}

/* ===================== Sesiones en memoria ===================== */
const sessions = new Map(); // waId -> { messages, updatedAt }
async function getSession(waId) {
  if (!sessions.has(waId)) {
    const systemText = await buildSystemPrompt({ force: true });
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

/* ===================== Chat con historial ===================== */
async function chatWithHistoryJSON(waId, userText) {
  const session = await getSession(waId);
  try {
    const sys = await buildSystemPrompt({ force: true });
    session.messages[0] = { role: "system", content: sys };
  } catch (e) {
    console.warn("⚠️ No se pudo refrescar system:", e.message);
  }
  pushMessage(session, "user", userText);

  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    temperature: CHAT_TEMPERATURE,
    top_p: 1,
    messages: [ ...session.messages ]
  });

  const content = completion.choices?.[0]?.message?.content || "";
  const data = await safeJsonParseStrictOrFix(content) || null;

  const responseText =
    (data && typeof data.response === "string" && data.response.trim()) ||
    (typeof content === "string" ? content.trim() : "") ||
    "Perdón, no pude generar una respuesta. ¿Podés reformular?";

  const estado =
    (data && typeof data.estado === "string" && data.estado.trim().toUpperCase()) || "IN_PROGRESS";

  pushMessage(session, "assistant", responseText);
  return { response: responseText, estado, raw: data || {} };
}

/* ===================== WhatsApp send/mark ===================== */
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

/* ===================== Webhook rutas ===================== */
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

app.post("/webhook", async (req, res) => {
  try {
    if (process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) {
      console.warn("❌ Firma inválida");
      return res.sendStatus(403);
    }
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return res.sendStatus(404);

    res.sendStatus(200); // responder ASAP

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const messages = value.messages || [];
        if (!messages.length) continue;

        for (const msg of messages) {
          const phoneNumberId = value.metadata?.phone_number_id;
          const from = msg.from;
          const type = msg.type;
          const messageId = msg.id;

          if (messageId && phoneNumberId) markAsRead(messageId, phoneNumberId).catch(() => {});

          // Normalizar entrada
          let userText = "";
          let userMeta = {};

          if (type === "text") {
            userText = msg.text?.body || "";

          } else if (type === "interactive") {
            const it = msg.interactive;
            if (it?.type === "button_reply") userText = it.button_reply?.title || "";
            if (it?.type === "list_reply")   userText = it.list_reply?.title || "";
            if (!userText) userText = "Seleccionaste una opción. ¿En qué puedo ayudarte?";

          } else if (type === "audio") {
            try {
              const mediaId = msg.audio?.id;
              if (!mediaId) {
                userText = "Recibí un audio, pero no pude obtenerlo. ¿Podés escribir tu consulta?";
              } else {
                const info = await getMediaInfo(mediaId);
                const buffer = await downloadMediaBuffer(info.url);
                const id = putInCache(buffer, info.mime_type);
                const baseUrl = getBaseUrl(req);
                const publicUrl = `${baseUrl}/cache/audio/${id}`;
                userMeta.mediaUrl = publicUrl;

                try {
                  const trData = await transcribeAudioExternal({
                    publicAudioUrl: publicUrl, buffer, mime: info.mime_type, filename: "audio.ogg"
                  });
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
            } catch (e) {
              console.error("⚠️ Audio/transcripción fallback:", e);
              userText = "Tu audio no se pudo procesar. ¿Podés escribir tu consulta?";
            }

          } else if (type === "image") {
            try {
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
            } catch (e) {
              console.error("⚠️ Imagen/OCR fallback:", e);
              userText = "No pude procesar la imagen. ¿Podés escribir lo que dice?";
            }

          } else if (type === "document") {
            userText = "Recibí un documento. Pegá el texto relevante o contame tu consulta.";

          } else {
            userText = "Hola 👋 ¿Podés escribir tu consulta en texto?";
          }

          console.log("IN:", { from, type, preview: (userText || "").slice(0, 120) });

          // Persistencia conversación + mensaje usuario
          const conv = await ensureOpenConversation(from);
          await appendMessage(conv._id, { role: "user", content: userText, type, meta: userMeta });

          // Llamada a modelo
          let responseText = "Perdón, no pude generar una respuesta. ¿Podés reformular?";
          let estado = "IN_PROGRESS";
          let raw = null;
          try {
            const out = await chatWithHistoryJSON(from, userText);
            responseText = out.response || responseText;
            estado = (out.estado || "IN_PROGRESS").toUpperCase();
            raw = out.raw || null;
            console.log("✅ modelo respondió, estado:", estado);
          } catch (e) {
            console.error("❌ OpenAI error:", e);
          }

          // Respuesta texto
          await sendText(from, responseText, phoneNumberId);
          console.log("OUT →", from, "| estado:", estado);

          // Guardar mensaje assistant
          await appendMessage(conv._id, { role: "assistant", content: responseText, type: "text", meta: { estado } });

          // TTS si el usuario envió audio
          if (type === "audio" && (process.env.ENABLE_TTS_FOR_AUDIO || "true").toLowerCase() === "true") {
            try {
              const { buffer, mime } = await synthesizeTTS(responseText);
              const ttsId = putInCache(buffer, mime || "audio/mpeg");
              const baseUrl = getBaseUrl(req);
              const ttsUrl = `${baseUrl}/cache/tts/${ttsId}`;
              await sendAudioLink(from, ttsUrl, phoneNumberId);
            } catch (e) { console.error("⚠️ Error generando/enviando TTS:", e); }
          }

          // Finalización idempotente (Sheets + Mongo orders) y reset de sesión
          const shouldFinalize =
            (estado && estado !== "IN_PROGRESS") ||
            ((raw?.Pedido?.["Estado pedido"] || "").toLowerCase().includes("cancel"));

          if (shouldFinalize) {
            try {
              const result = await finalizeConversationOnce(conv._id, raw, estado);
              if (result.didFinalize) {
                resetSession(from);
                console.log("🔁 Historial reiniciado para", from, "| estado:", estado);
              } else {
                console.log("ℹ️ Ya estaba finalizada; no se guarda en Sheets de nuevo.");
              }
            } catch (e) {
              console.error("⚠️ Error al finalizar conversación:", e);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error en webhook:", err);
  }
});

/* ===================== Panel / Admin ===================== */
// Guardia simple por token (opcional). Seteá ADMIN_TOKEN para habilitar.
function requireAdmin(req, res, next) {
  const need = (process.env.ADMIN_TOKEN || "").trim();
  if (!need) return next();
  const got = (req.query.token || "").trim();
  if (got && got === need) return next();
  res.status(401).send("No autorizado. Agregá ?token=TU_TOKEN");
}

/* ---------- HTML listado con filtros + CSV ---------- */
app.get("/admin/orders", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const tokenQs = (req.query.token ? `&token=${encodeURIComponent(req.query.token)}` : "");
  res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Órdenes · Admin</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" />
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial,"Noto Sans","Liberation Sans",sans-serif; margin:20px;background:#f7f7f8;color:#111;}
h1{margin:0 0 12px;}
.card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 2px 10px rgba(0,0,0,.06);margin-bottom:16px;}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
input,select,button{padding:8px 10px;border-radius:10px;border:1px solid #ddd;outline:none}
table{width:100%;border-collapse:collapse}
th,td{padding:10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
.badge.ok{background:#e8fff1;color:#0a7f3b;border:1px solid #b6e6c8}
.badge.cancel{background:#fff0f0;color:#b20a0a;border:1px solid #f1b3b3}
small{color:#666}
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
label.chk{display:flex;gap:6px;align-items:center}
.actions{display:flex;gap:8px;align-items:center}
</style>
</head>
<body>
  <h1>Órdenes</h1>
  <div class="card">
    <div class="controls">
      <label>Estado
        <select id="estado">
          <option value="">Todos</option>
          <option value="COMPLETED">COMPLETED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
      </label>
      <label>WA ID <input id="waid" placeholder="549..." /></label>
      <label>Desde <input id="from" type="date" /></label>
      <label>Hasta <input id="to" type="date" /></label>
      <div class="filters">
        <label class="chk"><input type="checkbox" id="f_pollo"/> Pollo</label>
        <label class="chk"><input type="checkbox" id="f_papas"/> Papas</label>
        <label class="chk"><input type="checkbox" id="f_milas"/> Milanesas</label>
        <label class="chk"><input type="checkbox" id="f_milas_napo"/> Milanesas Napolitanas</label>
        <label class="chk"><input type="checkbox" id="f_ensaladas"/> Ensaladas</label>
        <label class="chk"><input type="checkbox" id="f_bebidas"/> Bebidas</label>
      </div>
      <div class="actions">
        <button id="reload">Cargar</button>
        <a id="csv" href="#" download="ordenes.csv">Exportar CSV</a>
        <a href="/admin/charts${tokenQs ? "?"+tokenQs.slice(1) : ""}" style="margin-left:auto">Ver gráficos →</a>
      </div>
    </div>
    <div id="summary"><small>Cargando…</small></div>
    <div class="table-wrap">
      <table id="tbl">
        <thead>
          <tr><th>Fecha</th><th>WA</th><th>Estado</th><th>Nombre / Entrega</th><th>Pedido</th><th>Monto</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>
<script>
const qs = new URLSearchParams(location.search);
const token = qs.get("token")||"";

document.getElementById("reload").onclick = load;

function buildParams(){
  const q = new URLSearchParams();
  const estado = document.getElementById("estado").value;
  const waid = document.getElementById("waid").value.trim();
  const from = document.getElementById("from").value;
  const to   = document.getElementById("to").value;

  if (token) q.set("token", token);
  if (estado) q.set("estado", estado);
  if (waid) q.set("waId", waid);
  if (from) q.set("from", from);
  if (to) q.set("to", to);

  if (document.getElementById("f_pollo").checked) q.set("fp_pollo","1");
  if (document.getElementById("f_papas").checked) q.set("fp_papas","1");
  if (document.getElementById("f_milas").checked) q.set("fp_milas","1");
  if (document.getElementById("f_milas_napo").checked) q.set("fp_milas_napo","1");
  if (document.getElementById("f_ensaladas").checked) q.set("fp_ensaladas","1");
  if (document.getElementById("f_bebidas").checked) q.set("fp_bebidas","1");

  return q;
}

async function load(){
  const q = buildParams();

  // link CSV
  const csvA = document.getElementById("csv");
  csvA.href = "/admin/orders.csv?"+q.toString();

  const r = await fetch("/admin/orders.json?"+q.toString());
  const data = await r.json();
  const tbody = document.querySelector("#tbl tbody"); tbody.innerHTML = "";
  let total = 0;

  for (const o of data.items){
    const p = o.pedido || {};
    const monto = Number(p["Monto"]||0)||0;
    total += monto;

    const tr = document.createElement("tr");
    const estadoBadge = o.estado==="CANCELLED" ? '<span class="badge cancel">CANCELLED</span>' : '<span class="badge ok">COMPLETED</span>';
    const pedidoTxt = [
      p["Pedido pollo"] ? "Pollo: "+p["Pedido pollo"] : "",
      p["Pedido papas"] ? "Papas: "+p["Pedido papas"] : "",
      p["Milanesas comunes"] ? "Milanesas: "+p["Milanesas comunes"] : "",
      p["Milanesas Napolitanas"] ? "Milas Napo: "+p["Milanesas Napolitanas"] : "",
      p["Ensaladas"] ? "Ensaladas: "+p["Ensaladas"] : "",
      p["Bebidas"] ? "Bebidas: "+p["Bebidas"] : ""
    ].filter(Boolean).join(" · ");

    tr.innerHTML = \`
      <td>\${new Date(o.createdAt).toLocaleString("es-AR")}</td>
      <td>\${o.waId}</td>
      <td>\${estadoBadge}</td>
      <td><div><b>\${(p["Nombre"]||"")}</b></div><small>\${(p["Entrega"]||"")}</small></td>
      <td>\${pedidoTxt || "-"}</td>
      <td>\${new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS"}).format(monto)}</td>
    \`;
    tbody.appendChild(tr);
  }
  document.getElementById("summary").innerHTML =
    \`<b>\${data.count}</b> órdenes · Total: <b>\${new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS"}).format(total)}</b>\`;
}
load();
</script>
</body></html>`);
});

/* ---------- JSON con filtros por producto ---------- */
app.get("/admin/orders.json", requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { estado, waId, from, to } = req.query;
    // filtros por producto (flag=1)
    const fp = {
      pollo: req.query.fp_pollo === "1",
      papas: req.query.fp_papas === "1",
      milas: req.query.fp_milas === "1",
      milas_napo: req.query.fp_milas_napo === "1",
      ensaladas: req.query.fp_ensaladas === "1",
      bebidas: req.query.fp_bebidas === "1",
    };

    const q = {};
    if (estado) q.estado = String(estado);
    if (waId) q.waId = String(waId);
    if (from || to) {
      q.createdAt = {};
      if (from) q.createdAt.$gte = new Date(from + "T00:00:00");
      if (to)   q.createdAt.$lte = new Date(to   + "T23:59:59");
    }

    // construir AND de campos requeridos
    const and = [];
    if (fp.pollo) and.push({ ['pedido.'+"Pedido pollo"]: { $exists: true, $ne: "" } });
    if (fp.papas) and.push({ ['pedido.'+"Pedido papas"]: { $exists: true, $ne: "" } });
    if (fp.milas) and.push({ ['pedido.'+"Milanesas comunes"]: { $exists: true, $ne: "" } });
    if (fp.milas_napo) and.push({ ['pedido.'+"Milanesas Napolitanas"]: { $exists: true, $ne: "" } });
    if (fp.ensaladas) and.push({ ['pedido.'+"Ensaladas"]: { $exists: true, $ne: "" } });
    if (fp.bebidas) and.push({ ['pedido.'+"Bebidas"]: { $exists: true, $ne: "" } });
    if (and.length) q.$and = and;

    const items = await db.collection("orders")
      .find(q).sort({ createdAt: -1 }).limit(2000).toArray();

    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error("orders.json error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- CSV export ---------- */
app.get("/admin/orders.csv", requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { estado, waId, from, to } = req.query;

    const fp = {
      pollo: req.query.fp_pollo === "1",
      papas: req.query.fp_papas === "1",
      milas: req.query.fp_milas === "1",
      milas_napo: req.query.fp_milas_napo === "1",
      ensaladas: req.query.fp_ensaladas === "1",
      bebidas: req.query.fp_bebidas === "1",
    };

    const q = {};
    if (estado) q.estado = String(estado);
    if (waId) q.waId = String(waId);
    if (from || to) {
      q.createdAt = {};
      if (from) q.createdAt.$gte = new Date(from + "T00:00:00");
      if (to)   q.createdAt.$lte = new Date(to   + "T23:59:59");
    }
    const and = [];
    if (fp.pollo) and.push({ ['pedido.'+"Pedido pollo"]: { $exists: true, $ne: "" } });
    if (fp.papas) and.push({ ['pedido.'+"Pedido papas"]: { $exists: true, $ne: "" } });
    if (fp.milas) and.push({ ['pedido.'+"Milanesas comunes"]: { $exists: true, $ne: "" } });
    if (fp.milas_napo) and.push({ ['pedido.'+"Milanesas Napolitanas"]: { $exists: true, $ne: "" } });
    if (fp.ensaladas) and.push({ ['pedido.'+"Ensaladas"]: { $exists: true, $ne: "" } });
    if (fp.bebidas) and.push({ ['pedido.'+"Bebidas"]: { $exists: true, $ne: "" } });
    if (and.length) q.$and = and;

    const items = await db.collection("orders").find(q).sort({ createdAt: -1 }).limit(20000).toArray();

    const headers = [
      "createdAt","waId","estado","Nombre","Entrega","Domicilio",
      "Pedido pollo","Pedido papas","Milanesas comunes","Milanesas Napolitanas",
      "Ensaladas","Bebidas","Monto","Respuesta"
    ];
    const lines = [headers.join(",")];

    for (const o of items) {
      const p = o.pedido || {};
      const row = [
        csvEscape(new Date(o.createdAt).toISOString()),
        csvEscape(o.waId || ""),
        csvEscape(o.estado || ""),
        csvEscape(p["Nombre"] || ""),
        csvEscape(p["Entrega"] || ""),
        csvEscape(p["Domicilio"] || ""),
        csvEscape(p["Pedido pollo"] || ""),
        csvEscape(p["Pedido papas"] || ""),
        csvEscape(p["Milanesas comunes"] || ""),
        csvEscape(p["Milanesas Napolitanas"] || ""),
        csvEscape(p["Ensaladas"] || ""),
        csvEscape(p["Bebidas"] || ""),
        csvEscape(p["Monto"] ?? ""),
        csvEscape(o.response || "")
      ];
      lines.push(row.join(","));
    }

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="ordenes.csv"');
    res.send(csv);
  } catch (e) {
    console.error("orders.csv error", e);
    res.status(500).send("Error generando CSV");
  }
});

/* ---------- Métricas + Gráficos ---------- */
app.get("/admin/metrics.json", requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { from, to } = req.query;
    const match = {};
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from + "T00:00:00");
      if (to)   match.createdAt.$lte = new Date(to   + "T23:59:59");
    }
    const pipeline = [
      { $match: match },
      {
        $addFields: {
          montoNum: {
            $toDouble: {
              $ifNull: [
                { $getField: { field: "Monto", input: "$pedido" } },
                0
              ]
            }
          }
        }
      },
      {
        $group: {
          _id: {
            y: { $year: "$createdAt" },
            m: { $month: "$createdAt" },
            d: { $dayOfMonth: "$createdAt" }
          },
          orders: { $sum: 1 },
          revenue: { $sum: "$montoNum" }
        }
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } }
    ];
    const daily = await db.collection("orders").aggregate(pipeline).toArray();
    res.json({ ok: true, daily });
  } catch (e) {
    console.error("metrics.json error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/admin/charts", requireAdmin, (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const qs = _req.url.includes("?") ? _req.url.slice(_req.url.indexOf("?")) : "";
  res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Gráficos · Admin</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial,"Noto Sans","Liberation Sans",sans-serif; margin:20px;background:#f7f7f8;color:#111;}
h1{margin:0 0 12px;}
.card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 2px 10px rgba(0,0,0,.06);margin-bottom:16px;}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
input,button{padding:8px 10px;border-radius:10px;border:1px solid #ddd;outline:none}
canvas{max-width:100%;height:300px}
</style>
</head>
<body>
  <h1>Gráficos</h1>
  <div class="card">
    <div class="controls">
      <label>Desde <input id="from" type="date" /></label>
      <label>Hasta <input id="to" type="date" /></label>
      <button id="reload">Actualizar</button>
      <a href="/admin/orders${qs}" style="margin-left:auto">← Volver a órdenes</a>
    </div>
    <div>
      <h3>Órdenes por día</h3>
      <canvas id="ordersChart"></canvas>
    </div>
    <div style="margin-top:24px">
      <h3>Facturación por día</h3>
      <canvas id="revenueChart"></canvas>
    </div>
  </div>
<script>
const q0 = new URLSearchParams(location.search);
const token = q0.get("token")||"";
document.getElementById("reload").onclick = load;

let oChart, rChart;

async function load(){
  const from = document.getElementById("from").value;
  const to   = document.getElementById("to").value;

  const q = new URLSearchParams();
  if (token) q.set("token", token);
  if (from) q.set("from", from);
  if (to) q.set("to", to);

  const r = await fetch("/admin/metrics.json?"+q.toString());
  const data = await r.json();
  const labels = data.daily.map(d => \`\${d._id.d}/\${d._id.m}\`);
  const orders = data.daily.map(d => d.orders);
  const revenue = data.daily.map(d => d.revenue);

  const oc = document.getElementById("ordersChart");
  const rc = document.getElementById("revenueChart");

  if (oChart) oChart.destroy();
  if (rChart) rChart.destroy();

  oChart = new Chart(oc, {
    type: "line",
    data: { labels, datasets: [{ label: "Órdenes", data: orders }] },
    options: { responsive: true, scales: { y: { beginAtZero: true } } }
  });
  rChart = new Chart(rc, {
    type: "bar",
    data: { labels, datasets: [{ label: "Facturación (ARS)", data: revenue }] },
    options: { responsive: true, scales: { y: { beginAtZero: true } } }
  });
}
load();
</script>
</body></html>`);
});

/* ===================== Start ===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));
