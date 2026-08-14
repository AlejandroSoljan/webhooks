// conversation_followup_panel.js
// Seguimiento de conversaciones del bot en modo "conversacional".
// - Vista principal simple en tabla.
// - Chat y edición de seguimiento en modales.
// - Cierre automático por inactividad configurable por tenant.
// - Clasificación automática con IA al finalizar: tipo, cotización, satisfacción y resumen.
// - Superadmin puede seleccionar dominio; admin/user quedan restringidos a su tenant.

const { ObjectId } = require('mongodb');
const OpenAI = require('openai');
const { getDb } = require('./db');

const DEFAULT_TENANT_ID = String(process.env.TENANT_ID || 'default').trim() || 'default';
const SETTINGS_PREFIX = 'conversation_followup:';
const FOLLOWUP_COLLECTION = 'conversation_followups';
const DEFAULT_INACTIVITY_MINUTES = 30;
const AUTO_CLOSE_INTERVAL_MS = 60 * 1000;
const AI_RETRY_MINUTES = 10;
const AI_BACKFILL_PER_SWEEP = 4;
const aiClassificationInFlight = new Set();
const openaiClients = new Map();
const FOLLOWUP_BUILD = '2026-08-14-v3-no-temperature';

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cleanString(value, max = 500) {
  return String(value ?? '').trim().slice(0, Math.max(1, Number(max) || 500));
}

function boolValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return !!fallback;
  if (['1', 'true', 'yes', 'si', 'sí', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return !!fallback;
}

function intValue(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function resolveTenant(req, auth) {
  if (auth && typeof auth.resolveTenantId === 'function') {
    return auth.resolveTenantId(req, {
      defaultTenantId: DEFAULT_TENANT_ID,
      envTenantId: process.env.TENANT_ID,
    });
  }
  const role = String(req?.user?.role || '').toLowerCase();
  const userTenant = String(req?.user?.tenantId || '').trim();
  if (role !== 'superadmin' && userTenant) return userTenant;
  return String(req?.query?.tenant || req?.headers?.['x-tenant-id'] || userTenant || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
}

function isAdmin(req) {
  const role = String(req?.user?.role || '').toLowerCase();
  return role === 'admin' || role === 'superadmin';
}

function isSuperAdmin(req) {
  return String(req?.user?.role || '').toLowerCase() === 'superadmin';
}

function hasPageAccess(auth, req, key) {
  if (auth && typeof auth.hasAccess === 'function') return auth.hasAccess(req?.user, key);
  const role = String(req?.user?.role || '').toLowerCase();
  if (role === 'superadmin') return true;
  if (!Array.isArray(req?.user?.allowedPages)) return true;
  return req.user.allowedPages.includes(key);
}

function settingsId(tenant) {
  return SETTINGS_PREFIX + String(tenant || DEFAULT_TENANT_ID).trim();
}

async function loadConfig(db, tenant) {
  const doc = await db.collection('settings').findOne({ _id: settingsId(tenant) });
  return {
    tenantId: tenant,
    autoCloseEnabled: doc?.autoCloseEnabled !== false,
    inactivityMinutes: intValue(doc?.inactivityMinutes, DEFAULT_INACTIVITY_MINUTES, 1, 10080),
    updatedAt: doc?.updatedAt || null,
    updatedBy: doc?.updatedBy || null,
  };
}

async function saveConfig(db, tenant, body, req) {
  const cfg = {
    autoCloseEnabled: boolValue(body?.autoCloseEnabled, true),
    inactivityMinutes: intValue(body?.inactivityMinutes, DEFAULT_INACTIVITY_MINUTES, 1, 10080),
    tenantId: tenant,
    updatedAt: new Date(),
    updatedBy: cleanString(req?.user?.username || req?.user?.uid || 'admin', 120),
  };
  await db.collection('settings').updateOne(
    { _id: settingsId(tenant) },
    { $set: cfg },
    { upsert: true }
  );
  return cfg;
}

function normalizeWorkflowStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['pending_review', 'follow_up', 'resolved', 'discarded'].includes(v) ? v : 'pending_review';
}

function normalizeCategory(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['consulta', 'cotizacion', 'soporte', 'reclamo', 'comercial', 'otro'].includes(v) ? v : 'consulta';
}

function normalizePriority(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['baja', 'normal', 'alta', 'urgente'].includes(v) ? v : 'normal';
}

function normalizeQuoteRequested(value) {
  if (value === true || value === false) return value;
  const v = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'si', 'sí'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  return null;
}

function normalizeSatisfaction(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 1 && i <= 5 ? i : null;
}

function normalizeTags(value) {
  const arr = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(arr.map(v => cleanString(v, 50)).filter(Boolean))].slice(0, 20);
}

function effectiveWorkflow(conv, followup) {
  if (conv?.finalized !== true) return 'active';
  if (followup?.workflowStatus) return normalizeWorkflowStatus(followup.workflowStatus);
  return 'pending_review';
}

function lastActivity(conv) {
  return conv?.lastUserTs || conv?.lastAssistantTs || conv?.updatedAt || conv?.closedAt || conv?.openedAt || conv?.createdAt || null;
}

function hasManualClassification(followup) {
  if (!followup) return false;
  if (followup.manualClassificationEditedAt) return true;
  // Compatibilidad con clasificaciones guardadas manualmente por la versión anterior.
  const by = String(followup.classifiedBy || '').trim().toLowerCase();
  return !!by && by !== 'ai' && by !== 'asisto-ai' && !followup.aiClassifiedAt;
}

function shouldBypassAiRetry(followup) {
  const err = String(followup?.aiClassificationError || '').toLowerCase();
  // Error generado por la versión anterior del panel: algunos modelos sólo admiten
  // el valor por defecto de temperature. Como ya no enviamos ese parámetro,
  // permitimos reintentar inmediatamente después de actualizar el código.
  return err.includes('temperature') && (err.includes('unsupported') || err.includes('does not support'));
}

function publicConversation(conv, followup, lead, config) {
  const workflowStatus = effectiveWorkflow(conv, followup);
  const quoteDetected = String(conv?.leadType || lead?.leadType || '').toLowerCase() === 'cotizacion';
  const quoteRequested = followup && Object.prototype.hasOwnProperty.call(followup, 'quoteRequested')
    ? followup.quoteRequested
    : (quoteDetected ? true : null);
  const pendingContact = !!followup?.pendingContact;
  const nextContactAt = followup?.nextContactAt || null;
  const nextContactMs = nextContactAt ? new Date(nextContactAt).getTime() : NaN;
  const isDue = pendingContact && Number.isFinite(nextContactMs) && nextContactMs <= Date.now();
  const lastAt = lastActivity(conv);
  const lastMs = lastAt ? new Date(lastAt).getTime() : NaN;
  const inactivityMinutes = config?.inactivityMinutes || DEFAULT_INACTIVITY_MINUTES;
  const inactivityDeadline = conv?.finalized === true || !Number.isFinite(lastMs)
    ? null
    : new Date(lastMs + inactivityMinutes * 60 * 1000);
  const aiStatus = followup?.aiClassificationStatus || (followup?.aiClassifiedAt ? 'done' : 'pending');

  return {
    _id: String(conv?._id || ''),
    tenantId: conv?.tenantId || '',
    waId: conv?.waId || '',
    contactName: conv?.contactName || '',
    channelType: conv?.channelType || 'whatsapp',
    displayPhoneNumber: conv?.displayPhoneNumber || '',
    status: conv?.status || (conv?.finalized ? 'CLOSED' : 'OPEN'),
    finalized: conv?.finalized === true,
    closedAt: conv?.closedAt || null,
    closeReason: conv?.closeReason || '',
    openedAt: conv?.openedAt || conv?.createdAt || null,
    lastAt,
    inactivityDeadline,
    botMode: conv?.botMode || '',
    leadId: conv?.leadId ? String(conv.leadId) : null,
    leadType: conv?.leadType || lead?.leadType || null,
    quoteDetected,
    quoteReady: lead?.quoteReady === true,
    lead: lead ? {
      name: lead.name || '',
      company: lead.company || '',
      email: lead.email || '',
      phone: lead.phone || '',
      quote: lead.quote || null,
    } : null,
    workflowStatus,
    satisfaction: followup?.satisfaction ?? null,
    category: followup?.category || (quoteDetected ? 'cotizacion' : null),
    quoteRequested,
    pendingContact,
    nextContactAt,
    isDue,
    priority: followup?.priority || 'normal',
    assignedTo: followup?.assignedTo || '',
    summary: followup?.summary || '',
    notes: followup?.notes || '',
    tags: Array.isArray(followup?.tags) ? followup.tags : [],
    classifiedAt: followup?.classifiedAt || null,
    classifiedBy: followup?.classifiedBy || '',
    followupUpdatedAt: followup?.updatedAt || null,
    manualEditedAt: followup?.manualEditedAt || null,
    manualClassificationEditedAt: followup?.manualClassificationEditedAt || null,
    aiClassificationStatus: aiStatus,
    aiClassifiedAt: followup?.aiClassifiedAt || null,
    aiModel: followup?.aiModel || '',
    aiConfidence: followup?.aiConfidence || '',
    aiNeedsFollowUp: followup?.aiNeedsFollowUp === true,
    aiFollowUpReason: followup?.aiFollowUpReason || '',
    aiClassificationError: followup?.aiClassificationError || '',
    aiClassifierBuild: followup?.aiClassifierBuild || '',
  };
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadConversationBundle(db, tenant, conversationId) {
  const oid = new ObjectId(String(conversationId));
  const conv = await db.collection('conversations').findOne({ _id: oid, tenantId: tenant, botMode: 'conversacional' });
  if (!conv) return null;
  const [followup, lead] = await Promise.all([
    db.collection(FOLLOWUP_COLLECTION).findOne({ tenantId: tenant, conversationId: oid }),
    db.collection('leads').findOne({ tenantId: tenant, conversationId: oid }),
  ]);
  const config = await loadConfig(db, tenant);
  return { conv, followup, lead, config, item: publicConversation(conv, followup, lead, config) };
}

function mediaDescriptor(msg) {
  const type = String(msg?.type || msg?.meta?.raw?.type || '').toLowerCase();
  const raw = msg?.meta?.raw || {};
  const meta = msg?.meta?.media || {};
  let mime = meta.mime || meta.mimetype || '';
  let filename = meta.filename || '';
  if (type === 'image') {
    mime ||= raw?.image?.mime_type || '';
    filename ||= 'imagen';
  } else if (type === 'audio') {
    mime ||= raw?.audio?.mime_type || '';
    filename ||= 'audio';
  } else if (type === 'document') {
    mime ||= raw?.document?.mime_type || '';
    filename ||= raw?.document?.filename || raw?.document?.file_name || 'archivo';
  } else if (type === 'video') {
    mime ||= raw?.video?.mime_type || '';
    filename ||= 'video';
  } else if (type === 'sticker') {
    mime ||= raw?.sticker?.mime_type || '';
    filename ||= 'sticker';
  }
  const hasMedia = ['image', 'audio', 'document', 'video', 'sticker'].includes(type) || !!(meta.data || meta.base64 || meta.cacheId || meta.publicUrl);
  if (!hasMedia) return null;
  let kind = type || meta.kind || 'file';
  const ml = String(mime || '').toLowerCase();
  if (ml.startsWith('image/')) kind = 'image';
  else if (ml.startsWith('audio/')) kind = 'audio';
  else if (ml.startsWith('video/')) kind = 'video';
  else if (ml.includes('pdf')) kind = 'pdf';
  return { kind, mime: mime || null, filename: filename || 'archivo', url: '/api/media/' + String(msg._id) };
}

// ===================== Clasificación automática con IA =====================

function getOpenAIClient(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  if (openaiClients.has(key)) return openaiClients.get(key);
  const client = new OpenAI({ apiKey: key });
  openaiClients.set(key, client);
  return client;
}

function pickAiConfig(doc) {
  const cfg = doc && typeof doc === 'object' ? doc : {};
  const openai = cfg.openai && typeof cfg.openai === 'object' ? cfg.openai : {};
  const model = cleanString(
    openai.chat_model || openai.chatModel || cfg.CHAT_MODEL || cfg.chat_model || cfg.chatModel || process.env.CHAT_MODEL || 'gpt-5.4',
    120
  );
  return { model: model || 'gpt-5.4' };
}

async function resolveConversationAiRuntime(db, tenant, conv) {
  const [tenantDoc, channels] = await Promise.all([
    db.collection('tenant_config').findOne({ _id: tenant }).catch(() => null),
    db.collection('tenant_channels').find({ tenantId: tenant }).sort({ isDefault: -1, updatedAt: -1 }).limit(100).toArray().catch(() => []),
  ]);
  const aiCfg = pickAiConfig(tenantDoc || {});
  const candidates = [conv?.phoneNumberId, conv?.displayPhoneNumber]
    .map(v => String(v || '').trim())
    .filter(Boolean);
  let channel = channels.find(ch => candidates.includes(String(ch?.phoneNumberId || '').trim()) || candidates.includes(String(ch?.displayPhoneNumber || '').trim()));
  if (!channel) channel = channels.find(ch => ch?.isDefault === true && String(ch?.openaiApiKey || '').trim());
  if (!channel) channel = channels.find(ch => String(ch?.openaiApiKey || '').trim());
  const apiKey = String(channel?.openaiApiKey || process.env.OPENAI_API_KEY || '').trim();
  return { apiKey, model: aiCfg.model, channel };
}

function buildTranscript(messages) {
  const lines = [];
  for (const msg of messages || []) {
    const role = String(msg?.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    if (String(msg?.type || 'text').toLowerCase() === 'json') continue;
    const content = cleanString(msg?.content, 5000);
    if (!content) continue;
    lines.push((role === 'user' ? 'CLIENTE' : 'ASISTO') + ': ' + content);
  }
  let text = lines.join('\n');
  const max = 30000;
  if (text.length > max) {
    const first = text.slice(0, 8000);
    const last = text.slice(-(max - 8050));
    text = first + '\n...[parte intermedia omitida]...\n' + last;
  }
  return text;
}

const FOLLOWUP_AI_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'followup_classification',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['category', 'satisfaction', 'quote_requested', 'needs_follow_up', 'follow_up_reason', 'summary', 'confidence'],
      properties: {
        category: { type: 'string', enum: ['consulta', 'cotizacion', 'soporte', 'reclamo', 'comercial', 'otro'] },
        satisfaction: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        quote_requested: { type: 'boolean' },
        needs_follow_up: { type: 'boolean' },
        follow_up_reason: { type: 'string' },
        summary: { type: 'string' },
        confidence: { type: 'string', enum: ['alta', 'media', 'baja'] },
      },
    },
  },
};

