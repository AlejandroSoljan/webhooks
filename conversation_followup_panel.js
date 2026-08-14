// conversation_followup_panel.js
// Panel de seguimiento para conversaciones del bot en modo "conversacional".
// - Cierre automático por inactividad configurable por tenant.
// - Clasificación operativa/comercial sin mezclar datos con el flujo de pedidos.
// - Historial del cliente por waId.

const { ObjectId } = require('mongodb');
const { getDb } = require('./db');

const DEFAULT_TENANT_ID = String(process.env.TENANT_ID || 'default').trim() || 'default';
const SETTINGS_PREFIX = 'conversation_followup:';
const FOLLOWUP_COLLECTION = 'conversation_followups';
const DEFAULT_INACTIVITY_MINUTES = 30;
const AUTO_CLOSE_INTERVAL_MS = 60 * 1000;

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

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
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
  // Mientras la conversación sigue abierta, el panel la muestra como activa aunque
  // el operador ya haya cargado notas preliminares. La clasificación operativa
  // toma vigencia cuando la conversación queda finalizada.
  if (conv?.finalized !== true) return 'active';
  if (followup?.workflowStatus) return normalizeWorkflowStatus(followup.workflowStatus);
  return 'pending_review';
}

function lastActivity(conv) {
  return conv?.lastUserTs || conv?.lastAssistantTs || conv?.updatedAt || conv?.closedAt || conv?.openedAt || conv?.createdAt || null;
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
    category: followup?.category || (quoteDetected ? 'cotizacion' : 'consulta'),
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
  return {
    kind,
    mime: mime || null,
    filename: filename || 'archivo',
    url: '/api/media/' + String(msg._id),
  };
}

async function autoCloseTenant(db, tenant, config) {
  if (!config.autoCloseEnabled) return 0;
  const cutoff = new Date(Date.now() - config.inactivityMinutes * 60 * 1000);
  const now = new Date();
  const result = await db.collection('conversations').updateMany(
    {
      tenantId: tenant,
      botMode: 'conversacional',
      finalized: { $ne: true },
      updatedAt: { $lte: cutoff },
    },
    {
      $set: {
        finalized: true,
        status: 'CLOSED_INACTIVITY',
        closedAt: now,
        closeReason: 'inactivity',
        followupReviewPending: true,
        followupAutoClosedAt: now,
      },
    }
  );
  if (result.modifiedCount) {
    console.log(`[followup] cierre automático tenant=${tenant} conversaciones=${result.modifiedCount} minutos=${config.inactivityMinutes}`);
  }
  return result.modifiedCount || 0;
}

async function runAutoCloseSweep() {
  const db = await getDb();
  const tenants = await db.collection('conversations').distinct('tenantId', {
    botMode: 'conversacional',
    finalized: { $ne: true },
  });
  for (const raw of tenants) {
    const tenant = String(raw || '').trim();
    if (!tenant) continue;
    try {
      const config = await loadConfig(db, tenant);
      await autoCloseTenant(db, tenant, config);
    } catch (e) {
      console.warn(`[followup] auto-close tenant=${tenant}:`, e?.message || e);
    }
  }
}

async function ensureIndexes() {
  try {
    const db = await getDb();
    await Promise.all([
      db.collection(FOLLOWUP_COLLECTION).createIndex({ tenantId: 1, conversationId: 1 }, { unique: true }),
      db.collection(FOLLOWUP_COLLECTION).createIndex({ tenantId: 1, workflowStatus: 1, nextContactAt: 1 }),
      db.collection('conversations').createIndex({ tenantId: 1, botMode: 1, finalized: 1, updatedAt: -1 }),
      db.collection('conversations').createIndex({ tenantId: 1, botMode: 1, waId: 1, updatedAt: -1 }),
    ]);
  } catch (e) {
    console.warn('[followup] indexes:', e?.message || e);
  }
}

async function loadAvailableTenants(db, currentTenant) {
  const tenants = new Set();
  const add = (value) => {
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
    for (const doc of results[0].value || []) {
      add(doc?.tenantId);
      add(doc?.tenantid);
      add(doc?._id);
    }
  }
  for (let i = 1; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
   for (const value of results[i].value || []) add(value);
  }

  return Array.from(tenants).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true }));
}

