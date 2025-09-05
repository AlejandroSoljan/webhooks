// services/mediaService.js
const crypto = require("crypto");
const fetch = global.fetch || require("node-fetch");

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10); // 5 min

// In-memory cache
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

// periodic clean
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of fileCache.entries()) if (now > item.expiresAt) fileCache.delete(id);
}, 60 * 1000);

function registerCacheRoutes(app) {
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
}

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

function getBaseUrl(req) {
  let base = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/,"");
  if (!base) {
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const host = req.headers.host;
    base = `${proto}://${host}`;
  }
  return base;
}

module.exports = { registerCacheRoutes, putInCache, getFromCache, getMediaInfo, downloadMediaBuffer, getBaseUrl };
