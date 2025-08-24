// server.js
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai");
const { google } = require("googleapis");

// --- MongoDB helpers
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");

const app = express();

// ========= Body / firma =========
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

// ========= OpenAI =========
const openai = new OpenAI({ apiKey: process.envOPENAI_API_KEY || process.env.OPENAI_API_KEY }); // robustez

// ====== Config de modelo / temperatura ======
const CHAT_MODEL =
  process.env.OPENAI_CHAT_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";
const CHAT_TEMPERATURE = Number.isFinite(parseFloat(process.env.OPENAI_TEMPERATURE))
  ? parseFloat(process.env.OPENAI_TEMPERATURE)
  : 0.2;

// --- Helpers de timeout/retry ---
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function withTimeout(promise, ms, label="op"){
  let to;
  const timeout = new Promise((_,rej)=>{
    to = setTimeout(()=>rej(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  try {
    const res = await Promise.race([promise, timeout]);
    clearTimeout(to);
    return res;
  } finally {
    clearTimeout(to);
  }
}

async function retry(fn, { retries=2, baseDelay=400 } = {}){
  let lastErr;
  for (let i=0;i<=retries;i++){
    try { return await fn(i); }
    catch(e){ lastErr = e; if (i<retries) await sleep(baseDelay * Math.pow(2,i)); }
  }
  throw lastErr;
}

// ========= Helpers JSON robustos =========
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

// ========= WhatsApp / Media helpers =========
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "https://transcribegpt-569454200011.northamerica-northeast1.run.app").trim().replace(/\/+$/,"");
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10); // 5 min

// ---- Cache en memoria de binarios (audio e imagen) ----
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

// ---- OCR de imagen con OpenAI Chat Completions (o4-mini) ----
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
    fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
    Number(process.env.OCR_TIMEOUT_MS || 8000),
    "openai_ocr"
  );

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`OpenAI vision error: ${resp.status} ${errTxt}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ---- Transcriptor externo con variantes + timeout ----
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime, filename = "audio.ogg" }) {
  const base = TRANSCRIBE_API_URL;
  const paths = ["", "/transcribe", "/api/transcribe", "/v1/transcribe"];

  // 1) POST JSON { audio_url }
  for (const p of paths) {
    const url = `${base}${p}`;
    const r = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_url: publicAudioUrl })
      }),
      Number(process.env.TRANSCRIBE_TIMEOUT_MS || 8000),
      "transcribe"
    );
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
      const r = await withTimeout(
        fetch(url, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body }),
        Number(process.env.TRANSCRIBE_TIMEOUT_MS || 8000),
        "transcribe"
      );
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
    const g = await withTimeout(fetch(url), Number(process.env.TRANSCRIBE_TIMEOUT_MS || 8000), "transcribe");
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

// ======== TTS (Texto a voz) con OpenAI ========
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

// ========= Google Sheets helpers =========
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

// ----- Guardado en dos pestañas (Hoja 1 y BigData)
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

// ===== Productos desde Google Sheets (A nombre, B precio, C venta, D obs, E activo= S/N) =====
const PRODUCTS_CACHE_TTL_MS = parseInt(process.env.PRODUCTS_CACHE_TTL_MS || "300000", 10); // 5 min
let productsCache = { at: 0, items: [] };

function looksActive(v) {
  if (!v) return false;
  return String(v).trim().toUpperCase() === "S";
}
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

// ===== Comportamiento (ENV o Sheet) + Catálogo (siempre Sheet) =====
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

  const baseText = (BEHAVIOR_SOURCE === "env")
    ? await loadBehaviorTextFromEnv()
    : await loadBehaviorTextFromSheet();

  let catalogText = "";
  try {
    const products = await loadProductsFromSheet();
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

// ========= Persistencia NoSQL (MongoDB) =========
async function ensureOpenConversation(waId) {
  const db = await getDb();
  let conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
  if (!conv) {
    const doc = {
      waId,
      status: "OPEN", // OPEN | COMPLETED | CANCELLED
      finalized: false, // idempotencia
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

  const updated = !!res?.value?.finalized;
  if (!updated) return { didFinalize: false };

  try {
    await saveCompletedToSheets({ waId: res.value.waId, data: finalPayload || {} });
    return { didFinalize: true };
  } catch (e) {
    console.error("⚠️ Error guardando en Sheets tras finalizar:", e);
    return { didFinalize: true, sheetsError: e?.message };
  }
}

// ========= Sesiones (historial en memoria) =========
const sessions = new Map(); // waId -> { messages, updatedAt }

async function getSession(waId) {
  if (!sessions.has(waId)) {
    const systemText = await buildSystemPrompt({ force: true });
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

// ========= Chat con historial (system refrescado + parser robusto) =========
async function chatWithHistoryJSON(
  waId,
  userText,
  model = CHAT_MODEL,
  temperature = CHAT_TEMPERATURE
) {
  const session = await getSession(waId);

  // refrescar system por turno
  try {
    const systemText = await buildSystemPrompt({ force: true });
    session.messages[0] = { role: "system", content: systemText };
  } catch (e) {
    console.warn("⚠️ No se pudo refrescar system:", e.message);
  }

  pushMessage(session, "user", userText);

  let completion;
  try {
    completion = await retry(
      async () => withTimeout(
        openai.chat.completions.create({
          model,
          response_format: { type: "json_object" },
          temperature,
          top_p: 1,
          messages: [ ...session.messages ]
        }),
        Number(process.env.OPENAI_TIMEOUT_MS || 12000),
        "openai_chat"
      ),
      { retries: Number(process.env.OPENAI_RETRIES || 2), baseDelay: 500 }
    );
  } catch (e) {
    console.error("❌ OpenAI error:", e);
    const fallback = {
      response: "Estoy con demoras técnicas para responder. ¿Podés repetir tu consulta en un mensaje más corto o darme un dato más?",
      estado: "IN_PROGRESS"
    };
    pushMessage(session, "assistant", fallback.response);
    return { response: fallback.response, estado: fallback.estado, raw: fallback };
  }

  const content = completion?.choices?.[0]?.message?.content || "";
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

// ========= WhatsApp send / mark =========
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

// --- Cola por usuario (mutex simple) ---
const queues = new Map(); // waId -> Promise

function enqueueUserTask(waId, taskFn){
  const prev = queues.get(waId) || Promise.resolve();
  const next = prev.then(() => taskFn()).catch(e => {
    console.error("⚠️ Error en tarea de cola:", e);
  });
  const cleaned = next.finally(() => {
    if (queues.get(waId) === cleaned) queues.delete(waId);
  });
  queues.set(waId, cleaned);
  return cleaned;
}

// ========= Rutas =========
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
    // Respondemos 200 lo antes posible
    res.sendStatus(200);

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const messages = value.messages || [];
        if (!messages.length) continue;

        for (const msg of messages) {
          const phoneNumberId = value.metadata?.phone_number_id;
          const from = msg.from; // E.164 sin '+'

          await enqueueUserTask(from, async () => {
            console.log(`▶️ start task ${from} msg:${msg.id}`);

            const type = msg.type;
            const messageId = msg.id;

            if (messageId && phoneNumberId) markAsRead(messageId, phoneNumberId).catch(() => {});

            // ---- Normalizar entrada del usuario ----
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

            console.log("📩 IN:", { from, type, preview: (userText || "").slice(0, 120) });

            // === Persistencia: asegurar conversación abierta y registrar turno del usuario ===
            const conv = await ensureOpenConversation(from);
            await appendMessage(conv._id, {
              role: "user",
              content: userText,
              type,
              meta: userMeta
            });

            // ---- Modelo con historial (system refrescado por turno) + parser robusto ----
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
              console.error("❌ OpenAI error final:", e);
            }

            // ---- Envío a WhatsApp con reintento
            let whatsappSent = false;
            try {
              await sendText(from, responseText, phoneNumberId);
              whatsappSent = true;
            } catch(e){
              console.error("❌ sendText falló, reintento:", e.message);
              try {
                await sendText(from, "Tuve un problema para responder. ¿Podés repetir en un mensaje corto?", phoneNumberId);
                whatsappSent = true;
              } catch(e2){
                console.error("❌ sendText reintento falló:", e2.message);
              }
            }
            if (!whatsappSent) {
              await appendMessage(conv._id, {
                role: "assistant",
                content: "[ERROR] No se pudo enviar respuesta a WhatsApp.",
                type: "text",
                meta: { error: "whatsapp_send_failed" }
              });
            }
            console.log("📤 OUT →", from, "| estado:", estado);

            // ---- Persistencia: turno del assistant
            await appendMessage(conv._id, {
              role: "assistant",
              content: responseText,
              type: "text",
              meta: { estado }
            });

            // ---- Si el usuario envió AUDIO, responder TAMBIÉN con AUDIO (TTS)
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

            // ---- Guardar en Sheets y cerrar conversación cuando NO esté en curso (idempotente)
            const shouldFinalize =
              (estado && estado !== "IN_PROGRESS") ||
              ((raw?.Pedido?.["Estado pedido"] || "").toLowerCase().includes("cancel"));

            if (shouldFinalize) {
              try {
                const result = await finalizeConversationOnce(conv._id, raw, estado);
                if (result.didFinalize) {
                  resetSession(from); // limpia historial en memoria
                  console.log("🔁 Historial reiniciado para", from, "| estado:", estado);
                  if (result.sheetsError) {
                    console.warn("⚠️ Sheets guardado con error (pero finalizado igual):", result.sheetsError);
                  } else {
                    console.log("🧾 Guardado en Google Sheets (idempotente) para", from, "estado", estado);
                  }
                } else {
                  console.log("ℹ️ Ya estaba finalizada; no se guarda en Sheets de nuevo.");
                }
              } catch (e) {
                console.error("⚠️ Error al finalizar conversación:", e);
              }
            }

            console.log(`⏹ end task ${from} msg:${msg.id}`);
          });
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error en webhook:", err);
  }
});

// ========= Start =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));
