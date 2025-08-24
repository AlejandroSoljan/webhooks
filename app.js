// server.js
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai");
const { google } = require("googleapis");
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");

// ================== Config ==================
const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// WhatsApp / Meta
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o-mini";
const CHAT_TEMPERATURE = Number.isFinite(+process.env.CHAT_TEMPERATURE) ? +process.env.CHAT_TEMPERATURE : 0.6;

// Timeouts (ms)
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || "25000", 10);
const OPENAI_JSONFIX_TIMEOUT_MS = parseInt(process.env.OPENAI_JSONFIX_TIMEOUT_MS || "7000", 10);
const OPENAI_TTS_TIMEOUT_MS = parseInt(process.env.OPENAI_TTS_TIMEOUT_MS || "12000", 10);
const OPENAI_VISION_TIMEOUT_MS = parseInt(process.env.OPENAI_VISION_TIMEOUT_MS || "12000", 10);

// Transcriber externo
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "https://transcribegpt-569454200011.northamerica-northeast1.run.app").trim().replace(/\/+$/,"");

// Cache binarios
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10); // 5m

// Fuentes de comportamiento
// BEHAVIOR_SOURCE=env|sheet
const BEHAVIOR_SOURCE = (process.env.BEHAVIOR_SOURCE || "env").toLowerCase();

// Productos cache TTL
const PRODUCTS_CACHE_TTL_MS = parseInt(process.env.PRODUCTS_CACHE_TTL_MS || "300000", 10); // 5m

// ================== Utils ==================
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

function withTimeout(promise, ms, tag = "op") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${tag}_timeout_${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); })
           .catch((e) => { clearTimeout(t); reject(e); });
  });
}

function getBaseUrl(req) {
  let base = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/,"");
  if (!base) {
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const host = req.headers.host;
    base = `${proto}://${host}`;
  }
  return base;
}

// Limpieza de cercas y espacios «raros»
function stripCodeFences(raw) {
  if (raw == null) return "";
  let txt = String(raw).trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  }
  // quitar caracteres no imprimibles comunes
  txt = txt.replace(/[\u0000-\u001F\u007F]+/g, "").trim();
  return txt;
}

async function safeJsonParseStrictOrFix(raw, { openai, model }) {
  let txt = stripCodeFences(raw);
  try {
    if (!txt) throw new Error("empty");
    return JSON.parse(txt);
  } catch (_e) {
    // Pedir a OpenAI que repare el JSON rápidamente
    const fix = await withTimeout(
      openai.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: 300,
        messages: [
          { role: "system", content: "Devuelve EXCLUSIVAMENTE un JSON válido, sin markdown ni comentarios." },
          { role: "user", content: `Repará a JSON estricto (si falta llave/coma, corregilo). Texto:\n${txt.slice(0, 8000)}` }
        ]
      }),
      OPENAI_JSONFIX_TIMEOUT_MS,
      "openai_jsonfix"
    );
    const repaired = fix.choices?.[0]?.message?.content || "";
    return JSON.parse(stripCodeFences(repaired));
  }
}

// ================== Cache binarios en memoria ==================
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
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of fileCache.entries()) {
    if (now > item.expiresAt) fileCache.delete(id);
  }
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

// ================== Google Sheets ==================
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

// ----- Carga de comportamiento desde Sheet: pestaña "Comportamiento_API" (A y B)
async function loadBehaviorFromSheet() {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const range = "Comportamiento_API!A2:B"; // saltea encabezado
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = resp.data.values || [];
  if (!rows.length) return "Sos un asistente claro, amable y conciso. Respondé en español.";

  // Combina A y B como "A: B" por línea, omitiendo vacíos.
  const lines = rows.map(([a, b]) => {
    const A = (a || "").trim();
    const B = (b || "").trim();
    if (!A && !B) return null;
    if (A && B) return `${A}: ${B}`;
    return A || B;
  }).filter(Boolean);

  // Garantiza instrucción fuerte de JSON
  lines.push(
    "Formatea las respuestas exclusivamente en JSON válido sin bloques de código."
  );

  return lines.join("\n");
}