async function recordClassificationUsage(db, tenant, conv, model, usage) {
  try {
    const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
    const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
    const totalTokens = Number(usage?.total_tokens ?? (inputTokens + outputTokens)) || (inputTokens + outputTokens);
    await db.collection('ai_token_usage_log').insertOne({
      tenantId: tenant,
      kind: 'followup_classification',
      provider: 'openai',
      model: model || null,
      inputTokens: Math.max(0, inputTokens),
      outputTokens: Math.max(0, outputTokens),
      totalTokens: Math.max(0, totalTokens),
      conversationId: String(conv?._id || ''),
      waId: String(conv?.waId || ''),
      channelType: String(conv?.channelType || 'whatsapp').toLowerCase(),
      meta: { source: 'conversation_followup_panel' },
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn('[followup][ai] token log:', e?.message || e);
  }
}

async function classifyConversationWithAi(db, tenant, conversationId, { force = false } = {}) {
  const oid = conversationId instanceof ObjectId ? conversationId : new ObjectId(String(conversationId));
  const lockKey = `${tenant}:${String(oid)}`;
  if (aiClassificationInFlight.has(lockKey)) return { ok: true, skipped: 'in_flight' };
  aiClassificationInFlight.add(lockKey);
  try {
    const [conv, existing] = await Promise.all([
      db.collection('conversations').findOne({ _id: oid, tenantId: tenant, botMode: 'conversacional' }),
      db.collection(FOLLOWUP_COLLECTION).findOne({ tenantId: tenant, conversationId: oid }),
    ]);
    if (!conv) return { ok: false, error: 'conversation_not_found' };
    if (conv.finalized !== true && !force) return { ok: true, skipped: 'conversation_open' };
    if (!force && hasManualClassification(existing)) return { ok: true, skipped: 'manual_classification' };
    if (!force && existing?.aiClassifiedAt && existing?.aiClassificationStatus === 'done') return { ok: true, skipped: 'already_classified' };
    const retryAt = safeDate(existing?.aiClassificationNextRetryAt);
    if (!force && !shouldBypassAiRetry(existing) && retryAt && retryAt.getTime() > Date.now()) {
      return { ok: true, skipped: 'retry_later' };
    }

    const messages = await db.collection('messages')
      .find({ tenantId: tenant, conversationId: oid })
      .sort({ ts: 1, createdAt: 1 })
      .limit(300)
      .toArray();
    const transcript = buildTranscript(messages);
    if (!transcript) {
      await db.collection(FOLLOWUP_COLLECTION).updateOne(
        { tenantId: tenant, conversationId: oid },
        { $set: { aiClassificationStatus: 'error', aiClassificationError: 'sin_mensajes', aiClassificationNextRetryAt: new Date(Date.now() + AI_RETRY_MINUTES * 60000), updatedAt: new Date() }, $setOnInsert: { tenantId: tenant, conversationId: oid, waId: String(conv.waId || ''), createdAt: new Date() } },
        { upsert: true }
      );
      return { ok: false, error: 'no_messages' };
    }

    const runtime = await resolveConversationAiRuntime(db, tenant, conv);
    if (!runtime.apiKey) {
      await db.collection(FOLLOWUP_COLLECTION).updateOne(
        { tenantId: tenant, conversationId: oid },
        { $set: { aiClassificationStatus: 'error', aiClassificationError: 'openai_api_key_missing', aiClassificationNextRetryAt: new Date(Date.now() + AI_RETRY_MINUTES * 60000), updatedAt: new Date() }, $setOnInsert: { tenantId: tenant, conversationId: oid, waId: String(conv.waId || ''), createdAt: new Date() } },
        { upsert: true }
      );
      return { ok: false, error: 'openai_api_key_missing' };
    }

    await db.collection(FOLLOWUP_COLLECTION).updateOne(
      { tenantId: tenant, conversationId: oid },
      { $set: { aiClassificationStatus: 'running', aiClassificationError: '', aiClassifierBuild: FOLLOWUP_BUILD, aiClassificationStartedAt: new Date() }, $setOnInsert: { tenantId: tenant, conversationId: oid, waId: String(conv.waId || ''), createdAt: new Date() } },
      { upsert: true }
    );

    const system = [
      'Sos el clasificador interno de seguimiento comercial de Asisto.',
      'Analizá TODA la conversación entre el cliente y Asisto. No respondas al cliente.',
      'Clasificá el tipo principal de consulta:',
      '- consulta: información general que no encaja mejor en otra categoría.',
      '- cotizacion: pedido de precio, presupuesto, cotización o valores para comprar/contratar.',
      '- soporte: ayuda técnica, uso, configuración o resolución de un problema técnico.',
      '- reclamo: queja, disconformidad, problema con atención/producto/servicio.',
      '- comercial: interés comercial, recomendación de producto/servicio o intención de compra sin pedido concreto de cotización.',
      '- otro: sólo cuando ninguna categoría anterior corresponde.',
      'quote_requested debe ser true si en cualquier momento pidió precio, presupuesto o cotización.',
      'satisfaction mide la satisfacción/tone FINAL del cliente respecto de la atención: 5 muy satisfecho, 4 satisfecho, 3 neutral o sin evidencia clara, 2 insatisfecho, 1 muy insatisfecho.',
      'needs_follow_up=true cuando quedó una duda, promesa, dato a verificar o acción humana pendiente.',
      'summary debe ser breve y operativo, máximo 300 caracteres.',
      'No inventes información que no esté en la conversación.'
    ].join('\n');

    const client = getOpenAIClient(runtime.apiKey);
    const response = await client.chat.completions.create({
      model: runtime.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcript },
      ],
      response_format: FOLLOWUP_AI_RESPONSE_FORMAT,
    });
    const raw = String(response?.choices?.[0]?.message?.content || '').trim();
    if (!raw) throw new Error('openai_empty_classification');
    const parsed = JSON.parse(raw);
    const now = new Date();
    const quoteDetected = String(conv?.leadType || '').toLowerCase() === 'cotizacion';
    const set = {
      category: normalizeCategory(parsed.category),
      satisfaction: normalizeSatisfaction(parsed.satisfaction) || 3,
      quoteRequested: quoteDetected ? true : !!parsed.quote_requested,
      summary: cleanString(existing?.summary || parsed.summary, 1000),
      aiNeedsFollowUp: parsed.needs_follow_up === true,
      aiFollowUpReason: cleanString(parsed.follow_up_reason, 1000),
      aiConfidence: ['alta', 'media', 'baja'].includes(String(parsed.confidence || '').toLowerCase()) ? String(parsed.confidence).toLowerCase() : 'media',
      aiClassificationStatus: 'done',
      aiClassifierBuild: FOLLOWUP_BUILD,
      aiClassifiedAt: now,
      aiModel: runtime.model,
      aiClassificationError: '',
      aiClassificationNextRetryAt: null,
      classifiedAt: existing?.classifiedAt || now,
      classifiedBy: 'asisto-ai',
      workflowStatus: existing?.workflowStatus || 'pending_review',
      updatedAt: now,
      updatedBy: force ? 'asisto-ai-reclassify' : 'asisto-ai',
    };
    await db.collection(FOLLOWUP_COLLECTION).updateOne(
      { tenantId: tenant, conversationId: oid },
      { $set: set, $setOnInsert: { tenantId: tenant, conversationId: oid, waId: String(conv.waId || ''), createdAt: now } },
      { upsert: true }
    );
    await db.collection('conversations').updateOne(
      { _id: oid, tenantId: tenant },
      { $set: { followupReviewPending: true, followupWorkflowStatus: existing?.workflowStatus || 'pending_review', followupAiClassifiedAt: now } }
    );
    await recordClassificationUsage(db, tenant, conv, response?.model || runtime.model, response?.usage || {});
    console.log(`[followup][ai] clasificada tenant=${tenant} conv=${String(oid)} tipo=${set.category} satisfaccion=${set.satisfaction} cotizacion=${set.quoteRequested}`);
    return { ok: true, classification: set };
  } catch (e) {
    console.warn(`[followup][ai] clasificación tenant=${tenant} conv=${String(oid)}:`, e?.message || e);
    try {
      await db.collection(FOLLOWUP_COLLECTION).updateOne(
        { tenantId: tenant, conversationId: oid },
        { $set: { aiClassificationStatus: 'error', aiClassifierBuild: FOLLOWUP_BUILD, aiClassificationError: cleanString(e?.message || e, 500), aiClassificationNextRetryAt: new Date(Date.now() + AI_RETRY_MINUTES * 60000), updatedAt: new Date() }, $setOnInsert: { tenantId: tenant, conversationId: oid, createdAt: new Date() } },
        { upsert: true }
      );
    } catch {}
    return { ok: false, error: String(e?.message || e) };
  } finally {
    aiClassificationInFlight.delete(lockKey);
  }
}

