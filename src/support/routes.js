// Asisto | Version: 5.00.071 | Fecha: 2026-09-09
const express = require('express');
const path = require('node:path');
const QRCode = require('qrcode');
const { getDb } = require('../../db');
const { inspectConfiguration } = require('./config');
const { scopeOf, scopedId, hash, fail, text, SupportError } = require('./core');
const { SupportService } = require('./service');
const { asistoTranscriber } = require('./transcriber');
const { asistoTitleAnalyzer } = require('./title_analyzer');
const { HubSpotContract } = require('./hubspot');
const { createDeviceRouter, deviceLeaseId } = require('./devices');
const { createExtensionRouter } = require('./extension');

function createRouter({ getService, hubspotFactory = token => new HubSpotContract(token), publicOrigin, hubspotEnabled = process.env.SUPPORT_HUBSPOT_ENABLED === 'true' }) {
  const router = express.Router();
  router.use((req, res, next) => {
    try {
      req.supportScope = scopeOf(req.user);
      res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
      if (!['GET', 'HEAD'].includes(req.method)) {
        // Cookie authenticated mutations require an exact configured origin and a non-simple header.
        if (req.headers.origin !== publicOrigin || req.headers['x-asisto-support'] !== '1' || !req.is('application/json')) fail('csrf_rejected', 403);
      }
      next();
    } catch (e) { next(e); }
  });
  router.use(express.json({ limit: '128kb' }));
  router.use((req, res, next) => {
    if (Buffer.byteLength(JSON.stringify(req.body || {})) > 128 * 1024) return res.status(413).json({ error: 'body_too_large' });
    next();
  });
  const route = fn => async (req, res, next) => { try { const s = await getService(); res.json(await fn(req, s, req.supportScope)); } catch (e) { next(e); } };
  const admin = req => { if (!['admin', 'superadmin'].includes(req.user.role)) fail('admin_required', 403); };
  const requireHubSpot = () => { if (!hubspotEnabled) fail('hubspot_deferred', 409); };
  const client = async (s, scope) => {
    requireHubSpot();
    const row = await s.col('integrations').findOne({ tenantId: scope.tenantId });
    if (!row) fail('hubspot_not_configured', 409);
    return hubspotFactory(s.vault.open(row.token, hash(scope.tenantId, 'hubspot')));
  };
  router.get('/capabilities', (req, res) => res.json({ hubspotEnabled, ...req.supportScope }));
  router.get('/settings', route((req, s, scope) => s.config(scope)));
  router.put('/settings', route((req, s, scope) => s.saveConfig(scope, req.body)));
  router.put('/tenant-settings', route((req, s, scope) => { admin(req); return s.saveConfig({ ...scope, userId: '*' }, req.body); }));
  router.get('/session', route(async (req, s, scope) => {
    const row = await s.col('sessions').findOne(scope);
    const qr = row?.qr && row.desired === 'connected' && row.qrExpiresAt > s.now() ? await QRCode.toDataURL(s.vault.open(row.qr, row._id + ':qr')) : null;
    return { state: row?.state || 'disconnected', desired: row?.desired || 'disconnected', qr, qrExpiresAt: row?.qrExpiresAt || null };
  }));
  router.post('/session', route(async (req, s, scope) => {
    const desired = req.body.desired;
    if (!['connected', 'disconnected'].includes(desired)) fail('invalid_session_state');
    const _id = scopedId(scope, 'session');
    await s.col('sessions').updateOne({ _id, ...scope }, { $set: { desired, state: desired === 'connected' ? 'queued' : 'disconnected', qr: null, retryAt: s.now(), updatedAt: s.now() }, $push: { events: { action: desired, at: s.now(), by: scope.userId } } }, { upsert: true });
    return { desired };
  }));
  router.post('/history', route((req, s, scope) => s.history(scope, req.body.from, req.body.to)));
  router.get('/history/status', route((req, s, scope) => s.historyStatus(scope, req.query.from, req.query.to)));
  router.get('/drafts', route((req, s, scope) => s.listDrafts(scope, req.query.before, req.query.view || 'tasks')));
  router.get('/drafts/:id/evidence', route((req, s, scope) => s.evidence(scope, req.params.id)));
  router.patch('/drafts/:id', route((req, s, scope) => s.editDraft(scope, req.params.id, req.body.revision, req.body.fields)));
  router.post('/drafts/:id/approve', route((req, s, scope) => s.editDraft(scope, req.params.id, req.body.revision, {}, true)));
  router.post('/drafts/:id/acknowledge-source', route(async (req, s, scope) => {
    if (!Number.isInteger(req.body.revision)) fail('revision_required', 409);
    const result = await s.col('drafts').updateOne({ _id: text(req.params.id, 64), ...scope, revision: req.body.revision, 'hubspot.state': { $nin: ['sending', 'uncertain'] }, state: { $ne: 'merged' }, reconciliationRequired: { $ne: true } }, { $set: { sourceChanged: false, state: 'pending', updatedAt: s.now() }, $inc: { revision: 1 }, $push: { events: { action: 'source_reviewed', at: s.now(), by: scope.userId } } });
    if (!result.matchedCount) fail('revision_conflict_or_reconciliation_required', 409);
    return { revision: req.body.revision + 1 };
  }));
  router.get('/jobs', route((req, s, scope) => s.col('jobs').find(scope, { projection: { claim: 0 } }).sort({ createdAt: -1 }).limit(50).toArray()));
  router.get('/usage', route((req, s, scope) => s.col('usage').find(scope).sort({ at: -1 }).limit(100).toArray()));
  router.get('/audit', route((req, s, scope) => s.col('audit').find(scope).sort({ at: -1 }).limit(100).toArray()));
  router.get('/memory', route((req, s, scope) => s.col('memory').find(scope).limit(500).toArray()));
  router.put('/memory', route((req, s, scope) => s.rememberContact(scope, req.body)));
  router.put('/memory/verify', route(async (req, s, scope) => {
    requireHubSpot();
    const jid = text(req.body.jid);
    if (!/^[^@]+@(s\.whatsapp\.net|lid)$/.test(jid)) fail('invalid_jid');
    const identity = await (await client(s, scope)).identity(text(req.body.companyId), text(req.body.contactId || ''));
    await s.col('memory').updateOne({ ...scope, jid }, { $set: { ...identity, source: 'hubspot', verifiedAt: s.now() }, $push: { events: { action: 'identity_verified', by: scope.userId, at: s.now() } } }, { upsert: true });
    return identity;
  }));
  router.put('/hubspot', route(async (req, s, scope) => {
    admin(req);
    requireHubSpot();
    const token = text(req.body.token, 1000);
    if (!token) fail('token_required');
    await hubspotFactory(token).metadata();
    await s.col('integrations').updateOne({ tenantId: scope.tenantId }, { $set: { token: s.vault.seal(token, hash(scope.tenantId, 'hubspot')), updatedAt: s.now() }, $push: { events: { action: 'token_replaced', by: scope.userId, at: s.now() } } }, { upsert: true });
    return { configured: true };
  }));
  router.get('/hubspot/metadata', route(async (req, s, scope) => (await client(s, scope)).metadata()));
  router.get('/hubspot/companies/:id/tickets', route(async (req, s, scope) => (await client(s, scope)).companyTickets(req.params.id)));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error instanceof SupportError ? error.status : 500).json({ error: error instanceof SupportError ? error.code : 'support_request_failed' });
  });
  return router;
}