// ----- Productos: pestaña "Productos" (A nombre, B precio, C venta, D observaciones, E activo S/N)
let productsCache = { at: 0, items: [] };
async function loadProductsFromSheet(force = false) {
  const now = Date.now();
  if (!force && now - productsCache.at < PRODUCTS_CACHE_TTL_MS && productsCache.items?.length) {
    return productsCache.items;
  }
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const range = "Productos!A2:E";
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = resp.data.values || [];

  const items = rows.map((r) => {
    const nombre = (r[0] || "").trim();
    const precioRaw = (r[1] || "").toString().trim();
    const venta = (r[2] || "").trim();
    const obs = (r[3] || "").trim();
    const activo = (r[4] || "").trim().toUpperCase() === "S";
    if (!nombre) return null;
    // precio puede venir "39000" o "$39.000"
    const precioNum = Number(precioRaw.replace(/[^\d.,-]/g, "").replace(",", "."));
    const precio = Number.isFinite(precioNum) ? precioNum : (precioRaw || "");
    return { nombre, precio, venta, observaciones: obs, activo };
  }).filter(Boolean);

  // Filtrar activos
  const activos = items.filter(it => it.activo);

  productsCache = { at: now, items: activos };
  return activos;
}

function buildProductsSystemMessage(items) {
  if (!items?.length) return "Catálogo actual: (sin datos de productos)";
  const lines = items.map(it => {
    const precioFmt = (typeof it.precio === "number") ? `$${it.precio}` : (it.precio || "s/p");
    const venta = it.venta ? ` — ${it.venta}` : "";
    const obs = it.observaciones ? ` — obs: ${it.observaciones}` : "";
    return `- ${it.nombre} — ${precioFmt}${venta}${obs}`;
  });
  return [
    "Catálogo de productos (nombre — precio — modo de venta — observaciones):",
    ...lines
  ].join("\n");
}

// ================== Sesiones en memoria (historial corto) ==================
const sessions = new Map(); // waId -> { messages, updatedAt }

async function buildSystemPrompt({ force = false } = {}) {
  // comportamiento: env o sheet
  let comportamiento = (process.env.COMPORTAMIENTO || "Sos un asistente claro, amable y conciso. Respondé en español.");
  if (BEHAVIOR_SOURCE === "sheet") {
    try { comportamiento = await loadBehaviorFromSheet(); }
    catch (e) { console.warn("⚠️ No se pudo cargar comportamiento del Sheet:", e.message); }
  }

  // catálogo
  let catalogMsg = "Catálogo actual: (sin datos de productos)";
  try {
    const products = await loadProductsFromSheet(force);
    catalogMsg = buildProductsSystemMessage(products);
  } catch (e) {
    console.warn("⚠️ No se pudo cargar Productos del Sheet:", e.message);
  }

  // bloque JSON requerido
  const jsonRules =
    "Respondé SOLO con JSON válido (sin ```). Estructura: " +
    '{ "response": "texto para WhatsApp", "estado": "IN_PROGRESS|COMPLETED|CANCELLED",' +
    '  "Pedido"?: { "Fecha y hora de inicio de conversacion": string, "Fecha y hora fin de conversacion": string, "Estado pedido": string, "Motivo cancelacion": string, "Pedido pollo": string, "Pedido papas": string, "Milanesas comunes": string, "Milanesas Napolitanas": string, "Ensaladas": string, "Bebidas": string, "Monto": number, "Nombre": string, "Entrega": string, "Domicilio": string, "Fecha y hora de entrega": string, "Hora": string },' +
    '  "Bigdata"?: { "Sexo": string, "Estudios": string, "Satisfaccion del cliente": number, "Motivo puntaje satisfaccion": string, "Cuanto nos conoce el cliente": number, "Motivo puntaje conocimiento": string, "Motivo puntaje general": string, "Perdida oportunidad": string, "Sugerencias": string, "Flujo": string, "Facilidad en el proceso de compras": number, "Pregunto por bot": string } } ' +
    "Usá el catálogo provisto (incluidas las observaciones) para definir precios/ofertas y cómo vender. " +
    "Si la persona cancela, usa estado=CANCELLED y completa Motivo cancelacion.";

  return [comportamiento, catalogMsg, jsonRules].join("\n\n");
}