async function classifyMissingFinalized(db, tenant, limit = AI_BACKFILL_PER_SWEEP) {
  const convs = await db.collection('conversations')
    .find({ tenantId: tenant, botMode: 'conversacional', finalized: true })
    .sort({ closedAt: -1, updatedAt: -1 })
    .limit(40)
    .toArray();
  if (!convs.length) return 0;
  const ids = convs.map(c => c._id);
  const followups = await db.collection(FOLLOWUP_COLLECTION).find({ tenantId: tenant, conversationId: { $in: ids } }).toArray();
  const fm = new Map(followups.map(f => [String(f.conversationId), f]));
  const pending = convs.filter(c => {
    const f = fm.get(String(c._id));
    if (hasManualClassification(f)) return false;
    if (f?.aiClassifiedAt && f?.aiClassificationStatus === 'done') return false;
    const retryAt = safeDate(f?.aiClassificationNextRetryAt);
    if (!shouldBypassAiRetry(f) && retryAt && retryAt.getTime() > Date.now()) return false;
    return true;
  }).slice(0, Math.max(1, limit));
  let done = 0;
  for (const conv of pending) {
    const r = await classifyConversationWithAi(db, tenant, conv._id, { force: false });
    if (r?.ok && !r?.skipped) done++;
  }
  return done;
}

// ===================== Cierre automático =====================

async function autoCloseTenant(db, tenant, config) {
  if (!config.autoCloseEnabled) return 0;
  const cutoff = new Date(Date.now() - config.inactivityMinutes * 60 * 1000);
  const now = new Date();
  const result = await db.collection('conversations').updateMany(
    { tenantId: tenant, botMode: 'conversacional', finalized: { $ne: true }, updatedAt: { $lte: cutoff } },
    { $set: { finalized: true, status: 'CLOSED_INACTIVITY', closedAt: now, closeReason: 'inactivity', followupReviewPending: true, followupAutoClosedAt: now } }
  );
  if (result.modifiedCount) {
    console.log(`[followup] cierre automático tenant=${tenant} conversaciones=${result.modifiedCount} minutos=${config.inactivityMinutes}`);
  }
  return result.modifiedCount || 0;
}

async function runAutoCloseSweep() {
  const db = await getDb();
  const tenants = await db.collection('conversations').distinct('tenantId', { botMode: 'conversacional' });
  for (const raw of tenants) {
    const tenant = String(raw || '').trim();
    if (!tenant) continue;
    try {
      const config = await loadConfig(db, tenant);
      await autoCloseTenant(db, tenant, config);
      await classifyMissingFinalized(db, tenant, AI_BACKFILL_PER_SWEEP);
    } catch (e) {
      console.warn(`[followup] sweep tenant=${tenant}:`, e?.message || e);
    }
  }
}

