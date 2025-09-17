// ========================= logic.js (versión simplificada) =========================
// Mantiene firmas/exports para no romper app.js, pero reduce validaciones y
// deja que la mayoría de las reglas vivan en el comportamiento (prompt).
require("dotenv").config();

const crypto = require("crypto");
const OpenAI = require("openai");
const { google } = require("googleapis");
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");

// --- Multi-tenant (empresa)
const TENANT_ID = (process.env.TENANT_ID || "").trim() || null;

// --- OpenAI
const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHAT_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0.3) || 0.3;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Utilidades
function escapeRegExp(s) { return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function withTimeout(promise, ms, onTimeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(onTimeoutMessage || "timeout")), ms))
  ]);
}

function coerceJsonString(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  return str;
}


function buildChatRequest(messages, { model = CHAT_MODEL, temperature = CHAT_TEMPERATURE } = {}) {
  return {
    model,
    temperature,
    messages,
    response_format: { type: "json_object" }
  };
}




// parseo tolerante: intenta JSON.parse; si falla, extrae el mayor bloque {...}
async function safeJsonParseStrictOrFix(s, { openaiClient = null, model = CHAT_MODEL } = {}) {
  try { return JSON.parse(String(s)); } catch {}
  const str = String(s || "");
  const i = str.indexOf("{"), j = str.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try { return JSON.parse(str.slice(i, j + 1)); } catch {}
  }
  // Último recurso: si nos pasan un client, pedimos “fix JSON” (pero sin forzar).
  if (openaiClient && str.trim()) {
    try {
      const r = await openaiClient.chat.completions.create({
        model, temperature: 0,
        messages: [
          { role: "system", content: "Repara el JSON del usuario. Devolvé SOLO JSON válido, sin texto extra." },
          { role: "user", content: str.slice(0, 6000) }
        ],
        response_format: { type: "json_object" }
      });
      const content = r.choices?.[0]?.message?.content;
      if (content) return JSON.parse(content);
    } catch {}
  }
  return null;
}

// ================== Fecha/Hora local para el modelo ==================
const STORE_TZ = (process.env.STORE_TZ || "America/Argentina/Cordoba").trim();
const SIMULATED_NOW_ISO = (process.env.SIMULATED_NOW_ISO || "").trim();
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