async function getSession(waId) {
  if (!sessions.has(waId)) {
    const system = await buildSystemPrompt({ force: true }).catch(() =>
      "Sos un asistente claro, amable y conciso. Respondé en español."
    );
    sessions.set(waId, {
      messages: [{ role: "system", content: system }],
      updatedAt: Date.now()
    });
  }
  return sessions.get(waId);
}
function resetSession(waId) { sessions.delete(waId); }
function pushMessage(session, role, content, maxTurns = 6) {
  session.messages.push({ role, content });
  const system = session.messages[0];
  const tail = session.messages.slice(-2 * maxTurns);
  session.messages = [system, ...tail];
  session.updatedAt = Date.now();
}

// ================== WhatsApp helpers ==================
async function getMediaInfo(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) { const data = await resp.json().catch(()=>({})); throw new Error(`Media info error: ${resp.status} ${JSON.stringify(data)}`); }
  return resp.json();
}
async function downloadMediaBuffer(mediaUrl) {
  const token = process.env.WHATSAPP_TOKEN;
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Media download error: ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
async function sendText(to, body, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body } };
  const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await resp.json();
  if (!resp.ok) console.error("❌ Error WhatsApp sendText:", resp.status, data);
  else console.log("📤 Enviado:", data);
  return data;
}
async function sendAudioLink(to, publicUrl, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "audio", audio: { link: publicUrl } };
  const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await resp.json();
  if (!resp.ok) console.error("❌ Error WhatsApp sendAudioLink:", resp.status, data);
  else console.log("📤 Enviado AUDIO:", data);
  return data;
}
async function markAsRead(messageId, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", status: "read", message_id: messageId };
  const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!resp.ok) { const data = await resp.json().catch(()=>({})); console.warn("⚠️ markAsRead falló:", resp.status, data); }
}

// ================== Vision / TTS / Transcriber ==================
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
  const resp = await withTimeout(
    fetch(url, { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    OPENAI_VISION_TIMEOUT_MS,
    "openai_vision"
  );
  if (!resp.ok) { const t = await resp.text().catch(()=> ""); throw new Error(`OpenAI vision error: ${resp.status} ${t}`); }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function synthesizeTTS(text) {
  const model = process.env.TTS_MODEL || "gpt-4o-mini-tts";
  const voice = process.env.TTS_VOICE || "alloy";
  const format = (process.env.TTS_FORMAT || "mp3").toLowerCase();
  const resp = await withTimeout(
    openai.audio.speech.create({ model, voice, input: text, format }),
    OPENAI_TTS_TIMEOUT_MS,
    "openai_tts"
  );
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mime = format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg";
  return { buffer, mime };
}

// Transcriptor externo: intenta POST JSON {audio_url} y luego multipart, luego GET
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime, filename = "audio.ogg" }) {
  const base = TRANSCRIBE_API_URL;
  const paths = ["", "/transcribe", "/api/transcribe", "/v1/transcribe"];

  for (const p of paths) {
    const url = `${base}${p}`;
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio_url: publicAudioUrl }) });
    if (r.ok) return r.json().catch(()=>({}));
    else console.warn("Transcribe POST JSON fallo:", r.status, url, await r.text().catch(()=> ""));
  }

  // multipart
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
      const { body, boundary } = buildMultipart([{ type: "file", name: "file", filename, contentType: mime || "application/octet-stream", data: buffer }]);
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
      if (r.ok) return r.json().catch(()=> ({}));
      else console.warn("Transcribe POST multipart fallo:", r.status, url, await r.text().catch(()=> ""));
    }
  }

  for (const p of paths) {
    const url = `${base}${p}?audio_url=${encodeURIComponent(publicAudioUrl)}`;
    const g = await fetch(url);
    if (g.ok) return g.json().catch(()=> ({}));
    else console.warn("Transcribe GET fallo:", g.status, url, await g.text().catch(()=> ""));
  }

  throw new Error("No hubo variantes válidas para el endpoint de transcripción.");
}