async function ensureIndexes() {
  try {
    const db = await getDb();
    await Promise.all([
      db.collection(FOLLOWUP_COLLECTION).createIndex({ tenantId: 1, conversationId: 1 }, { unique: true }),
      db.collection(FOLLOWUP_COLLECTION).createIndex({ tenantId: 1, workflowStatus: 1, nextContactAt: 1 }),
      db.collection(FOLLOWUP_COLLECTION).createIndex({ tenantId: 1, aiClassificationStatus: 1, aiClassificationNextRetryAt: 1 }),
      db.collection('conversations').createIndex({ tenantId: 1, botMode: 1, finalized: 1, updatedAt: -1 }),
      db.collection('conversations').createIndex({ tenantId: 1, botMode: 1, waId: 1, updatedAt: -1 }),
    ]);
  } catch (e) {
    console.warn('[followup] indexes:', e?.message || e);
  }
}

async function loadAvailableTenants(db, currentTenant) {
  const tenants = new Set();
  const add = value => {
    const v = String(value || '').trim();
    if (v && !v.startsWith('__')) tenants.add(v);
  };
  add(currentTenant);
  const results = await Promise.allSettled([
    db.collection('tenant_config').find({}, { projection: { _id: 1, tenantId: 1, tenantid: 1 } }).limit(2000).toArray(),
    db.collection('users').distinct('tenantId'),
    db.collection('tenant_channels').distinct('tenantId'),
    db.collection('conversations').distinct('tenantId', { botMode: 'conversacional' }),
  ]);
  if (results[0].status === 'fulfilled') {
    for (const doc of results[0].value || []) { add(doc?.tenantId); add(doc?.tenantid); add(doc?._id); }
  }
  for (let i = 1; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    for (const value of results[i].value || []) add(value);
  }
  return Array.from(tenants).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true }));
}

// ===================== UI =====================