// ================== WhatsApp / media / cache ==================
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "").trim().replace(/\/+$/, "");
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
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  phoneNumberId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error("whatsapp_not_configured");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body: String(body||"").slice(0,4096) } };
  const resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!resp.ok) throw new Error(`whatsapp_send_failed_${resp.status}`);
  return resp.json().catch(() => ({ ok: true }));
}
async function sendSafeText(to, body, value) {
  try { return await sendText(to, body, getPhoneNumberId(value)); }
  catch (e) { console.warn("sendSafeText warn:", e?.message || e); return null; }
}
async function markAsRead(messageId, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  phoneNumberId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId || !messageId) return;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", status: "read", message_id: messageId };
  await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(()=>{});
}
async function getMediaInfo(mediaId) {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !mediaId) throw new Error("media_info_missing");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const resp = await fetch(`${url}?fields=url,mime_type`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`media_info_failed_${resp.status}`);
  return resp.json();
}
async function downloadMediaBuffer(mediaUrl) {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`download_media_failed_${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}
async function transcribeImageWithOpenAI(publicImageUrl) {
  try {
    const r = await openai.chat.completions.create({
      model: CHAT_MODEL, temperature: 0,
      messages: [
        { role: "system", content: "Extraé el texto visible de la imagen (si hay)." },
        { role: "user", content: `Imagen: ${publicImageUrl}` }
      ]
    });
    return r.choices?.[0]?.message?.content?.trim() || "";
  } catch { return ""; }
}
async function transcribeAudioExternal({ publicAudioUrl, buffer, mime }) {
  // 1) servicio externo si está configurado
  const prefer = TRANSCRIBE_API_URL;
  if (prefer && publicAudioUrl) {
    try {
      const r = await fetch(`${prefer}/transcribe?url=${encodeURIComponent(publicAudioUrl)}`);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j && typeof j.text === "string") return { text: j.text, usage: j.tokens || j.usage || null };
      }
    } catch {}
  }
  // 2) fallback: OpenAI audio
  try {
    let buf = buffer, mt = mime;
    if (!buf && publicAudioUrl) {
      const r2 = await fetch(publicAudioUrl);
      mt = r2.headers.get("content-type") || mime || "audio/ogg";
      const ab = await r2.arrayBuffer(); buf = Buffer.from(ab);
    }
    if (!buf) return { text: "" };
    const model = process.env.WHISPER_MODEL || process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
    const file = new File([buf], `audio.${(mt||"").includes("wav")?"wav":(mt||"").includes("mp3")?"mp3":((mt||"").includes("ogg")|| (mt||"").includes("opus"))?"ogg":"mp3"}`, { type: mt || "audio/ogg" });
    const r = await openai.audio.transcriptions.create({ file, model });
    return { text: r.text || "", usage: r.usage || null };
  } catch { return { text: "" }; }
}
async function synthesizeTTS(text) {
  try {
    const r = await openai.audio.speech.create({
      model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.TTS_VOICE || "alloy",
      input: String(text || "").slice(0, 1000)
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { buffer: buf, mime: "audio/mpeg" };
  } catch { return { buffer: null, mime: null }; }
}
async function sendAudioLink(to, publicUrl, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  phoneNumberId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId || !publicUrl) return;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "audio", audio: { link: publicUrl } };
  await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(()=>{});
}

// ================== Comportamiento / catálogo ==================
const COMPORTAMIENTO_CACHE_TTL_MS = parseInt(process.env.BEHAVIOR_CACHE_TTL_MS || "120000", 10);
let behaviorCache = { at: 0, text: null };
const BEHAVIOR_SOURCE = (process.env.BEHAVIOR_SOURCE || "mongo").toLowerCase(); // env | mongo | sheet

async function loadBehaviorTextFromEnv() {
  const s = String(process.env.COMPORTAMIENTO || "").trim();
  return s || "Sos un asistente claro, amable y conciso. Respondé en español. Devolvé SOLO JSON.";
}
async function loadBehaviorTextFromMongo() {
  const db = await getDb();
  const key = TENANT_ID ? `behavior:${TENANT_ID}` : "behavior";
  let doc = await db.collection("settings").findOne({ _id: key });
  if (doc?.text?.trim()) return doc.text.trim();
  if (key !== "behavior") {
    const global = await db.collection("settings").findOne({ _id: "behavior" });
    if (global?.text?.trim()) return global.text.trim();
  }
  const fallback = "Sos un asistente claro, amable y conciso. Respondé en español. Devolvé SOLO JSON.";
  await db.collection("settings").updateOne({ _id: key }, { $setOnInsert: { text: fallback, updatedAt: new Date() } }, { upsert: true });
  return fallback;
}
async function saveBehaviorTextToMongo(newText) {
  const db = await getDb();
  const key = TENANT_ID ? `behavior:${TENANT_ID}` : "behavior";
  await db.collection("settings").updateOne({ _id: key }, { $set: { text: String(newText||"").trim(), updatedAt: new Date() } }, { upsert: true });
  behaviorCache = { at: 0, text: null };
}
async function loadBehaviorTextFromSheet(){ return ""; } // simplificado

async function loadProductsFromMongo() {
  const db = await getDb();
  const filter = { active: { $ne: false } };
  if (TENANT_ID) filter.tenantId = TENANT_ID;
  const docs = await db.collection("products").find(filter).sort({ createdAt: -1, descripcion: 1 }).toArray();
  const toNumber = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  return docs.map(d => ({
    descripcion: d.descripcion || d.description || d.nombre || d.title || "",
    importe: toNumber(d.importe ?? d.precio ?? d.price ?? d.monto),
    observacion: d.observacion || d.observaciones || d.nota || d.note || "",
    active: d.active !== false
  }));
}
async function loadProductsFromSheet(){ return []; } // simplificado
function buildCatalogText(products) {
  if (!Array.isArray(products) || !products.length) return "No hay productos disponibles por el momento.";
  const list = products.filter(p => p && p.active !== false);
  const money = (n) => { const v = Number(n); return Number.isFinite(v) ? "$" + (Number.isInteger(v) ? String(v) : v.toFixed(2)) : ""; };
  const lines = [];
  for (const p of list) {
    const desc = String(p.descripcion || "").trim();
    const price = (p.importe != null) ? money(p.importe) : "";
    lines.push(`• ${desc}${price ? ` — ${price}` : ""}`);
  }
  return lines.join("\n");
}
function invalidateBehaviorCache(){ behaviorCache = { at: 0, text: null }; }

function getSpreadsheetIdFromEnv(){ return null; } // stub
function getSheetsClient(){ return google.sheets("v4"); } // stub (no usado)
async function saveCompletedToSheets(){ /* opcional: stub */ }

// Construye el prompt completo, cacheado, con COMPORTAMIENTO + CATALOGO
async function buildSystemPrompt({ force = false, conversation = null } = {}) {
  const now = Date.now();
  if (!force && behaviorCache.text && (now - behaviorCache.at) < COMPORTAMIENTO_CACHE_TTL_MS) return behaviorCache.text;

  let baseText = "";
  if (BEHAVIOR_SOURCE === "env") baseText = await loadBehaviorTextFromEnv();
  else if (BEHAVIOR_SOURCE === "mongo") baseText = await loadBehaviorTextFromMongo();
  else if (BEHAVIOR_SOURCE === "sheet") baseText = await loadBehaviorTextFromSheet();
  else baseText = await loadBehaviorTextFromMongo();

  // catálogo
  const products = await loadProductsFromMongo();
  const catalogText = buildCatalogText(products);

  // guía minimal para empujar al modelo a JSON:
  /*const jsonHint = [
    "[SALIDA]",
    "Devolvé SOLO un objeto JSON plano con esta forma mínima:",
    '{ "response": string, "estado": "IN_PROGRESS" | "COMPLETED" | "CANCELLED", "Pedido"?: { "Nombre"?: string, "Entrega"?: string, "Domicilio"?: string, "Fecha y hora de entrega"?: string, "Hora"?: string, "Estado pedido"?: string, "Motivo cancelacion"?: string, "items"?: [{ "descripcion": string, "cantidad": number, "importe_unitario": number, "total": number }], "Monto"?: number }, "Bigdata"?: object }',
    "No incluyas texto fuera del JSON."
  ].join("\n");*/

  const fullText = [
    buildNowBlock(),
    "[COMPORTAMIENTO]\n" + baseText,
    "[CATALOGO]\n" + catalogText//,    jsonHint
  ].join("\n\n").trim();

  behaviorCache = { at: now, text: fullText };
  return fullText;
}

// ================== Conversaciones / mensajes / órdenes ==================
async function bumpConversationTokenCounters(conversationId, tokens, role = "assistant") {
  try {
    const db = await getDb();
    const prompt = Number(tokens?.prompt_tokens || 0);
    const completion = Number(tokens?.completion_tokens || 0);
    const total = prompt + completion;
    const inc = { "counters.messages_total": 0, "counters.tokens_prompt_total": prompt, "counters.tokens_completion_total": completion, "counters.tokens_total": total };
    if (role === "assistant") inc["counters.messages_assistant"] = 1; else if (role === "user") inc["counters.messages_user"] = 1;
    const set = { updatedAt: new Date() };
    await db.collection("conversations").updateOne({ _id: new ObjectId(conversationId) }, { $inc: inc, $set: set });
  } catch (err) { console.warn("bumpConversationTokenCounters warn:", err?.message || err); }
}

async function ensureOpenConversation(waId, { contactName = null } = {}) {
  const db = await getDb();
  const q = TENANT_ID ? { waId, status: "OPEN", tenantId: TENANT_ID } : { waId, status: "OPEN" };
  let conv = await db.collection("conversations").findOne(q);
  if (!conv) {
    const behaviorText = await buildSystemPrompt({ force: true });
    const doc = {
      tenantId: TENANT_ID || null, waId, status: "OPEN", finalized: false,
      contactName: contactName || null, openedAt: new Date(), closedAt: null,
      lastUserTs: null, lastAssistantTs: null, turns: 0,
      behaviorSnapshot: { text: behaviorText, source: (process.env.BEHAVIOR_SOURCE || "mongo").toLowerCase(), savedAt: new Date() }
    };
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
    role, content: String(content || ""), type, meta: meta || {}, ts: new Date()
  };
  if (ttlDays && Number(ttlDays) > 0) {
    doc.expireAt = new Date(Date.now() + Number(ttlDays) * 24 * 3600 * 1000);
  }
  await db.collection("messages").insertOne(doc);
  try {
    const set = { updatedAt: new Date() };
    if (role === "user") set.lastUserTs = doc.ts;
    if (role === "assistant") set.lastAssistantTs = doc.ts;
    const upd = { $set: set };
    if (role === "assistant") upd.$inc = { turns: 1 };
    await db.collection("conversations").updateOne({ _id: doc.conversationId }, upd);
  } catch (e) { console.warn("appendMessage warn:", e?.message || e); }
}

function parseMoneyLoose(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v || "").replace(/[^\d.,-]/g, "").replace(",", ".");
  const n = Number(s); return Number.isFinite(n) ? n : null;
}

function normalizeOrder(waId, contactName, pedido) {
  const entrega = pedido?.["Entrega"] || "";
  const domicilio = pedido?.["Domicilio"] || "";
  const monto = parseMoneyLoose(pedido?.["Monto"]);
  const items = Array.isArray(pedido?.items) ? pedido.items.map(it => ({
    descripcion: String(it.descripcion || it.name || "").trim(),
    cantidad: Number(it.cantidad || 0) || 0,
    importe_unitario: parseMoneyLoose(it.importe_unitario) || 0,
    total: parseMoneyLoose(it.total) || 0
  })) : [];
  return {
    tenantId: TENANT_ID || null,
    waId, contactName: contactName || pedido?.["Nombre"] || null,
    entrega, domicilio,
    items, monto: Number.isFinite(monto) ? monto : items.reduce((a,x)=>a+(Number(x.total)||0),0),
    createdAt: new Date()
  };
}

async function finalizeConversationOnce(conversationId, finalPayload, estado) {
  const db = await getDb();
  const res = await db.collection("conversations").findOneAndUpdate(
    { _id: new ObjectId(conversationId), finalized: { $ne: true } },
    { $set: { status: estado || "COMPLETED", finalized: true, closedAt: new Date(),
              summary: { response: finalPayload?.response || "", Pedido: finalPayload?.Pedido || null, Bigdata: finalPayload?.Bigdata || null } } },
    { returnDocument: "after" }
  );
  if (!res?.value?.finalized) return { didFinalize: false };
  const conv = res.value;
  try { await saveCompletedToSheets({ waId: conv.waId, data: finalPayload || {} }); } catch (e) { /* opcional */ }
  try {
    if (finalPayload?.Pedido) {
      const pedidoNombre = finalPayload.Pedido["Nombre"];
      if (pedidoNombre && !conv.contactName) {
        await db.collection("conversations").updateOne({ _id: conv._id }, { $set: { contactName: pedidoNombre } });
      }
      const orderDoc = normalizeOrder(conv.waId, pedidoNombre || conv.contactName, finalPayload.Pedido);
      orderDoc.conversationId = conv._id;
      await db.collection("orders").insertOne(orderDoc);
    }
  } catch (e) { console.error("order insert warn:", e); }
  return { didFinalize: true };
}

// ================== Sesiones + chat ==================
const sessions = new Map(); // waId -> { messages, updatedAt }
async function getSession(waId) {
  if (!sessions.has(waId)) {
    const db = await getDb();
    const conv = await db.collection("conversations").findOne(TENANT_ID ? { waId, status: "OPEN", tenantId: TENANT_ID } : { waId, status: "OPEN" });
    const systemText = await buildSystemPrompt({ conversation: conv || null });
    sessions.set(waId, { messages: [{ role: "system", content: systemText }], updatedAt: Date.now() });
  }
  return sessions.get(waId);
}
function resetSession(waId){ sessions.delete(waId); }
function pushMessage(session, role, content, maxTurns = 20) {
  session.messages.push({ role, content });
  const system = session.messages[0];
  const tail = session.messages.slice(1).slice(-2*maxTurns);
  session.messages = [system, ...tail];
  session.updatedAt = Date.now();
}

// Merge de Pedido muy simple (prioriza lo nuevo si viene bien formateado)
function _normItem(it){
  const desc = String(it?.descripcion || it?.name || "").trim();
  const cantidad = Number(it?.cantidad ?? 0) || 0;
  const iu = parseMoneyLoose(it?.importe_unitario);
  const tot = parseMoneyLoose(it?.total);
  const total = Number.isFinite(tot) && tot > 0 ? tot : (Number.isFinite(iu) && cantidad > 0 ? iu*cantidad : 0);
  return { descripcion: desc, cantidad, importe_unitario: iu || 0, total };
}
function _mergeItems(prev=[], next=[]){
  const byKey = new Map(), key = (s)=>String(s||"").toLowerCase().trim();
  for (const p of prev) { const n = _normItem(p); if (n.descripcion) byKey.set(key(n.descripcion), n); }
  for (const p of next) {
    const n = _normItem(p); if (!n.descripcion) continue;
    const k = key(n.descripcion);
    const old = byKey.get(k) || { descripcion:n.descripcion, cantidad:0, importe_unitario:0, total:0 };
    const cantidad = n.cantidad>0 ? n.cantidad : old.cantidad;
    const iu = n.importe_unitario>0 ? n.importe_unitario : old.importe_unitario;
    const total = n.total>0 ? n.total : ((iu>0 && cantidad>0) ? iu*cantidad : old.total);
    byKey.set(k, { descripcion: old.descripcion, cantidad, importe_unitario: iu, total });
  }
  return Array.from(byKey.values()).filter(x=>x.descripcion);
}
function _sumItems(items=[]){
  let acc=0; for (const it of items) { const t = parseMoneyLoose(it?.total); if (Number.isFinite(t) && t>0) acc+=t; } return acc;
}
function mergePedido(prev={}, nuevo={}){
  const base = { ...(prev||{}) };
  for (const k of ["Nombre","Entrega","Domicilio","Fecha y hora de entrega","Hora","Estado pedido","Motivo cancelacion"]) {
    const nv = (nuevo?.[k] ?? "").toString().trim(); if (nv) base[k] = nv;
  }
  const items = _mergeItems(prev?.items||[], nuevo?.items||[]);
  base.items = items;
  base["Monto"] = items.length ? _sumItems(items) : parseMoneyLoose(nuevo?.["Monto"]) ?? parseMoneyLoose(prev?.["Monto"]) ?? 0;
  return base;
}
function _findLastPedidoMemo(messages=[]){
  for (let i=messages.length-1;i>=0;i--){
    const m = messages[i]; if (!m || m.role!=="assistant" || typeof m.content!=="string") continue;
    const mm = m.content.match(/MEMO_PEDIDO=(\{[\s\S]*\})/); if (mm){ try{ return JSON.parse(mm[1]); } catch{} }
  }
  return null;
}
function _slimPedido(p){
  const slim = { ...p };
  if (Array.isArray(slim.items)) slim.items = slim.items.map(({descripcion,cantidad,importe_unitario,total})=>({descripcion,cantidad,importe_unitario,total}));
  return slim;
}
/*
async function openaiChatWithRetries(messages, { model = CHAT_MODEL, temperature = CHAT_TEMPERATURE } = {}) {
  return openai.chat.completions.create({ model, temperature, messages, response_format: { type: "json_object" } });
}*/

async function openaiChatWithRetries(messages, { model = CHAT_MODEL, temperature = CHAT_TEMPERATURE } = {}) {
  const payload = buildChatRequest(messages, { model, temperature });

  // LOG: SOLO el JSON que se envía al ChatGPT (sin prefijos ni texto extra)
  console.log(JSON.stringify(payload));

  return openai.chat.completions.create(payload);
}

function extractShippingFromBehavior(_systemText){ return null; } // simplificado (si querés, extraé un envío fijo)

async function chatWithHistoryJSON(waId, userText, model = CHAT_MODEL, temperature = CHAT_TEMPERATURE, { onTimeoutMessage = "Demora", value } = {}) {
  const session = await getSession(waId);
  pushMessage(session, "user", String(userText || "").slice(0, 4096));

  // Compactar historia si hace falta (sin duplicar system)
  const hist = session.messages;

  // Llamada a OpenAI (con timeout opcional vía env)
  const timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || "30000", 10);
  let resp;
  try {
    resp = await withTimeout(
      openaiChatWithRetries(hist, { model, temperature }),
      timeoutMs,
      onTimeoutMessage
    );
  } catch (e) {
    // En timeout devolvemos un esqueleto para no dejar colgado
    const fallback = { response: String(onTimeoutMessage || "Estoy con demoras, por favor esperá un momento."), estado: "IN_PROGRESS" };
    // NO pusheamos JSON completo al historial; solo el texto “visible”
    pushMessage(session, "assistant", fallback.response);
    return { content: JSON.stringify(fallback), json: fallback, usage: null };
  }

  const msg = resp.choices?.[0]?.message?.content || "";
  const usage = resp.usage || null;

  // Parseo tolerante
  let parsed = await safeJsonParseStrictOrFix(msg, { openaiClient: openai, model });
  if (!parsed || typeof parsed !== "object") parsed = { response: "Listo, ¿algo más?", Pedido: null, estado: "IN_PROGRESS" };
  if (!parsed.response || /^\s*[\{\[]/.test(String(parsed.response))) parsed.response = "Listo, ¿algo más?";

  // Merge de Pedido (tolerante, sin repricing agresivo)
  try {
    if (parsed.Pedido) {
      const previo = _findLastPedidoMemo(session.messages) || {};
      const merged = mergePedido(previo, parsed.Pedido);
      // si hay items y falta/está en 0 el monto, lo fijamos a la suma
      if (Array.isArray(merged.items) && merged.items.length) {
        const sum = _sumItems(merged.items);
        if (!Number.isFinite(merged.Monto) || merged.Monto <= 0) merged.Monto = sum;
      }
      parsed.Pedido = merged;
      // MEMO (solo historial del modelo)
      const memo = "MEMO_PEDIDO=" + JSON.stringify(_slimPedido(merged));
      pushMessage(session, "assistant", memo.slice(0, 6000));
    }
  } catch (e) { console.warn("merge/memo warn:", e?.message || e); }

  // Guardamos solo el texto visible en el historial
  const assistantTextForHistory = String(parsed.response || "Ok.").slice(0, 4096);
  pushMessage(session, "assistant", assistantTextForHistory);

  console.log('RESPUESTA:'+memo.slice(0, 6000));

  return { content: msg, json: parsed, usage };
}

// --- Idempotencia de mensajes entrantes ---
async function ensureMessageOnce(messageId) {
  if (!messageId) return true;
  const db = await getDb();
  try {
    await db.collection("processed_messages").insertOne({ _id: String(messageId), at: new Date() });
    return true; // primera vez
  } catch (e) {
    if (e && (e.code === 11000 || String(e.message||'').includes('E11000'))) return false;
    throw e;
  }
}

// ================== Exports (misma lista esperada por app.js) ==================
module.exports = {
  // OpenAI + chat
  CHAT_MODEL, CHAT_TEMPERATURE, openai, withTimeout,
  safeJsonParseStrictOrFix, coerceJsonString,

  // WhatsApp helpers
  GRAPH_VERSION, TRANSCRIBE_API_URL,
  fileCache, putInCache, getFromCache,
  getPhoneNumberId, sendText, sendSafeText, markAsRead,
  getMediaInfo, downloadMediaBuffer, transcribeImageWithOpenAI, transcribeAudioExternal,
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

  // Sheets (stubs para compatibilidad)
  getSpreadsheetIdFromEnv, getSheetsClient, saveCompletedToSheets,

  // Cross
  ObjectId,
  ensureMessageOnce
};