// ================== Persistencia Mongo ==================
async function ensureOpenConversation(waId) {
  const db = await getDb();
  let conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
  if (!conv) {
    const doc = {
      waId,
      status: "OPEN",
      openedAt: new Date(),
      closedAt: null,
      lastUserTs: null,
      lastAssistantTs: null,
      turns: 0,
      sheetsSaved: false,
      finalStatus: null
    };
    const ins = await db.collection("conversations").insertOne(doc);
    conv = { _id: ins.insertedId, ...doc };
  }
  return conv;
}
async function appendMessage(conversationId, { role, content, type = "text", meta = {}, ttlDays = null }) {
  const db = await getDb();
  const doc = { conversationId: new ObjectId(conversationId), role, content, type, meta, ts: new Date() };
  if (ttlDays && Number.isFinite(ttlDays)) doc.expireAt = new Date(Date.now() + ttlDays * 864e5);
  await db.collection("messages").insertOne(doc);

  const upd = { $inc: { turns: 1 }, $set: {} };
  if (role === "user") upd.$set.lastUserTs = doc.ts;
  if (role === "assistant") upd.$set.lastAssistantTs = doc.ts;
  await db.collection("conversations").updateOne({ _id: new ObjectId(conversationId) }, upd);
}
async function completeConversation(conversationId, finalPayload, status = "COMPLETED") {
  const db = await getDb();
  await db.collection("conversations").updateOne(
    { _id: new ObjectId(conversationId) },
    {
      $set: {
        status,
        finalStatus: status,
        closedAt: new Date(),
        summary: {
          response: finalPayload?.response || "",
          Pedido: finalPayload?.Pedido || null,
          Bigdata: finalPayload?.Bigdata || null
        }
      }
    }
  );
}
async function finalizeAndSaveIfNeeded({ convId, waId, estado, raw }) {
  const db = await getDb();
  const convFresh = await db.collection("conversations").findOne({ _id: new ObjectId(convId) });

  const isTerminal = estado && estado !== "IN_PROGRESS";
  if (!isTerminal) return { skipped: true, reason: "not_terminal" };

  if (convFresh?.sheetsSaved) {
    console.log("ℹ️ Ya estaba finalizada y guardada en Sheets; se evita duplicado.");
    return { skipped: true, reason: "already_saved" };
  }

  await completeConversation(convId, raw, estado);

  try {
    await saveCompletedToSheets({ waId, data: raw });
    await db.collection("conversations").updateOne(
      { _id: new ObjectId(convId) },
      { $set: { sheetsSaved: true } }
    );
    console.log("🧾 Guardado en Google Sheets (Hoja 1 & BigData) para", waId, "con estado", estado);
    return { saved: true };
  } catch (e) {
    console.error("⚠️ Error guardando en Google Sheets:", e);
    return { saved: false, error: e };
  }
}

