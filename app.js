// server.js
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai");
const { google } = require("googleapis");

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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: parseo seguro de JSON (limpia fences si aparecieran)
function safeJsonParse(raw) {
  if (raw == null) return null;
  let txt = String(raw).trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    console.error("❌ No se pudo parsear JSON:", e.message, "\nRaw:", raw);
    return null;
  }
}

// ========= Sesiones (historial) =========
const comportamiento = process.env.COMPORTAMIENTO ||
  "Sos un asistente claro, amable y conciso. Respondé en español.";

const sessions = new Map(); // waId -> { messages, updatedAt }

/** Crea/obtiene sesión por waId */
function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      messages: [{ role: "system", content: comportamiento }],
      updatedAt: Date.now()
    });
  }
  return sessions.get(waId);
}

/** Reinicia (borra) la sesión del usuario */
function resetSession(waId) {
  sessions.delete(waId);
}

/** Agrega mensaje y recorta historial (últimos 20 turnos) */
function pushMessage(session, role, content, maxTurns = 20) {
  session.messages.push({ role, content });
  const system = session.messages[0];
  const tail = session.messages.slice(-2 * maxTurns);
  session.messages = [system, ...tail];
  session.updatedAt = Date.now();
}

// ========= WhatsApp / Media helpers =========
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "https://transcribegpt-569454200011.northamerica-northeast1.run.app").trim().replace(/\/+$/,"");
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10); // 5 min
const TRANSCRIBE_FORCE_GET = process.env.TRANSCRIBE_FORCE_GET === "true";

// ---- Cache en memoria de binarios (audio e imagen) ----
const fileCache = new Map(); // id -> { buffer, mime, expiresAt }
function makeId(n = 16) { return crypto.randomBytes(n).toString("hex"); }
function getBaseUrl(req) {
  let base = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/,"");
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
// 👉 Nuevo: servir audios TTS
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

