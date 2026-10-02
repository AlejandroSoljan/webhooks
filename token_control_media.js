'use strict';
const { ObjectId } = require('mongodb');
const { getDb } = require('./db');
const MAX_BYTES = 5 * 1024 * 1024;
const MEDIA_TYPES = new Set(['ptt', 'audio', 'image']);
function decodeMedia(raw) {
  let result; try { result = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (result?.status !== 'ready' || typeof result.data !== 'string' || result.data.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data)) return null;
  const buffer = Buffer.from(result.data, 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES) return null;
  const mime = String(result.mime || '').split(';')[0].toLowerCase();
  const magic = buffer.subarray(0, 12);
  const valid = (mime === 'image/jpeg' && magic[0] === 255 && magic[1] === 216 && magic[2] === 255) ||
    (mime === 'image/png' && magic.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
    (mime === 'image/webp' && magic.toString('ascii', 0, 4) === 'RIFF' && magic.toString('ascii', 8, 12) === 'WEBP') ||
    (mime === 'image/gif' && /^GIF8[79]a/.test(magic.toString('ascii'))) ||
    (mime === 'audio/ogg' && magic.toString('ascii', 0, 4) === 'OggS') ||
    (mime === 'audio/mpeg' && (magic.toString('ascii', 0, 3) === 'ID3' || (magic[0] === 255 && (magic[1] & 224) === 224))) ||
    (mime === 'audio/mp4' && magic.toString('ascii', 4, 8) === 'ftyp') ||
    (mime === 'audio/wav' && magic.toString('ascii', 0, 4) === 'RIFF' && magic.toString('ascii', 8, 12) === 'WAVE');
  return valid ? { buffer, mime, kind: mime.startsWith('image/') ? 'image' : 'audio' } : null;
}
function resultStatus(action) {
  if (decodeMedia(action.result)) return 'ready';
  if (action.result || Date.now() - new Date(action.requestedAt).getTime() > 60000) return 'unavailable';
  return 'pending';
}
function mountTokenMediaRoutes(app, auth, database = getDb) {
  const superOnly = (req, res, next) => String(req.user?.role || '').toLowerCase() === 'superadmin' ? next() : res.sendStatus(403);
  const wrap = fn => async (req, res) => { res.set('Cache-Control', 'no-store'); try { await fn(req, res); } catch { res.status(503).json({ error: 'media_unavailable' }); } };
  const objectId = value => /^[a-f\d]{24}$/i.test(String(value || '')) ? new ObjectId(value) : null;
  let indexes;
  app.post('/api/token-control/messages/:id/media', auth.requireAuth, superOnly, wrap(async (req, res) => {
    if (req.get('X-Asisto-Media') !== '1' || (req.get('Sec-Fetch-Site') && !['same-origin', 'none'].includes(req.get('Sec-Fetch-Site')))) return res.sendStatus(403);
    const logId = objectId(req.params.id); if (!logId) return res.sendStatus(404);
    const db = await database(), log = await db.collection('wa_wweb_message_log').findOne({ _id: logId });
    if (!log || !MEDIA_TYPES.has(String(log.messageType).toLowerCase()) || !log.messageId || !log.tenantId || !log.numero) return res.status(404).json({ error: 'media_unavailable' });
    const coll = db.collection('wa_wweb_actions');
    const lock = await db.collection('wa_locks').findOne({ _id: log.tenantId + ':' + log.numero }, { projection: { runtimeVersion: 1 } });
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(String(lock?.runtimeVersion || ''));
    if (version && (Number(version[1]) * 1000000 + Number(version[2]) * 1000 + Number(version[3])) < 4005016) return res.json({ status: 'requires_update' });
    if (!indexes) indexes = coll.createIndex({ mediaExpiresAt: 1 }, { expireAfterSeconds: 0, name: 'media_request_expiry' }).catch(e => { indexes = null; throw e; });
    await indexes;
    // One shared, short-lived request per log prevents polling/click duplicates.
    // Mongo ObjectId of the log is unique; actions otherwise use fresh ObjectIds.
    const key = logId, now = new Date();
    await coll.updateOne({ _id: key }, { $setOnInsert: { action: 'read_message_media', lockId: log.tenantId + ':' + log.numero,
      mediaLogId: logId, payload: { messageId: String(log.messageId), contact: String(log.contact || ''), direction: log.direction },
      requestedAt: now, requestedBy: String(req.user?.username || 'superadmin'), mediaExpiresAt: new Date(now.getTime() + 15 * 60 * 1000) } }, { upsert: true });
    const action = await coll.findOne({ _id: key });
    if (action.mediaExpiresAt <= now) return res.status(410).json({ error: 'media_expired' });
    res.json({ status: resultStatus(action), requestId: logId.toHexString() });
  }));
  async function load(req) {
    const logId = objectId(req.params.id); if (!logId) return null;
    const db = await database(), action = await db.collection('wa_wweb_actions').findOne({ _id: logId, action: 'read_message_media', mediaExpiresAt: { $gt: new Date() } });
    if (!action || !await db.collection('wa_wweb_message_log').findOne({ _id: logId }, { projection: { _id: 1 } })) return null;
    return action;
  }
  app.get('/api/token-control/media/:id', auth.requireAuth, superOnly, wrap(async (req, res) => {
    const action = await load(req); if (!action) return res.sendStatus(404);
    const status = resultStatus(action), media = status === 'ready' ? decodeMedia(action.result) : null;
    res.json({ status, ...(media ? { kind: media.kind, url: '/api/token-control/media/' + req.params.id + '/content' } : {}) });
  }));
  app.get('/api/token-control/media/:id/content', auth.requireAuth, superOnly, wrap(async (req, res) => {
    const action = await load(req), media = action && decodeMedia(action.result); if (!media) return res.sendStatus(404);
    res.set({ 'Content-Type': media.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Accept-Ranges': 'bytes', 'Cross-Origin-Resource-Policy': 'same-origin' });
    const range = req.get('Range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range), total = media.buffer.length;
      let start = match?.[1] ? Number(match[1]) : Math.max(0, total - Number(match?.[2]));
      let end = match?.[1] && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) return res.status(416).set('Content-Range', 'bytes */' + total).end();
      return res.status(206).set('Content-Range', `bytes ${start}-${end}/${total}`).send(media.buffer.subarray(start, end + 1));
    }
    res.send(media.buffer);
  }));
}
module.exports = { mountTokenMediaRoutes, decodeMedia, resultStatus };