function mountSupport(app) {
  const configuration = inspectConfiguration();
  const { publicOrigin, vault } = configuration;
  app.get('/api/support/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let scope;
    try { scope = scopeOf(req.user); } catch { return res.status(403).json({ error: 'forbidden' }); }
    const checks = configuration.checks.map(check => ({ ...check }));
    let workerRunning = false, queuedMessages = null;
    if (configuration.ready) {
      try {
        const db = await getDb();
        checks.push({ key: 'migration', ok: !!await db.collection('support_migrations').findOne({ _id: '001' }), label: 'Preparar las colecciones de soporte' });
        const lease = await db.collection('support_leases').findOne({ _id: deviceLeaseId(scope), source: 'desktop', until: { $gt: new Date() } });
        workerRunning = !!lease; queuedMessages = lease?.queuedMessages ?? null;
      } catch { checks.push({ key: 'connection', ok: false, label: 'Restablecer la conexión a la base de datos' }); }
    }
    res.json({ ready: checks.every(check => check.ok), checks, workerRunning, queuedMessages });
  });
  // Resolve the shared DB on every request; db.js may disconnect an idle client.
  const getService = async () => {
    const db = await getDb();
    if (!await db.collection('support_migrations').findOne({ _id: '001' })) fail('support_migration_required', 503);
    return new SupportService(db, vault, { transcribe: asistoTranscriber(), titleAnalyzer: asistoTitleAnalyzer() });
  };
  if (configuration.ready) {
    app.use('/api/support/device', createDeviceRouter({ getService, publicOrigin }));
    app.use('/api/support/extension', createExtensionRouter({ getService }));
    app.use('/api/support', createRouter({ getService, publicOrigin }));
  }
  else app.use('/api/support', (req, res) => {
    try { scopeOf(req.user); } catch { return res.status(403).json({ error: 'forbidden' }); }
    res.set('Cache-Control', 'no-store').status(503).json({ error: 'support_setup_required' });
  });
  app.get('/admin/support', (req, res) => {
    try { scopeOf(req.user); } catch { return res.status(403).send('No autorizado'); }
    res.set('Cache-Control', 'no-store').set('Content-Security-Policy', "default-src 'self'; connect-src 'self' http://127.0.0.1:17658; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'self'");
    res.sendFile(path.join(__dirname, 'panel.html'));
  });
}
module.exports = { createRouter, mountSupport };