// ================== Guardado en Google Sheets ==================
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
  const spreadsheetId = getSpreadsheetIdFromEnv();
  console.log("🧭 Sheets target:", { spreadsheetId });

  const response = data?.response || "";
  const pedido = data?.Pedido || {};
  const bigdata = data?.Bigdata || {};

  const hPedido = headerPedido();
  const vPedido = flattenPedido({ waId, response, pedido });
  console.log("➡️ Append Hoja 1:", { headerLen: hPedido.length, valuesLen: vPedido.length });
  await ensureHeaderIfEmpty({ sheetName: "Hoja 1", header: hPedido });
  await appendRow({ sheetName: "Hoja 1", values: vPedido });

  const hBig = headerBigdata();
  const vBig = flattenBigdata({ waId, bigdata });
  console.log("➡️ Append BigData:", { headerLen: hBig.length, valuesLen: vBig.length });
  await ensureHeaderIfEmpty({ sheetName: "BigData", header: hBig });
  await appendRow({ sheetName: "BigData", values: vBig });
}

// ================== Chat con historial y fallbacks ==================
async function chatWithHistoryJSON(waId, userText, model = CHAT_MODEL, temperature = CHAT_TEMPERATURE) {
  const session = await getSession(waId);
  // refrescar system al vuelo (por si cambió Sheet)
  try {
    const sys = await buildSystemPrompt({ force: true });
    session.messages[0] = { role: "system", content: sys };
  } catch (e) {
    console.warn("⚠️ No se pudo refrescar system:", e.message);
  }

  pushMessage(session, "user", userText, 6);

  // Intento A: historial completo (corto) y timeout estándar
  try {
    const completion = await withTimeout(
      openai.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        temperature,
        top_p: 1,
        max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || "700", 10),
        messages: [ ...session.messages ]
      }),
      OPENAI_TIMEOUT_MS,
      "openai_chat"
    );

    const contentA = completion.choices?.[0]?.message?.content || "";
    let dataA = null;
    try { dataA = await safeJsonParseStrictOrFix(contentA, { openai, model }); }
    catch (e) { console.error("❌ No se pudo parsear JSON (A):", e.message, "\nRaw:", contentA?.slice(0, 300)); }

    let responseTextA = "Perdón, no pude generar una respuesta. ¿Podés reformular?";
    let estadoA = "IN_PROGRESS";
    if (dataA && typeof dataA === "object") {
      responseTextA = (typeof dataA.response === "string" && dataA.response.trim()) || responseTextA;
      estadoA = (typeof dataA.estado === "string" && dataA.estado.trim().toUpperCase()) || "IN_PROGRESS";
    } else if (contentA && contentA.trim()) {
      responseTextA = contentA.trim();
    }

    pushMessage(session, "assistant", responseTextA, 6);
    return { response: responseTextA, estado: estadoA, raw: dataA || {} };
  } catch (eA) {
    console.error("❌ Intento A falló:", eA?.message || eA);
  }

  // Intento B: mínimo contexto y temperatura baja
  try {
    const minimal = (() => {
      const sys = session.messages[0];
      const tail = session.messages.slice(-4);
      return [sys, ...tail];
    })();

    const completionB = await withTimeout(
      openai.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        temperature: Math.min(0.2, temperature),
        top_p: 1,
        max_tokens: 400,
        messages: minimal
      }),
      Math.min(OPENAI_TIMEOUT_MS, 18000),
      "openai_chat_fallbackB"
    );

    const contentB = completionB.choices?.[0]?.message?.content || "";
    let dataB = null;
    try { dataB = await safeJsonParseStrictOrFix(contentB, { openai, model }); }
    catch (e) { console.error("❌ No se pudo parsear JSON (B):", e.message, "\nRaw:", contentB?.slice(0, 300)); }

    let responseTextB = "Perdón, tuve un problema momentáneo. ¿Podés repetir tu consulta brevemente?";
    let estadoB = "IN_PROGRESS";
    if (dataB && typeof dataB === "object") {
      responseTextB = (typeof dataB.response === "string" && dataB.response.trim()) || responseTextB;
      estadoB = (typeof dataB.estado === "string" && dataB.estado.trim().toUpperCase()) || "IN_PROGRESS";
    } else if (contentB && contentB.trim()) {
      responseTextB = contentB.trim();
    }

    pushMessage(session, "assistant", responseTextB, 6);
    return { response: responseTextB, estado: estadoB, raw: dataB || {} };
  } catch (eB) {
    console.error("❌ Intento B falló:", eB?.message || eB);
  }

  // Fallback C: respuesta mínima válida
  const fallbackJSON = {
    response: "Estoy con demoras para responder. ¿Podés reformular en una sola frase para ayudarte mejor?",
    estado: "IN_PROGRESS"
  };
  const responseTextC = fallbackJSON.response;
  pushMessage(session, "assistant", responseTextC, 6);
  return { response: responseTextC, estado: fallbackJSON.estado, raw: fallbackJSON };
}

