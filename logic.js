// ========================= logic.js =========================
// Mueve TODA la lógica acá. Los endpoints en app.js importan desde este módulo.
// Mantiene firmas y comportamiento para no romper nada.

require("dotenv").config();

const crypto = require("crypto");
const OpenAI = require("openai");
const { google } = require("googleapis");
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");

// ------- OpenAI -------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHAT_TEMPERATURE = Number.isFinite(parseFloat(process.env.OPENAI_TEMPERATURE))
  ? parseFloat(process.env.OPENAI_TEMPERATURE)
  : 0.2;

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms))
  ]);
}

// ------- JSON helpers -------
function escapeRegExp(s) { return String(s).replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"); }
function coerceJsonString(raw) {
  if (raw == null) return null;
  let s = String(raw);
  s = s.replace(/^\uFEFF/, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, " ").trim();
  if (s.startsWith("```")) s = s.replace(/^```(\w+)?/i, "").replace(/```$/i, "").trim();
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  if (s.startsWith("{") && s.endsWith("}")) return s;
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return s.slice(first, last + 1).trim();
  return s;
}
async function safeJsonParseStrictOrFix(raw, { openaiClient = openai, model = "gpt-4o-mini" } = {}) {
  let s = coerceJsonString(raw);
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) {}
  try {
    const fix = await openaiClient.chat.completions.create({
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
    try { return JSON.parse(s); } catch (e3) { return null; }
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
async function sendText(to, body, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body } };
  const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await resp.json();
  if (!resp.ok) console.error("❌ Error WhatsApp sendText:", resp.status, data);
  return data;
}
async function sendSafeText(to, body, value) {
  const phoneNumberId = getPhoneNumberId(value);
  if (!phoneNumberId) return { error: "missing_phone_number_id" };
  try { return await sendText(to, body, phoneNumberId); } catch (e) { return { error: e.message || "send_failed" }; }
}
async function markAsRead(messageId, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", status: "read", message_id: messageId };
  const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!resp.ok) { const data = await resp.json().catch(() => ({})); console.warn("⚠️ markAsRead falló:", resp.status, data); }
}
async function getMediaInfo(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) { const data = await resp.json().catch(() => ({})); throw new Error(`Media info error: ${resp.status} ${JSON.stringify(data)}`); }
  return resp.json();
}
async function downloadMediaBuffer(mediaUrl) {
  const token = process.env.WHATSAPP_TOKEN;
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Media download error: ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
async function transcribeImageWithOpenAI(publicImageUrl) {
  const url = "https://api.openai.com/v1/chat/completions";
  const body = { model: "o4-mini", messages: [ { role: "system", content: "Muestra solo el texto sin saltos de linea ni caracteres especiales que veas en la imagen" }, { role: "user", content: [{ type: "image_url", image_url: { url: publicImageUrl } }] } ], temperature: 1 };
  const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`OpenAI vision error: ${resp.status}`);
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime, filename = "audio.ogg" }) {
  const base = TRANSCRIBE_API_URL;
  const paths = ["", "/transcribe", "/api/transcribe", "/v1/transcribe"];
  // 1) POST JSON { audio_url }
  for (const p of paths) {
    const url = `${base}${p}`;
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio_url: publicAudioUrl }) });
    if (r.ok) return await r.json().catch(() => ({}));
  }
  // 2) multipart file
  if (buffer && buffer.length) {
    function buildMultipart(parts) {
      const boundary = "----NodeForm" + crypto.randomBytes(8).toString("hex");
      const chunks = [];
      for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (part.type === "file") {
          const headers = `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType || "application/octet-stream"}\r\n\r\n`;
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
      if (r.ok) return await r.json().catch(() => ({}));
    }
  }
  // 3) GET ?audio_url=
  for (const p of paths) {
    const url = `${base}${p}?audio_url=${encodeURIComponent(publicAudioUrl)}`;
    const g = await fetch(url);
    if (g.ok) return await g.json().catch(() => ({}));
  }
  throw new Error("No hubo variantes válidas para el endpoint de transcripción.");
}
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
  const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await resp.json();
  if (!resp.ok) console.error("❌ Error WhatsApp sendAudioLink:", resp.status, data);
  return data;
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
async function loadProductsFromMongo() {
  const db = await getDb();
  const docs = await db.collection("products").find({ active: { $ne: false } }).sort({ createdAt: -1, descripcion: 1 }).toArray();
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
async function loadProductsFromSheet() {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Productos!A2:D" });
  const rows = resp.data.values || [];
  return rows.map(r => ({
    descripcion: (r[0] || "").trim(),
    importe: r[1] ? Number(String(r[1]).replace(/[^\d.,-]/g, "").replace(",", ".")) : null,
    observacion: (r[2] || "").trim(),
    active: String(r[3] || "true").toLowerCase() !== "false"
  }));
}
function buildCatalogText(products) {
  if (!Array.isArray(products) || !products.length) return "No hay productos disponibles por el momento.";
  const list = products.filter(p => p && p.active !== false);
  function fmtMoney(n) { const v = Number(n); if (!Number.isFinite(v)) return ""; return "$" + (Number.isInteger(v) ? String(v) : v.toFixed(2)); }
  const lines = [];
  for (const p of list) {
    const desc = String(p.descripcion || "").trim();
    const price = (p.importe != null) ? fmtMoney(p.importe) : "";
    const obs = String(p.observacion || "").trim();
    let line = `- ${desc}`; if (price) line += ` - ${price}`; if (obs) line += ` — Obs: ${obs}`; lines.push(line);
  }
  return lines.length ? lines.join("\n") : "No hay productos activos en el catálogo.";
}
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
    "FORMATO DE RESPUESTA (OBLIGATORIO - SOLO JSON, sin ```):\n" +
    '{ "response": "texto para WhatsApp", "estado": "IN_PROGRESS|COMPLETED|CANCELLED", ' +
    '  "Pedido"?: { "Fecha y hora de inicio de conversacion": string, "Fecha y hora fin de conversacion": string, "Estado pedido": string, "Motivo cancelacion": string, "Pedido pollo": string, "Pedido papas": string, "Milanesas comunes": string, "Milanesas Napolitanas": string, "Ensaladas": string, "Bebidas": string, "Monto": number, "Nombre": string, "Entrega": string, "Domicilio": string, "Fecha y hora de entrega": string, "Hora": string }, ' +
    '  "Bigdata"?: { "Sexo": string, "Estudios": string, "Satisfaccion del cliente": number, "Motivo puntaje satisfaccion": string, "Cuanto nos conoce el cliente": number, "Motivo puntaje conocimiento": string, "Motivo puntaje general": string, "Perdida oportunidad": string, "Sugerencias": string, "Flujo": string, "Facilidad en el proceso de compras": number, "Pregunto por bot": string } }';
  const fullText = [
    "[COMPORTAMIENTO]\n" + baseText,
    "[CATALOGO]\n" + catalogText,
    "[SALIDA]\n" + jsonSchema,
    "RECORDATORIOS: Respondé en español. No uses bloques de código. Devolvé SOLO JSON plano."
  ].join("\n\n").trim();
  behaviorCache = { at: now, text: fullText };
  return fullText;
}

