// Asisto | Version: 5.00.172 | Fecha: 2026-09-19
// Read-only operational overview. No configuration writes or message sends.
const { effectiveSessionState } = require('./wweb_phone_access');

function argentinaDay(now = new Date()) {
  const day = new Date(+now - 3 * 3600000).toISOString().slice(0, 10);
  const start = new Date(day + 'T00:00:00-03:00');
  return { day, start, end: new Date(+start + 86400000) };
}

function dashboardScope(user, requested) {
  if (!user?.uid) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (user.role !== 'superadmin') return String(user.tenantId || 'default');
  const tenant = typeof requested === 'string' ? requested.trim() : '';
  if (tenant.length > 120) throw Object.assign(new Error('invalid_tenant'), { status: 400 });
  return tenant;
}

function dashboardRange(period = 'today', now = new Date()) {
  if (!['today', 'yesterday', '7d'].includes(period)) throw Object.assign(new Error('invalid_period'), { status: 400 });
  const current = argentinaDay(now);
  const start = new Date(+current.start - (period === '7d' ? 6 : period === 'yesterday' ? 1 : 0) * 86400000);
  const end = period === 'yesterday' ? current.start : current.end;
  return { ...current, start, end, period, fromDay: argentinaDay(start).day, toDay: argentinaDay(new Date(+end - 1)).day };
}

function sessionRow(lock, policy, channel, now) {
  const state = effectiveSessionState(lock, policy, +now);
  const version = String(lock.runtimeVersion || lock.currentVersion || '');
  const target = String(lock.desiredTag || lock.targetTag || '');
  const clean = value => value.replace(/^v/, '');
  return {
    tenantId: String(lock.tenantId || ''), channel,
    number: String(lock.numero || ''), state,
    lastSeenAt: lock.lastSeenAt || lock.updatedAt || null,
    version, target,
    versionMismatch: !!version && !!target && clean(version) !== clean(target),
  };
}

