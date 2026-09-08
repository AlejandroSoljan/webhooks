// Asisto | Version: 5.00.064 | Fecha: 2026-09-08
const crypto = require('node:crypto');
const { fail, scopedId, hash, settings, excluded, groupMessages, analyze, text, range } = require('./core');

class SupportService {
  constructor(db, vault, { transcribe = null, now = () => new Date() } = {}) {
    this.db = db; this.vault = vault; this.transcribe = transcribe; this.now = now;
  }
  col(name) { return this.db.collection(`support_${name}`); }
  async audit(scope, action, recordId, outcome = 'ok') {
    await this.col('audit').insertOne({ ...scope, action, recordId, outcome, at: this.now() });
  }
  async config(scope) {
    const [tenant, user] = await Promise.all([
      this.col('settings').findOne({ tenantId: scope.tenantId, userId: '*' }),
      this.col('settings').findOne(scope),
    ]);
    const own = settings(user?.config);
    return { ...own, excludedJids: [...(tenant?.config.excludedJids || []), ...own.excludedJids], excludedNames: [...(tenant?.config.excludedNames || []), ...own.excludedNames] };
  }
  async saveConfig(scope, input) {
    const config = settings(input);
    await this.col('settings').updateOne(scope, { $set: { config, updatedAt: this.now() }, $push: { events: { action: 'settings_saved', at: this.now() } } }, { upsert: true });
    return config;
  }
  async rememberContact(scope, input) {
    const jid = text(input.jid);
    if (!/^[^@]+@(s\.whatsapp\.net|lid)$/.test(jid)) fail('invalid_jid');
    // Manual labels must never inherit a previously verified remote identity.
    if (['companyId', 'contactId', 'verifiedAt', 'source'].some(key => Object.hasOwn(input, key))) fail('manual_identity_fields_only');
    const company = text(input.company || ''), contact = text(input.contact || '');
    if (!company) fail('company_required');
    const identity = { company, contact, source: 'manual', updatedAt: this.now() };
    await this.col('memory').updateOne({ ...scope, jid }, {
      $set: identity, $unset: { companyId: '', contactId: '', verifiedAt: '' },
      $push: { events: { action: 'identity_recorded_manually', by: scope.userId, at: this.now() } },
    }, { upsert: true });
    return { jid, ...identity };
  }
  async ingest(scope, message, { historical = false } = {}) {
    const config = await this.config(scope);
    if (excluded(message, config)) return { ignored: true };
    if (!message.id || !Number.isFinite(+message.at) || message.at > new Date(+this.now() + 300000)) return { ignored: true };
    const _id = scopedId(scope, 'message', message.jid, message.id, !!message.fromMe);
    const { text: content = '', raw = null, ...metadata } = message;
    const contentTooLarge = String(content).length > 20000;
    const doc = { _id, ...scope, ...metadata, historical, contentTooLarge, payload: this.vault.seal({ text: contentTooLarge ? '' : String(content), raw }, _id), queued: false, receivedAt: this.now() };
    await this.col('messages').updateOne({ _id, ...scope }, { $setOnInsert: doc }, { upsert: true });
    await this.enqueueMessage(scope, { ...message, historical }, config.inactivityMs);
    await this.col('messages').updateOne({ _id, ...scope }, { $set: { queued: true } });
    return { id: _id };
  }
  async enqueueMessage(scope, message, delay) {
    if (!message.historical) return this.enqueue(scope, message.jid, delay);
    const requests = await this.col('history_requests').find({ ...scope, 'dates.start': { $lte: message.at }, 'dates.end': { $gt: message.at }, expiresAt: { $gt: this.now() } }).toArray();
    for (const request of requests) await this.enqueue(scope, message.jid, 1000, request.dates);
  }
  async enqueue(scope, jid, delay = 0, dates = null) {
    const _id = scopedId(scope, 'job', jid, dates ? [dates.start.toISOString(), dates.end.toISOString()] : 'live');
    await this.col('jobs').updateOne({ _id, ...scope }, {
      $set: { jid, dates, state: 'pending', dueAt: new Date(+this.now() + delay), attempts: 0 },
      $inc: { generation: 1 }, $setOnInsert: { createdAt: this.now() },
    }, { upsert: true });
    return _id;
  }
  async history(scope, from, to) {
    const dates = range(from, to);
    await this.col('history_requests').updateOne({ _id: scopedId(scope, 'history', dates.start.toISOString(), dates.end.toISOString()), ...scope }, { $set: { dates, updatedAt: this.now(), expiresAt: new Date(+this.now() + 30 * 86400000) } }, { upsert: true });
    // Asisto's MongoDB pool uses Stable API v1 with apiStrict:true.
    // distinct is unavailable there; aggregate preserves the scoped grouping.
    const chats = await this.col('messages').aggregate([
      { $match: { ...scope, at: { $gte: dates.start, $lt: dates.end } } },
      { $group: { _id: '$jid', messages: { $sum: 1 } } },
    ]).toArray();
    const jids = chats.map(chat => chat._id);
    for (const jid of jids) await this.enqueue(scope, jid, 0, dates);
    await this.audit(scope, 'history_requested', `${dates.start.toISOString()}/${dates.end.toISOString()}`);
    return { conversations: jids.length, messages: chats.reduce((n, chat) => n + chat.messages, 0), source: 'locally_synced_messages', completeHistoryGuaranteed: false };
  }
  async historyStatus(scope, from, to) {
    const dates = range(from, to);
    const rows = await this.col('jobs').aggregate([
      { $match: { ...scope, 'dates.start': dates.start, 'dates.end': dates.end } },
      { $group: { _id: { state: '$state', error: '$error' }, count: { $sum: 1 } } },
    ]).toArray();
    const result = { pending: 0, processing: 0, done: 0, failed: 0, retrying: 0, errors: [] };
    for (const row of rows) {
      if (Object.hasOwn(result, row._id.state) && typeof result[row._id.state] === 'number') result[row._id.state] += row.count;
      if (row._id.error && ['pending', 'failed'].includes(row._id.state)) result.errors.push(row._id.error);
      if (row._id.error && row._id.state === 'pending') result.retrying += row.count;
    }
    result.errors = [...new Set(result.errors)];
    const lease = await this.col('leases').findOne({ ...scope, source: 'desktop', until: { $gt: this.now() } });
    result.syncPending = lease?.queuedMessages ?? null;
    return result;
  }
  async repairQueue(owner = {}) {
    const rows = await this.col('messages').find({ ...owner, queued: false }).limit(100).toArray();
    for (const row of rows) {
      const scope = { tenantId: row.tenantId, userId: row.userId };
      await this.enqueueMessage(scope, row, (await this.config(scope)).inactivityMs);
      await this.col('messages').updateOne({ _id: row._id, ...scope }, { $set: { queued: true } });
    }
  }
  async runOne(assertOwner = async () => {}, owner = {}) {
    const claim = crypto.randomUUID();
    const job = await this.col('jobs').findOneAndUpdate({ ...owner, $or: [
      { state: 'pending', dueAt: { $lte: this.now() } },
      { state: 'processing', leaseUntil: { $lte: this.now() } },
    ] }, { $set: { state: 'processing', claim, leaseUntil: new Date(+this.now() + 120000) }, $inc: { attempts: 1 } }, { sort: { dueAt: 1 }, returnDocument: 'after' });
    if (!job) return false;
    const scope = { tenantId: job.tenantId, userId: job.userId };
    const filter = { _id: job._id, claim, generation: job.generation };
    const check = async () => {
      await assertOwner();
      const r = await this.col('jobs').updateOne({ ...filter, state: 'processing', leaseUntil: { $gt: this.now() } }, { $set: { leaseUntil: new Date(+this.now() + 120000) } });
      if (!r.matchedCount) fail('job_lease_lost', 409);
    };
    try {
      await this.process(scope, job, check);
      await check();
      await this.col('jobs').updateOne(filter, { $set: { state: 'done', completedAt: this.now() }, $unset: { error: '' } });
    } catch (error) {
      const code = error.code || 'processing_failed';
      await this.col('jobs').updateOne(filter, { $set: { state: job.attempts >= 3 ? 'failed' : 'pending', error: code, dueAt: new Date(+this.now() + 30000 * job.attempts) } });
      await this.audit(scope, 'processing_failed', job._id, code);
    }
    return true;
  }
  async process(scope, job, check) {
    const { ObjectId } = require('mongodb');
    const actor = ObjectId.isValid(scope.userId) ? await this.db.collection('users').findOne({ _id: new ObjectId(scope.userId), tenantId: scope.tenantId, isLocked: { $ne: true } }) : null;
    if (!actor || !['user', 'admin', 'superadmin'].includes(actor.role) || (actor.role !== 'superadmin' && Array.isArray(actor.allowedPages) && !actor.allowedPages.includes('support'))) fail('access_revoked', 403);
    const config = await this.config(scope);
    // Read complete stored chat for stable boundaries across overlapping history requests.
    const rows = await this.col('messages').find({ ...scope, jid: job.jid }).sort({ at: 1, _id: 1 }).limit(5001).toArray();
    if (rows.length > 5000) fail('conversation_requires_pagination', 422);
    const eligible = rows.filter(m => !excluded(m, config) && (job.dates ? m.at >= job.dates.start && m.at < job.dates.end : !m.historical));
    for (const group of groupMessages(eligible, config.inactivityMs)) {
      if (job.dates && !group.some(m => m.at >= job.dates.start && m.at < job.dates.end)) continue;
      if (!job.dates && +group.at(-1).receivedAt + config.inactivityMs > +this.now()) continue;
      await check();
      const ids = group.map(m => m._id);
      if (group.some(m => m.contentTooLarge)) fail('message_too_large', 422);
      if (ids.length > 500) fail('conversation_window_too_large', 422);
      const fingerprint = hash(ids);
      const existing = await this.col('drafts').find({ ...scope, jid: job.jid, messageIds: { $in: ids } }).toArray();
      if (existing.length === 1 && existing[0].fingerprint === fingerprint) continue;
      if (existing.length > 1) {
        await this.col('drafts').updateMany({ ...scope, _id: { $in: existing.map(d => d._id) } }, { $set: { state: 'needs_review', sourceChanged: true, reconciliationRequired: true, updatedAt: this.now() }, $inc: { revision: 1 } });
        continue;
      }
      const decoded = [];
      for (const row of group) {
        await check();
        const payload = this.vault.open(row.payload, row._id);
        if (row.audio && !payload.transcribed) {
          if (!this.transcribe) fail('transcription_provider_required', 422);
          const attemptId = crypto.randomUUID(), started = Date.now();
          const units = { inputTokens: 0, outputTokens: 0, audioSeconds: row.audio.seconds, processingUnits: row.audio.seconds, costUsd: null };
          await this.col('usage').insertOne({ _id: attemptId, ...scope, conversationId: job.jid, messageId: row._id, model: this.transcribe.model, kind: 'transcription', ...units, result: 'started', at: this.now() });
          try {
            const result = await this.transcribe.run(payload.raw, row.audio, { ...scope, jid: job.jid, conversationId: job._id, messageId: row._id });
            payload.text = text(result.text, 50000); payload.transcribed = true;
            await check();
            await this.col('messages').updateOne({ _id: row._id, ...scope }, { $set: { payload: this.vault.seal(payload, row._id) } });
            await this.col('usage').updateOne({ _id: attemptId }, { $set: { result: 'ok', model: result.model || this.transcribe.model, durationMs: Date.now() - started, costUsd: result.costUsd ?? null } });
          } catch (e) {
            await this.col('usage').updateOne({ _id: attemptId }, { $set: { result: 'error', error: e.code || 'transcription_failed', durationMs: Date.now() - started } });
            throw e;
          }
        }
        decoded.push({ ...row, text: payload.text });
      }
      const started = Date.now();
      if (decoded.reduce((n, m) => n + m.text.length, 0) > 100000) fail('conversation_window_too_large', 422);
      const result = analyze(decoded);
      if (result.description?.length > 100000) fail('conversation_window_too_large', 422);
      const _id = existing[0]?._id || scopedId(scope, 'draft', ids[0]);
      await check();
      await this.col('usage').insertOne({ ...scope, conversationId: job.jid, recordId: _id, fingerprint, model: 'manager-rules-v1', kind: 'analysis', inputTokens: 0, outputTokens: 0, audioSeconds: 0, processingUnits: decoded.reduce((n, m) => n + m.text.length, 0), unit: 'characters', costUsd: 0, durationMs: Date.now() - started, result: result.result, at: this.now() });
      const memory = await this.col('memory').findOne({ ...scope, jid: job.jid });
      const draft = { ...result, messageDate: group[0].at.toISOString(), companyId: memory?.companyId || '', company: memory?.company || '', contactId: memory?.contactId || '', contact: memory?.contact || group.find(m => !m.fromMe)?.name || '', identitySource: memory?.source || (memory?.verifiedAt ? 'hubspot' : 'unassigned'), proposedAction: 'review' };
      if (existing.length) {
        // Refresh generated fields as history arrives, but never overwrite human edits.
        const untouched = existing[0].events?.every(event => ['generated', 'source_changed'].includes(event.action)) === true;
        await this.col('drafts').updateOne({ _id, ...scope, revision: existing[0].revision }, { $set: { fingerprint, messageIds: ids, state: untouched ? (result.result === 'ignored' ? 'ignored' : 'pending') : 'needs_review', sourceChanged: !untouched, ...(untouched ? { fields: this.vault.seal(draft, _id) } : {}), source: this.vault.seal(draft, _id + ':source'), updatedAt: this.now() }, $inc: { revision: 1 }, $push: { events: { action: 'source_changed', at: this.now() } } });
      } else {
        await this.col('drafts').updateOne({ _id, ...scope }, { $setOnInsert: { ...scope, jid: job.jid, messageIds: ids, fingerprint, state: result.result === 'ignored' ? 'ignored' : 'pending', revision: 1, fields: this.vault.seal(draft, _id), source: this.vault.seal(draft, _id + ':source'), mode: config.mode, createdAt: this.now(), updatedAt: this.now(), events: [{ action: 'generated', at: this.now() }] } }, { upsert: true });
      }
    }
  }
  async listDrafts(scope, before, view = 'all') {
    if (!['all', 'tasks', 'ignored'].includes(view)) fail('invalid_draft_view');
    const rows = await this.col('drafts').find({ ...scope, ...(view === 'tasks' ? { state: { $ne: 'ignored' } } : view === 'ignored' ? { state: 'ignored' } : {}), ...(before ? { _id: { $lt: text(before, 64) } } : {}) }).sort({ _id: -1 }).limit(50).toArray();
    return rows.map(({ fields, source, ...row }) => ({ ...row, fields: this.vault.open(fields, row._id), source: this.vault.open(source, row._id + ':source') }));
  }
  async evidence(scope, id) {
    const draft = await this.col('drafts').findOne({ _id: text(id, 64), ...scope });
    if (!draft) fail('not_found', 404);
    const rows = await this.col('messages').find({ ...scope, _id: { $in: draft.messageIds } }).sort({ at: 1, _id: 1 }).limit(500).toArray();
    return { description: rows.map(row => {
      const payload = this.vault.open(row.payload, row._id);
      return `${row.at.toISOString()} ${row.fromMe ? 'Operador' : 'Contacto'}: ${row.audio && !payload.transcribed ? '[Audio pendiente de transcripción]' : payload.text}`;
    }).join('\n').slice(0, 100000) };
  }
  async editDraft(scope, id, revision, input, approve = false) {
    if (!Number.isInteger(revision) || revision < 1) fail('revision_required', 409);
    const current = await this.col('drafts').findOne({ _id: text(id, 64), ...scope });
    if (!current) fail('not_found', 404);
    if (approve) {
      const config = await this.config(scope);
      const sources = await this.col('messages').find({ ...scope, _id: { $in: current.messageIds } }).toArray();
      if (sources.some(m => excluded(m, config))) fail('conversation_excluded', 409);
    }
    const fields = this.vault.open(current.fields, id);
    const editable = ['subject', 'description', 'companyId', 'company', 'contactId', 'contact', 'status', 'channel', 'category', 'errorType', 'messageDate', 'proposedAction'];
    for (const [key, value] of Object.entries(input || {})) {
      if (!editable.includes(key)) fail('invalid_draft_field');
      fields[key] = text(value, key === 'description' ? 100000 : 200);
    }
    if (!['review', 'create', 'update', 'close', 'ignore'].includes(fields.proposedAction)) fail('invalid_action');
    if (!Number.isFinite(+new Date(fields.messageDate))) fail('invalid_message_date');
    if (approve && (current.reconciliationRequired || current.sourceChanged)) fail('source_reconciliation_required', 409);
    if (approve && current.mode === 'suggest') fail('suggestion_only', 409);
    if (approve && (!fields.subject || (!fields.company && !fields.companyId) || fields.proposedAction === 'review')) fail('approval_fields_required');
    const state = approve ? 'approved' : 'pending';
    const result = await this.col('drafts').updateOne({ _id: id, ...scope, revision }, {
      $set: { fields: this.vault.seal(fields, id), state, updatedAt: this.now() }, $inc: { revision: 1 },
      $push: { events: { action: approve ? 'approved' : 'edited', by: scope.userId, revision: revision + 1, at: this.now() } },
    });
    if (!result.matchedCount) fail('revision_conflict', 409);
    return { id, revision: revision + 1, state, remoteWrite: false };
  }
}
module.exports = { SupportService };