// ---- Transcriptor externo: JSON {audio_url}, luego multipart file, luego GET ----
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime, filename = "audio.ogg" }) {
  const base = TRANSCRIBE_API_URL;

  try {
    const ah = new URL(publicAudioUrl).host;
    const th = new URL(base).host;
    if (ah === th) console.warn("⚠️ CONFIG: PUBLIC_BASE_URL y TRANSCRIBE_API_URL comparten host.");
  } catch {}

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
    function buildMultipart(bodyParts) {
      const boundary = "----NodeForm" + crypto.randomBytes(8).toString("hex");
      const chunks = [];
      for (const part of bodyParts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (part.type === "file") {
          const headers =
            `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType || "application/octet-stream"}\r\n\r\n`;
          chunks.push(Buffer.from(headers));
          chunks.push(part.data);
          chunks.push(Buffer.from("\r\n"));
        } else {
          const headers = `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`;
          chunks.push(Buffer.from(headers));
          chunks.push(Buffer.from(String(part.value)));
          chunks.push(Buffer.from("\r\n"));
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
// Aceptar ID o URL en GOOGLE_SHEETS_ID
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
  const spreadsheetId = getSpreadsheetIdFromEnv(); // valida
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

// ===== Productos desde Google Sheets (pestaña Productos: A nombre, B precio, C venta) =====
const PRODUCTS_CACHE_TTL_MS = parseInt(process.env.PRODUCTS_CACHE_TTL_MS || "300000", 10); // 5 min
let productsCache = { at: 0, items: [] };

async function loadProductsFromSheet() {
  const now = Date.now();
  if (now - productsCache.at < PRODUCTS_CACHE_TTL_MS && productsCache.items?.length) {
    return productsCache.items;
  }
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const range = "Productos!A2:C"; // salteo de encabezados
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = resp.data.values || [];

  const items = rows.map((r) => {
    const nombre = (r[0] || "").trim();
    const precioRaw = (r[1] || "").toString().trim();
    const venta = (r[2] || "").trim();
    if (!nombre) return null;
    const precioNum = Number(precioRaw.replace(/[^\d.,-]/g, "").replace(",", "."));
    const precio = Number.isFinite(precioNum) ? precioNum : precioRaw;
    return { nombre, precio, venta };
  }).filter(Boolean);

  productsCache = { at: now, items };
  return items;
}
function buildProductsSystemMessage(items) {
  if (!items?.length) return "Catálogo actual: (sin datos de productos)";
  const lines = items.map(it => {
    const precioFmt = (typeof it.precio === "number") ? `$${it.precio}` : `${it.precio}`;
    const venta = it.venta ? ` (${it.venta})` : "";
    return `- ${it.nombre} — ${precioFmt}${venta}`;
  });
  return ["Catálogo de productos (nombre — precio (modo de venta)):", ...lines].join("\n");
}

// ========= Chat con historial (inyecta catálogo) =========
async function chatWithHistoryJSON(
  waId,
  userText,
  model = process.env.OPENAI_MODEL || "gpt-4o-mini"
) {
  const session = getSession(waId);
  pushMessage(session, "user", userText);

  // Catálogo de productos como system extra
  let catalogMsg = "Catálogo actual: (sin datos de productos)";
  try {
    const products = await loadProductsFromSheet();
    catalogMsg = buildProductsSystemMessage(products);
  } catch (e) {
    console.warn("⚠️ No se pudo cargar Productos del Sheet:", e.message);
  }

  const completion = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      ...session.messages,
      { role: "system", content: catalogMsg },
      {
        role: "system",
        content:
          "Respondé SOLO con JSON válido (sin ```). Estructura: " +
          '{ "response": "texto para WhatsApp", "estado": "IN_PROGRESS|COMPLETED",' +
          '  "Pedido"?: { "Fecha y hora de inicio de conversacion": string, "Fecha y hora fin de conversacion": string, "Estado pedido": string, "Motivo cancelacion": string, "Pedido pollo": string, "Pedido papas": string, "Milanesas comunes": string, "Milanesas Napolitanas": string, "Ensaladas": string, "Bebidas": string, "Monto": number, "Nombre": string, "Entrega": string, "Domicilio": string, "Fecha y hora de entrega": string, "Hora": string },' +
          '  "Bigdata"?: { "Sexo": string, "Estudios": string, "Satisfaccion del cliente": number, "Motivo puntaje satisfaccion": string, "Cuanto nos conoce el cliente": number, "Motivo puntaje conocimiento": string, "Motivo puntaje general": string, "Perdida oportunidad": string, "Sugerencias": string, "Flujo": string, "Facilidad en el proceso de compras": number, "Pregunto por bot": string } } ' +
          "Usá el catálogo provisto para nombres y precios. Si falta un dato, pedilo amablemente."
      }
    ],
    temperature: 0.6
  });

  const content = completion.choices?.[0]?.message?.content || "";
  const data = safeJsonParse(content) || {};

  const responseText =
    (typeof data.response === "string" && data.response.trim()) ||
    (typeof content === "string" ? content.trim() : "") ||
    "Perdón, no pude generar una respuesta. ¿Podés reformular?";

  const estado =
    (typeof data.estado === "string" && data.estado.trim().toUpperCase()) || "IN_PROGRESS";

  pushMessage(session, "assistant", responseText);
  return { response: responseText, estado, raw: data };
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
    // Responder 200 rápido
    res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const msg = value.messages?.[0];
        if (!msg) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        const from = msg.from; // E.164 sin '+'
        const type = msg.type;
        const messageId = msg.id;

        if (messageId && phoneNumberId) markAsRead(messageId, phoneNumberId).catch(() => {});

        // ---- Normalizar entrada ----
        let userText = "";

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

              try {
                const trData = await transcribeAudioExternal({ publicAudioUrl: publicUrl, buffer, mime: info.mime_type, filename: "audio.ogg" });
                const transcript = trData.text || trData.transcript || trData.transcription || trData.result || "";
                userText = transcript
                  ? `Transcripción del audio del usuario: "${transcript}"`
                  : "No obtuve texto de la transcripción. ¿Podés escribir tu consulta?";
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

              const text = await transcribeImageWithOpenAI(publicUrl);
              userText = text
                ? `Texto detectado en la imagen: "${text}"`
                : "No pude detectar texto en la imagen. ¿Podés escribir lo que dice?";
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

        // ---- Modelo con historial + catálogo ----
        let responseText = "Perdón, no pude generar una respuesta. ¿Podés reformular?";
        let estado = "IN_PROGRESS";
        let raw = null;
        try {
          const out = await chatWithHistoryJSON(from, userText);
          responseText = out.response || responseText;
          estado = (out.estado || "IN_PROGRESS").toUpperCase();
          raw = out.raw || null;
        } catch (e) {
          console.error("❌ OpenAI error:", e);
        }

        // ---- Responder por texto SIEMPRE
        await sendText(from, responseText, phoneNumberId);
        console.log("📤 OUT →", from, "| estado:", estado);

        // ---- Y si el usuario mandó AUDIO, responder TAMBIÉN con AUDIO (TTS)
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

        // ---- Si COMPLETED, guardar en Sheets y reiniciar ----
        if (estado === "COMPLETED") {
          try {
            await saveCompletedToSheets({ waId: from, data: raw });
            console.log("🧾 Guardado en Google Sheets (Hoja 1 & BigData) para", from);
          } catch (e) {
            console.error("⚠️ Error guardando en Google Sheets:", e);
          }
          resetSession(from);
          console.log("🔁 Historial reiniciado para", from);
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
