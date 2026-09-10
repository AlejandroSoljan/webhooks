// Asisto | Version: 5.00.096 | Fecha: 2026-09-10
const express = require('express');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { scopeOf, scopedId, hash, text, fail, SupportError, TASK_CHOICES } = require('./core');
const { HubSpotContract } = require('./hubspot');
const { hubspotCredential } = require('./hubspot_config');

function createExtensionRouter({ getService, hubspotFactory = token => new HubSpotContract(token), env = process.env }) {
  const router = express.Router();
  router.use(express.json({ limit: '128kb' }));
  router.use(async (req, res, next) => {
    try {
      req.service = await getService();
      const deviceToken = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
      if (deviceToken) {
        const device = await req.service.col('devices').findOne({ _id: hash(deviceToken), state: 'approved', expiresAt: { $gt: req.service.now() } });
        const user = device && ObjectId.isValid(device.userId) ? await req.service.db.collection('users').findOne({ _id: new ObjectId(device.userId), tenantId: device.tenantId, isLocked: { $ne: true } }) : null;
        if (!user) fail('device_unauthorized', 401);
        req.user = { ...user, uid: String(user._id) };
      }
      req.scope = scopeOf(req.user);
      res.set('Cache-Control', 'no-store');
      const id = req.headers['x-asisto-extension-id'];
      if (!/^[a-p]{32}$/.test(id || '')) fail('extension_required', 403);
      req.extensionOrigin = 'chrome-extension://' + id;
      if (req.headers.origin && req.headers.origin !== req.extensionOrigin) fail('csrf_rejected', 403);
      if (!['GET', 'HEAD'].includes(req.method)) {
        let grant;
        try { grant = req.service.vault.open(JSON.parse(Buffer.from(req.headers['x-asisto-extension'] || '', 'base64url').toString()), 'extension-csrf'); } catch { fail('extension_session_expired', 403); }
        if (grant.origin !== req.extensionOrigin || grant.tenantId !== req.scope.tenantId || grant.userId !== req.scope.userId || grant.expires <= Date.now()) fail('extension_session_expired', 403);
      }
      next();
    } catch (error) { next(error); }
  });
  const route = fn => async (req, res, next) => { try { res.json(await fn(req, req.service, req.scope)); } catch (error) { next(error); } };
  const rowFor = async (s, scope, id) => {
    const row = await s.col('drafts').findOne({ _id: text(id, 64), ...scope, state: { $ne: 'merged' } });
    if (!row) fail('not_found', 404);
    return row;
  };
  const clientFor = async (s, scope) => {
    const credential = await hubspotCredential(s, scope, env);
    if (!credential) fail('hubspot_not_configured', 409);
    return { connection: credential.connection, client: hubspotFactory(credential.token), source: credential.source };
  };
  router.get('/session', route(async (req, s, scope) => {
    const csrf = Buffer.from(JSON.stringify(s.vault.seal({ ...scope, origin: req.extensionOrigin, expires: Date.now() + 600000 }, 'extension-csrf'))).toString('base64url');
    return { ...scope, username: req.user.username || '', csrf, choices: TASK_CHOICES };
  }));
  router.get('/index', route(async (req, s, scope) => {
    const chats = await s.col('drafts').aggregate([{ $match: { ...scope, state: { $nin: ['merged', 'ignored'] }, 'hubspot.state': { $ne: 'saved' } } }, { $group: { _id: '$jid', count: { $sum: 1 }, updatedAt: { $max: '$updatedAt' } } }, { $sort: { updatedAt: -1 } }, { $limit: 1001 }]).toArray();
    const jids = chats.slice(0, 1000).map(row => row._id);
    const contacts = await s.col('contacts').find({ ...scope, jid: { $in: jids } }).toArray();
    const names = new Map(contacts.map(row => [row.jid, row]));
    const missing = jids.filter(jid => !names.get(jid)?.name);
    if (missing.length) {
      const recent = await s.col('messages').aggregate([{ $match: { ...scope, jid: { $in: missing }, fromMe: false, name: { $nin: ['', null] } } }, { $sort: { at: -1 } }, { $group: { _id: '$jid', name: { $first: '$name' } } }]).toArray();
      for (const row of recent) if (row.name) names.set(row._id, { name: row.name, aliases: [row._id] });
    }
    const config = await s.config(scope), { excluded } = require('./core');
    return { chats: chats.slice(0, 1000).map(row => ({ jid: row._id, count: row.count, name: names.get(row._id)?.name || '', aliases: names.get(row._id)?.aliases || [row._id] })).filter(chat => !excluded(chat, config)), truncated: chats.length > 1000 };
  }));
  router.get('/drafts', route(async (req, s, scope) => {
    const jid = text(req.query.jid, 200);
    const contact = await s.col('contacts').findOne({ _id: scopedId(scope, 'contact', jid), ...scope });
    const rows = await s.col('drafts').find({ ...scope, jid: { $in: [...new Set([jid, ...(contact?.aliases || [])])] }, state: { $nin: ['merged', 'ignored'] }, 'hubspot.state': { $ne: 'saved' } }).sort({ updatedAt: -1 }).limit(100).toArray();
    return rows.map(row => { const fields = s.vault.open(row.fields, row._id); return { id: row._id, subject: fields.subject || 'Tarea para revisar', contact: fields.contact || contact?.name || '', state: row.state, hubspot: row.hubspot || null }; });
  }));
  router.post('/contact', route(async (req, s, scope) => {
    const jid = text(req.body.jid, 200), name = text(req.body.name, 200);
    if (!/^[0-9]+@(s\.whatsapp\.net|lid)$/.test(jid) || !name) fail('invalid_contact');
    // A visible WhatsApp label can enrich only a conversation already owned by this user.
    if (!await s.col('messages').findOne({ ...scope, jid }, { projection: { _id: 1 } }) && !await s.col('drafts').findOne({ ...scope, jid }, { projection: { _id: 1 } })) return { saved: false };
    await s.col('contacts').updateOne({ _id: scopedId(scope, 'contact', jid), ...scope }, { $set: { jid, name, source: 'whatsapp-web', updatedAt: s.now() }, $addToSet: { aliases: jid } }, { upsert: true });
    return { saved: true };
  }));
  router.post('/contacts', route(async (req, s, scope) => {
    if (!Array.isArray(req.body.contacts) || req.body.contacts.length > 50) fail('invalid_contacts');
    const known = await s.col('drafts').find({ ...scope, state: { $ne: 'merged' } }, { projection: { jid: 1 } }).toArray(), knownJids = new Set(known.map(row => row.jid));
    const writes = [];
    for (const input of req.body.contacts) {
      const jid = text(input.jid, 200), name = text(input.name, 200);
      const aliases = Array.isArray(input.aliases) ? [...new Set(input.aliases.map(value => text(value, 200)).filter(value => /^\d+@(s\.whatsapp\.net|lid)$/.test(value)))] : [];
      if (!/^\d+@(s\.whatsapp\.net|lid)$/.test(jid) || !name || aliases.length > 5 || !knownJids.has(jid)) continue;
      writes.push({ updateOne: { filter: { _id: scopedId(scope, 'contact', jid), ...scope }, update: { $set: { jid, name, aliases: [...new Set([jid, ...aliases])], source: 'whatsapp-web', updatedAt: s.now() } }, upsert: true } });
    }
    if (writes.length) await s.col('contacts').bulkWrite(writes, { ordered: false });
    return { saved: writes.length };
  }));
  router.get('/drafts/:id', route(async (req, s, scope) => {
    try { await s.summarizeDraft(scope, req.params.id); } catch {}
    const row = await rowFor(s, scope, req.params.id), fields = s.vault.open(row.fields, row._id);
    if (!fields.contact) fields.contact = (await s.col('contacts').findOne({ _id: scopedId(scope, 'contact', row.jid), ...scope }))?.name || '';
    return { id: row._id, jid: row.jid, revision: row.revision, fields, source: s.vault.open(row.source, row._id + ':source'), sourceChanged: !!row.sourceChanged, reconciliationRequired: !!row.reconciliationRequired, hubspot: row.hubspot || null, mode: row.mode };
  }));
  router.post('/drafts/:id/save', route((req, s, scope) => s.editDraft(scope, req.params.id, req.body.revision, req.body.fields)));
  router.post('/drafts/:id/queue', route(async (req, s, scope) => {
    const row = await rowFor(s, scope, req.params.id);
    if (row.revision !== req.body.revision) fail('revision_conflict', 409);
    const result = await s.col('drafts').updateOne(
      { _id: row._id, ...scope, revision: row.revision, state: { $nin: ['merged', 'ignored'] }, 'hubspot.state': { $nin: ['sending', 'uncertain', 'saved'] } },
      { $set: { state: 'pending', 'hubspot.state': 'awaiting_configuration', 'hubspot.queuedAt': s.now(), updatedAt: s.now() }, $inc: { revision: 1 }, $push: { events: { action: 'queued_for_hubspot', by: scope.userId, at: s.now() } } }
    );
    if (!result.matchedCount) fail('revision_conflict', 409);
    await s.audit(scope, 'task_queued_for_hubspot', row._id);
    return { queued: true, revision: row.revision + 1 };
  }));
  router.post('/drafts/:id/manual-complete', route(async (req, s, scope) => {
    const row = await rowFor(s, scope, req.params.id);
    if (row.revision !== req.body.revision) fail('revision_conflict', 409);
    const hubspot = { state: 'saved', method: 'browser_extension', ticketId: text(req.body.ticketId || 'manual', 100), savedAt: s.now() };
    const result = await s.col('drafts').updateOne(
      { _id: row._id, ...scope, revision: row.revision, state: { $nin: ['merged', 'ignored'] }, 'hubspot.state': { $nin: ['sending', 'uncertain', 'saved'] } },
      { $set: { state: 'approved', hubspot, updatedAt: s.now() }, $inc: { revision: 1 }, $push: { events: { action: 'hubspot_saved_from_browser', by: scope.userId, at: s.now() } } }
    );
    if (!result.matchedCount) fail('revision_conflict', 409);
    await s.audit(scope, 'hubspot_saved_from_browser', row._id);
    return { ...hubspot, revision: row.revision + 1 };
  }));
  router.post('/drafts/:id/dismiss', route(async (req, s, scope) => {
    const row = await rowFor(s, scope, req.params.id);
    if (row.revision !== req.body.revision) fail('revision_conflict', 409);
    const result = await s.col('drafts').updateOne({ _id: row._id, ...scope, revision: row.revision, state: { $nin: ['merged', 'ignored'] }, 'hubspot.state': { $nin: ['sending', 'uncertain', 'saved'] } }, { $set: { state: 'ignored', updatedAt: s.now() }, $inc: { revision: 1 }, $push: { events: { action: 'dismissed_from_extension', by: scope.userId, at: s.now() } } });
    if (!result.matchedCount) fail('revision_conflict', 409);
    await s.audit(scope, 'task_dismissed', row._id);
    return { dismissed: true, revision: row.revision + 1 };
  }));
  router.get('/hubspot', route(async (req, s, scope) => {
    const credential = await hubspotCredential(s, scope, env);
    if (!credential) return { configured: false };
    const client = hubspotFactory(credential.token), checked = await client.preflight();
    const preferences = await s.col('settings').findOne(scope, { projection: { hubspotOwnerId: 1 } });
    const preferredOwnerId = checked.metadata.owners.some(row => String(row.id) === String(preferences?.hubspotOwnerId || '')) ? String(preferences.hubspotOwnerId) : '';
    return { configured: true, portalId: checked.portalId || credential.connection.portalId || null, metadata: checked.metadata, preferredOwnerId, credentialSource: credential.source };
  }));
  router.post('/hubspot/connect', route(async (req, s, scope) => {
    fail('hubspot_backend_managed', 410);
  }));
  router.get('/hubspot/search', route(async (req, s, scope) => {
    const type = text(req.query.type, 20), query = text(req.query.q || '', 200);
    const { client } = await clientFor(s, scope), result = await client.search(type, query, 15);
    return { results: (result.results || []).map(row => ({ id: String(row.id), properties: row.properties || {} })) };
  }));
  router.post('/drafts/:id/publish', route(async (req, s, scope) => {
    const row = await rowFor(s, scope, req.params.id);
    if (row.revision !== req.body.revision) fail('revision_conflict', 409);
    if (row.mode === 'suggest' || row.sourceChanged || row.reconciliationRequired) fail('source_reconciliation_required', 409);
    if (['sending', 'uncertain'].includes(row.hubspot?.state)) fail('hubspot_delivery_unconfirmed', 409);
    const fields = s.vault.open(row.fields, row._id);
    if (!fields.subject || (!fields.company && !fields.companyId) || fields.proposedAction === 'ignore') fail('approval_fields_required');
    const config = await s.config(scope);
    const sources = await s.col('messages').find({ ...scope, _id: { $in: row.messageIds } }).toArray();
    const { excluded } = require('./core');
    const contact = await s.col('contacts').findOne({ ...scope, jid: row.jid });
    if (excluded({ jid: row.jid, name: contact?.name || fields.contact }, config) || sources.some(message => excluded(message, config))) fail('conversation_excluded', 409);
    const { client, connection } = await clientFor(s, scope), checked = await client.preflight();
    connection.portalId = checked.portalId || connection.portalId || null;
    await s.audit(scope, 'hubspot_preflight_ok', checked.portalId);
    if (row.hubspot?.ticketId && row.hubspot.portalId !== (connection.portalId || null)) fail('hubspot_portal_changed', 409);
    if (fields.companyId || fields.contactId) {
      if (!fields.companyId) fail('company_required');
      await client.identity(fields.companyId, fields.contactId);
    }
    const mapping = req.body.mapping;
    if (!mapping?.fields || ['category', 'errorType', 'channel'].some(field => !mapping.fields[field]?.property)) fail('hubspot_mapping_required');
    if (new Set(['category', 'errorType', 'channel'].map(field => mapping.fields[field].property)).size !== 3) fail('hubspot_mapping_required');
    const payload = client.prepare(fields, checked.metadata, mapping);
    // Keep the WhatsApp labels visible even when CRM associations have not been chosen.
    payload.properties.content = ['Contacto de WhatsApp: ' + (fields.contact || ''), 'Empresa: ' + (fields.company || ''), '', fields.description].join('\n');
    if (row.hubspot?.ticketId && (row.hubspot.companyId !== (fields.companyId || '') || row.hubspot.contactId !== (fields.contactId || ''))) fail('hubspot_associations_changed', 409);
    const operationId = crypto.randomUUID();
    if (!row.hubspot?.ticketId) payload.objectWriteTraceId = operationId;
    const lock = await s.col('drafts').updateOne({ _id: row._id, ...scope, revision: row.revision, sourceChanged: { $ne: true }, reconciliationRequired: { $ne: true }, 'hubspot.state': { $nin: ['sending', 'uncertain'] }, state: { $ne: 'merged' } }, { $set: { hubspot: { ...row.hubspot, state: 'sending', operationId, startedAt: s.now() } } });
    if (!lock.matchedCount) fail('revision_conflict', 409);
    let remote;
    try {
      remote = await client.save(payload, row.hubspot?.ticketId);
      if (!remote?.id) throw new Error('missing_ticket_id');
    } catch (error) {
      const rejected = error.remoteStatus >= 400 && error.remoteStatus < 500;
      await s.col('drafts').updateOne({ _id: row._id, ...scope, 'hubspot.operationId': operationId }, { $set: { 'hubspot.state': rejected ? 'failed' : 'uncertain' } });
      fail(rejected ? (error.code || 'hubspot_request_failed') : 'hubspot_delivery_unconfirmed', 502);
    }
    const hubspot = { state: 'saved', ticketId: String(remote.id), portalId: connection.portalId || null, companyId: fields.companyId || '', contactId: fields.contactId || '', savedAt: s.now() };
    await s.col('drafts').updateOne({ _id: row._id, ...scope, 'hubspot.operationId': operationId }, { $set: { hubspot, state: 'approved' }, $inc: { revision: 1 } });
    await s.col('settings').updateOne(scope, { $set: { hubspotOwnerId: String(mapping.ownerId), updatedAt: s.now() } }, { upsert: true });
    await s.audit(scope, 'hubspot_saved', row._id);
    return { ...hubspot, revision: row.revision + 1 };
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error instanceof SupportError ? error.status : 500).json({ error: error instanceof SupportError ? error.code : 'extension_request_failed' });
  });
  return router;
}
module.exports = { createExtensionRouter };
