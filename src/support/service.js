// Asisto | Version: 5.00.075 | Fecha: 2026-09-09
const crypto = require('node:crypto');
const { fail, scopedId, hash, settings, excluded, groupTasks, analyze, ANALYZER_VERSION, text, range } = require('./core');

class SupportService {
  constructor(db, vault, { transcribe = null, titleAnalyzer = null, now = () => new Date() } = {}) {
    this.db = db; this.vault = vault; this.transcribe = transcribe; this.titleAnalyzer = titleAnalyzer; this.now = now;
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
  async repairTitle(scope) {
    if (!this.titleAnalyzer) return false;
    const row = await this.col('drafts').findOne({ ...scope, analyzerVersion: { $ne: ANALYZER_VERSION }, state: { $nin: ['merged', 'ignored'] }, 'hubspot.state': { $ne: 'saved' } }, { sort: { updatedAt: 1 } });
    if (!row) return false;
    const generatedOnly = row.events?.every(event => ['generated', 'source_changed', 'tasks_merged'].includes(event.action)) === true;
    if (!generatedOnly) {
      await this.col('drafts').updateOne({ _id: row._id, ...scope, revision: row.revision }, { $set: { analyzerVersion: ANALYZER_VERSION, titleUpgradeSkipped: 'human_edited', updatedAt: this.now() } });
      return true;
    }
    const messages = await this.col('messages').find({ ...scope, _id: { $in: row.messageIds || [] } }).sort({ at: 1, _id: 1 }).limit(500).toArray();
    const decoded = messages.map(message => ({ ...message, text: this.vault.open(message.payload, message._id).text || '' })).filter(message => message.text.trim());
    if (!decoded.length) return false;
    const title = await this.titleAnalyzer.run(decoded, { ...scope, jid: row.jid, draftId: row._id });
    const fields = this.vault.open(row.fields, row._id), source = this.vault.open(row.source, row._id + ':source');
    fields.subject = title.subject; source.subject = title.subject;
    const updated = await this.col('drafts').updateOne({ _id: row._id, ...scope, revision: row.revision, analyzerVersion: { $ne: ANALYZER_VERSION } }, { $set: { fields: this.vault.seal(fields, row._id), source: this.vault.seal(source, row._id + ':source'), analyzerVersion: ANALYZER_VERSION, updatedAt: this.now() }, $inc: { revision: 1 }, $push: { events: { action: 'title_regenerated_ai', at: this.now() } } });
    if (!updated.matchedCount) return false;
    await this.db.collection('ai_token_usage_log').insertOne({ ...scope, conversationId: row.jid, waId: row.jid, kind: 'message', provider: 'openai', model: title.model, inputTokens: title.inputTokens, outputTokens: title.outputTokens, totalTokens: title.totalTokens || title.inputTokens + title.outputTokens, channelType: 'whatsapp_tasks', meta: { usageType: 'whatsapp_task_title', source: 'support_task_title_repair' }, createdAt: this.now() });
    return true;
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
    const whatsappContact = await this.col('contacts').findOne({ _id: scopedId(scope, 'contact', job.jid), ...scope });
    const rows = (await this.col('messages').find({ ...scope, jid: job.jid }).sort({ at: 1, _id: 1 }).limit(5001).toArray()).map(row => ({ ...row, name: whatsappContact?.name || row.name }));
    if (rows.length > 5000) fail('conversation_requires_pagination', 422);
    const eligible = rows.filter(m => !excluded(m, config) && (job.dates ? m.at >= job.dates.start && m.at < job.dates.end : !m.historical));
    const decoded = [];
    // Group on the actual text, including cached audio transcriptions.
    for (const row of eligible) {
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
    for (const group of groupTasks(decoded)) {
      if (!job.dates && +group.at(-1).receivedAt + config.inactivityMs > +this.now()) continue;
      await check();
      const ids = group.map(m => m._id), fingerprint = hash(ids);
      if (group.some(m => m.contentTooLarge)) fail('message_too_large', 422);
      if (ids.length > 500 || group.reduce((n, m) => n + m.text.length, 0) > 100000) fail('conversation_window_too_large', 422);
      const existing = await this.col('drafts').find({ ...scope, jid: job.jid, state: { $ne: 'merged' }, messageIds: { $in: ids } }).sort({ createdAt: 1, _id: 1 }).toArray();
      if (existing.some(row => ['sending', 'uncertain'].includes(row.hubspot?.state))) fail('hubspot_delivery_in_progress', 409);
      const untouched = row => !row.hubspot?.ticketId && row.events?.every(event => ['generated', 'source_changed', 'tasks_merged'].includes(event.action)) === true;
      // A narrower historical request must not shrink a consolidated task.
      if (existing.length === 1 && existing[0].analyzerVersion === ANALYZER_VERSION && ids.every(id => existing[0].messageIds.includes(id))) continue;
      const edited = existing.filter(row => !untouched(row));
      if (edited.length > 1 || existing.some(row => row.messageIds.some(id => !ids.includes(id)))) {
        const flagged = await this.col('drafts').updateMany({ ...scope, _id: { $in: existing.map(d => d._id) }, 'hubspot.state': { $nin: ['sending', 'uncertain'] }, state: { $ne: 'merged' } }, { $set: { state: 'needs_review', sourceChanged: true, reconciliationRequired: true, updatedAt: this.now() } });
        if (flagged.matchedCount !== existing.length) fail('revision_conflict', 409);
        continue;
      }
      if (edited.length === 1) existing.sort((a, b) => Number(b._id === edited[0]._id) - Number(a._id === edited[0]._id));
      const started = Date.now(), result = analyze(group);
      if (result.result === 'draft' && this.titleAnalyzer) {
        const title = await this.titleAnalyzer.run(group, { ...scope, jid: job.jid, jobId: job._id });
        result.subject = title.subject;
        await this.db.collection('ai_token_usage_log').insertOne({ ...scope, conversationId: job.jid, waId: job.jid, kind: 'message', provider: 'openai', model: title.model, inputTokens: title.inputTokens, outputTokens: title.outputTokens, totalTokens: title.totalTokens || title.inputTokens + title.outputTokens, channelType: 'whatsapp_tasks', meta: { usageType: 'whatsapp_task_title', source: 'support_task_title' }, createdAt: this.now() });
      }
      if (result.description?.length > 100000) fail('conversation_window_too_large', 422);
      const _id = existing[0]?._id || scopedId(scope, 'draft', ids[0]);
      await check();
      await this.col('usage').insertOne({ ...scope, conversationId: job.jid, recordId: _id, fingerprint, model: ANALYZER_VERSION, kind: 'analysis', inputTokens: 0, outputTokens: 0, audioSeconds: 0, processingUnits: group.reduce((n, m) => n + m.text.length, 0), unit: 'characters', costUsd: 0, durationMs: Date.now() - started, result: result.result, at: this.now() });
      const memory = await this.col('memory').findOne({ ...scope, jid: job.jid });
      const draft = { ...result, messageDate: group[0].at.toISOString(), companyId: memory?.companyId || '', company: memory?.company || '', contactId: memory?.contactId || '', contact: memory?.contact || whatsappContact?.name || group.find(m => !m.fromMe && m.name)?.name || '', identitySource: memory?.source || (memory?.verifiedAt ? 'hubspot' : 'unassigned'), proposedAction: 'review' };
      if (existing.length) {
        const generatedOnly = untouched(existing[0]);
        const saved = await this.col('drafts').updateOne({ _id, ...scope, revision: existing[0].revision, 'hubspot.state': { $nin: ['sending', 'uncertain'] }, state: { $ne: 'merged' } }, { $set: { fingerprint, analyzerVersion: ANALYZER_VERSION, messageIds: ids, state: generatedOnly ? (result.result === 'ignored' ? 'ignored' : 'pending') : 'needs_review', sourceChanged: !generatedOnly, reconciliationRequired: false, ...(generatedOnly ? { fields: this.vault.seal(draft, _id) } : {}), source: this.vault.seal(draft, _id + ':source'), updatedAt: this.now() }, $inc: { revision: 1 }, $push: { events: { action: existing.length > 1 ? 'tasks_merged' : 'source_changed', at: this.now() } } });
        if (!saved.matchedCount) fail('revision_conflict', 409);
        for (const duplicate of existing.slice(1)) {
          const merged = await this.col('drafts').updateOne({ _id: duplicate._id, ...scope, revision: duplicate.revision, 'hubspot.state': { $nin: ['sending', 'uncertain'] }, state: { $ne: 'merged' } }, { $set: { state: 'merged', mergedInto: _id, updatedAt: this.now() }, $inc: { revision: 1 }, $push: { events: { action: 'tasks_merged', into: _id, at: this.now() } } });
          if (!merged.matchedCount) fail('revision_conflict', 409);
          await this.col('drafts').updateOne({ _id, ...scope }, { $addToSet: { mergedDraftIds: duplicate._id } });
        }
      } else {
        await this.col('drafts').updateOne({ _id, ...scope }, { $setOnInsert: { ...scope, jid: job.jid, messageIds: ids, fingerprint, analyzerVersion: ANALYZER_VERSION, state: result.result === 'ignored' ? 'ignored' : 'pending', revision: 1, fields: this.vault.seal(draft, _id), source: this.vault.seal(draft, _id + ':source'), mode: config.mode, createdAt: this.now(), updatedAt: this.now(), events: [{ action: 'generated', at: this.now() }] } }, { upsert: true });
      }
    }
  }

  async listDrafts(scope, before, view = 'all') {
    if (!['all', 'tasks', 'ignored'].includes(view)) fail('invalid_draft_view');
    const rows = await this.col('drafts').find({ ...scope, state: { $ne: 'merged' }, ...(view === 'tasks' ? { state: { $nin: ['ignored', 'merged'] } } : view === 'ignored' ? { state: 'ignored' } : {}), ...(before ? { _id: { $lt: text(before, 64) } } : {}) }).sort({ _id: -1 }).limit(50).toArray();
    const decoded = rows.map(({ fields, source, ...row }) => ({ ...row, fields: this.vault.open(fields, row._id), source: this.vault.open(source, row._id + ':source') }));
    const missing = [...new Set(decoded.filter(row => !row.fields.contact).map(row => row.jid))];
    if (missing.length) {
      const contacts = await this.col('contacts').find({ ...scope, _id: { $in: missing.map(jid => scopedId(scope, 'contact', jid)) } }).toArray();
      const names = new Map(contacts.map(contact => [contact.jid, contact.name]));
      const messages = await this.col('messages').aggregate([{ $match: { ...scope, jid: { $in: missing.filter(jid => !names.has(jid)) }, fromMe: false, name: { $type: 'string', $ne: '' } } }, { $sort: { at: -1 } }, { $group: { _id: '$jid', name: { $first: '$name' } } }]).toArray();
      for (const row of messages) names.set(row._id, row.name);
      for (const row of decoded) if (!row.fields.contact && names.has(row.jid)) row.fields.contact = names.get(row.jid);
    }
    return decoded;
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
    if (current.state === 'merged') fail('draft_merged', 409);
    if (current.hubspot?.state === 'sending') fail('hubspot_delivery_in_progress', 409);
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
    const result = await this.col('drafts').updateOne({ _id: id, ...scope, revision, state: { $ne: 'merged' }, 'hubspot.state': { $ne: 'sending' } }, {
      $set: { fields: this.vault.seal(fields, id), state, updatedAt: this.now() }, $inc: { revision: 1 },
      $push: { events: { action: approve ? 'approved' : 'edited', by: scope.userId, revision: revision + 1, at: this.now() } },
    });
    if (!result.matchedCount) fail('revision_conflict', 409);
    return { id, revision: revision + 1, state, remoteWrite: false };
  }
}
module.exports = { SupportService };