function panelHtml({ tenant, tenantOptions = [], user, canInbox, canEditConfig, canSelectTenant = false }) {
  const role = String(user?.role || 'user');
  return `<!doctype html>
<html lang="es">
<head>
+<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Seguimiento de conversaciones</title>
<style>
:root{--bg:#eef3f6;--card:#fff;--line:#dfe7ec;--text:#132238;--muted:#667085;--primary:#0e6b66;--primary2:#0b5955;--danger:#b42318;--warn:#b54708;--ok:#067647;--blue:#175cd3;--soft:#f8fafc;--shadow:0 8px 24px rgba(16,24,40,.08)}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text)}button,input,select,textarea{font:inherit}button{cursor:pointer}
.wrap{padding:14px;min-height:100vh}.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px}.title h1{font-size:22px;margin:0 0 4px}.title p{margin:0;color:var(--muted);font-size:13px}.topActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tenantPicker{display:flex;align-items:center;gap:7px;padding:5px 8px;border:1px solid var(--line);border-radius:10px;background:#fff}.tenantPicker label{font-size:11px;font-weight:800;color:#475467}.tenantPicker select{min-width:150px;border:0;background:transparent;color:var(--text);font-weight:800;outline:none;padding:3px 20px 3px 2px}
.btn{border:1px solid var(--line);border-radius:10px;padding:9px 12px;background:#fff;color:var(--text);font-weight:700}.btn:hover{background:#f8fafc}.btnPrimary{background:var(--primary);border-color:var(--primary);color:white}.btnPrimary:hover{background:var(--primary2)}.btnDanger{color:var(--danger)}.btnSm{padding:7px 9px;font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:10px;margin-bottom:12px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;box-shadow:var(--shadow)}.kpi b{display:block;font-size:24px}.kpi span{font-size:12px;color:var(--muted)}
.filters{display:flex;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid var(--line);padding:10px;border-radius:14px;margin-bottom:12px}.filters input,.filters select{border:1px solid var(--line);border-radius:9px;padding:8px 10px;background:white;min-height:38px}.filters .search{min-width:240px;flex:1}
.layout{display:grid;grid-template-columns:minmax(280px,34%) minmax(340px,1fr) minmax(310px,36%);gap:12px;height:calc(100vh - 235px);min-height:570px}.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);min-height:0;overflow:hidden}.panelHead{padding:11px 12px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;align-items:center}.panelHead h3{margin:0;font-size:14px}.muted{color:var(--muted);font-size:12px}
.list{overflow:auto;height:calc(100% - 47px)}.item{padding:11px 12px;border-bottom:1px solid var(--line);cursor:pointer}.item:hover{background:#f8fafc}.item.active{background:#ecfdf3;border-left:4px solid var(--primary);padding-left:8px}.row{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.name{font-size:14px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.phone{font-size:11px;color:var(--muted);margin-top:2px}.badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 7px;font-size:10px;font-weight:800;border:1px solid transparent}.bOpen{background:#eff8ff;color:#175cd3}.bPending{background:#fffaeb;color:#b54708}.bFollow{background:#f4f3ff;color:#5925dc}.bResolved{background:#ecfdf3;color:#067647}.bDiscarded{background:#f2f4f7;color:#475467}.bDue{background:#fef3f2;color:#b42318}.bQuote{background:#eef4ff;color:#3538cd}
.chatWrap{display:flex;flex-direction:column;height:100%}.chatMeta{padding:11px 12px;border-bottom:1px solid var(--line);background:#fbfcfd}.chatMeta strong{display:block}.chat{flex:1;overflow:auto;padding:14px;background:#f6f8fa}.msgRow{display:flex;margin:7px 0}.msgRow.user{justify-content:flex-start}.msgRow.assistant{justify-content:flex-end}.bubble{max-width:82%;padding:9px 11px;border-radius:12px;font-size:13px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}.user .bubble{background:white;border:1px solid var(--line);border-bottom-left-radius:4px}.assistant .bubble{background:#dff6e9;border:1px solid #c4ebd5;border-bottom-right-radius:4px}.msgAt{display:block;font-size:10px;color:var(--muted);margin-top:5px}.media{margin-top:7px}.media img{max-width:260px;max-height:220px;border-radius:8px}.media audio,.media video{max-width:280px}.empty{padding:28px;text-align:center;color:var(--muted)}
.form{height:calc(100% - 47px);overflow:auto;padding:12px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}.field label{font-size:11px;font-weight:800;color:#475467}.field input,.field select,.field textarea{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px 10px;background:white}.field textarea{min-height:76px;resize:vertical}.check{display:flex;gap:8px;align-items:center;padding:9px 10px;border:1px solid var(--line);border-radius:9px;margin-bottom:10px}.check input{width:auto}.actions{display:flex;gap:8px;flex-wrap:wrap;position:sticky;bottom:-12px;background:white;padding:10px 0 4px;border-top:1px solid var(--line)}
.history{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}.histItem{padding:8px;border:1px solid var(--line);border-radius:9px;margin:6px 0;background:#fafbfc;font-size:11px}.leadBox{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:9px;margin-bottom:10px;font-size:11px}.configPop{display:none;position:fixed;z-index:50;inset:0;background:rgba(15,23,42,.45);align-items:center;justify-content:center;padding:16px}.configPop.open{display:flex}.configCard{width:min(480px,96vw);background:white;border-radius:16px;padding:16px;box-shadow:0 24px 70px rgba(0,0,0,.3)}.configCard h3{margin:0 0 12px}.toast{position:fixed;right:18px;bottom:18px;background:#101828;color:white;padding:10px 13px;border-radius:10px;display:none;z-index:70;font-size:12px}.toast.show{display:block}.toast.err{background:#b42318}
@media(max-width:1200px){.layout{grid-template-columns:330px 1fr;height:auto;min-height:0}.panel.classify{grid-column:1/-1;height:auto}.panel.listPanel,.panel.chatPanel{height:650px}.form{height:auto;max-height:none}.kpis{grid-template-columns:repeat(3,1fr)}}
@media(max-width:760px){.wrap{padding:8px}.kpis{grid-template-columns:repeat(2,1fr)}.layout{display:block}.panel{margin-bottom:10px}.panel.listPanel{height:430px}.panel.chatPanel{height:560px}.grid2{grid-template-columns:1fr}.filters .search{min-width:100%}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="title"><h1>Seguimiento de conversaciones</h1><p>Dominio: <strong id="tenantLabel">${htmlEscape(tenant)}</strong> · ${htmlEscape(role)} · sólo modo conversacional</p></div>
    <div class="topActions">
          ${canSelectTenant ? `<div class="tenantPicker"><label for="tenantSelect">Dominio</label><select id="tenantSelect">${tenantOptions.map(t => `<option value="${htmlEscape(t)}" ${String(t) === String(tenant) ? 'selected' : ''}>${htmlEscape(t)}</option>`).join('')}</select></div>` : ''}
      <span class="muted" id="cfgLabel">Cierre automático: cargando…</span>
      ${canEditConfig ? '<button class="btn" id="cfgBtn">⚙ Configurar cierre</button>' : ''}
      <button class="btn" id="refreshBtn">↻ Actualizar</button>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><b id="kActive">0</b><span>Conversaciones abiertas</span></div>
    <div class="kpi"><b id="kPending">0</b><span>Pendientes de clasificar</span></div>
    <div class="kpi"><b id="kFollow">0</b><span>En seguimiento</span></div>
    <div class="kpi"><b id="kDue">0</b><span>Contactos vencidos</span></div>
    <div class="kpi"><b id="kQuote">0</b><span>Con cotización detectada</span></div>
  </div>

  <div class="filters">
    <input class="search" id="q" placeholder="Buscar nombre, teléfono, resumen, nota o etiqueta…"/>
    <select id="state"><option value="all">Todas</option><option value="active">Abiertas</option><option value="pending_review">Pendientes clasificar</option><option value="follow_up">Seguimiento</option><option value="due">Contacto vencido</option><option value="resolved">Resueltas</option><option value="discarded">Descartadas</option></select>
    <select id="category"><option value="all">Todos los tipos</option><option value="consulta">Consulta</option><option value="cotizacion">Cotización</option><option value="soporte">Soporte</option><option value="reclamo">Reclamo</option><option value="comercial">Comercial</option><option value="otro">Otro</option></select>
  </div>

  <div class="layout">
    <section class="panel listPanel"><div class="panelHead"><h3>Conversaciones</h3><span class="muted" id="listCount">0</span></div><div class="list" id="list"><div class="empty">Cargando…</div></div></section>
    <section class="panel chatPanel"><div class="chatWrap"><div class="chatMeta" id="chatMeta"><strong>Seleccioná una conversación</strong><span class="muted">Acá vas a ver el intercambio completo.</span></div><div class="chat" id="chat"><div class="empty">Sin conversación seleccionada.</div></div></div></section>
    <section class="panel classify"><div class="panelHead"><h3>Clasificación y seguimiento</h3><span class="muted" id="saveState"></span></div><div class="form" id="formArea"><div class="empty">Seleccioná una conversación.</div></div></section>
  </div>
</div>

${canEditConfig ? `<div class="configPop" id="cfgPop"><div class="configCard"><h3>Cierre automático por inactividad</h3><div class="check"><input type="checkbox" id="cfgEnabled"/><span>Finalizar automáticamente conversaciones conversacionales inactivas</span></div><div class="field"><label>Minutos de inactividad</label><input type="number" id="cfgMinutes" min="1" max="10080" step="1"/><small class="muted">Al vencer este tiempo, la conversación se cierra y pasa a “Pendiente de clasificar”. Si el cliente vuelve a escribir, se crea una conversación nueva.</small></div><div class="actions"><button class="btn btnPrimary" id="cfgSave">Guardar</button><button class="btn" id="cfgCancel">Cancelar</button></div></div></div>` : ''}
<div class="toast" id="toast"></div>
<script>
let TENANT=${JSON.stringify(tenant)};
const CAN_INBOX=${canInbox ? 'true' : 'false'};
const CAN_EDIT_CONFIG=${canEditConfig ? 'true' : 'false'};
const CAN_SELECT_TENANT=${canSelectTenant ? 'true' : 'false'};
let rows=[];let activeId='';let activeItem=null;let config={autoCloseEnabled:true,inactivityMinutes:30};let debounce=null;
const el=id=>document.getElementById(id);
function api(path){const u=new URL(path,location.origin);if(TENANT)u.searchParams.set('tenant',TENANT);return u.toString()}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function fmt(v){if(!v)return '-';const d=new Date(v);return isNaN(d)?'-':d.toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'})}
function fmtInput(v){if(!v)return '';const d=new Date(v);if(isNaN(d))return '';const z=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate())+'T'+z(d.getHours())+':'+z(d.getMinutes())}
function toast(msg,err=false){const t=el('toast');t.textContent=msg;t.className='toast show'+(err?' err':'');setTimeout(()=>t.className='toast',2600)}
function workflowLabel(v){return ({active:'Abierta',pending_review:'Pendiente clasificar',follow_up:'Seguimiento',resolved:'Resuelta',discarded:'Descartada'})[v]||v}
function badgeClass(v){return ({active:'bOpen',pending_review:'bPending',follow_up:'bFollow',resolved:'bResolved',discarded:'bDiscarded'})[v]||'bPending'}
function stars(v){if(!v)return 'Sin definir';return '★'.repeat(Number(v))+'☆'.repeat(5-Number(v))}
function quoteText(v){return v===true?'Sí':(v===false?'No':'Sin definir')}
function cfgText(){el('cfgLabel').textContent=config.autoCloseEnabled?('Cierre automático: '+config.inactivityMinutes+' min de inactividad'):'Cierre automático desactivado'}
async function requestJson(url,opts){const r=await fetch(api(url),opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Error');return j}
async function loadConfig(){const j=await requestJson('/api/conversation-followup/config');config=j.config||config;cfgText()}
async function loadRows(preserve=true){const prev=preserve?activeId:'';const p=new URLSearchParams();p.set('limit','500');const q=el('q').value.trim();const st=el('state').value;const cat=el('category').value;if(q)p.set('q',q);if(st)p.set('state',st);if(cat)p.set('category',cat);const j=await requestJson('/api/conversation-followup/conversations?'+p.toString());rows=j.items||[];renderKpis(j.summary||{});renderList();if(prev&&rows.some(x=>x._id===prev)){activeId=prev;renderList()}else if(!activeId&&rows[0]){await selectRow(rows[0]._id)}else if(activeId&&!rows.some(x=>x._id===activeId)){activeId='';activeItem=null;el('chat').innerHTML='<div class="empty">La conversación activa no coincide con los filtros.</div>';el('formArea').innerHTML='<div class="empty">Seleccioná otra conversación.</div>'}}
function renderKpis(s){el('kActive').textContent=s.active||0;el('kPending').textContent=s.pending_review||0;el('kFollow').textContent=s.follow_up||0;el('kDue').textContent=s.due||0;el('kQuote').textContent=s.quote||0}
function renderList(){el('listCount').textContent=rows.length+' visibles';if(!rows.length){el('list').innerHTML='<div class="empty">No hay conversaciones con estos filtros.</div>';return}el('list').innerHTML=rows.map(x=>{const nm=x.contactName||x.lead?.name||x.waId||'Sin nombre';return '<div class="item '+(x._id===activeId?'active':'')+'" data-id="'+esc(x._id)+'"><div class="row"><div style="min-width:0"><div class="name">'+esc(nm)+'</div><div class="phone">'+esc(x.waId||'')+' · '+esc(fmt(x.lastAt))+'</div></div><span class="badge '+badgeClass(x.workflowStatus)+'">'+esc(workflowLabel(x.workflowStatus))+'</span></div><div class="badges">'+(x.isDue?'<span class="badge bDue">Contacto vencido</span>':'')+(x.quoteDetected?'<span class="badge bQuote">Cotización detectada</span>':'')+(x.pendingContact&&!x.isDue?'<span class="badge bFollow">Contactar</span>':'')+(x.satisfaction?'<span class="badge bResolved">'+esc(stars(x.satisfaction))+'</span>':'')+'</div></div>'}).join('');el('list').querySelectorAll('.item').forEach(n=>n.addEventListener('click',()=>selectRow(n.dataset.id)))}
async function selectRow(id){activeId=id;renderList();el('chat').innerHTML='<div class="empty">Cargando conversación…</div>';el('formArea').innerHTML='<div class="empty">Cargando clasificación…</div>';try{const [d,m,h]=await Promise.all([requestJson('/api/conversation-followup/'+encodeURIComponent(id)),requestJson('/api/conversation-followup/'+encodeURIComponent(id)+'/messages'),requestJson('/api/conversation-followup/'+encodeURIComponent(id)+'/history')]);activeItem=d.item;renderChat(activeItem,m.items||[]);renderForm(activeItem,h.items||[])}catch(e){toast(e.message,true)}}
function renderMedia(m){if(!m.media||!m.media.url)return '';const u=api(m.media.url);const k=String(m.media.kind||'');if(k==='image')return '<div class="media"><a href="'+esc(u)+'" target="_blank"><img src="'+esc(u)+'"/></a></div>';if(k==='audio')return '<div class="media"><audio controls src="'+esc(u)+'"></audio></div>';if(k==='video')return '<div class="media"><video controls src="'+esc(u)+'"></video></div>';return '<div class="media"><a href="'+esc(u)+'" target="_blank">📎 '+esc(m.media.filename||'Archivo')+'</a></div>'}
function renderChat(x,msgs){const nm=x.contactName||x.lead?.name||x.waId||'Sin nombre';el('chatMeta').innerHTML='<strong>'+esc(nm)+'</strong><span class="muted">'+esc(x.waId||'')+' · '+esc(workflowLabel(x.workflowStatus))+' · última actividad '+esc(fmt(x.lastAt))+'</span>';if(!msgs.length){el('chat').innerHTML='<div class="empty">No hay mensajes guardados.</div>';return}el('chat').innerHTML=msgs.map(m=>'<div class="msgRow '+(m.role==='user'?'user':'assistant')+'"><div class="bubble">'+esc(m.content||'')+renderMedia(m)+'<span class="msgAt">'+esc(fmt(m.createdAt))+'</span></div></div>').join('');el('chat').scrollTop=el('chat').scrollHeight}
function renderForm(x,history){const qr=x.quoteRequested===true?'true':(x.quoteRequested===false?'false':'');const hist=history.length?history.map(h=>'<div class="histItem"><b>'+esc(fmt(h.lastAt))+'</b> · '+esc(workflowLabel(h.workflowStatus))+(h.category?' · '+esc(h.category):'')+(h.satisfaction?' · '+esc(stars(h.satisfaction)):'')+(h.summary?'<div style="margin-top:4px">'+esc(h.summary)+'</div>':'')+'</div>').join(''):'<div class="muted">Sin conversaciones anteriores clasificadas.</div>';const lead=x.lead?'<div class="leadBox"><b>Datos detectados por el bot</b><div>Tipo: '+esc(x.leadType||'-')+' · Cotización completa: '+(x.quoteReady?'Sí':'No')+'</div>'+(x.lead.company?'<div>Empresa: '+esc(x.lead.company)+'</div>':'')+(x.lead.email?'<div>Email: '+esc(x.lead.email)+'</div>':'')+'</div>':'';el('formArea').innerHTML=lead+'<div class="grid2"><div class="field"><label>Estado de gestión</label><select id="fWorkflow"><option value="pending_review">Pendiente de clasificar</option><option value="follow_up">En seguimiento</option><option value="resolved">Resuelta</option><option value="discarded">Descartada</option></select></div><div class="field"><label>Tipo de consulta</label><select id="fCategory"><option value="consulta">Consulta</option><option value="cotizacion">Cotización</option><option value="soporte">Soporte</option><option value="reclamo">Reclamo</option><option value="comercial">Comercial</option><option value="otro">Otro</option></select></div><div class="field"><label>Satisfacción del cliente</label><select id="fSatisfaction"><option value="">Sin definir</option><option value="5">★★★★★ Muy satisfecho</option><option value="4">★★★★☆ Satisfecho</option><option value="3">★★★☆☆ Neutro</option><option value="2">★★☆☆☆ Insatisfecho</option><option value="1">★☆☆☆☆ Muy insatisfecho</option></select></div><div class="field"><label>¿Pidió cotización?</label><select id="fQuote"><option value="">Sin definir</option><option value="true">Sí</option><option value="false">No</option></select></div><div class="field"><label>Prioridad</label><select id="fPriority"><option value="baja">Baja</option><option value="normal">Normal</option><option value="alta">Alta</option><option value="urgente">Urgente</option></select></div><div class="field"><label>Responsable</label><input id="fAssigned" placeholder="Operario / vendedor" value="'+esc(x.assignedTo||'')+'"/></div></div><div class="check"><input type="checkbox" id="fPending" '+(x.pendingContact?'checked':'')+'/><span><b>Hay que volver a contactar al cliente</b></span></div><div class="field"><label>Próximo contacto</label><input type="datetime-local" id="fNext" value="'+esc(fmtInput(x.nextContactAt))+'"/></div><div class="field"><label>Resumen de la consulta</label><textarea id="fSummary" placeholder="Qué consultó y cuál fue el resultado…">'+esc(x.summary||'')+'</textarea></div><div class="field"><label>Notas internas</label><textarea id="fNotes" placeholder="Dudas pendientes, compromiso asumido, información a verificar…">'+esc(x.notes||'')+'</textarea></div><div class="field"><label>Etiquetas (separadas por coma)</label><input id="fTags" value="'+esc((x.tags||[]).join(', '))+'" placeholder="precio, soporte, urgente…"/></div><div class="actions"><button class="btn btnPrimary" id="saveBtn">Guardar clasificación</button>'+(CAN_INBOX?'<button class="btn" id="inboxBtn">Abrir en WhatsApp</button>':'')+(!x.finalized?'<button class="btn btnDanger" id="closeBtn">Finalizar ahora</button>':'')+'</div><div class="history"><b style="font-size:12px">Historial de este cliente</b>'+hist+'</div>';el('fWorkflow').value=x.workflowStatus==='active'?'pending_review':x.workflowStatus;el('fCategory').value=x.category||'consulta';el('fSatisfaction').value=x.satisfaction||'';el('fQuote').value=qr;el('fPriority').value=x.priority||'normal';el('saveBtn').addEventListener('click',saveClassification);if(el('inboxBtn'))el('inboxBtn').addEventListener('click',()=>window.open('/admin/inbox?convId='+encodeURIComponent(x._id)+(TENANT?'&tenant='+encodeURIComponent(TENANT):''),'_blank'));if(el('closeBtn'))el('closeBtn').addEventListener('click',closeNow)}
async function saveClassification(){if(!activeId)return;const pending=el('fPending').checked;const body={workflowStatus:el('fWorkflow').value,category:el('fCategory').value,satisfaction:el('fSatisfaction').value,quoteRequested:el('fQuote').value,priority:el('fPriority').value,assignedTo:el('fAssigned').value,pendingContact:pending,nextContactAt:pending?el('fNext').value:null,summary:el('fSummary').value,notes:el('fNotes').value,tags:el('fTags').value};el('saveState').textContent='Guardando…';try{await requestJson('/api/conversation-followup/'+encodeURIComponent(activeId),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('Clasificación guardada');await loadRows(true);await selectRow(activeId)}catch(e){toast(e.message,true)}finally{el('saveState').textContent=''}}
async function closeNow(){if(!activeId||!confirm('¿Finalizar esta conversación ahora?'))return;try{await requestJson('/api/conversation-followup/'+encodeURIComponent(activeId)+'/close',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});toast('Conversación finalizada');await loadRows(true);await selectRow(activeId)}catch(e){toast(e.message,true)}}
async function refresh(){el('refreshBtn').disabled=true;try{await loadConfig();await loadRows(true)}catch(e){toast(e.message,true)}finally{el('refreshBtn').disabled=false}}
async function changeTenant(value){const next=String(value||'').trim();if(!CAN_SELECT_TENANT||!next||next===TENANT)return;TENANT=next;activeId='';activeItem=null;rows=[];if(el('tenantLabel'))el('tenantLabel').textContent=TENANT;el('list').innerHTML='<div class="empty">Cargando dominio…</div>';el('chatMeta').innerHTML='<strong>Seleccioná una conversación</strong><span class="muted">Acá vas a ver el intercambio completo.</span>';el('chat').innerHTML='<div class="empty">Sin conversación seleccionada.</div>';el('formArea').innerHTML='<div class="empty">Seleccioná una conversación.</div>';try{const u=new URL(location.href);u.searchParams.set('tenant',TENANT);history.replaceState(null,'',u.toString())}catch{}try{await loadConfig();await loadRows(false)}catch(e){toast(e.message,true)}}
el('refreshBtn').addEventListener('click',refresh);if(CAN_SELECT_TENANT&&el('tenantSelect'))el('tenantSelect').addEventListener('change',e=>changeTenant(e.target.value));['q','state','category'].forEach(id=>el(id).addEventListener(id==='q'?'input':'change',()=>{clearTimeout(debounce);debounce=setTimeout(()=>loadRows(false).catch(e=>toast(e.message,true)),id==='q'?280:0)}));
if(CAN_EDIT_CONFIG){el('cfgBtn').addEventListener('click',()=>{el('cfgEnabled').checked=config.autoCloseEnabled;el('cfgMinutes').value=config.inactivityMinutes;el('cfgPop').classList.add('open')});el('cfgCancel').addEventListener('click',()=>el('cfgPop').classList.remove('open'));el('cfgPop').addEventListener('click',e=>{if(e.target===el('cfgPop'))el('cfgPop').classList.remove('open')});el('cfgSave').addEventListener('click',async()=>{try{const j=await requestJson('/api/conversation-followup/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoCloseEnabled:el('cfgEnabled').checked,inactivityMinutes:el('cfgMinutes').value})});config=j.config;cfgText();el('cfgPop').classList.remove('open');toast('Configuración guardada');await loadRows(true)}catch(e){toast(e.message,true)}})}
Promise.all([loadConfig(),loadRows(false)]).catch(e=>toast(e.message,true));setInterval(()=>loadRows(true).catch(()=>{}),30000);
</script>
</body>
</html>`;
}