async function loadDashboard(db, { user, tenant, access, messagePipeline, now = new Date(), period = 'today' }) {
  const { day, start, end, fromDay, toDay } = dashboardRange(period, now);
  const filter = tenant ? { tenantId: tenant } : {};
  const today = { $gte: start, $lt: end };
  const metrics = [], sessions = [], unavailable = [];
  const jobs = [];
  let activity = null;
  let sessionsTruncated = false;
  const opts = { maxTimeMS: 1800 };
  const count = (collection, query) => db.collection(collection).countDocuments(query, opts);
  const aggregate = (collection, pipeline, maxTimeMS = opts.maxTimeMS) => db.collection(collection).aggregate(pipeline, { maxTimeMS }).toArray();
  const run = (key, fn) => jobs.push(async () => {
    try { await fn(); } catch { unavailable.push(key); }
  });
  const metric = (key, label, detail, href, fn) => run(key, async () => {
    metrics.push({ key, label, detail, href, value: await fn() });
  });
  const scopedLink = path => path + (tenant ? '?tenant=' + encodeURIComponent(tenant) + '&tenantId=' + encodeURIComponent(tenant) : '');
  if (access.includes('wweb')) {
    run('whatsapp', async () => {
      const projection = { tenantId: 1, numero: 1, state: 1, lastSeenAt: 1, updatedAt: 1, runtimeVersion: 1, currentVersion: 1, desiredTag: 1, targetTag: 1 };
      const [locks, policies] = await Promise.all([
        db.collection('wa_locks').find(filter, { projection, ...opts }).limit(501).toArray(),
        db.collection('wa_wweb_policies').find(filter, { projection: { tenantId: 1, numero: 1, disabled: 1, paused: 1, pausado: 1, blocked: 1, bloqueado: 1, messagesBlocked: 1, mensajes_bloqueados: 1 }, ...opts }).limit(2001).toArray(),
      ]);
      if (policies.length > 2000) throw new Error('policy_limit');
      sessionsTruncated ||= locks.length > 500;
      const policyMap = new Map(policies.map(p => [p.tenantId + ':' + p.numero, p]));
      sessions.push(...locks.slice(0, 500).map(lock => sessionRow(lock, policyMap.get(lock.tenantId + ':' + lock.numero), 'WhatsApp', now)));
    });
    metric('sent', 'WhatsApp enviados', 'Envíos registrados · no solicitudes API. Criterio de deduplicado de Sesiones, no confirmación de entrega.', '/admin/wweb', async () => {
      const rows = await aggregate('wa_wweb_message_log', [
        ...messagePipeline({ ...filter, direction: { $in: ['out', 'in'] }, at: today }),
        { $group: { _id: { bucket: { $dateToString: { date: '$at', timezone: 'America/Argentina/Buenos_Aires', format: period === '7d' ? '%Y-%m-%d' : '%H' } }, direction: '$direction' }, n: { $sum: 1 } } },
      ], period === '7d' ? 5000 : opts.maxTimeMS);
      const totals = new Map(rows.map(r => [r._id.bucket + ':' + r._id.direction, r.n]));
      activity = Array.from({ length: period === '7d' ? 7 : 24 }, (_, i) => {
        const bucket = period === '7d' ? argentinaDay(new Date(+start + i * 86400000)).day : String(i).padStart(2, '0');
        return { label: period === '7d' ? bucket.slice(8) + '/' + bucket.slice(5, 7) : bucket, sent: totals.get(bucket + ':out') || 0, received: totals.get(bucket + ':in') || 0 };
      });
      return activity.reduce((sum, row) => sum + row.sent, 0);
    });
    metric('confirmationErrors', 'Fallos de confirmación hoy', 'Errores registrados al solicitar autorización para enviar mensajes.', '/admin/wweb', async () => {
      const rows = await aggregate('wa_api_mensajes_confirmaciones', [
        { $match: { ...(tenant ? { tenantId: tenant.toUpperCase() } : {}), solicitudDayKey: { $gte: fromDay, $lte: toDay } } },
        { $group: { _id: null, n: { $sum: { $cond: [{ $eq: ['$tipoDocumento', 'metrica'] }, { $ifNull: ['$contadores.fallos', 0] }, { $cond: [{ $regexMatch: { input: { $ifNull: ['$motivoCancelacion', ''] }, regex: 'error' } }, 1, 0] }] } } } },
      ]);
      return rows[0]?.n || 0;
    });
  }
  if (access.includes('telegram')) run('telegram', async () => {
    const [locks, policies] = await Promise.all([
      db.collection('tg_locks').find(filter, { projection: { tenantId: 1, numero: 1, state: 1, lastSeenAt: 1 }, ...opts }).limit(501).toArray(),
      db.collection('tg_bot_policies').find(filter, { projection: { tenantId: 1, numero: 1, disabled: 1, paused: 1 }, ...opts }).limit(2001).toArray(),
    ]);
    if (policies.length > 2000) throw new Error('policy_limit');
    sessionsTruncated ||= locks.length > 500;
    const policyMap = new Map(policies.map(p => [p.tenantId + ':' + p.numero, p]));
    sessions.push(...locks.slice(0, 500).map(lock => sessionRow(lock, policyMap.get(lock.tenantId + ':' + lock.numero), 'Telegram', now)));
  });
  if (access.includes('followup')) {
    metric('review', 'Conversaciones por revisar', 'Acumulado marcado como pendiente de revisión en Seguimiento; no equivale a mensajes sin leer.', scopedLink('/ui/followup'), () => count('conversations', { ...filter, botMode: 'conversacional', followupReviewPending: true }));
    metric('contacts', 'Contactos pendientes', 'Acumulado con “volver a contactar” y sin estado resuelto o descartado.', scopedLink('/ui/followup'), () => count('conversation_followups', { ...filter, pendingContact: true, workflowStatus: { $nin: ['resolved', 'discarded'] } }));
  }
  if (access.includes('admin')) metric('orders', 'Pedidos registrados hoy', 'Pedidos definitivos con estado COMPLETED y fecha de creación de hoy.', scopedLink('/ui/admin'), () => count('orders', { ...filter, createdAt: today, $or: [{ status: 'COMPLETED' }, { estado: 'COMPLETED' }] }));
  if (access.includes('leads')) metric('leads', 'Leads nuevos hoy', tenant ? 'Leads asignados a este dominio. No incluye formularios generales sin dominio.' : 'Incluye formularios generales de Asisto sin dominio asignado.', '/admin/leads', () => count('leads', { ...filter, createdAt: today }));
  if (access.includes('token_control')) metric('tokens', 'Tokens IA de hoy', 'Suma de totalTokens registrados. El costo se consulta en Consumos y facturación.', scopedLink('/ui/token_control'), async () => {
    const rows = await aggregate('ai_token_usage_log', [{ $match: { ...filter, createdAt: today } }, { $group: { _id: null, n: { $sum: { $ifNull: ['$totalTokens', 0] } } } }]);
    return rows[0]?.n || 0;
  });
  if (access.includes('support')) metric('tasks', 'Mis tareas pendientes', 'Tareas de tu usuario por revisar o guardar; no incluye tareas privadas de otros usuarios.', '/admin/wweb', () => count('support_drafts', { ...filter, userId: String(user.uid), state: { $nin: ['merged', 'ignored'] }, $or: [{ 'hubspot.state': { $ne: 'saved' } }, { 'hubspot.pendingFollowup': true }, { sourceChanged: true }, { reconciliationRequired: true }] }));
  // Bound concurrent Mongo work even when every feature is authorized.
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
    while (index < jobs.length) await jobs[index++]();
  }));
  sessions.sort((a, b) => (a.state === 'online') - (b.state === 'online') || a.tenantId.localeCompare(b.tenantId));
  if (period !== 'today') for (const metric of metrics) {
    metric.label = metric.label.replace(/hoy/g, 'del período');
    metric.detail = metric.detail.replace(/de hoy/g, 'del período seleccionado');
  }
  return { tenant, day, period, fromDay, toDay, generatedAt: now.toISOString(), metrics, activity, sessions, sessionsTruncated, unavailable, access };
}