function panelHtml({ tenant, tenantOptions = [], user, canInbox, canEditConfig, canSelectTenant = false }) {
  const role = String(user?.role || 'user');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Seguimiento de conversaciones</title>
<style>
:root{--bg:#eef3f6;--card:#fff;--line:#dce5ea;--text:#10243e;--muted:#667085;--primary:#0e6b66;--primary2:#0a5955;--danger:#b42318;--warn:#b54708;--ok:#067647;--blue:#175cd3;--purple:#5925dc;--shadow:0 6px 18px rgba(16,24,40,.07)}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text)}button,input,select,textarea{font:inherit}button{cursor:pointer}.wrap{padding:14px;min-height:100vh}.top{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.title h1{font-size:22px;margin:0 0 4px}.title p{margin:0;color:var(--muted);font-size:12px}.topActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tenantPicker{display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--line);border-radius:10px;background:#fff}.tenantPicker label{font-size:11px;font-weight:800;color:#475467}.tenantPicker select{min-width:150px;border:0;background:transparent;color:var(--text);font-weight:800;outline:none}.btn{border:1px solid var(--line);border-radius:9px;padding:8px 11px;background:#fff;color:var(--text);font-weight:750}.btn:hover{background:#f8fafc}.btnPrimary{background:var(--primary);border-color:var(--primary);color:#fff}.btnPrimary:hover{background:var(--primary2)}.btnDanger{color:var(--danger);border-color:#f4c7c3}.btnSm{padding:6px 9px;font-size:12px}.muted{color:var(--muted);font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(125px,1fr));gap:9px;margin-bottom:10px}.kpi{background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 12px;box-shadow:var(--shadow)}.kpi b{display:block;font-size:22px}.kpi span{font-size:11px;color:var(--muted)}
.filters{display:grid;grid-template-columns:minmax(220px,1fr) 160px 175px 165px;gap:8px;background:#fff;border:1px solid var(--line);padding:10px;border-radius:12px;margin-bottom:10px}.filters input,.filters select{width:100%;border:1px solid var(--line);border-radius:9px;padding:8px 10px;background:white;min-height:38px}
.tableCard{background:#fff;border:1px solid var(--line);border-radius:13px;box-shadow:var(--shadow);overflow:hidden}.tableHead{padding:10px 12px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}.tableWrap{overflow:auto;max-height:calc(100vh - 300px);min-height:330px}table{width:100%;border-collapse:collapse;font-size:12px;min-width:1120px}th{position:sticky;top:0;z-index:2;background:#f8fafc;color:#475467;font-size:11px;text-transform:uppercase;letter-spacing:.02em;text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}td{padding:10px;border-bottom:1px solid #edf1f4;vertical-align:middle}tr:hover td{background:#fbfdfd}.clientName{font-size:13px;font-weight:800;max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.phone{font-size:11px;color:var(--muted);margin-top:2px}.summaryCell{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#475467}.actionsCell{display:flex;gap:6px;white-space:nowrap}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:800;border:1px solid transparent;white-space:nowrap}.bOpen{background:#eff8ff;color:#175cd3}.bClosed{background:#f2f4f7;color:#344054}.bPending{background:#fffaeb;color:#b54708}.bFollow{background:#f4f3ff;color:#5925dc}.bResolved{background:#ecfdf3;color:#067647}.bDiscarded{background:#f2f4f7;color:#475467}.bDue{background:#fef3f2;color:#b42318}.bYes{background:#eef4ff;color:#3538cd}.bNo{background:#f2f4f7;color:#475467}.bAi{background:#ecfdf3;color:#067647}.bAiPending{background:#fff7ed;color:#c2410c}.bAiError{background:#fef3f2;color:#b42318}.stars{color:#b54708;font-size:13px;letter-spacing:1px}.empty{padding:40px;text-align:center;color:var(--muted)}
.modal{display:none;position:fixed;z-index:80;inset:0;background:rgba(15,23,42,.50);align-items:center;justify-content:center;padding:18px}.modal.open{display:flex}.modalCard{width:min(900px,96vw);max-height:92vh;background:#fff;border-radius:16px;box-shadow:0 28px 80px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden}.modalCard.wide{width:min(1050px,97vw)}.modalHead{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}.modalHead h3{margin:0;font-size:17px}.modalBody{padding:14px 16px;overflow:auto}.modalFoot{padding:11px 16px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.chat{background:#f6f8fa;padding:14px;min-height:360px;max-height:68vh;overflow:auto}.msgRow{display:flex;margin:7px 0}.msgRow.user{justify-content:flex-start}.msgRow.assistant{justify-content:flex-end}.bubble{max-width:78%;padding:9px 11px;border-radius:12px;font-size:13px;line-height:1.42;white-space:pre-wrap;overflow-wrap:anywhere}.user .bubble{background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}.assistant .bubble{background:#dff6e9;border:1px solid #c4ebd5;border-bottom-right-radius:4px}.msgAt{display:block;font-size:10px;color:var(--muted);margin-top:5px}.media{margin-top:7px}.media img{max-width:320px;max-height:250px;border-radius:8px}.media audio,.media video{max-width:320px}
.aiBox{background:#f5fbfa;border:1px solid #cfe9e6;border-radius:12px;padding:11px 12px;margin-bottom:12px}.aiBoxHead{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px}.aiBox h4{margin:0;font-size:13px}.aiGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px}.aiMini{background:#fff;border:1px solid var(--line);border-radius:9px;padding:8px}.aiMini label{display:block;font-size:10px;color:var(--muted);margin-bottom:3px}.aiMini b{font-size:12px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}.field label{font-size:11px;font-weight:800;color:#475467}.field input,.field select,.field textarea{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px 10px;background:#fff}.field textarea{min-height:76px;resize:vertical}.check{display:flex;gap:8px;align-items:center;padding:9px 10px;border:1px solid var(--line);border-radius:9px;margin-bottom:10px}.check input{width:auto}.history{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}.histItem{padding:8px;border:1px solid var(--line);border-radius:9px;margin:6px 0;background:#fafbfc;font-size:11px}.leadBox{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:9px;margin-bottom:10px;font-size:11px}.toast{position:fixed;right:18px;bottom:18px;background:#101828;color:#fff;padding:10px 13px;border-radius:10px;display:none;z-index:100;font-size:12px}.toast.show{display:block}.toast.err{background:#b42318}
@media(max-width:1000px){.filters{grid-template-columns:1fr 1fr}.kpis{grid-template-columns:repeat(3,1fr)}.aiGrid{grid-template-columns:1fr 1fr}}@media(max-width:650px){.wrap{padding:8px}.filters{grid-template-columns:1fr}.kpis{grid-template-columns:1fr 1fr}.grid2{grid-template-columns:1fr}.aiGrid{grid-template-columns:1fr 1fr}.modal{padding:6px}.modalCard{max-height:97vh}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="title"><h1>Seguimiento de conversaciones</h1><p>Dominio: <strong id="tenantLabel">${htmlEscape(tenant)}</strong> · ${htmlEscape(role)} · conversaciones en modo conversacional · IA ${htmlEscape(FOLLOWUP_BUILD)}</p></div>
    <div class="topActions">
      ${canSelectTenant ? `<div class="tenantPicker"><label for="tenantSelect">Dominio</label><select id="tenantSelect">${tenantOptions.map(t => `<option value="${htmlEscape(t)}" ${String(t) === String(tenant) ? 'selected' : ''}>${htmlEscape(t)}</option>`).join('')}</select></div>` : ''}
      <span class="muted" id="cfgLabel">Cierre automático: cargando…</span>
      ${canEditConfig ? '<button class="btn" id="cfgBtn">⚙ Configurar cierre</button>' : ''}
      <button class="btn" id="refreshBtn">↻ Actualizar</button>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><b id="kActive">0</b><span>Abiertas</span></div>
    <div class="kpi"><b id="kClosed">0</b><span>Finalizadas</span></div>
    <div class="kpi"><b id="kPending">0</b><span>Pendientes de gestión</span></div>
    <div class="kpi"><b id="kFollow">0</b><span>En seguimiento</span></div>
    <div class="kpi"><b id="kDue">0</b><span>Contactos vencidos</span></div>
  </div>

  <div class="filters">
    <input id="q" placeholder="Buscar cliente, teléfono, resumen, nota o etiqueta…"/>
    <select id="conversationState"><option value="all">Todas</option><option value="open">Abiertas</option><option value="closed">Finalizadas</option></select>
    <select id="workflow"><option value="all">Toda gestión</option><option value="pending_review">Pendiente</option><option value="follow_up">En seguimiento</option><option value="due">Contacto vencido</option><option value="resolved">Resuelta</option><option value="discarded">Descartada</option></select>
    <select id="category"><option value="all">Todos los tipos</option><option value="consulta">Consulta</option><option value="cotizacion">Cotización</option><option value="soporte">Soporte</option><option value="reclamo">Reclamo</option><option value="comercial">Comercial</option><option value="otro">Otro</option></select>
  </div>

  <section class="tableCard">
    <div class="tableHead"><strong>Conversaciones</strong><span class="muted" id="listCount">0 registros</span></div>
    <div class="tableWrap">
      <table>
        <thead><tr><th>Cliente</th><th>Última actividad</th><th>Conversación</th><th>Gestión</th><th>Tipo</th><th>Cotización</th><th>Satisfacción</th><th>Resumen</th><th>Próximo contacto</th><th>Acciones</th></tr></thead>
        <tbody id="tbody"><tr><td colspan="10" class="empty">Cargando…</td></tr></tbody>
      </table>
    </div>
  </section>
</div>

<div class="modal" id="chatModal"><div class="modalCard wide"><div class="modalHead"><div><h3 id="chatTitle">Conversación</h3><div class="muted" id="chatSubtitle"></div></div><button class="btn btnSm" data-close="chatModal">Cerrar</button></div><div class="chat" id="chatBody"><div class="empty">Cargando…</div></div><div class="modalFoot" id="chatFoot"></div></div></div>
<div class="modal" id="followModal"><div class="modalCard wide"><div class="modalHead"><div><h3 id="followTitle">Seguimiento</h3><div class="muted" id="followSubtitle"></div></div><button class="btn btnSm" data-close="followModal">Cerrar</button></div><div class="modalBody" id="followBody"><div class="empty">Cargando…</div></div><div class="modalFoot" id="followFoot"></div></div></div>
${canEditConfig ? `<div class="modal" id="cfgModal"><div class="modalCard" style="max-width:480px"><div class="modalHead"><h3>Cierre automático</h3><button class="btn btnSm" data-close="cfgModal">Cerrar</button></div><div class="modalBody"><div class="check"><input type="checkbox" id="cfgEnabled"/><span>Finalizar automáticamente conversaciones inactivas</span></div><div class="field"><label>Minutos de inactividad</label><input type="number" id="cfgMinutes" min="1" max="10080" step="1"/><span class="muted">Al finalizar, Asisto clasifica automáticamente la conversación con IA.</span></div></div><div class="modalFoot"><button class="btn btnPrimary" id="cfgSave">Guardar</button></div></div></div>` : ''}
<div class="toast" id="toast"></div>
<script>
let TENANT=${JSON.stringify(tenant)};
const CAN_INBOX=${canInbox ? 'true' : 'false'};
const CAN_EDIT_CONFIG=${canEditConfig ? 'true' : 'false'};
const CAN_SELECT_TENANT=${canSelectTenant ? 'true' : 'false'};
let rows=[];let activeId='';let activeItem=null;let config={autoCloseEnabled:true,inactivityMinutes:30};let debounce=null;let classificationTouched=false;
const el=id=>document.getElementById(id);
function api(path){const u=new URL(path,location.origin);if(TENANT)u.searchParams.set('tenant',TENANT);return u.toString()}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function fmt(v){if(!v)return '-';const d=new Date(v);return isNaN(d)?'-':d.toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'})}
function fmtInput(v){if(!v)return '';const d=new Date(v);if(isNaN(d))return '';const z=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate())+'T'+z(d.getHours())+':'+z(d.getMinutes())}
function toast(msg,err=false){const t=el('toast');t.textContent=msg;t.className='toast show'+(err?' err':'');setTimeout(()=>t.className='toast',2800)}
function workflowLabel(v){return ({active:'Sin finalizar',pending_review:'Pendiente',follow_up:'En seguimiento',resolved:'Resuelta',discarded:'Descartada'})[v]||v}
function workflowBadge(v){return ({active:'bOpen',pending_review:'bPending',follow_up:'bFollow',resolved:'bResolved',discarded:'bDiscarded'})[v]||'bPending'}
function categoryLabel(v){return ({consulta:'Consulta',cotizacion:'Cotización',soporte:'Soporte',reclamo:'Reclamo',comercial:'Comercial',otro:'Otro'})[v]||'Pendiente IA'}
function stars(v){const n=Number(v);if(!n)return '<span class="badge bAiPending">Pendiente IA</span>';return '<span class="stars">'+'★'.repeat(n)+'☆'.repeat(5-n)+'</span>'}
function quoteBadge(v,finalized){if(v===true)return '<span class="badge bYes">Sí</span>';if(v===false)return '<span class="badge bNo">No</span>';return finalized?'<span class="badge bAiPending">Pendiente IA</span>':'<span class="badge bNo">—</span>'}
function aiBadge(x){if(x.manualClassificationEditedAt)return '<span class="badge bNo">Editado</span>';if(x.aiClassificationStatus==='done'&&String(x.classifiedBy||'').toLowerCase()==='asisto-ai')return '<span class="badge bAi">IA</span>';if(x.aiClassificationStatus==='error')return '<span class="badge bAiError">Error IA</span>';if(x.aiClassificationStatus==='running')return '<span class="badge bAiPending">Procesando IA</span>';if(x.finalized)return '<span class="badge bAiPending">IA pendiente</span>';return ''}
function openModal(id){el(id).classList.add('open')}
function closeModal(id){el(id).classList.remove('open')}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModal(m.id)}));document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.modal.open').forEach(m=>closeModal(m.id))});
async function requestJson(url,opts){const r=await fetch(api(url),opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Error');return j}
function cfgText(){el('cfgLabel').textContent=config.autoCloseEnabled?('Cierre: '+config.inactivityMinutes+' min'):'Cierre automático desactivado'}
async function loadConfig(){const j=await requestJson('/api/conversation-followup/config');config=j.config||config;cfgText()}
function renderKpis(s){el('kActive').textContent=s.active||0;el('kClosed').textContent=s.closed||0;el('kPending').textContent=s.pending_review||0;el('kFollow').textContent=s.follow_up||0;el('kDue').textContent=s.due||0}
function renderRows(){el('listCount').textContent=rows.length+' registros';if(!rows.length){el('tbody').innerHTML='<tr><td colspan="10" class="empty">No hay conversaciones con estos filtros.</td></tr>';return}el('tbody').innerHTML=rows.map(x=>{const nm=x.contactName||x.lead?.name||x.waId||'Sin nombre';const status=x.finalized?'<span class="badge bClosed">Finalizada</span>':'<span class="badge bOpen">Abierta</span>';const workflow='<span class="badge '+workflowBadge(x.workflowStatus)+'">'+esc(workflowLabel(x.workflowStatus))+'</span>'+(x.isDue?' <span class="badge bDue">Vencido</span>':'');const cat=x.category?'<span class="badge bYes">'+esc(categoryLabel(x.category))+'</span> '+aiBadge(x):aiBadge(x)||'<span class="badge bNo">Sin clasificar</span>';const next=x.pendingContact?(x.isDue?'<span class="badge bDue">'+esc(fmt(x.nextContactAt))+'</span>':esc(fmt(x.nextContactAt))):'—';return '<tr><td><div class="clientName" title="'+esc(nm)+'">'+esc(nm)+'</div><div class="phone">'+esc(x.waId||'')+'</div></td><td>'+esc(fmt(x.lastAt))+'</td><td>'+status+'</td><td>'+workflow+'</td><td>'+cat+'</td><td>'+quoteBadge(x.quoteRequested,x.finalized)+'</td><td>'+stars(x.satisfaction)+'</td><td><div class="summaryCell" title="'+esc(x.summary||'')+'">'+esc(x.summary||'—')+'</div></td><td>'+next+'</td><td><div class="actionsCell"><button class="btn btnSm" data-chat="'+esc(x._id)+'">💬 Ver chat</button><button class="btn btnSm btnPrimary" data-follow="'+esc(x._id)+'">✎ Seguimiento</button></div></td></tr>'}).join('');el('tbody').querySelectorAll('[data-chat]').forEach(b=>b.addEventListener('click',()=>openChat(b.dataset.chat)));el('tbody').querySelectorAll('[data-follow]').forEach(b=>b.addEventListener('click',()=>openFollow(b.dataset.follow)))}
async function loadRows(){const p=new URLSearchParams();p.set('limit','500');const q=el('q').value.trim();if(q)p.set('q',q);p.set('conversationState',el('conversationState').value);p.set('workflow',el('workflow').value);p.set('category',el('category').value);const j=await requestJson('/api/conversation-followup/conversations?'+p.toString());rows=j.items||[];renderKpis(j.summary||{});renderRows()}
function renderMedia(m){if(!m.media||!m.media.url)return '';const u=api(m.media.url);const k=String(m.media.kind||'');if(k==='image')return '<div class="media"><a href="'+esc(u)+'" target="_blank"><img src="'+esc(u)+'"/></a></div>';if(k==='audio')return '<div class="media"><audio controls src="'+esc(u)+'"></audio></div>';if(k==='video')return '<div class="media"><video controls src="'+esc(u)+'"></video></div>';return '<div class="media"><a href="'+esc(u)+'" target="_blank">📎 '+esc(m.media.filename||'Archivo')+'</a></div>'}
async function openChat(id){activeId=id;openModal('chatModal');el('chatBody').innerHTML='<div class="empty">Cargando conversación…</div>';el('chatFoot').innerHTML='';try{const [d,m]=await Promise.all([requestJson('/api/conversation-followup/'+encodeURIComponent(id)),requestJson('/api/conversation-followup/'+encodeURIComponent(id)+'/messages')]);const x=d.item;activeItem=x;const nm=x.contactName||x.lead?.name||x.waId||'Sin nombre';el('chatTitle').textContent=nm;el('chatSubtitle').textContent=(x.waId||'')+' · '+(x.finalized?'Finalizada':'Abierta')+' · última actividad '+fmt(x.lastAt);const msgs=m.items||[];el('chatBody').innerHTML=msgs.length?msgs.map(v=>'<div class="msgRow '+(v.role==='user'?'user':'assistant')+'"><div class="bubble">'+esc(v.content||'')+renderMedia(v)+'<span class="msgAt">'+esc(fmt(v.createdAt))+'</span></div></div>').join(''):'<div class="empty">No hay mensajes guardados.</div>';el('chatBody').scrollTop=el('chatBody').scrollHeight;let foot='';if(CAN_INBOX)foot+='<button class="btn" id="openInboxBtn">Abrir en WhatsApp</button>';if(!x.finalized)foot+='<button class="btn btnDanger" id="closeNowBtn">Finalizar conversación</button>';foot+='<button class="btn btnPrimary" id="chatFollowBtn">Seguimiento</button>';el('chatFoot').innerHTML=foot;if(el('openInboxBtn'))el('openInboxBtn').onclick=()=>window.open('/admin/inbox?convId='+encodeURIComponent(x._id)+(TENANT?'&tenant='+encodeURIComponent(TENANT):''),'_blank');if(el('closeNowBtn'))el('closeNowBtn').onclick=()=>closeNow(x._id);if(el('chatFollowBtn'))el('chatFollowBtn').onclick=()=>{closeModal('chatModal');openFollow(x._id)}}catch(e){el('chatBody').innerHTML='<div class="empty">Error cargando el chat.</div>';toast(e.message,true)}}
function aiInfoHtml(x){let status='Pendiente';if(x.manualClassificationEditedAt)status='Clasificación editada manualmente';else if(x.aiClassificationStatus==='done'&&String(x.classifiedBy||'').toLowerCase()==='asisto-ai')status='Clasificada automáticamente por Asisto';else if(x.aiClassificationStatus==='error')status='No se pudo clasificar automáticamente';else if(!x.finalized)status='Se clasificará al finalizar la conversación';return '<div class="aiBox"><div class="aiBoxHead"><div><h4>Clasificación automática</h4><span class="muted">'+esc(status)+(x.aiModel?' · '+esc(x.aiModel):'')+(x.aiClassifierBuild?' · '+esc(x.aiClassifierBuild):'')+'</span></div>'+(x.finalized?'<button class="btn btnSm" id="reclassifyBtn">↻ Reclasificar con IA</button>':'')+'</div><div class="aiGrid"><div class="aiMini"><label>Tipo</label><b>'+esc(categoryLabel(x.category))+'</b></div><div class="aiMini"><label>Cotización</label><b>'+(x.quoteRequested===true?'Sí':(x.quoteRequested===false?'No':'Pendiente'))+'</b></div><div class="aiMini"><label>Satisfacción</label><b>'+(x.satisfaction?('★'.repeat(x.satisfaction)+'☆'.repeat(5-x.satisfaction)):'Pendiente')+'</b></div><div class="aiMini"><label>¿Requiere contacto?</label><b>'+(x.aiNeedsFollowUp?'Sí':'No')+'</b></div></div>'+(x.aiFollowUpReason?'<div class="muted" style="margin-top:8px"><b>Motivo sugerido:</b> '+esc(x.aiFollowUpReason)+'</div>':'')+(x.aiClassificationError?'<div class="muted" style="margin-top:8px;color:#b42318">'+esc(x.aiClassificationError)+'</div>':'')+'</div>'}
async function openFollow(id){activeId=id;openModal('followModal');el('followBody').innerHTML='<div class="empty">Cargando seguimiento…</div>';el('followFoot').innerHTML='';try{const [d,h]=await Promise.all([requestJson('/api/conversation-followup/'+encodeURIComponent(id)),requestJson('/api/conversation-followup/'+encodeURIComponent(id)+'/history')]);const x=d.item;activeItem=x;const nm=x.contactName||x.lead?.name||x.waId||'Sin nombre';el('followTitle').textContent='Seguimiento · '+nm;el('followSubtitle').textContent=(x.waId||'')+' · '+(x.finalized?'Finalizada':'Abierta');const qr=x.quoteRequested===true?'true':(x.quoteRequested===false?'false':'');const hist=(h.items||[]).length?(h.items||[]).map(v=>'<div class="histItem"><b>'+esc(fmt(v.lastAt))+'</b> · '+esc(v.finalized?'Finalizada':'Abierta')+' · '+esc(categoryLabel(v.category))+(v.satisfaction?' · '+'★'.repeat(v.satisfaction):'')+(v.summary?'<div style="margin-top:4px">'+esc(v.summary)+'</div>':'')+'</div>').join(''):'<div class="muted">Sin conversaciones anteriores.</div>';const lead=x.lead?'<div class="leadBox"><b>Datos detectados por el bot</b><div>Tipo lead: '+esc(x.leadType||'-')+' · Cotización completa: '+(x.quoteReady?'Sí':'No')+'</div>'+(x.lead.company?'<div>Empresa: '+esc(x.lead.company)+'</div>':'')+(x.lead.email?'<div>Email: '+esc(x.lead.email)+'</div>':'')+'</div>':'';el('followBody').innerHTML=aiInfoHtml(x)+lead+'<div class="grid2"><div class="field"><label>Estado de gestión</label><select id="fWorkflow"><option value="pending_review">Pendiente</option><option value="follow_up">En seguimiento</option><option value="resolved">Resuelta</option><option value="discarded">Descartada</option></select></div><div class="field"><label>Tipo de consulta</label><select id="fCategory"><option value="">Automático / pendiente</option><option value="consulta">Consulta</option><option value="cotizacion">Cotización</option><option value="soporte">Soporte</option><option value="reclamo">Reclamo</option><option value="comercial">Comercial</option><option value="otro">Otro</option></select></div><div class="field"><label>Satisfacción del cliente</label><select id="fSatisfaction"><option value="">Sin definir</option><option value="5">★★★★★ Muy satisfecho</option><option value="4">★★★★☆ Satisfecho</option><option value="3">★★★☆☆ Neutral</option><option value="2">★★☆☆☆ Insatisfecho</option><option value="1">★☆☆☆☆ Muy insatisfecho</option></select></div><div class="field"><label>¿Pidió cotización?</label><select id="fQuote"><option value="">Sin definir</option><option value="true">Sí</option><option value="false">No</option></select></div><div class="field"><label>Prioridad</label><select id="fPriority"><option value="baja">Baja</option><option value="normal">Normal</option><option value="alta">Alta</option><option value="urgente">Urgente</option></select></div><div class="field"><label>Responsable</label><input id="fAssigned" placeholder="Operario / vendedor" value="'+esc(x.assignedTo||'')+'"/></div></div><div class="check"><input type="checkbox" id="fPending" '+(x.pendingContact?'checked':'')+'/><span><b>Hay que volver a contactar al cliente</b></span></div><div class="field"><label>Próximo contacto</label><input type="datetime-local" id="fNext" value="'+esc(fmtInput(x.nextContactAt))+'"/></div><div class="field"><label>Resumen</label><textarea id="fSummary" placeholder="Resumen de la consulta…">'+esc(x.summary||'')+'</textarea></div><div class="field"><label>Notas internas</label><textarea id="fNotes" placeholder="Dudas pendientes, compromiso asumido, información a verificar…">'+esc(x.notes||'')+'</textarea></div><div class="field"><label>Etiquetas</label><input id="fTags" value="'+esc((x.tags||[]).join(', '))+'" placeholder="precio, soporte, urgente…"/></div><div class="history"><b style="font-size:12px">Historial de este cliente</b>'+hist+'</div>';el('fWorkflow').value=x.workflowStatus==='active'?'pending_review':x.workflowStatus;el('fCategory').value=x.category||'';el('fSatisfaction').value=x.satisfaction||'';el('fQuote').value=qr;el('fPriority').value=x.priority||'normal';classificationTouched=false;['fCategory','fSatisfaction','fQuote'].forEach(fid=>el(fid).addEventListener('change',()=>{classificationTouched=true}));el('followFoot').innerHTML=(!x.finalized?'<button class="btn btnDanger" id="followCloseBtn">Finalizar conversación</button>':'')+'<button class="btn btnPrimary" id="saveFollowBtn">Guardar cambios</button>';el('saveFollowBtn').onclick=saveFollow;if(el('followCloseBtn'))el('followCloseBtn').onclick=()=>closeNow(x._id);if(el('reclassifyBtn'))el('reclassifyBtn').onclick=()=>reclassify(x._id)}catch(e){el('followBody').innerHTML='<div class="empty">Error cargando seguimiento.</div>';toast(e.message,true)}}
async function saveFollow(){if(!activeId)return;const pending=el('fPending').checked;const body={workflowStatus:el('fWorkflow').value,category:el('fCategory').value,satisfaction:el('fSatisfaction').value,quoteRequested:el('fQuote').value,classificationTouched,priority:el('fPriority').value,assignedTo:el('fAssigned').value,pendingContact:pending,nextContactAt:pending?el('fNext').value:null,summary:el('fSummary').value,notes:el('fNotes').value,tags:el('fTags').value};try{await requestJson('/api/conversation-followup/'+encodeURIComponent(activeId),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('Seguimiento guardado');await loadRows();await openFollow(activeId)}catch(e){toast(e.message,true)}}
async function reclassify(id){if(!confirm('¿Volver a analizar esta conversación con IA? La clasificación automática reemplazará tipo, cotización, satisfacción y resumen.'))return;try{toast('Clasificando con IA…');await requestJson('/api/conversation-followup/'+encodeURIComponent(id)+'/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({force:true})});toast('Clasificación actualizada');await loadRows();await openFollow(id)}catch(e){toast(e.message,true)}}
async function closeNow(id){if(!confirm('¿Finalizar esta conversación ahora? Al finalizar se clasificará automáticamente con IA.'))return;try{toast('Finalizando y clasificando…');await requestJson('/api/conversation-followup/'+encodeURIComponent(id)+'/close',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});toast('Conversación finalizada');closeModal('chatModal');await loadRows();if(el('followModal').classList.contains('open'))await openFollow(id)}catch(e){toast(e.message,true)}}
async function refresh(){el('refreshBtn').disabled=true;try{await loadConfig();await loadRows()}catch(e){toast(e.message,true)}finally{el('refreshBtn').disabled=false}}
async function changeTenant(value){const next=String(value||'').trim();if(!CAN_SELECT_TENANT||!next||next===TENANT)return;TENANT=next;activeId='';activeItem=null;if(el('tenantLabel'))el('tenantLabel').textContent=TENANT;try{const u=new URL(location.href);u.searchParams.set('tenant',TENANT);history.replaceState(null,'',u.toString())}catch{}await refresh()}
el('refreshBtn').addEventListener('click',refresh);if(CAN_SELECT_TENANT&&el('tenantSelect'))el('tenantSelect').addEventListener('change',e=>changeTenant(e.target.value));['q','conversationState','workflow','category'].forEach(id=>el(id).addEventListener(id==='q'?'input':'change',()=>{clearTimeout(debounce);debounce=setTimeout(()=>loadRows().catch(e=>toast(e.message,true)),id==='q'?250:0)}));
if(CAN_EDIT_CONFIG){el('cfgBtn').addEventListener('click',()=>{el('cfgEnabled').checked=config.autoCloseEnabled;el('cfgMinutes').value=config.inactivityMinutes;openModal('cfgModal')});el('cfgSave').addEventListener('click',async()=>{try{const j=await requestJson('/api/conversation-followup/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoCloseEnabled:el('cfgEnabled').checked,inactivityMinutes:el('cfgMinutes').value})});config=j.config;cfgText();closeModal('cfgModal');toast('Configuración guardada');await loadRows()}catch(e){toast(e.message,true)}})}
Promise.all([loadConfig(),loadRows()]).catch(e=>toast(e.message,true));setInterval(()=>{if(!document.hidden)loadRows().catch(()=>{})},30000);
</script>
</body>
</html>`;
}

// ===================== Rutas =====================

function mountConversationFollowupPanel(app, { auth } = {}) {
  if (!app || app.__asistoConversationFollowupMounted) return;
  app.__asistoConversationFollowupMounted = true;

  ensureIndexes();
  setTimeout(() => runAutoCloseSweep().catch(e => console.warn('[followup] initial sweep:', e?.message || e)), 5000).unref?.();
  const timer = setInterval(() => runAutoCloseSweep().catch(e => console.warn('[followup] sweep:', e?.message || e)), AUTO_CLOSE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  app.get('/admin/followup', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const canSelectTenant = isSuperAdmin(req);
      const db = canSelectTenant ? await getDb() : null;
      const tenantOptions = canSelectTenant ? await loadAvailableTenants(db, tenant) : [tenant];
      return res.status(200).send(panelHtml({
        tenant,
        tenantOptions,
        user: req.user,
        canInbox: hasPageAccess(auth, req, 'inbox'),
        canEditConfig: isAdmin(req),
        canSelectTenant,
      }));
    } catch (e) {
      console.error('[followup] page:', e);
      return res.status(500).send('Error cargando seguimiento de conversaciones.');
    }
  });

  app.get('/api/conversation-followup/version', (req, res) => {
    return res.json({ ok: true, build: FOLLOWUP_BUILD, temperatureSent: false });
  });

  app.get('/api/conversation-followup/config', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const db = await getDb();
      return res.json({ ok: true, config: await loadConfig(db, tenant) });
    } catch (e) {
      console.error('[followup] config get:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.post('/api/conversation-followup/config', async (req, res) => {
    try {
      if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
      const tenant = resolveTenant(req, auth);
      const db = await getDb();
      const config = await saveConfig(db, tenant, req.body || {}, req);
      const closed = await autoCloseTenant(db, tenant, config);
      if (closed) setImmediate(() => classifyMissingFinalized(db, tenant, AI_BACKFILL_PER_SWEEP).catch(() => {}));
      return res.json({ ok: true, config });
    } catch (e) {
      console.error('[followup] config save:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.get('/api/conversation-followup/conversations', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const db = await getDb();
      const config = await loadConfig(db, tenant);
      const closedNow = config.autoCloseEnabled ? await autoCloseTenant(db, tenant, config) : 0;
      if (closedNow) setImmediate(() => classifyMissingFinalized(db, tenant, AI_BACKFILL_PER_SWEEP).catch(() => {}));

      const limit = intValue(req.query?.limit, 500, 1, 1000);
      const qText = cleanString(req.query?.q, 150);
      const conversationState = cleanString(req.query?.conversationState || 'all', 30).toLowerCase();
      const workflow = cleanString(req.query?.workflow || 'all', 30).toLowerCase();
      const category = cleanString(req.query?.category || 'all', 30).toLowerCase();
      const q = { tenantId: tenant, botMode: 'conversacional' };
      if (conversationState === 'open') q.finalized = { $ne: true };
      if (conversationState === 'closed') q.finalized = true;

      if (qText) {
        const rx = new RegExp(escapeRegex(qText), 'i');
        const [followupHits, leadHits] = await Promise.all([
          db.collection(FOLLOWUP_COLLECTION).find({ tenantId: tenant, $or: [{ summary: rx }, { notes: rx }, { tags: rx }, { assignedTo: rx }, { aiFollowUpReason: rx }] }, { projection: { conversationId: 1 } }).limit(500).toArray(),
          db.collection('leads').find({ tenantId: tenant, $or: [{ name: rx }, { company: rx }, { email: rx }, { phone: rx }, { lastMessage: rx }] }, { projection: { conversationId: 1 } }).limit(500).toArray(),
        ]);
        const relatedIds = [...followupHits, ...leadHits]
          .map(x => x.conversationId)
          .filter(x => x && (x instanceof ObjectId || ObjectId.isValid(String(x))))
          .map(x => x instanceof ObjectId ? x : new ObjectId(String(x)));
        q.$or = [{ waId: rx }, { contactName: rx }];
        if (relatedIds.length) q.$or.push({ _id: { $in: relatedIds } });
      }

      const convs = await db.collection('conversations').find(q).sort({ updatedAt: -1, openedAt: -1 }).limit(Math.min(2000, limit * 3)).toArray();
      const ids = convs.map(c => c._id);
      const [followups, leads] = ids.length ? await Promise.all([
        db.collection(FOLLOWUP_COLLECTION).find({ tenantId: tenant, conversationId: { $in: ids } }).toArray(),
        db.collection('leads').find({ tenantId: tenant, conversationId: { $in: ids } }).toArray(),
      ]) : [[], []];
      const fm = new Map(followups.map(x => [String(x.conversationId), x]));
      const lm = new Map(leads.map(x => [String(x.conversationId), x]));
      let items = convs.map(c => publicConversation(c, fm.get(String(c._id)), lm.get(String(c._id)), config));
      const allForSummary = items.slice();
      if (workflow !== 'all') items = items.filter(x => workflow === 'due' ? x.isDue : x.workflowStatus === workflow);
      if (category !== 'all') items = items.filter(x => String(x.category || '') === category);
      items = items.slice(0, limit);
      const summary = {
        active: allForSummary.filter(x => !x.finalized).length,
        closed: allForSummary.filter(x => x.finalized).length,
        pending_review: allForSummary.filter(x => x.workflowStatus === 'pending_review').length,
        follow_up: allForSummary.filter(x => x.workflowStatus === 'follow_up').length,
        due: allForSummary.filter(x => x.isDue).length,
      };
      return res.json({ ok: true, items, summary, config });
    } catch (e) {
      console.error('[followup] list:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.get('/api/conversation-followup/:id/messages', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const id = String(req.params.id || '').trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const db = await getDb();
      const conv = await db.collection('conversations').findOne({ _id: new ObjectId(id), tenantId: tenant, botMode: 'conversacional' }, { projection: { _id: 1 } });
      if (!conv) return res.status(404).json({ ok: false, error: 'not_found' });
      const messages = await db.collection('messages').find({ tenantId: tenant, conversationId: conv._id }).sort({ ts: 1, createdAt: 1 }).limit(1000).toArray();
      return res.json({ ok: true, items: messages.map(m => ({ _id: String(m._id), role: m.role, type: m.type, content: m.content, createdAt: m.ts || m.createdAt, media: mediaDescriptor(m) })) });
    } catch (e) {
      console.error('[followup] messages:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.get('/api/conversation-followup/:id/history', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const id = String(req.params.id || '').trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const db = await getDb();
      const current = await db.collection('conversations').findOne({ _id: new ObjectId(id), tenantId: tenant, botMode: 'conversacional' });
      if (!current) return res.status(404).json({ ok: false, error: 'not_found' });
      const convs = await db.collection('conversations').find({ tenantId: tenant, botMode: 'conversacional', waId: current.waId, _id: { $ne: current._id } }).sort({ updatedAt: -1 }).limit(30).toArray();
      const ids = convs.map(c => c._id);
      const [followups, leads] = ids.length ? await Promise.all([
        db.collection(FOLLOWUP_COLLECTION).find({ tenantId: tenant, conversationId: { $in: ids } }).toArray(),
        db.collection('leads').find({ tenantId: tenant, conversationId: { $in: ids } }).toArray(),
      ]) : [[], []];
      const fm = new Map(followups.map(x => [String(x.conversationId), x]));
      const lm = new Map(leads.map(x => [String(x.conversationId), x]));
      const config = await loadConfig(db, tenant);
      return res.json({ ok: true, items: convs.map(c => publicConversation(c, fm.get(String(c._id)), lm.get(String(c._id)), config)) });
    } catch (e) {
      console.error('[followup] history:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.get('/api/conversation-followup/:id', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const id = String(req.params.id || '').trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const db = await getDb();
      let bundle = await loadConversationBundle(db, tenant, id);
      if (!bundle) return res.status(404).json({ ok: false, error: 'not_found' });

      // Migración automática de errores generados por la versión vieja que enviaba
      // temperature: 0. La versión actual NO envía ese parámetro. Al abrir el
      // seguimiento reintentamos inmediatamente y devolvemos ya el resultado nuevo.
      if (bundle.conv?.finalized === true && shouldBypassAiRetry(bundle.followup)) {
        console.log(`[followup][ai] reparando error temperature viejo build=${FOLLOWUP_BUILD} tenant=${tenant} conv=${id}`);
        await classifyConversationWithAi(db, tenant, bundle.conv._id, { force: true });
        bundle = await loadConversationBundle(db, tenant, id);
      }

      return res.json({ ok: true, item: bundle.item, config: bundle.config, build: FOLLOWUP_BUILD });
    } catch (e) {
      console.error('[followup] get:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.post('/api/conversation-followup/:id/classify', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const id = String(req.params.id || '').trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const db = await getDb();
      const conv = await db.collection('conversations').findOne({ _id: new ObjectId(id), tenantId: tenant, botMode: 'conversacional' });
      if (!conv) return res.status(404).json({ ok: false, error: 'not_found' });
      if (conv.finalized !== true) return res.status(409).json({ ok: false, error: 'conversation_must_be_finalized' });
      const result = await classifyConversationWithAi(db, tenant, conv._id, { force: boolValue(req.body?.force, true) });
      if (!result.ok) return res.status(500).json({ ok: false, error: result.error || 'classification_failed' });
      const bundle = await loadConversationBundle(db, tenant, id);
      return res.json({ ok: true, item: bundle?.item || null });
    } catch (e) {
      console.error('[followup] classify:', e);
      return res.status(500).json({ ok: false, error: 'classification_failed' });
    }
  });

  app.post('/api/conversation-followup/:id', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const id = String(req.params.id || '').trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const db = await getDb();
      const oid = new ObjectId(id);
      const conv = await db.collection('conversations').findOne({ _id: oid, tenantId: tenant, botMode: 'conversacional' });
      if (!conv) return res.status(404).json({ ok: false, error: 'not_found' });
      const body = req.body || {};
      const now = new Date();
      const pendingContact = boolValue(body.pendingContact, false);
      const nextContactAt = pendingContact ? safeDate(body.nextContactAt) : null;
      const workflowStatus = normalizeWorkflowStatus(body.workflowStatus);
      const classificationTouched = boolValue(body.classificationTouched, false);
      const operator = cleanString(req?.user?.username || req?.user?.uid || 'operator', 120);
      const set = {
        tenantId: tenant,
        conversationId: oid,
        waId: String(conv.waId || ''),
        workflowStatus,
        pendingContact,
        nextContactAt,
        priority: normalizePriority(body.priority),
        assignedTo: cleanString(body.assignedTo, 120),
        summary: cleanString(body.summary, 3000),
        notes: cleanString(body.notes, 5000),
        tags: normalizeTags(body.tags),
        manualEditedAt: now,
        updatedAt: now,
        updatedBy: operator,
      };
      if (classificationTouched) {
        set.category = cleanString(body.category, 30) ? normalizeCategory(body.category) : null;
        set.satisfaction = normalizeSatisfaction(body.satisfaction);
        set.quoteRequested = normalizeQuoteRequested(body.quoteRequested);
        set.manualClassificationEditedAt = now;
        set.classifiedAt = now;
        set.classifiedBy = operator;
      }
      await db.collection(FOLLOWUP_COLLECTION).updateOne(
        { tenantId: tenant, conversationId: oid },
        { $set: set, $setOnInsert: { createdAt: now } },
        { upsert: true }
      );
      await db.collection('conversations').updateOne(
        { _id: oid, tenantId: tenant },
        { $set: { followupReviewPending: workflowStatus === 'pending_review', followupWorkflowStatus: workflowStatus } }
      );
      const bundle = await loadConversationBundle(db, tenant, id);
      return res.json({ ok: true, item: bundle?.item || null });
    } catch (e) {
      console.error('[followup] save:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.post('/api/conversation-followup/:id/close', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const id = String(req.params.id || '').trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const db = await getDb();
      const oid = new ObjectId(id);
      const now = new Date();
      const r = await db.collection('conversations').updateOne(
        { _id: oid, tenantId: tenant, botMode: 'conversacional' },
        { $set: { finalized: true, status: 'CLOSED_MANUAL', closedAt: now, closeReason: 'operator', followupReviewPending: true } }
      );
      if (!r.matchedCount) return res.status(404).json({ ok: false, error: 'not_found' });
      const classification = await classifyConversationWithAi(db, tenant, oid, { force: false });
      return res.json({ ok: true, classification });
    } catch (e) {
      console.error('[followup] close:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });
}

module.exports = { mountConversationFollowupPanel, runAutoCloseSweep };
