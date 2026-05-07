// wa_inbox_panel.js
// Panel WhatsApp aislado: agrega rutas nuevas sin tocar la lógica existente de /admin Conversaciones.

const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
const { getRuntimeByPhoneNumberId, getRuntimeByTenantId } = require("./tenant_runtime");
const {
  DEFAULT_TENANT_ID,
  putInCache,
  getFromCache,
  getMediaInfo,
  downloadMediaBuffer,
  
} = require("./logic");

const TENANT_ID = (process.env.TENANT_ID || "").trim();
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v17.0";
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || "";
const MAX_UPLOAD_BYTES = Number(process.env.WA_INBOX_UPLOAD_MAX_BYTES || 25 * 1024 * 1024);

function withTenant(q = {}, tenantId) {
  const out = { ...q };
  const tid = String(tenantId || TENANT_ID || DEFAULT_TENANT_ID || "").trim();
  if (tid) out.tenantId = tid;
  return out;
}

function resolveTenantIdFromAuth(auth, req) {
  return auth.resolveTenantId(req, {
    defaultTenantId: DEFAULT_TENANT_ID || "default",
    envTenantId: process.env.TENANT_ID,
  });
}

function htmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function jsonForHtml(value) {
  return JSON.stringify(value || [])
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function adminStatusLabel(conv) {
  const raw = String(conv?.status || "").trim();
  const up = raw.toUpperCase();
  const pedidoEstado = String(conv?.pedidoEstado || "").trim().toUpperCase();

  if (up === "COMPLETED") return "COMPLETED";
  if (up === "CANCELLED" || up === "CANCELED" || up === "CANCELADA" || up === "CANCELADO") return "CANCELADA";

  const flow = String(conv?.transferFlowStatus || "").trim().toUpperCase();
  if (flow === "PENDIENTE_IMPORTE_TRANSFERENCIA") return "PENDIENTE IMPORTE";
  if (flow === "PENDIENTE_COMPROBANTE_TRANSFERENCIA") return "PENDIENTE COMPROBANTE";

  if (raw) return up;
  if (pedidoEstado === "PENDIENTE") return "PENDIENTE";
  return conv?.finalized ? "COMPLETED" : "OPEN";
}

function dateMs(v) {
  const ms = Date.parse(v || "");
  return Number.isFinite(ms) ? ms : 0;
}

function lastConversationDate(conv) {
  return conv?.lastUserTs || conv?.lastAssistantTs || conv?.updatedAt || conv?.closedAt || conv?.openedAt || conv?.createdAt || null;
}

function normalizePhoneKey(waId) {
  const raw = String(waId || "").trim();
  if (!raw) return "";

  // WhatsApp Cloud espera y suele guardar el identificador como número, pero
  // hay datos legacy que pueden venir como +54..., 5434..., 3462...,
  // whatsapp:+54..., 549...@c.us, etc. Unificamos esos formatos.
  let value = raw
    .replace(/^whatsapp:/i, "")
    .replace(/@c\.us$/i, "")
    .replace(/@s\.whatsapp\.net$/i, "")
    .trim();

  const digits = value.replace(/\D+/g, "");
  if (!digits) return value.toLowerCase();

  // Normalización útil para Argentina: 3462xxxxxx, 543462xxxxxx y
  // 5493462xxxxxx deben agruparse como el mismo contacto.
  if (digits.startsWith("549") && digits.length >= 12) return digits;
  if (digits.startsWith("54") && digits.length >= 11) {
    const rest = digits.slice(2);
    return rest.startsWith("9") ? digits : `549${rest}`;
 }
  if (digits.length === 10) return `549${digits}`;
  if (digits.length === 11 && digits.startsWith("9")) return `54${digits}`;

  return digits;
}

function normalizeCloudRecipient(value) {
  const key = normalizePhoneKey(value);
  const digits = String(key || "").replace(/\D+/g, "");
  if (!digits) return "";
  return digits;
}

function conversationContactCandidates(conv = {}) {
  const raw = [];
  const add = (v) => {
    const s = String(v || "").trim();
    if (s) raw.push(s);
  };

  add(conv.waId);
  add(conv.contactWaId);
  add(conv.contactPhone);
  add(conv.customerPhone);
  add(conv.telefono);
  add(conv.phone);
  add(conv.from);
  add(conv.userPhone);

  if (conv.contact && typeof conv.contact === "object") {
    add(conv.contact.waId);
    add(conv.contact.wa_id);
    add(conv.contact.phone);
    add(conv.contact.telefono);
  }

  return raw;
}

function getConversationContactKey(conv = {}) {
  const candidates = conversationContactCandidates(conv);
  for (const candidate of candidates) {
    const key = normalizePhoneKey(candidate);
    if (key) return key;
  }
  return String(conv?._id || "sin-numero").toLowerCase();
}

function getConversationDisplayWaId(conv = {}) {
  const candidates = conversationContactCandidates(conv);
  return candidates[0] || String(conv?._id || "");
}

function buildInboxContactGroups(rows = []) {
  const groups = new Map();

  for (const conv of Array.isArray(rows) ? rows : []) {
    const waId = getConversationDisplayWaId(conv);
    const key = getConversationContactKey(conv);
    const convId = String(conv?._id || "");
    const lastAt = lastConversationDate(conv);
    const lastAtMs = dateMs(lastAt);

    if (!groups.has(key)) {
      groups.set(key, {
        _id: convId,
        contactKey: key,
        waId,
        contactName: conv?.contactName || "-",
        status: adminStatusLabel(conv),
        manualOpen: !!conv?.manualOpen,
        conversationIds: [],
        conversationCount: 0,
        allStatuses: [],
        lastAt,
        channelType: conv?.channelType || "whatsapp",
        phoneNumberId: conv?.phoneNumberId || null,
        displayPhoneNumber: conv?.displayPhoneNumber || null,
        instagramAccountId: conv?.instagramAccountId || null,
        instagramPageId: conv?.instagramPageId || null,
      });
    }

    const g = groups.get(key);
    if (convId && !g.conversationIds.includes(convId)) g.conversationIds.push(convId);
    g.conversationCount = g.conversationIds.length;
    g.manualOpen = !!g.manualOpen || !!conv?.manualOpen;

    const status = adminStatusLabel(conv);
    if (status && !g.allStatuses.includes(status)) g.allStatuses.push(status);

    const currentMs = dateMs(g.lastAt);
    if (lastAtMs >= currentMs) {
      g._id = convId || g._id;
      g.waId = waId || g.waId;
      g.contactName = conv?.contactName || g.contactName || "-";
      g.status = status || g.status || "OPEN";
      g.lastAt = lastAt || g.lastAt;
      g.channelType = conv?.channelType || g.channelType || "whatsapp";
      g.phoneNumberId = conv?.phoneNumberId || g.phoneNumberId || null;
      g.displayPhoneNumber = conv?.displayPhoneNumber || g.displayPhoneNumber || null;
      g.instagramAccountId = conv?.instagramAccountId || g.instagramAccountId || null;
      g.instagramPageId = conv?.instagramPageId || g.instagramPageId || null;
    }
  }

  return Array.from(groups.values()).sort((a, b) => dateMs(b.lastAt) - dateMs(a.lastAt));
}

async function loadInboxConversations(tenantId, limit = 500) {
  const db = await getDb();
  const rows = await db.collection("conversations")
    .find(withTenant({}, tenantId))
    .sort({ updatedAt: -1, lastUserTs: -1, lastAssistantTs: -1, closedAt: -1, openedAt: -1, createdAt: -1 })
    .limit(Math.max(1, Math.min(Number(limit) || 500, 1000)))
    .toArray();
  return buildInboxContactGroups(rows);
}

function parseConvIdList(value) {
  const arr = Array.isArray(value) ? value : String(value || "").split(",");
  return arr
    .map((x) => String(x || "").trim())
    .filter((x) => ObjectId.isValid(x))
    .slice(0, 200)
    .map((x) => new ObjectId(x));
}

async function findConversationsForInbox({ tenantId, convId, convIds, waId, contactKey, limit = 200 }) {
  const db = await getDb();
  const ids = parseConvIdList(convIds);
  if (convId && ObjectId.isValid(String(convId))) ids.unshift(new ObjectId(String(convId)));

  if (ids.length) {
    return db.collection("conversations")
      .find(withTenant({ _id: { $in: ids } }, tenantId))
      .sort({ updatedAt: -1, openedAt: -1, createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  if (waId) {
    return db.collection("conversations")
      .find(withTenant({ waId: String(waId) }, tenantId))
      .sort({ updatedAt: -1, openedAt: -1, createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  if (contactKey) {
    const all = await db.collection("conversations")
      .find(withTenant({}, tenantId))
      .sort({ updatedAt: -1, openedAt: -1, createdAt: -1 })
      .limit(1000)
      .toArray();
    const wanted = normalizePhoneKey(contactKey);
    return all.filter((c) => getConversationContactKey(c) === wanted).slice(0, limit);
  }

  return [];
}

async function pickConversationForReply({ tenantId, convId, waId, convIds }) {
  const db = await getDb();

  if (convId && ObjectId.isValid(String(convId))) {
    const conv = await db.collection("conversations").findOne(withTenant({ _id: new ObjectId(String(convId)) }, tenantId));
    if (conv) return conv;
  }

  const ids = parseConvIdList(convIds);
  if (ids.length) {
    const active = await db.collection("conversations").findOne(
      withTenant({ _id: { $in: ids }, finalized: { $ne: true }, status: { $nin: ["COMPLETED", "CANCELLED"] } }, tenantId),
      { sort: { updatedAt: -1, openedAt: -1, createdAt: -1 } }
    );
    if (active) return active;

    const latest = await db.collection("conversations").findOne(
      withTenant({ _id: { $in: ids } }, tenantId),
      { sort: { updatedAt: -1, openedAt: -1, createdAt: -1 } }
    );
    if (latest) return latest;
  }

  if (waId) {
    const active = await db.collection("conversations").findOne(
      withTenant({ waId: String(waId), finalized: { $ne: true }, status: { $nin: ["COMPLETED", "CANCELLED"] } }, tenantId),
      { sort: { updatedAt: -1, openedAt: -1, createdAt: -1 } }
    );
    if (active) return active;

    return db.collection("conversations").findOne(
      withTenant({ waId: String(waId) }, tenantId),
      { sort: { updatedAt: -1, openedAt: -1, createdAt: -1 } }
    );
  }

  return null;
}

function safeFileName(name) {
  const s = String(name || "archivo").trim() || "archivo";
  return s.replace(/[\r\n"]/g, "").slice(0, 180) || "archivo";
}

function extFromMime(mime) {
  const mt = String(mime || "").toLowerCase();
  if (mt.includes("jpeg")) return "jpg";
  if (mt.includes("png")) return "png";
  if (mt.includes("webp")) return "webp";
  if (mt.includes("gif")) return "gif";
  if (mt.includes("pdf")) return "pdf";
  if (mt.includes("mp3")) return "mp3";
  if (mt.includes("wav")) return "wav";
  if (mt.includes("ogg") || mt.includes("opus")) return "ogg";
  if (mt.includes("mp4")) return "mp4";
  return "";
}

function appendTenantParam(url, tenantId) {
  const t = String(tenantId || "").trim();
  if (!t) return url;
  const raw = String(url || "");
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const u = new URL(raw, "http://localhost");
    u.searchParams.set("tenant", t);
    return u.pathname + (u.search || "") + (u.hash || "");
  } catch {
    return raw.includes("?")
      ? raw + "&tenant=" + encodeURIComponent(t)
      : raw + "?tenant=" + encodeURIComponent(t);
  }
}

function inferKindFromMime(mime, filename = "", fallback = "file") {
  const mt = String(mime || "").toLowerCase();
  const fn = String(filename || "").toLowerCase();
  if (mt.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(fn)) return "image";
  if (mt.startsWith("audio/") || /\.(mp3|wav|ogg|opus|m4a)$/i.test(fn)) return "audio";
  if (mt.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(fn)) return "video";
  if (mt.includes("pdf") || fn.endsWith(".pdf")) return "pdf";
  return fallback || "document";
}

function extractMessageMediaInfo(m) {
  const raw = m?.meta?.raw || {};
  const type = String(m?.type || raw?.type || "").trim().toLowerCase();
  const outMedia = m?.meta?.waInbox?.media || m?.meta?.media || null;

  let mediaId = "";
  let filename = "";
  let mime = "";
  let caption = "";

  if (type === "image") {
    mediaId = raw?.image?.id || "";
    mime = raw?.image?.mime_type || "";
    caption = String(raw?.image?.caption || "").trim();
    filename = "imagen";
  } else if (type === "audio") {
    mediaId = raw?.audio?.id || "";
    mime = raw?.audio?.mime_type || "";
    filename = "audio";
  } else if (type === "document") {
    mediaId = raw?.document?.id || "";
    filename = String(raw?.document?.filename || raw?.document?.file_name || "archivo").trim();
    mime = raw?.document?.mime_type || "";
    caption = String(raw?.document?.caption || "").trim();
  } else if (type === "video") {
    mediaId = raw?.video?.id || "";
    mime = raw?.video?.mime_type || "";
    caption = String(raw?.video?.caption || "").trim();
    filename = "video";
  } else if (type === "sticker") {
    mediaId = raw?.sticker?.id || "";
    mime = raw?.sticker?.mime_type || "";
    filename = "sticker";
  }

  if (outMedia) {
    mediaId = mediaId || String(outMedia.mediaId || "");
    filename = String(outMedia.filename || filename || "archivo").trim();
    mime = String(outMedia.mime || mime || "").trim();
    caption = caption || String(outMedia.caption || "").trim();
  }

  const cacheId = outMedia?.cacheId || "";
  return { mediaId, filename, mime, caption, cacheId, type };
}

function buildInboxMediaDescriptor(m, tenantId) {
  const info = extractMessageMediaInfo(m);
  if (!info.mediaId && !info.cacheId) return null;

  const filename = safeFileName(info.filename || "archivo");
  const mime = String(info.mime || "").toLowerCase();
  const kind = inferKindFromMime(mime, filename, info.type || "document");
  const base = `/api/admin/wa-inbox/media/${String(m._id)}`;
  const url = appendTenantParam(base, tenantId);

  return {
    kind,
    url,
    mime: mime || null,
    filename,
    caption: info.caption || null,
  };
}

function cleanInboxContentForDisplay(message, media) {
  const text = String(message?.content || "").trim();
  if (!text) return "";
  if (!media) return text;

  // El backend puede guardar texto técnico generado por visión/STT para que el bot
  // procese imágenes, por ejemplo: "El usuario envió una imagen... Lectura preliminar...".
  // En este panel estilo WhatsApp no mostramos ese texto auxiliar: solo el adjunto/caption.
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const syntheticMediaText =
    normalized.startsWith("el usuario envio una imagen") ||
    normalized.startsWith("el usuario envio un audio") ||
    normalized.startsWith("el usuario envio un video") ||
    normalized.startsWith("el usuario envio un documento") ||
    normalized.startsWith("el usuario envio un archivo") ||
    /^\[archivo enviado:/i.test(text);

  return syntheticMediaText ? "" : text;
}

function buildInboxMessagesFilter(conversationIds, tenantId) {
  const stringIds = [];
  const objectIds = [];

  for (const value of Array.isArray(conversationIds) ? conversationIds : []) {
    const id = String(value || "").trim();
    if (!id) continue;
    if (!stringIds.includes(id)) stringIds.push(id);
    if (ObjectId.isValid(id) && !objectIds.some((x) => String(x) === id)) {
      objectIds.push(new ObjectId(id));
    }
  }

  const alternatives = [];
  if (objectIds.length) alternatives.push({ conversationId: { $in: objectIds } });
  if (stringIds.length) alternatives.push({ conversationId: { $in: stringIds } });

  const base = alternatives.length > 1
    ? { $or: alternatives }
    : (alternatives[0] || { _id: { $exists: false } });

  return withTenant(base, tenantId);
}

function toInboxMessageDto(message, tenantId) {
  let media = null;
  try {
    media = buildInboxMediaDescriptor(message, tenantId);
  } catch (e) {
    console.warn("[wa-inbox] media descriptor skipped", String(message?._id || ""), e?.message || e);
  }

  let content = "";
  try {
    content = cleanInboxContentForDisplay(message, media);
  } catch (e) {
    console.warn("[wa-inbox] content cleanup skipped", String(message?._id || ""), e?.message || e);
    content = String(message?.content || "");
  }

  return {
    _id: String(message?._id || ""),
    role: String(message?.role || ""),
    content,
    type: String(message?.type || "text"),
    media,
    createdAt: message?.ts || message?.createdAt || null,
  };
}


async function getRuntimeForConversation(conv, tenantId) {
  let rt = null;
  try {
    if (conv?.phoneNumberId) rt = await getRuntimeByPhoneNumberId(conv.phoneNumberId);
  } catch {}
  try {
    if (!rt && tenantId) rt = await getRuntimeByTenantId(tenantId);
  } catch {}

  return {
    whatsappToken: rt?.whatsappToken || WHATSAPP_TOKEN || null,
    phoneNumberId: rt?.phoneNumberId || conv?.phoneNumberId || PHONE_NUMBER_ID || null,
  };
}

async function sendWhatsAppTextStrict(to, text, opts = {}) {
  const body = String(text || "").trim();
  if (!body) throw new Error("text_required");

  const pid = String(opts.phoneNumberId || PHONE_NUMBER_ID || "").trim();
  const token = String(opts.whatsappToken || WHATSAPP_TOKEN || "").trim();
  const recipient = normalizeCloudRecipient(to);

  if (!recipient) throw new Error(`invalid_whatsapp_recipient: ${String(to || "")}`);
  if (!pid) throw new Error("missing_phone_number_id");
  if (!token) throw new Error("missing_whatsapp_token");

  const resp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pid}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: recipient, text: { body } }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`whatsapp_text_failed_${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function uploadWhatsAppMediaStrict({ buffer, filename, mime }, opts = {}) {
  const pid = String(opts.phoneNumberId || PHONE_NUMBER_ID || "").trim();
  const token = String(opts.whatsappToken || WHATSAPP_TOKEN || "").trim();
  if (!pid) throw new Error("missing_phone_number_id");
  if (!token) throw new Error("missing_whatsapp_token");
  if (!buffer || !buffer.length) throw new Error("media_buffer_required");

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", String(mime || "application/octet-stream"));
  form.append("file", new Blob([buffer], { type: String(mime || "application/octet-stream") }), safeFileName(filename || "archivo"));

  const resp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pid}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.id) {
    throw new Error(`whatsapp_media_upload_failed_${resp.status}: ${JSON.stringify(data)}`);
  }
  return data.id;
}

async function sendWhatsAppMediaStrict(to, media, opts = {}) {
  const pid = String(opts.phoneNumberId || PHONE_NUMBER_ID || "").trim();
  const token = String(opts.whatsappToken || WHATSAPP_TOKEN || "").trim();
  const recipient = normalizeCloudRecipient(to);
  if (!recipient) throw new Error(`invalid_whatsapp_recipient: ${String(to || "")}`);
  if (!pid) throw new Error("missing_phone_number_id");
  if (!token) throw new Error("missing_whatsapp_token");

  const filename = safeFileName(media?.filename || "archivo");
  const mime = String(media?.mime || "application/octet-stream").trim() || "application/octet-stream";
  const kindRaw = String(media?.type || inferOutboundMediaKind(mime, filename)).toLowerCase();
  const kind = ["image", "video", "audio", "document"].includes(kindRaw) ? kindRaw : "document";
  const mediaId = await uploadWhatsAppMediaStrict({ buffer: media?.buffer, filename, mime }, opts);

  const node = { id: mediaId };
  const caption = String(media?.caption || "").trim();
  if ((kind === "image" || kind === "video" || kind === "document") && caption) node.caption = caption;
  if (kind === "document" && filename) node.filename = filename;

  const payload = { messaging_product: "whatsapp", to: recipient, type: kind, [kind]: node };
  const resp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pid}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`whatsapp_media_send_failed_${resp.status}: ${JSON.stringify(data)}`);
  }
  return { mediaId, response: data, kind };
}

function inferOutboundMediaKind(mime, filename = "") {
  const mt = String(mime || "").toLowerCase();
  const fn = String(filename || "").toLowerCase();
  if (mt.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(fn)) return "image";
  if (mt.startsWith("audio/") || /\.(mp3|wav|ogg|opus|m4a)$/i.test(fn)) return "audio";
  if (mt.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(fn)) return "video";
  return "document";
}

async function saveOutboundMessage({ tenantId, conv, content, type = "text", meta = {} }) {
  const db = await getDb();
  const now = new Date();
  await db.collection("messages").insertOne({
    tenantId,
    conversationId: conv._id,
    waId: String(conv.waId || ""),
    role: "assistant",
    content: String(content || ""),
    type: String(type || "text"),
    meta: { from: "wa-inbox", ...meta },
    ts: now,
    createdAt: now,
  });
  await db.collection("conversations").updateOne(
    { _id: conv._id },
    { $set: { lastAssistantTs: now, updatedAt: now } }
  );
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let idx = buffer.indexOf(separator, start);
  while (idx !== -1) {
    parts.push(buffer.subarray(start, idx));
    start = idx + separator.length;
    idx = buffer.indexOf(separator, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function stripCrlfEdges(buf) {
  let out = buf;
  if (out.length >= 2 && out[0] === 13 && out[1] === 10) out = out.subarray(2);
  if (out.length >= 2 && out[out.length - 2] === 13 && out[out.length - 1] === 10) out = out.subarray(0, out.length - 2);
  return out;
}

function parseContentDisposition(header) {
  const out = {};
  const s = String(header || "");
  for (const part of s.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    let val = part.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

async function readRequestBuffer(req, maxBytes = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("upload_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseMultipartForm(req, maxBytes = MAX_UPLOAD_BYTES) {
  const ct = String(req.headers["content-type"] || "");
  const m = /boundary=(?:(?:\"([^\"]+)\")|([^;]+))/i.exec(ct);
  if (!m) throw new Error("multipart_boundary_missing");
  const boundary = m[1] || m[2];
  const body = await readRequestBuffer(req, maxBytes);
  const boundaryBuf = Buffer.from("--" + boundary);
  const parts = splitBuffer(body, boundaryBuf);

  const fields = {};
  const files = {};

  for (let part of parts) {
    part = stripCrlfEdges(part);
    if (!part.length) continue;
    if (part.length >= 2 && part[0] === 45 && part[1] === 45) continue;

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const headerText = part.subarray(0, headerEnd).toString("latin1");
    let content = part.subarray(headerEnd + 4);
    content = stripCrlfEdges(content);

    const headers = {};
    for (const line of headerText.split(/\r\n/)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    const disp = parseContentDisposition(headers["content-disposition"] || "");
    const name = disp.name;
    if (!name) continue;

    if (disp.filename !== undefined) {
      files[name] = {
        name: safeFileName(disp.filename || "archivo"),
        mimetype: headers["content-type"] || "application/octet-stream",
        data: content,
        size: content.length,
      };
    } else {
      fields[name] = content.toString("utf8");
    }
  }

  return { fields, files };
}

function errorJson(res, status, error, detail = "") {
  return res.status(status).json({ ok: false, error, detail: detail ? String(detail).slice(0, 1000) : undefined });
}

function mediaPlaceholderBuffer(kind, mime, filename, reason = "Archivo no disponible") {
  const label = htmlEscape(reason || "Archivo no disponible");
  const name = htmlEscape(filename || "archivo");
  const mt = String(mime || "").toLowerCase();
  const k = String(kind || "").toLowerCase();

  if (k === "image" || mt.startsWith("image/")) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#202c33"/><text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" fill="#e9edef" font-family="Arial, sans-serif" font-size="24">${label}</text><text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" fill="#aebac1" font-family="Arial, sans-serif" font-size="16">${name}</text></svg>`;
    return { buffer: Buffer.from(svg), mime: "image/svg+xml", filename: "archivo-no-disponible.svg" };
  }

  const text = `${reason || "Archivo no disponible"}${filename ? `: ${filename}` : ""}`;
  return { buffer: Buffer.from(text, "utf8"), mime: "text/plain; charset=utf-8", filename: "archivo-no-disponible.txt" };
}

function sendUnavailableMedia(res, info = {}, reason = "Archivo no disponible") {
  const ph = mediaPlaceholderBuffer(info.kind || info.type, info.mime, info.filename, reason);
  res.setHeader("Content-Type", ph.mime);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-WA-Inbox-Media-Status", "unavailable");
  res.setHeader("Content-Disposition", `inline; filename="${safeFileName(ph.filename)}"`);
  return res.status(200).send(ph.buffer);
}


function inboxHtml(initialConvs, tenant) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Admin | WhatsApp Web</title>
  <style>
    :root{--bg:#0b141a;--panel:#111b21;--panel2:#202c33;--text:#e9edef;--muted:#aebac1;--accent:#00a884;--bubbleMe:#005c4b;--bubbleThem:#202c33;--border:rgba(255,255,255,.08);--danger:#ff6b6b;}
    *{box-sizing:border-box} html,body{margin:0;width:100%;height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:var(--bg);color:var(--text);overflow:hidden}.app{display:flex;height:100vh;height:100dvh;width:100vw;overflow:hidden}.sidebar{width:370px;min-width:280px;background:var(--panel);border-right:1px solid var(--border);display:flex;flex-direction:column}.side-header{height:50px;padding:8px 12px;background:var(--panel2);display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border)}.side-header h1{font-size:16px;margin:0 8px 0 0;font-weight:650}.pill{font-size:10px;padding:3px 8px;border-radius:999px;border:1px solid var(--border);color:var(--muted);background:#0f1a20}.btn{border:1px solid var(--border);border-radius:10px;background:#0f1a20;color:var(--text);cursor:pointer;padding:8px 10px}.btn:hover{background:#16252d}.refresh-status{font-size:10px;color:var(--muted);min-width:64px;text-align:right}.menu-link{width:34px;height:34px;border-radius:10px;border:1px solid var(--border);background:#0f1a20;color:var(--text);text-decoration:none;display:inline-flex;align-items:center;justify-content:center;font-weight:800;flex:0 0 34px}.menu-link:hover{background:#16252d}.back-btn{display:none;border:1px solid var(--border);background:#0f1a20;color:var(--text);border-radius:10px;cursor:pointer;padding:7px 10px;font-size:12px;font-weight:750;line-height:1;white-space:nowrap;min-height:34px}.back-btn:hover{background:#16252d}.back-btn .back-icon{font-size:16px;line-height:1;margin-right:4px}.side-header-spacer{flex:1}.search{padding:10px 12px;border-bottom:1px solid var(--border)}.search input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:#0f1a20;color:var(--text);outline:none;font-size:13px}.conv-list{overflow:auto;flex:1;-webkit-overflow-scrolling:touch}.conv-item{padding:12px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;gap:10px;align-items:flex-start}.conv-item:hover{background:#0f1a20}.conv-item.active{background:#0d2420}.avatar{width:38px;height:38px;border-radius:50%;background:#2a3942;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#d1d7db;flex:0 0 38px}.conv-meta{flex:1;min-width:0}.conv-row{display:flex;justify-content:space-between;gap:8px;align-items:center}.conv-name{font-size:14px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.conv-wa{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.conv-last{font-size:11px;color:var(--muted);margin-top:3px}.chat{flex:1;display:flex;flex-direction:column;background:#0b141a;min-width:0}.chat-header{min-height:50px;background:var(--panel2);padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px}.chat-title{display:flex;align-items:center;gap:10px;min-width:0}.chat-title .name{font-size:15px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chat-title .sub{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48vw}.chat-actions{display:flex;align-items:center;gap:8px;font-size:11px;flex-wrap:wrap;justify-content:flex-end}.toggle{display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid var(--border);border-radius:10px;background:#0f1a20;white-space:nowrap}.toggle input{transform:translateY(1px)}.chat-body{flex:1;overflow:auto;padding:14px 16px 8px;-webkit-overflow-scrolling:touch}.empty{color:var(--muted);font-size:13px;padding:20px}.msg-row{display:flex;flex-direction:column}.msg{max-width:72%;padding:8px 10px;border-radius:10px;margin:6px 0;font-size:13.5px;line-height:1.32;word-wrap:break-word;white-space:pre-wrap}.msg.them{background:var(--bubbleThem);border-top-left-radius:4px;align-self:flex-start}.msg.me{background:var(--bubbleMe);border-top-right-radius:4px;align-self:flex-end}.msg-text:empty{display:none}.msg-meta{font-size:10px;color:rgba(255,255,255,.55);margin-top:4px;text-align:right}.media-wrap{margin-top:6px}.media-img{max-width:310px;border-radius:10px;display:block}.media-video{max-width:330px;border-radius:10px;display:block}.media-pdf{width:330px;max-width:100%;height:380px;border:0;border-radius:10px;display:block;background:#fff}.media-file{display:inline-flex;gap:8px;align-items:center;color:rgba(255,255,255,.92);text-decoration:none;border:1px solid var(--border);border-radius:10px;padding:10px;background:rgba(255,255,255,.04);max-width:330px}.media-links{display:flex;gap:10px;align-items:center;margin-top:5px}.media-links a{font-size:11px;color:rgba(255,255,255,.82);text-decoration:underline}.chat-footer{border-top:1px solid var(--border);background:var(--panel);padding:10px}.send-form{display:flex;gap:8px;align-items:center}.text-input{flex:1;min-width:0;padding:12px;border-radius:10px;border:1px solid var(--border);background:#0f1a20;color:var(--text);outline:none;font-size:13px}.attach-btn{width:42px;height:42px;display:flex;align-items:center;justify-content:center;border-radius:10px;border:1px solid var(--border);background:#0f1a20;color:var(--text);cursor:pointer;font-size:19px;flex:0 0 42px}.attach-btn:hover{background:#16252d}.file-selected{max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;align-items:center;cursor:pointer}.send-btn{height:42px;border-radius:10px;border:1px solid var(--border);background:var(--accent);color:white;cursor:pointer;font-weight:700;padding:0 16px}.send-btn:disabled{opacity:.5;cursor:not-allowed}.error-pill{color:#ffd0d0;border-color:rgba(255,107,107,.35);background:rgba(255,107,107,.08)}
    @media(max-width:760px){.app{position:relative;display:block;height:100dvh}.sidebar,.chat{position:absolute;inset:0;width:100%;height:100%;min-width:0;transition:transform .18s ease;background:var(--panel)}.chat{transform:translateX(100%);background:var(--bg)}.app.mobile-chat-open .sidebar{transform:translateX(-28%);pointer-events:none}.app.mobile-chat-open .chat{transform:translateX(0)}.side-header{height:48px}.side-header h1{font-size:15px}.btn{padding:7px 9px}.search{padding:8px}.conv-item{padding:11px 10px}.chat-header{height:52px;min-height:52px;padding:6px 8px}.back-btn{display:inline-flex;align-items:center;justify-content:center}.chat-title{gap:8px;flex:1}.chat-title .avatar{width:34px;height:34px;flex-basis:34px;font-size:12px}.chat-title .name{font-size:14px}.chat-title .sub{max-width:45vw;font-size:10px}.chat-actions{gap:4px}.chat-actions .pill{display:none}.toggle{font-size:10px;padding:4px 6px}.chat-body{padding:10px 8px 6px}.msg{max-width:86%;font-size:13px}.media-img,.media-video{max-width:min(74vw,310px)}.media-pdf{height:330px}.chat-footer{padding:8px}.send-form{gap:6px}.attach-btn{width:38px;height:38px;flex-basis:38px}.text-input{height:38px;padding:9px 10px}.send-btn{height:38px;padding:0 12px}.pauseHint{display:none}.file-selected{position:absolute;bottom:54px;left:54px;right:72px;max-width:none}#pauseHint{display:none}.app:not(.mobile-chat-open) .chat{visibility:hidden}.app.mobile-chat-open .chat{visibility:visible}}
</style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="side-header"><a href="/app" class="menu-link" title="Volver al menú principal" aria-label="Volver al menú principal">☰</a><h1>WhatsApp</h1><button id="refreshBtn" class="btn" type="button">↻</button><span id="refreshStatus" class="refresh-status"></span></div>
        <div class="search"><input id="searchInput" placeholder="Buscar contacto o número..."/></div>
      <div id="convList" class="conv-list"></div>
    </aside>
    <main class="chat">
      <div class="chat-header">
        <div class="chat-title"><a href="/app" class="menu-link" title="Volver al menú principal" aria-label="Volver al menú principal">☰</a><button id="backBtn" class="back-btn" type="button" aria-label="Volver a contactos"><span class="back-icon">‹</span><span>Contactos</span></button><div class="avatar" id="chatAvatar">?</div><div><div class="name" id="chatName">Seleccioná un chat</div><div class="sub" id="chatSub"></div></div></div>
         <div class="chat-actions"><span id="chatStatus" class="pill"></span><label class="toggle"><input type="checkbox" id="manualToggle"/><span>Pausar bot</span></label></div>
      </div>
      <div id="chatBody" class="chat-body"><div class="empty">No hay conversación seleccionada.</div></div>
      <div class="chat-footer">
        <form id="sendForm" class="send-form">
          <input id="fileInput" type="file" style="display:none"/>
          <label for="fileInput" class="attach-btn" title="Adjuntar archivo">📎</label>
          <input id="msgInput" class="text-input" placeholder="Escribí un mensaje..." autocomplete="off"/>
          <small id="fileHint" class="pill file-selected" title="Click para quitar adjunto"></small>
          <small id="pauseHint" class="pill">Bot activo</small>
          <button id="sendBtn" class="send-btn" type="submit" disabled>Enviar</button>
        </form>
      </div>
    </main>
  </div>
<script>
window.__INITIAL_CONVS__ = ${jsonForHtml(initialConvs)};
const urlQs = new URLSearchParams(location.search);
const TENANT = urlQs.get("tenant") || ${JSON.stringify(tenant || "")};
const PRESELECT_CONV = urlQs.get("convId") || "";
const PRESELECT_WA = urlQs.get("waId") || "";
let conversations = Array.isArray(window.__INITIAL_CONVS__) ? window.__INITIAL_CONVS__ : [];
let activeConvId = "";
let activeConvIds = [];
let activeWaId = "";
let activeContactKey = "";
let activeStatusLabel = "";
let refreshTimer = null;
let lastConversationsSig = "";
let lastMessagesSig = "";
const appEl = document.querySelector(".app");

const convListEl = document.getElementById("convList");
const searchInput = document.getElementById("searchInput");
const refreshBtn = document.getElementById("refreshBtn");
const refreshStatus = document.getElementById("refreshStatus");
const backBtn = document.getElementById("backBtn");
const chatAvatar = document.getElementById("chatAvatar");
const chatName = document.getElementById("chatName");
const chatSub = document.getElementById("chatSub");
const chatStatus = document.getElementById("chatStatus");
const manualToggle = document.getElementById("manualToggle");
const pauseHint = document.getElementById("pauseHint");
const chatBody = document.getElementById("chatBody");
const sendForm = document.getElementById("sendForm");
const msgInput = document.getElementById("msgInput");
const fileInput = document.getElementById("fileInput");
const fileHint = document.getElementById("fileHint");
const sendBtn = document.getElementById("sendBtn");

function api(url){
  const u = new URL(url, location.origin);
  if (TENANT) u.searchParams.set("tenant", TENANT);
  return u.toString();
}
function esc(s){return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;");}
function initials(v){const s=String(v||"").trim(); if(!s)return"?"; const p=s.split(/\\s+/).filter(Boolean); if(p.length>=2)return(p[0][0]+p[1][0]).toUpperCase(); return s.slice(0,2).toUpperCase();}
function normalizeContactKey(waId){const raw=String(waId||"").trim(); if(!raw)return"sin-numero"; let value=raw.replace(/^whatsapp:/i,"").replace(/@c\\.us$/i,"").replace(/@s\\.whatsapp\\.net$/i,"").trim(); const digits=value.replace(/\\D+/g,""); if(!digits)return value.toLowerCase(); if(digits.startsWith("549")&&digits.length>=12)return digits; if(digits.startsWith("54")&&digits.length>=11){const rest=digits.slice(2); return rest.startsWith("9")?digits:"549"+rest;} if(digits.length===10)return "549"+digits; if(digits.length===11&&digits.startsWith("9"))return "54"+digits; return digits;}
function fmtTime(d){try{const dt=new Date(d); if(Number.isNaN(dt.getTime()))return""; return dt.toLocaleString("es-AR",{hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"});}catch{return"";}}
function isMobile(){return window.matchMedia && window.matchMedia("(max-width:760px)").matches;}
function listUrl(){const u=new URL(location.href); u.searchParams.delete("convId"); u.searchParams.delete("waId"); if(TENANT)u.searchParams.set("tenant",TENANT); return u;}
function showContacts(updateUrl=false){if(appEl)appEl.classList.remove("mobile-chat-open"); if(isMobile()&&updateUrl)history.replaceState({waInboxView:"list"},"",listUrl().toString());}
function showChat(){if(appEl)appEl.classList.add("mobile-chat-open");}
function setRefreshStatus(text){if(!refreshStatus)return; refreshStatus.textContent=text||""; if(text)setTimeout(()=>{if(refreshStatus.textContent===text)refreshStatus.textContent="";},1200);}
function sigForConversations(rows){try{return JSON.stringify((rows||[]).map(c=>[c.contactKey,c._id,c.waId,c.contactName,c.conversationCount,c.manualOpen,c.lastAt,c.status]));}catch{return String(Date.now());}}
function sigForMessages(rows){try{return JSON.stringify((rows||[]).map(m=>[m._id,m.role,m.content,m.type,m.createdAt,m.media&&m.media.url,m.media&&m.media.filename]));}catch{return String(Date.now());}}
function visibleMessageText(m){const txt=String((m&&m.content)||"").trim(); if(!txt)return""; if(!m.media)return txt; const n=txt.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").replace(/\\s+/g," ").trim(); if(n.startsWith("el usuario envio una imagen")||n.startsWith("el usuario envio un audio")||n.startsWith("el usuario envio un video")||n.startsWith("el usuario envio un documento")||n.startsWith("el usuario envio un archivo")||/^\\[archivo enviado:/i.test(txt))return""; return txt;}
 
function syncManualUi(isManual){const paused=!!isManual; manualToggle.checked=paused; pauseHint.textContent=paused?"Bot pausado":"Bot activo"; chatStatus.textContent=paused?"BOT PAUSADO":(activeStatusLabel||""); chatStatus.classList.toggle("error-pill", paused);}
function selectedPayload(){return activeConvIds.length ? { convIds: activeConvIds, waId: activeWaId, convId: activeConvId } : (activeWaId ? { waId: activeWaId, convId: activeConvId } : { convId: activeConvId });}

function renderList(){
  const f=String(searchInput.value||"").toLowerCase().trim();
  const rows=conversations.filter(c=>!f || String(c.contactName||"").toLowerCase().includes(f) || String(c.waId||"").toLowerCase().includes(f));
  convListEl.innerHTML = rows.map(c=>{
    const id=String(c._id||"");
    const convIds=Array.isArray(c.conversationIds)?c.conversationIds.map(String).filter(Boolean):(id?[id]:[]);
    const waId=String(c.waId||"");
    const key=String(c.contactKey||normalizeContactKey(waId));
    const name=(c.contactName && c.contactName!=="-")?c.contactName:(waId||"Sin nombre");
    const count=Number(c.conversationCount || convIds.length || 1);
    const status=count>1 ? (count+" conversaciones") : (c.status||"OPEN");
    const manual=c.manualOpen?"BOT PAUSADO":"BOT ACTIVO";
    const cls=key===activeContactKey?"conv-item active":"conv-item";
    return '<div class="'+cls+'" data-id="'+esc(id)+'" data-convs="'+esc(convIds.join(','))+'" data-wa="'+esc(waId)+'" data-key="'+esc(key)+'"><div class="avatar">'+esc(initials(name))+'</div><div class="conv-meta"><div class="conv-row"><div class="conv-name">'+esc(name)+'</div><span class="pill">'+esc(status)+'</span></div><div class="conv-row"><div class="conv-wa">'+esc(waId)+'</div><span class="pill">'+esc(manual)+'</span></div><div class="conv-last">'+esc(fmtTime(c.lastAt))+'</div></div></div>';
  }).join("");
  convListEl.querySelectorAll(".conv-item").forEach(el=>el.addEventListener("click",()=>selectContact({convId:el.dataset.id||"",convIds:String(el.dataset.convs||"").split(",").filter(Boolean),waId:el.dataset.wa||"",contactKey:el.dataset.key||""})));
  if(!rows.length) convListEl.innerHTML='<div class="empty">Sin resultados.</div>';
}
async function refreshConversations(keepActive=true,{force=false}={}){
  const r=await fetch(api("/api/admin/wa-inbox/conversations?limit=500"));
  if(!r.ok) throw new Error("conversations_error");
  const next=await r.json();
  const sig=sigForConversations(next);
  if(!force && sig===lastConversationsSig) return false;
  lastConversationsSig=sig;
  conversations=next;
  renderList();
  if(keepActive && activeContactKey){
    const row=conversations.find(c=>String(c.contactKey||normalizeContactKey(c.waId))===activeContactKey);
    if(row){activeConvIds=row.conversationIds||activeConvIds; activeConvId=row._id||activeConvId; activeWaId=row.waId||activeWaId;}
  }
    return true;
}
function setUrlContact(pushHistory=false){const u=new URL(location.href); if(activeConvId)u.searchParams.set("convId",activeConvId); else u.searchParams.delete("convId"); if(activeWaId)u.searchParams.set("waId",activeWaId); else u.searchParams.delete("waId"); if(TENANT)u.searchParams.set("tenant",TENANT); const state={waInboxView:"chat"}; if(pushHistory&&isMobile())history.pushState(state,"",u.toString()); else history.replaceState(state,"",u.toString());}
async function responseError(r, fallback){let detail=""; try{detail=await r.text();}catch{} try{const j=detail?JSON.parse(detail):null; if(j)detail=j.detail||j.error||j.message||detail;}catch{} detail=String(detail||"").trim(); return new Error(fallback+"_"+r.status+(detail?": "+detail.slice(0,180):""));}
async function loadMeta(){const p=new URLSearchParams(); if(activeConvIds.length)p.set("convIds",activeConvIds.join(",")); else if(activeWaId)p.set("waId",activeWaId); else p.set("convId",activeConvId); const r=await fetch(api("/api/admin/wa-inbox/meta?"+p.toString())); if(!r.ok)throw await responseError(r,"meta_error"); return r.json();}
async function loadMessages(){const p=new URLSearchParams(); if(activeConvIds.length)p.set("convIds",activeConvIds.join(",")); else if(activeWaId)p.set("waId",activeWaId); else p.set("convId",activeConvId); const r=await fetch(api("/api/admin/wa-inbox/messages?"+p.toString())); if(!r.ok)throw await responseError(r,"messages_error"); return r.json();}
function downloadUrl(url){const u=new URL(url, location.origin); u.searchParams.set("download","1"); return u.toString();}
function buildMediaNode(m){
  const md=m&&m.media; if(!md||!md.url)return null;
  const url=api(md.url); const kind=String(md.kind||"").toLowerCase(); const mime=String(md.mime||"").toLowerCase(); const filename=String(md.filename||"archivo");
  const isImage=kind==="image"||mime.startsWith("image/"); const isAudio=kind==="audio"||mime.startsWith("audio/"); const isVideo=kind==="video"||mime.startsWith("video/"); const isPdf=kind==="pdf"||mime.includes("pdf")||filename.toLowerCase().endsWith(".pdf");
  const wrap=document.createElement("div"); wrap.className="media-wrap";
  const links=document.createElement("div"); links.className="media-links";
  const open=document.createElement("a"); open.href=url; open.target="_blank"; open.rel="noopener"; open.textContent="Abrir";
  const dl=document.createElement("a"); dl.href=downloadUrl(url); dl.textContent="Descargar";
  if(isImage){const a=document.createElement("a"); a.href=url; a.target="_blank"; a.rel="noopener"; const img=document.createElement("img"); img.className="media-img"; img.src=url; img.alt=filename; img.loading="lazy"; a.appendChild(img); wrap.appendChild(a); links.appendChild(dl); wrap.appendChild(links); return wrap;}
  if(isAudio){const audio=document.createElement("audio"); audio.controls=true; audio.src=url; audio.style.maxWidth="330px"; audio.style.display="block"; wrap.appendChild(audio); links.appendChild(open); links.appendChild(dl); wrap.appendChild(links); return wrap;}
  if(isVideo){const video=document.createElement("video"); video.className="media-video"; video.controls=true; video.src=url; wrap.appendChild(video); links.appendChild(open); links.appendChild(dl); wrap.appendChild(links); return wrap;}
  if(isPdf){const frame=document.createElement("iframe"); frame.className="media-pdf"; frame.src=url; wrap.appendChild(frame); links.appendChild(open); links.appendChild(dl); wrap.appendChild(links); return wrap;}
  const a=document.createElement("a"); a.className="media-file"; a.href=downloadUrl(url); a.textContent="📎 "+filename; wrap.appendChild(a); links.appendChild(open); links.appendChild(dl); wrap.appendChild(links); return wrap;
}
function renderMessages(msgs,{stickToBottom=true}={}){
  if(!Array.isArray(msgs)||!msgs.length){chatBody.innerHTML='<div class="empty">Sin mensajes todavía.</div>';return;}
  const wasNearBottom=(chatBody.scrollHeight-chatBody.scrollTop-chatBody.clientHeight)<90;
  chatBody.innerHTML=""; const frag=document.createDocumentFragment();
  msgs.forEach(m=>{const row=document.createElement("div"); row.className="msg-row"; row.style.alignItems=m.role==="user"?"flex-start":"flex-end"; const bubble=document.createElement("div"); bubble.className="msg "+(m.role==="user"?"them":"me"); const txt=document.createElement("div"); txt.className="msg-text"; txt.textContent=visibleMessageText(m); bubble.appendChild(txt); const media=buildMediaNode(m); if(media)bubble.appendChild(media); const meta=document.createElement("div"); meta.className="msg-meta"; meta.textContent=m.createdAt?fmtTime(m.createdAt):""; bubble.appendChild(meta); row.appendChild(bubble); frag.appendChild(row);});
  chatBody.appendChild(frag); if(stickToBottom||wasNearBottom)chatBody.scrollTop=chatBody.scrollHeight;
}
async function selectContact({convId="",convIds=[],waId="",contactKey="",pushHistory=true}={}){
  activeConvId=String(convId||""); activeConvIds=Array.isArray(convIds)?convIds.map(String).filter(Boolean):[]; activeWaId=String(waId||""); activeContactKey=String(contactKey||normalizeContactKey(activeWaId)); setUrlContact(pushHistory); showChat(); renderList(); sendBtn.disabled=!(activeWaId||activeConvId||activeConvIds.length); chatBody.innerHTML='<div class="empty">Cargando...</div>'; lastMessagesSig="";
  try{const meta=await loadMeta(); activeConvId=String(meta.convId||activeConvId||""); activeConvIds=Array.isArray(meta.conversationIds)?meta.conversationIds.map(String).filter(Boolean):activeConvIds; activeWaId=String(meta.waId||activeWaId||""); activeContactKey=meta.contactKey||activeContactKey||normalizeContactKey(activeWaId); const name=meta.contactName||meta.waId||"Chat"; chatAvatar.textContent=initials(name); chatName.textContent=name; const ch=meta.displayPhoneNumber||meta.phoneNumberId||""; chatSub.textContent=meta.waId?(meta.waId+(ch?" · "+ch:"")+(meta.conversationCount>1?" · "+meta.conversationCount+" conversaciones":"")):""; activeStatusLabel=meta.status||""; syncManualUi(!!meta.manualOpen); const msgs=await loadMessages(); lastMessagesSig=sigForMessages(msgs); renderMessages(msgs,{stickToBottom:true});}catch(e){chatBody.innerHTML='<div class="empty">No se pudo cargar la conversación.<br><small>'+esc(e&&e.message?e.message:e)+'</small></div>'; console.error("wa-inbox selectContact", e);}
}
async function refreshActiveMessages(){if(!activeContactKey)return; try{const msgs=await loadMessages(); renderMessages(msgs); await refreshConversations(true);}catch{}}
manualToggle.addEventListener("change",async()=>{if(!activeWaId&&!activeConvId&&!activeConvIds.length)return; try{const r=await fetch(api("/api/admin/wa-inbox/manual"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...selectedPayload(),manualOpen:manualToggle.checked})}); const j=await r.json().catch(()=>null); if(!r.ok)throw new Error(j&&j.error?j.error:"manual_error"); syncManualUi(!!j.manualOpen); await refreshConversations(true);}catch(e){alert("No se pudo cambiar la pausa del bot: "+(e.message||e)); syncManualUi(!manualToggle.checked);}});
function updateFileHint(){const f=fileInput.files&&fileInput.files[0]; if(!f){fileHint.style.display="none"; fileHint.textContent=""; return;} fileHint.style.display="flex"; fileHint.textContent="📎 "+f.name;}
fileInput.addEventListener("change",updateFileHint); fileHint.addEventListener("click",()=>{fileInput.value=""; updateFileHint();});
sendForm.addEventListener("submit",async(e)=>{e.preventDefault(); if(!activeWaId&&!activeConvId&&!activeConvIds.length)return; const text=String(msgInput.value||"").trim(); const file=fileInput.files&&fileInput.files[0]; if(!text&&!file)return; sendBtn.disabled=true; try{if(file){const fd=new FormData(); Object.entries(selectedPayload()).forEach(([k,v])=>{if(Array.isArray(v))fd.append(k,v.join(",")); else if(v)fd.append(k,v);}); if(text)fd.append("text",text); fd.append("file",file); const r=await fetch(api("/api/admin/wa-inbox/send-file"),{method:"POST",body:fd}); const j=await r.json().catch(()=>null); if(!r.ok)throw new Error((j&&j.detail)|| (j&&j.error) || "send_file_error"); fileInput.value=""; updateFileHint();}else{const r=await fetch(api("/api/admin/wa-inbox/send-message"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...selectedPayload(),text})}); const j=await r.json().catch(()=>null); if(!r.ok)throw new Error((j&&j.detail)|| (j&&j.error) || "send_message_error");} msgInput.value=""; await refreshActiveMessages();}catch(err){alert("No se pudo enviar: "+(err.message||err));}finally{sendBtn.disabled=false; msgInput.focus();}});
searchInput.addEventListener("input",renderList);
if(backBtn)backBtn.addEventListener("click",()=>showContacts(true));
window.addEventListener("popstate",()=>{if(isMobile())showContacts(false);});
refreshBtn.addEventListener("click",async()=>{try{await refreshConversations(true,{force:true}); if(activeContactKey)await refreshActiveMessages({force:true}); setRefreshStatus("Actualizado");}catch{setRefreshStatus("Error");}});
renderList(); lastConversationsSig=sigForConversations(conversations); history.replaceState({waInboxView:(PRESELECT_CONV||PRESELECT_WA)?"chat":"list"},"",location.href);
(function init(){let row=null; if(PRESELECT_WA)row=conversations.find(c=>String(c.waId||"")===PRESELECT_WA); if(!row&&PRESELECT_CONV)row=conversations.find(c=>String(c._id||"")===PRESELECT_CONV || (Array.isArray(c.conversationIds)&&c.conversationIds.includes(PRESELECT_CONV))); if(row)selectContact({convId:row._id||"",convIds:row.conversationIds||[],waId:row.waId||"",contactKey:row.contactKey||normalizeContactKey(row.waId||""),pushHistory:false}); else showContacts(false); refreshTimer=setInterval(async()=>{try{const changed=await refreshConversations(true); if(activeContactKey)await refreshActiveMessages(); if(changed)setRefreshStatus("Nuevo");}catch{}},7000);})();
 </script>
</body>
</html>`;
}

function mountWhatsAppInboxPanel(app, { auth } = {}) {
  if (!app || !auth) throw new Error("mountWhatsAppInboxPanel_requires_app_and_auth");

  // Nueva UI. Se monta antes del /admin/inbox legacy; el código viejo queda intacto debajo.
  app.get("/admin/inbox", async (req, res) => {
    try {
      const tenant = resolveTenantIdFromAuth(auth, req);
      const conversations = await loadInboxConversations(tenant, 500);
      res.status(200).send(inboxHtml(conversations, tenant));
    } catch (e) {
      console.error("GET /admin/inbox wa-inbox error:", e?.message || e);
      res.status(500).send("Error interno");
    }
  });

  app.get("/api/admin/wa-inbox/conversations", async (req, res) => {
    try {
      const tenant = resolveTenantIdFromAuth(auth, req);
      const limit = Math.max(1, Math.min(Number(req.query.limit || 500), 1000));
      res.json(await loadInboxConversations(tenant, limit));
    } catch (e) {
      console.error("GET /api/admin/wa-inbox/conversations error:", e?.message || e);
      errorJson(res, 500, "internal");
    }
  });

  app.get("/api/admin/wa-inbox/meta", async (req, res) => {
    try {
      const tenant = resolveTenantIdFromAuth(auth, req);
      const convs = await findConversationsForInbox({
        tenantId: tenant,
        convId: req.query.convId,
        convIds: req.query.convIds,
        waId: req.query.waId,
        contactKey: req.query.contactKey,
      });
      if (!convs.length) return errorJson(res, 404, "conv_not_found");
      const groups = buildInboxContactGroups(convs);
      const group = groups[0];
      return res.json({
        ok: true,
        convId: group._id,
        contactKey: group.contactKey,
        waId: group.waId,
        contactName: group.contactName || "",
        status: group.status || "OPEN",
        manualOpen: convs.some((c) => !!c.manualOpen),
        conversationIds: convs.map((c) => String(c._id)),
        conversationCount: convs.length,
        channelType: group.channelType || "whatsapp",
        phoneNumberId: group.phoneNumberId || null,
        displayPhoneNumber: group.displayPhoneNumber || null,
      });
    } catch (e) {
      console.error("GET /api/admin/wa-inbox/meta error:", e?.message || e);
      errorJson(res, 500, "internal");
    }
  });

  app.get("/api/admin/wa-inbox/messages", async (req, res) => {
    try {
      const tenant = resolveTenantIdFromAuth(auth, req);
      const convs = await findConversationsForInbox({
        tenantId: tenant,
        convId: req.query.convId,
        convIds: req.query.convIds,
        waId: req.query.waId,
        contactKey: req.query.contactKey,
      });
      const ids = convs.map((c) => c._id).filter(Boolean);
      if (!ids.length) return res.json([]);
      const db = await getDb();
      const rows = await db.collection("messages")
        .find(buildInboxMessagesFilter(ids, tenant))
        .sort({ ts: 1, createdAt: 1, _id: 1 })
        .limit(1000)
        .toArray();
      res.json(rows.map((m) => toInboxMessageDto(m, tenant)));
    } catch (e) {
       console.error("GET /api/admin/wa-inbox/messages error:", e?.stack || e?.message || e);
      errorJson(res, 500, "internal", e?.message || e);
    }
  });

  app.post("/api/admin/wa-inbox/manual", async (req, res) => {
    try {
      const tenant = resolveTenantIdFromAuth(auth, req);
      const convs = await findConversationsForInbox({
        tenantId: tenant,
        convId: req.body?.convId,
        convIds: req.body?.convIds,
        waId: req.body?.waId,
        contactKey: req.body?.contactKey,
      });
      const ids = convs.map((c) => c._id).filter(Boolean);
      if (!ids.length) return errorJson(res, 404, "conv_not_found");
      const flag = !!req.body?.manualOpen;
      const db = await getDb();
      await db.collection("conversations").updateMany(
        withTenant({ _id: { $in: ids } }, tenant),
        { $set: { manualOpen: flag, updatedAt: new Date() } }
      );
      res.json({ ok: true, manualOpen: flag, conversationIds: ids.map(String) });
    } catch (e) {
      console.error("POST /api/admin/wa-inbox/manual error:", e?.message || e);
      errorJson(res, 500, "internal");
    }
  });

  app.post("/api/admin/wa-inbox/send-message", async (req, res) => {
    try {
      const tenant = resolveTenantIdFromAuth(auth, req);
      const text = String(req.body?.text || "").trim();
      if (!text) return errorJson(res, 400, "text_required");
      const conv = await pickConversationForReply({ tenantId: tenant, convId: req.body?.convId, waId: req.body?.waId, convIds: req.body?.convIds });
      if (!conv) return errorJson(res, 404, "conv_not_found");
      if (String(conv.channelType || "whatsapp").toLowerCase() !== "whatsapp") return errorJson(res, 400, "only_whatsapp_supported");

      const waOpts = await getRuntimeForConversation(conv, tenant);
      const sent = await sendWhatsAppTextStrict(conv.waId, text, waOpts);
      await saveOutboundMessage({ tenantId: tenant, conv, content: text, type: "text", meta: { waInbox: { outbound: true, providerResponse: sent || null } } });
      res.json({ ok: true });
    } catch (e) {
      console.error("POST /api/admin/wa-inbox/send-message error:", e?.message || e);
      errorJson(res, 500, "send_message_failed", e?.message || e);
    }
  });

  app.post("/api/admin/wa-inbox/send-file", async (req, res) => {
    try {
      const tenant = resolveTenantIdFromAuth(auth, req);
      const parsed = await parseMultipartForm(req, MAX_UPLOAD_BYTES);
      const file = parsed.files.file || parsed.files.attachment || parsed.files.media;
      if (!file || !file.data || !file.data.length) return errorJson(res, 400, "file_required");
      const conv = await pickConversationForReply({ tenantId: tenant, convId: parsed.fields.convId, waId: parsed.fields.waId, convIds: parsed.fields.convIds });
      if (!conv) return errorJson(res, 404, "conv_not_found");
      if (String(conv.channelType || "whatsapp").toLowerCase() !== "whatsapp") return errorJson(res, 400, "only_whatsapp_supported");

      const filename = safeFileName(file.name || "archivo");
      const mime = String(file.mimetype || "application/octet-stream").trim() || "application/octet-stream";
      const caption = String(parsed.fields.text || parsed.fields.caption || "").trim();
      const kind = inferOutboundMediaKind(mime, filename);
      const waOpts = await getRuntimeForConversation(conv, tenant);
      const sent = await sendWhatsAppMediaStrict(conv.waId, { buffer: file.data, filename, mime, caption, type: kind }, waOpts);
      const cacheId = putInCache(file.data, mime);

      await saveOutboundMessage({
        tenantId: tenant,
        conv,
        content: caption || `[Archivo enviado: ${filename}]`,
        type: kind,
        meta: {
          waInbox: {
            outbound: true,
            media: { mediaId: sent?.mediaId || null, kind, filename, mime, caption: caption || null, cacheId },
          },
        },
      });

      res.json({ ok: true, mediaId: sent?.mediaId || null, kind, filename });
    } catch (e) {
      console.error("POST /api/admin/wa-inbox/send-file error:", e?.message || e);
      errorJson(res, 500, "send_file_failed", e?.message || e);
    }
  });

  app.get("/api/admin/wa-inbox/media/:msgId", async (req, res) => {
    try {
      const tenant = resolveTenantIdFromAuth(auth, req);
      const msgId = String(req.params.msgId || "").trim();
      if (!ObjectId.isValid(msgId)) return sendUnavailableMedia(res, {}, "Archivo no disponible");

      const db = await getDb();
      const msgDoc = await db.collection("messages").findOne(withTenant({ _id: new ObjectId(msgId) }, tenant));
      if (!msgDoc) return sendUnavailableMedia(res, {}, "Archivo no disponible");

      const infoLocal = extractMessageMediaInfo(msgDoc);
      let conv = null;
      try {
        if (msgDoc.conversationId) {
          conv = await db.collection("conversations").findOne(withTenant({ _id: msgDoc.conversationId }, tenant), { projection: { phoneNumberId: 1 } });
        }
      } catch {}

      const forceDl = String(req.query?.download || "") === "1";
      const sendBuffer = (buffer, mime, filename) => {
        const mimeFinal = String(mime || "application/octet-stream");
        let finalName = safeFileName(filename || "archivo");
        const ext = extFromMime(mimeFinal);
        if (ext && !finalName.toLowerCase().endsWith("." + ext)) finalName += "." + ext;
        const inlinePreferred = !forceDl && (mimeFinal.startsWith("image/") || mimeFinal.startsWith("audio/") || mimeFinal.startsWith("video/") || mimeFinal.includes("pdf"));
        res.setHeader("Content-Type", mimeFinal);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Disposition", `${inlinePreferred ? "inline" : "attachment"}; filename="${finalName}"`);
        return res.send(buffer);
      };

      if (infoLocal.mediaId) {
        try {
          const waOpts = await getRuntimeForConversation(conv || {}, tenant);
          const info = await getMediaInfo(infoLocal.mediaId, waOpts);
          const buffer = await downloadMediaBuffer(info.url, waOpts);
          return sendBuffer(buffer, info?.mime_type || infoLocal.mime, infoLocal.filename);
        } catch (e) {
          console.warn("GET /api/admin/wa-inbox/media unavailable_from_meta:", msgId, e?.message || e);
          if (!infoLocal.cacheId) return sendUnavailableMedia(res, infoLocal, "Archivo no disponible");
        }
      }

      if (infoLocal.cacheId) {
        const item = getFromCache(infoLocal.cacheId);
        if (item) return sendBuffer(item.buffer, item.mime || infoLocal.mime, infoLocal.filename);
      }

      return sendUnavailableMedia(res, infoLocal, "Archivo no disponible");
    } catch (e) {
            console.warn("GET /api/admin/wa-inbox/media unavailable:", e?.message || e);
      return sendUnavailableMedia(res, {}, "Archivo no disponible");
    }
  });
}

module.exports = { mountWhatsAppInboxPanel };