function mountOperationsDashboard(app, { requireAuth, getDb, getAccess, messagePipeline }) {
  const cache = new Map();
  const cached = (key, loader) => {
    const now = Date.now(), old = cache.get(key);
    if (old && old.expires > now) return old.promise;
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    const entry = { expires: now + 20000 };
    entry.promise = Promise.resolve().then(loader).catch(error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
    cache.set(key, entry);
    return entry.promise;
  };
  app.get('/api/operations-dashboard', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const tenant = dashboardScope(req.user, req.query.tenant);
      const access = getAccess(req.user).sort();
      const period = req.query.period || 'today';
      dashboardRange(period);
      const key = JSON.stringify([req.user.uid, req.user.role, tenant, access, argentinaDay().day, period]);
      const data = await cached(key, async () => loadDashboard(await getDb(), { user: req.user, tenant, access, messagePipeline, period }));
      res.json({ ok: true, ...data });
    } catch (error) { res.status(error.status || 503).json({ ok: false, error: 'No se pudo consultar el estado operativo.' }); }
  });
  app.get('/api/operations-dashboard/tenants', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.user.role !== 'superadmin') return res.status(403).json({ ok: false });
    try {
      const rows = await cached('tenants', async () => (await getDb()).collection('tenant_config').find({}, { projection: { _id: 1, nom_emp: 1 }, maxTimeMS: 1800 }).sort({ _id: 1 }).limit(2001).toArray());
      res.json({ ok: true, truncated: rows.length > 2000, tenants: rows.slice(0, 2000).map(row => ({ id: String(row._id), name: String(row.nom_emp || '') })) });
    } catch { res.status(503).json({ ok: false }); }
  });
}

function dashboardHtml(user) {
  return `<section class="opsPanel" id="operationsDashboard" aria-label="Estado operativo">
    <header class="opsHeading"><div><h1>Todo tu negocio, de un vistazo</h1><p>Actividad, conexiones y pendientes en un solo lugar.</p></div>
    <div class="opsControls">${user.role === 'superadmin' ? '<label class="opsSelect"><span class="srOnly">Dominio</span><select id="opsTenant"><option value="">Todos los dominios</option></select></label>' : ''}<label class="opsSelect"><span class="srOnly">Período</span><select id="opsPeriod"><option value="today">Hoy</option><option value="yesterday">Ayer</option><option value="7d">Últimos 7 días</option></select></label><button type="button" id="opsRefresh" aria-label="Actualizar indicadores" title="Actualizar indicadores">↻</button></div></header>
    <div id="opsNotices" role="status" aria-live="polite"></div>
    <div id="opsMetrics" class="opsMetrics" aria-label="Indicadores principales"></div>
    <div class="opsColumns"><section class="opsBox opsActivity"><div class="opsBoxHeading"><h2>Actividad de mensajes</h2><div class="opsChartLegend"><span><i class="mint"></i>Enviados</span><span><i class="blue"></i>Recibidos</span></div></div><div id="opsActivity"></div></section>
    <section class="opsBox"><h2>Estado de conexiones</h2><div id="opsConnectionChart"></div></section></div>
    <div class="opsColumns"><section class="opsBox"><div class="opsBoxHeading"><h2>Necesita tu atención</h2><button class="opsTextButton" id="opsShowAlerts" type="button" hidden>Ver todas</button></div><div id="opsAlerts" class="opsAlerts"></div></section>
    <section class="opsBox"><h2>Pendientes</h2><div id="opsPending"></div></section></div>
    <nav id="opsQuick" class="opsQuick" aria-label="Acciones rápidas"></nav>
    <footer class="opsFooter"><span id="opsStatus" role="status">Consultando indicadores…</span><span>Actualización automática cada 60 s</span></footer>
    <details class="opsExtra"><summary>Ver detalle de conexiones e indicadores</summary><div id="opsSecondary"></div><div id="opsConnections"></div></details>
  </section><script src="/static/operations_dashboard.js?v=5.00.171" defer></script>`;
}

module.exports = { argentinaDay, dashboardRange, dashboardScope, sessionRow, loadDashboard, mountOperationsDashboard, dashboardHtml };