// ------- Conversaciones / mensajes / órdenes -------
async function bumpConversationTokenCounters(conversationId, tokens, role = "assistant") {
  try {
    const db = await getDb();
    const prompt = (tokens && typeof tokens.prompt === "number") ? tokens.prompt : 0;
    const completion = (tokens && typeof tokens.completion === "number") ? tokens.completion : 0;
    const total = (tokens && typeof tokens.total === "number") ? tokens.total : (prompt + completion);
    const inc = { "counters.messages_total": 1, "counters.tokens_prompt_total": prompt, "counters.tokens_completion_total": completion, "counters.tokens_total": total };
    if (role === "assistant") inc["counters.messages_assistant"] = 1; else if (role === "user") inc["counters.messages_user"] = 1;
    const set = { updatedAt: new Date() }; if (tokens) set["last_usage"] = tokens;
    await db.collection("conversations").updateOne({ _id: conversationId }, { $inc: inc, $set: set });
  } catch (err) { console.warn("⚠️ bumpConversationTokenCounters error:", err?.message || err); }
}
async function ensureOpenConversation(waId, { contactName = null } = {}) {
  const db = await getDb();
  let conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
  if (!conv) {
    const behaviorText = await buildSystemPrompt({ force: true });
    const doc = { waId, status: "OPEN", finalized: false, contactName: contactName || null, openedAt: new Date(), closedAt: null, lastUserTs: null, lastAssistantTs: null, turns: 0, behaviorSnapshot: { text: behaviorText, source: (process.env.BEHAVIOR_SOURCE || "sheet").toLowerCase(), savedAt: new Date() } };
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
  const doc = { conversationId: new ObjectId(conversationId), role, content, type, meta, ts: new Date() };
  if (ttlDays && Number.isFinite(ttlDays)) doc.expireAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await db.collection("messages").insertOne(doc);
  const upd = { $inc: { turns: 1 }, $set: {} };
  if (role === "user") upd.$set.lastUserTs = doc.ts;
  if (role === "assistant") upd.$set.lastAssistantTs = doc.ts;
  await db.collection("conversations").updateOne({ _id: new ObjectId(conversationId) }, upd);
}
function normalizeOrder(waId, contactName, pedido) {
  const entrega = pedido?.["Entrega"] || "";
  const domicilio = pedido?.["Domicilio"] || "";
  const monto = Number(pedido?.["Monto"] ?? 0) || 0;
  const items = [];
  for (const key of ["Pedido pollo","Pedido papas","Milanesas comunes","Milanesas Napolitanas","Ensaladas","Bebidas"]) {
    const val = (pedido?.[key] || "").toString().trim();
    if (val && val.toUpperCase() !== "NO") items.push({ name: key, selection: val });
  }
  const name = pedido?.["Nombre"] || contactName || "";
  const fechaEntrega = pedido?.["Fecha y hora de entrega"] || "";
  const hora = pedido?.["Hora"] || "";
  const estadoPedido = pedido?.["Estado pedido"] || "";
  return { waId, name, entrega, domicilio, items, amount: monto, estadoPedido, fechaEntrega, hora, createdAt: new Date(), processed: false };
}
async function saveCompletedToSheets({ waId, data }) {
  try {
    const spreadsheetId = getSpreadsheetIdFromEnv();
    const sheets = getSheetsClient();
    const now = new Date();
    const pedido = data?.Pedido || {};
    const values = [[
      now.toISOString(),
      waId,
      data?.estado || "",
      data?.response || "",
      pedido["Nombre"] || "",
      pedido["Entrega"] || "",
      pedido["Domicilio"] || "",
      pedido["Monto"] ?? "",
      JSON.stringify(pedido || {})
    ]];
    await sheets.spreadsheets.values.append({ spreadsheetId, range: "Conversaciones!A1", valueInputOption: "USER_ENTERED", requestBody: { values } });
  } catch (e) { console.warn("⚠️ saveCompletedToSheets error:", e.message); }
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
      return await withTimeout(
        openai.chat.completions.create({ model, response_format: { type: "json_object" }, temperature, top_p: 1, messages }),
        parseInt(process.env.OPENAI_TIMEOUT_MS || "12000", 10),
        "openai_chat"
      );
    } catch (e) {
      lastErr = e; const msg = (e && e.message) ? e.message : String(e);
      const retriable = /timeout/i.test(msg) || e?.status === 429 || e?.code === "ETIMEDOUT" || e?.code === "ECONNRESET";
      if (attempt < maxRetries && retriable) { const jitter = Math.floor(Math.random() * 250); const delay = baseDelay * (2 ** attempt) + jitter; await new Promise(r => setTimeout(r, delay)); continue; }
      break;
    }
  }
  throw lastErr || new Error("openai_chat_failed");
}
async function chatWithHistoryJSON(waId, userText, model = CHAT_MODEL, temperature = CHAT_TEMPERATURE) {
  const session = await getSession(waId);
  try { const db = await getDb(); const conv = await db.collection("conversations").findOne({ waId, status: "OPEN" }); if (conv) session.messages[0] = { role: "system", content: await buildSystemPrompt({ conversation: conv }) }; } catch {}
  pushMessage(session, "user", userText);
  const resp = await openaiChatWithRetries(session.messages, { model, temperature });
  const msg = resp.choices?.[0]?.message?.content || "";
  const usage = resp.usage || null;
  const parsed = await safeJsonParseStrictOrFix(msg, { openaiClient: openai, model });
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
  bumpConversationTokenCounters, ensureOpenConversation, appendMessage, normalizeOrder, finalizeConversationOnce,
  // Sesiones + chat
  sessions, getSession, resetSession, pushMessage, openaiChatWithRetries, chatWithHistoryJSON,
  // Sheets helpers (exportados por si un endpoint los necesita)
  getSpreadsheetIdFromEnv, getSheetsClient, saveCompletedToSheets,
  ObjectId
};
