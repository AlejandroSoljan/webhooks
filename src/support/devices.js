// Asisto | Version: 5.00.067 | Fecha: 2026-09-08
const express = require('express');
const { randomBytes } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { scopeOf, scopedId, hash, fail, text, SupportError } = require('./core');

const deviceLeaseId = scope => scopedId(scope, 'desktop-worker');
function createDeviceRouter({ getService, publicOrigin }) {
  const router = express.Router(), starts = new Map(), activeWork = new Map();
  router.use(express.json({ limit: '128kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (Buffer.byteLength(JSON.stringify(req.body || {})) > 128 * 1024) return res.status(413).json({ error: 'body_too_large' });
    next();
  });
  const route = fn => async (req, res, next) => { try { res.json(await fn(req, await getService())); } catch (error) { next(error); } };
  const browserScope = req => {
    const scope = scopeOf(req.user);
    if (req.method !== 'GET' && (req.headers.origin !== publicOrigin || req.headers['x-asisto-support'] !== '1' || !req.is('application/json'))) fail('csrf_rejected', 403);
    return scope;
  };
  const credential = async (req, s, pending = false) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) fail('device_unauthorized', 401);
    const device = await s.col('devices').findOne({ _id: hash(token) });
    if (!device || device.expiresAt <= s.now() || (!pending && device.state !== 'approved') || device.state === 'revoked') fail('device_unauthorized', 401);
    if (device.state === 'approved') {
      const user = ObjectId.isValid(device.userId) && await s.db.collection('users').findOne({ _id: new ObjectId(device.userId), tenantId: device.tenantId, isLocked: { $ne: true } });
      if (!user) fail('device_unauthorized', 401);
      scopeOf({ ...user, uid: String(user._id) });
    }
    return device;
  };
  const context = async (req, s) => {
    const device = await credential(req, s);
    const scope = { tenantId: device.tenantId, userId: device.userId };
    const instance = req.headers['x-asisto-instance'];
    if (!/^[a-f0-9-]{36}$/.test(instance || '')) fail('invalid_instance');
    return { device, scope, owner: hash(device._id, instance), id: deviceLeaseId(scope) };
  };
  const assertLease = async (s, ctx) => {
    if (!await s.col('leases').findOne({ _id: ctx.id, owner: ctx.owner, until: { $gt: s.now() } })) fail('device_lease_lost', 409);
    if (!await s.col('devices').findOne({ _id: ctx.device._id, state: 'approved', expiresAt: { $gt: s.now() } })) fail('device_unauthorized', 401);
  };
  router.post('/start', route(async (req, s) => {
    if (req.headers.origin && req.headers.origin !== publicOrigin) fail('csrf_rejected', 403);
    const now = Date.now();
    for (const [ip, record] of starts) if (record.until < now) starts.delete(ip);
    if (starts.size > 10000) fail('device_rate_limited', 429);
    const rate = starts.get(req.ip) || { count: 0, until: now + 600000 };
    if (++rate.count > 30) fail('device_rate_limited', 429);
    starts.set(req.ip, rate);
    const token = randomBytes(32).toString('base64url'), code = randomBytes(6).toString('hex').toUpperCase();
    const expiresAt = new Date(+s.now() + 600000);
    await s.col('devices').insertOne({ _id: hash(token), code, name: text(req.body.name || 'Mi PC', 80), state: 'pending', createdAt: s.now(), expiresAt });
    const page = req.body.sessionsPanel === true ? '/admin/wweb' : '/ui/support';
    return { token, code, expiresAt, verificationUrl: `${publicOrigin}${page}?device=${code}` };
  }));
  router.post('/poll', route(async (req, s) => {
    const device = await credential(req, s, true);
    return { state: device.state, ...(device.state === 'approved' ? { userId: device.userId, tenantId: device.tenantId } : {}) };
  }));
  router.get('/request/:code', route(async (req, s) => {
    browserScope(req);
    const device = await s.col('devices').findOne({ code: text(req.params.code, 12), state: 'pending', expiresAt: { $gt: s.now() } });
    if (!device) fail('device_request_expired', 404);
    return { name: device.name, code: device.code };
  }));
  router.post('/approve', route(async (req, s) => {
    const scope = browserScope(req), code = text(req.body.code, 12);
    const device = await s.col('devices').findOne({ code, state: 'pending', expiresAt: { $gt: s.now() } });
    if (!device) fail('device_request_expired', 404);
    // Explicit approval replaces this user's previous PC only.
    await s.col('devices').updateMany({ ...scope, state: 'approved' }, { $set: { state: 'revoked', revokedAt: s.now() } });
    const updated = await s.col('devices').updateOne({ _id: device._id, state: 'pending', expiresAt: { $gt: s.now() } }, { $set: { ...scope, state: 'approved', approvedAt: s.now(), expiresAt: new Date(+s.now() + 365 * 86400000) } });
    if (!updated.modifiedCount) fail('device_request_expired', 409);
    await s.col('leases').deleteOne({ _id: deviceLeaseId(scope) });
    await s.col('sessions').updateOne(scope, { $set: { desired: 'connected', state: 'queued', qr: null, updatedAt: s.now() }, $setOnInsert: { _id: scopedId(scope, 'session') } }, { upsert: true });
    return { approved: true };
  }));
  router.post('/revoke', route(async (req, s) => {
    const scope = browserScope(req);
    await s.col('devices').updateMany({ ...scope, state: 'approved' }, { $set: { state: 'revoked', revokedAt: s.now() } });
    await s.col('leases').deleteOne({ _id: deviceLeaseId(scope) });
    await s.col('sessions').updateOne(scope, { $set: { desired: 'disconnected', state: 'disconnected', qr: null } });
    return { revoked: true };
  }));
  router.post('/heartbeat', route(async (req, s) => {
    const ctx = await context(req, s);
    const queuedMessages = Number.isSafeInteger(req.body.queuedMessages) && req.body.queuedMessages >= 0 ? req.body.queuedMessages : null;
    try {
      await s.col('leases').findOneAndUpdate({ _id: ctx.id, $or: [{ owner: ctx.owner }, { until: { $lte: s.now() } }] }, { $set: { ...ctx.scope, owner: ctx.owner, deviceId: ctx.device._id, source: 'desktop', queuedMessages, until: new Date(+s.now() + 30000) } }, { upsert: true });
    } catch (e) { if (e.code === 11000) fail('device_already_running', 409); throw e; }
    const session = await s.col('sessions').findOne(ctx.scope);
    return { desired: session?.desired || 'disconnected' };
  }));
  router.post('/session', route(async (req, s) => {
    const ctx = await context(req, s); await assertLease(s, ctx);
    const state = text(req.body.state, 30), qr = req.body.qr ? text(req.body.qr, 4096) : null;
    if (!['qr', 'connected', 'reconnecting', 'disconnected', 'logged_out'].includes(state)) fail('invalid_session_state');
    const id = scopedId(ctx.scope, 'session');
    await s.col('sessions').updateOne({ _id: id, ...ctx.scope, ...(state === 'disconnected' ? {} : { desired: 'connected' }) }, { $set: { state, qr: qr ? s.vault.seal(qr, id + ':qr') : null, qrExpiresAt: new Date(+s.now() + 45000), updatedAt: s.now(), ...(state === 'logged_out' ? { desired: 'disconnected' } : {}) } });
    return { ok: true };
  }));
  router.post('/messages', route(async (req, s) => {
    const ctx = await context(req, s); await assertLease(s, ctx);
    if (!Array.isArray(req.body.messages) || req.body.messages.length > 25) fail('invalid_messages');
    for (let offset = 0; offset < req.body.messages.length; offset += 5) {
    await Promise.all(req.body.messages.slice(offset, offset + 5).map(async input => {
      await assertLease(s, ctx);
      const message = { id: text(input.id, 200), jid: text(input.jid, 200), name: text(input.name || '', 200), fromMe: input.fromMe === true, at: new Date(input.at), text: input.contentTooLarge ? ' '.repeat(20001) : text(input.text || '', 20000), audio: input.audio || null, raw: input.raw ? text(input.raw, 64000) : null };
      await s.ingest(ctx.scope, message, { historical: input.historical === true || message.at < ctx.device.approvedAt });
    }));
    }
    return { accepted: req.body.messages.length };
  }));
  router.post('/contacts', route(async (req, s) => {
    const ctx = await context(req, s); await assertLease(s, ctx);
    if (!Array.isArray(req.body.contacts) || req.body.contacts.length > 50) fail('invalid_contacts');
    for (const input of req.body.contacts) {
      const jid = text(input.jid, 200), name = text(input.name, 200);
      if (!/^[^@]+@(s\.whatsapp\.net|lid)$/.test(jid) || !name) fail('invalid_contact');
      const aliases = input.aliases || [jid];
      if (!Array.isArray(aliases) || aliases.length > 5 || aliases.some(id => typeof id !== 'string' || id.length > 200 || !/^[^@]+@(s\.whatsapp\.net|lid)$/.test(id))) fail('invalid_contact');
      await assertLease(s, ctx);
      await s.col('contacts').updateOne({ _id: scopedId(ctx.scope, 'contact', jid), ...ctx.scope }, { $set: { jid, name, aliases: [...new Set([jid, ...aliases])], source: 'whatsapp', updatedAt: s.now() } }, { upsert: true });
    }
    return { accepted: req.body.contacts.length };
  }));
  router.post('/work', route(async (req, s) => {
    const ctx = await context(req, s); await assertLease(s, ctx);
    // A slow transcription may outlive the agent's HTTP timeout. Do not start
    // another job for that owner while the original request is still working.
    if (activeWork.has(ctx.id)) return { processed: false, busy: true };
    const work = (async () => {
      if (s.transcribe) await s.col('jobs').updateMany({ ...ctx.scope, state: { $in: ['pending', 'failed'] }, error: 'transcription_provider_required', transcriptionRecoveryV1: { $ne: true } }, {
        $set: { state: 'pending', attempts: 0, dueAt: s.now(), transcriptionRecoveryV1: true }, $unset: { error: '' },
      });
      await s.repairQueue(ctx.scope);
      return { processed: await s.runOne(() => assertLease(s, ctx), ctx.scope) };
    })();
    activeWork.set(ctx.id, work);
    try { return await work; } finally { activeWork.delete(ctx.id); }
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error instanceof SupportError ? error.status : 500).json({ error: error instanceof SupportError ? error.code : 'device_request_failed' });
  });
  return router;
}
module.exports = { createDeviceRouter, deviceLeaseId };