function mountConversationFollowupPanel(app, { auth } = {}) {
  if (!app || app.__asistoConversationFollowupMounted) return;
  app.__asistoConversationFollowupMounted = true;

  ensureIndexes();
  setTimeout(() => runAutoCloseSweep().catch(e => console.warn('[followup] initial sweep:', e?.message || e)), 5000).unref?.();
  const timer = setInterval(() => runAutoCloseSweep().catch(e => console.warn('[followup] sweep:', e?.message || e)), AUTO_CLOSE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  app.get('/admin/followup', async (req, res) => {
    try {
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
      await autoCloseTenant(db, tenant, config);
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
      if (config.autoCloseEnabled) await autoCloseTenant(db, tenant, config);

      const limit = intValue(req.query?.limit, 500, 1, 1000);
      const qText = cleanString(req.query?.q, 150);
      const state = cleanString(req.query?.state || 'all', 30).toLowerCase();
      const category = cleanString(req.query?.category || 'all', 30).toLowerCase();
      const q = { tenantId: tenant, botMode: 'conversacional' };
      if (qText) {
        const rx = new RegExp(escapeRegex(qText), 'i');
        const [followupHits, leadHits] = await Promise.all([
          db.collection(FOLLOWUP_COLLECTION).find({
            tenantId: tenant,
            $or: [{ summary: rx }, { notes: rx }, { tags: rx }, { assignedTo: rx }],
          }, { projection: { conversationId: 1 } }).limit(500).toArray(),
          db.collection('leads').find({
            tenantId: tenant,
            $or: [{ name: rx }, { company: rx }, { email: rx }, { phone: rx }, { lastMessage: rx }],
          }, { projection: { conversationId: 1 } }).limit(500).toArray(),
        ]);
        const relatedIds = [...followupHits, ...leadHits]
          .map(x => x.conversationId)
          .filter(x => x && (x instanceof ObjectId || ObjectId.isValid(String(x))))
          .map(x => x instanceof ObjectId ? x : new ObjectId(String(x)));
        q.$or = [{ waId: rx }, { contactName: rx }];
        if (relatedIds.length) q.$or.push({ _id: { $in: relatedIds } });
      }

      // Se trae un margen adicional porque los filtros de gestión viven en la colección de seguimiento.
      const convs = await db.collection('conversations')
        .find(q)
        .sort({ updatedAt: -1, openedAt: -1 })
        .limit(Math.min(2000, limit * 3))
        .toArray();

      const ids = convs.map(c => c._id);
      const [followups, leads] = ids.length ? await Promise.all([
        db.collection(FOLLOWUP_COLLECTION).find({ tenantId: tenant, conversationId: { $in: ids } }).toArray(),
        db.collection('leads').find({ tenantId: tenant, conversationId: { $in: ids } }).toArray(),
      ]) : [[], []];
      const fMap = new Map(followups.map(x => [String(x.conversationId), x]));
      const lMap = new Map(leads.map(x => [String(x.conversationId), x]));
      let items = convs.map(c => publicConversation(c, fMap.get(String(c._id)), lMap.get(String(c._id)), config));

      const allForSummary = items.slice();
      if (state !== 'all') {
        items = items.filter(x => state === 'due' ? x.isDue : x.workflowStatus === state);
      }
      if (category !== 'all') items = items.filter(x => String(x.category || '') === category);
      items = items.slice(0, limit);

      const summaryBase = allForSummary.length ? allForSummary : items;
      const summary = {
        active: summaryBase.filter(x => x.workflowStatus === 'active').length,
        pending_review: summaryBase.filter(x => x.workflowStatus === 'pending_review').length,
        follow_up: summaryBase.filter(x => x.workflowStatus === 'follow_up').length,
        due: summaryBase.filter(x => x.isDue).length,
        resolved: summaryBase.filter(x => x.workflowStatus === 'resolved').length,
        quote: summaryBase.filter(x => x.quoteDetected || x.quoteRequested === true).length,
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
      return res.json({ ok: true, items: messages.map(m => ({
        _id: String(m._id), role: m.role, type: m.type, content: m.content, createdAt: m.ts || m.createdAt, media: mediaDescriptor(m),
      })) });
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
      const convs = await db.collection('conversations').find({
        tenantId: tenant,
        botMode: 'conversacional',
        waId: current.waId,
        _id: { $ne: current._id },
      }).sort({ updatedAt: -1 }).limit(30).toArray();
      const ids = convs.map(c => c._id);
      const followups = ids.length ? await db.collection(FOLLOWUP_COLLECTION).find({ tenantId: tenant, conversationId: { $in: ids } }).toArray() : [];
      const leads = ids.length ? await db.collection('leads').find({ tenantId: tenant, conversationId: { $in: ids } }).toArray() : [];
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
      const bundle = await loadConversationBundle(db, tenant, id);
      if (!bundle) return res.status(404).json({ ok: false, error: 'not_found' });
      return res.json({ ok: true, item: bundle.item, config: bundle.config });
    } catch (e) {
      console.error('[followup] get:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
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
      let nextContactAt = pendingContact ? safeDate(body.nextContactAt) : null;
      const workflowStatus = normalizeWorkflowStatus(body.workflowStatus);
      const set = {
        tenantId: tenant,
        conversationId: oid,
        waId: String(conv.waId || ''),
        workflowStatus,
        category: normalizeCategory(body.category),
        satisfaction: normalizeSatisfaction(body.satisfaction),
        quoteRequested: normalizeQuoteRequested(body.quoteRequested),
        pendingContact,
        nextContactAt,
        priority: normalizePriority(body.priority),
        assignedTo: cleanString(body.assignedTo, 120),
        summary: cleanString(body.summary, 3000),
        notes: cleanString(body.notes, 5000),
        tags: normalizeTags(body.tags),
        updatedAt: now,
        updatedBy: cleanString(req?.user?.username || req?.user?.uid || 'operator', 120),
      };
      if (!pendingContact) set.nextContactAt = null;
      const existing = await db.collection(FOLLOWUP_COLLECTION).findOne({ tenantId: tenant, conversationId: oid }, { projection: { _id: 1, classifiedAt: 1 } });
      if (!existing?.classifiedAt) {
        set.classifiedAt = now;
        set.classifiedBy = cleanString(req?.user?.username || req?.user?.uid || 'operator', 120);
      }
      await db.collection(FOLLOWUP_COLLECTION).updateOne(
        { tenantId: tenant, conversationId: oid },
        { $set: set, $setOnInsert: { createdAt: now } },
        { upsert: true }
      );
      // Sólo espejo flags de lectura rápida. No tocamos updatedAt de la conversación para no alterar la inactividad.
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
      const now = new Date();
      const r = await db.collection('conversations').updateOne(
        { _id: new ObjectId(id), tenantId: tenant, botMode: 'conversacional' },
        { $set: { finalized: true, status: 'CLOSED_MANUAL', closedAt: now, closeReason: 'operator', followupReviewPending: true } }
      );
      if (!r.matchedCount) return res.status(404).json({ ok: false, error: 'not_found' });
      return res.json({ ok: true });
    } catch (e) {
      console.error('[followup] close:', e);
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  });
}

module.exports = { mountConversationFollowupPanel, runAutoCloseSweep };