// ================== Rutas ==================
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
    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(404);
    }

    // Responder 200 rápido
    res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;

        // Manejar TODOS los mensajes (podrían venir varios)
        for (const msg of (value.messages || [])) {
          const from = msg.from;
          const type = msg.type;
          const messageId = msg.id;

          if (messageId && phoneNumberId) markAsRead(messageId, phoneNumberId).catch(()=>{});

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

          // Persistencia
          const conv = await ensureOpenConversation(from);
          await appendMessage(conv._id, { role: "user", content: userText, type, meta: userMeta });

          // Chat con historial + catálogo + comportamiento
          let responseText = "Perdón, no pude generar una respuesta. ¿Podés reformular?";
          let estado = "IN_PROGRESS";
          let raw = null;
          try {
            const out = await chatWithHistoryJSON(from, userText, CHAT_MODEL, CHAT_TEMPERATURE);
            responseText = out.response || responseText;
            estado = (out.estado || "IN_PROGRESS").toUpperCase();
            raw = out.raw || null;
            console.log("✅ modelo respondió, estado:", estado);
          } catch (e) {
            console.error("❌ OpenAI error:", e);
          }

          // Enviar texto
          await sendText(from, responseText, phoneNumberId);
          console.log("📤 OUT →", from, "| estado:", estado);

          // Persistencia assistant
          await appendMessage(conv._id, { role: "assistant", content: responseText, type: "text", meta: { estado } });

          // Si el usuario mandó audio, respondemos también con audio (TTS)
          if (type === "audio" && (process.env.ENABLE_TTS_FOR_AUDIO || "true").toLowerCase() === "true") {
            try {
              const { buffer, mime } = await synthesizeTTS(responseText);
              const ttsId = putInCache(buffer, mime || "audio/mpeg");
              const baseUrl = getBaseUrl(req);
              const ttsUrl = `${baseUrl}/cache/tts/${ttsId}`;
              await sendAudioLink(from, ttsUrl, phoneNumberId);
            } catch (e) {
              console.error("⚠️ Error generando/enviando TTS:", e);
            }
          }

          // Finalización y guardado en Sheets idempotente
          try {
            const shouldFinalize = (estado && estado !== "IN_PROGRESS") ||
              ((raw?.Pedido?.["Estado pedido"] || "").toLowerCase().includes("cancel"));
            if (shouldFinalize) {
              const resFinal = await finalizeAndSaveIfNeeded({
                convId: conv._id,
                waId: from,
                estado: (estado || "COMPLETED").toUpperCase(),
                raw
              });

              // Reiniciar historial en memoria (terminal)
              resetSession(from);

              if (resFinal.saved) {
                console.log("🔁 Historial reiniciado y guardado correcto.");
              } else if (resFinal.skipped) {
                console.log(`ℹ️ Ya estaba finalizada; motivo: ${resFinal.reason}.`);
              } else {
                console.warn("⚠️ Finalizada pero sin guardar en Sheets (hubo error). Historial reiniciado.");
              }
            }
          } catch (e) {
            console.error("⚠️ Error al cerrar conversación / guardar en Google Sheets:", e);
          }

          console.log("🏁 turno terminado");
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error en webhook:", err);
    try { res.sendStatus(200); } catch {}
  }
});

// ================== Start ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));
