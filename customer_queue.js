// Asisto | Turnero AWS | Fecha: 2026-09-14
const { ObjectId } = require('mongodb');
const { createHmac, timingSafeEqual } = require('node:crypto');
const QRCode = require('qrcode');
const { queuePage } = require('./queue_pages');
const clean = (s, n = 120) => String(s || '').trim().slice(0, n);
const tenant = s => clean(s, 60).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
const active = ['WAITING', 'CALLED'];
const locks = new Map();
// This service has one authoritative Node process. All writes share this lock.
async function serial(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  locks.set(key, pending);
  await previous;
  try { return await fn(); } finally { release(); if (locks.get(key) === pending) locks.delete(key); }
}
function allowed(req, t) { return !!req.user?.uid && (req.user.role === 'superadmin' || tenant(req.user.tenantId) === t); }
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function presenceToken(t, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ t, exp: now + 90000 })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
function validPresence(token, t, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 500) return false;
  try {
    const [payload, signature, extra] = token.split('.');
    if (extra) return false;
    const expected = createHmac('sha256', secret).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const value = JSON.parse(Buffer.from(payload, 'base64url'));
    return value.t === t && value.exp > now && value.exp <= now + 90000;
  } catch { return false; }
}
function publicTicket(doc) {
  return { id: String(doc._id), displayNumber: doc.displayNumber, status: doc.status,
    sectorId: doc.sectorId, sectorName: doc.sectorName, desk: doc.desk || '', calledAt: doc.calledAt || null };
}
function mountQueue(app, { getDb, configFor, invalidateConfig = () => {}, dayKey, firebaseSender, secret = process.env.QUEUE_PRESENCE_SECRET || '', publicBase = process.env.PUBLIC_BASE_URL || 'https://asistobot.com.ar' }) {
  const wrap = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); } catch (e) { if (!e.status) console.error('[queue]', e.message); res.status(e.status || 500).json({ error: e.status ? e.message : 'No se pudo completar la operación. Reintentá.' }); }
  };
  const scope = async req => {
    const t = tenant(req.params.tenant);
    if (!t) fail(400, 'Dominio inválido');
    const db = await getDb(), cfg = await configFor(db, t);
    return { t, db, cfg, base: { tenantId: t, branchId: cfg.branchId, dayKey: dayKey() } };
  };
  const guard = (req, t) => { if (!allowed(req, t)) fail(req.user?.uid ? 403 : 401, 'Iniciá sesión con un usuario del comercio.'); };
  let indexPromise;
  async function prepare(db) {
    if (!indexPromise) indexPromise = (async () => {
      await db.collection('queue_tickets').updateMany({ queuedAt: { $exists: false } }, [{ $set: { queuedAt: '$createdAt' } }]);
      await db.collection('queue_tickets').createIndex({ tenantId: 1, branchId: 1, dayKey: 1, sectorId: 1, status: 1, queuedAt: 1, _id: 1 });
      await db.collection('queue_tickets').createIndex({ tenantId: 1, branchId: 1, dayKey: 1, installId: 1, status: 1 });
    })().catch(e => { indexPromise = null; throw e; });
    return indexPromise;
  }
  const order = { queuedAt: 1, _id: 1 };
  async function view(db, doc) {
    const ahead = doc.status === 'WAITING' ? await db.collection('queue_tickets').countDocuments({
      tenantId: doc.tenantId, branchId: doc.branchId, dayKey: doc.dayKey, sectorId: doc.sectorId, status: 'WAITING',
      $or: [{ queuedAt: { $lt: doc.queuedAt } }, { queuedAt: doc.queuedAt, _id: { $lt: doc._id } }],
    }) : 0;
    const current = await db.collection('queue_tickets').findOne({ tenantId: doc.tenantId, branchId: doc.branchId, dayKey: doc.dayKey, sectorId: doc.sectorId, status: 'CALLED' });
    return { ...publicTicket(doc), peopleAhead: ahead, estimatedMinutes: ahead * 5, currentDisplay: current?.displayNumber || '—', createdAt: doc.createdAt };
  }
  async function notify(db, doc) {
    if (!doc) return 'not_required';
    const device = await db.collection('customer_app_devices').findOne({ tenantId: doc.tenantId, installId: doc.installId, disabled: { $ne: true }, pushToken: { $type: 'string' } });
    if (!device) return 'no_device';
    try {
      const send = await firebaseSender();
      await send(device.pushToken, { title: '¡Es tu turno!', body: `${doc.displayNumber} · ${doc.sectorName}${doc.desk ? ' · ' + doc.desk : ''}`, url: publicBase.replace(/\/$/, '') + '/customer-app/' + encodeURIComponent(doc.tenantId) + '?view=ticket', channelId: 'asisto_turns' });
      return 'sent';
    } catch (e) { console.error('[queue] notification failed', e.message); return 'failed'; }
  }
  for (const mode of ['kiosk', 'display']) app.get('/customer-app/:tenant/' + mode, wrap(async (req, res) => {
    const t = tenant(req.params.tenant);
    if (mode === 'kiosk' && !allowed(req, t)) return res.redirect('/login?to=' + encodeURIComponent(req.originalUrl));
    res.type('html').send(queuePage(t, mode));
  }));
  app.get('/ui/turnero/:tenant', wrap(async (req, res) => { const t = tenant(req.params.tenant); guard(req, t); res.type('html').send(queuePage(t, 'admin')); }));
  app.get('/api/customer-app-admin/:tenant/presence', wrap(async (req, res) => {
    const { t, cfg } = await scope(req); guard(req, t);
    if (cfg.queuePresence === 'qr' && !secret) fail(503, 'Falta configurar la validación presencial.');
    const url = new URL('/customer-app/' + encodeURIComponent(t), publicBase);
    url.searchParams.set('view', 'turns');
    if (secret) url.searchParams.set('presence', presenceToken(t, secret));
    res.json({ image: await QRCode.toDataURL(url.href, { width: 320, margin: 3, errorCorrectionLevel: 'M' }), expiresIn: 90 });
  }));
  app.post('/api/customer-app-admin/:tenant/settings', wrap(async (req, res) => {
    const { t, db } = await scope(req); guard(req, t);
    if (!['admin', 'superadmin'].includes(req.user.role)) fail(403, 'Solo un administrador puede cambiar la configuración.');
    if (!['open', 'qr'].includes(req.body?.queuePresence)) fail(400, 'Modo de acceso inválido.');
    if (req.body.queuePresence === 'qr' && !secret) fail(503, 'Falta configurar la validación presencial.');
    await db.collection('customer_app_config').updateOne({ tenantId: t }, { $set: { queuePresence: req.body.queuePresence, queuePromotion: clean(req.body.queuePromotion, 240) } }, { upsert: true });
    invalidateConfig(t);
    res.json({ ok: true });
  }));
  const state = wrap(async (req, res) => {
    const { t, db, cfg, base } = await scope(req);
    if (req.path.startsWith('/api/customer-app-admin/')) guard(req, t);
    await prepare(db);
    const tickets = db.collection('queue_tickets');
    const sectors = await Promise.all(cfg.sectors.map(async s => {
      const filter = { ...base, sectorId: s.id };
      const [current, waiting, next] = await Promise.all([
        tickets.findOne({ ...filter, status: 'CALLED' }), tickets.countDocuments({ ...filter, status: 'WAITING' }),
        tickets.find({ ...filter, status: 'WAITING' }).sort(order).limit(4).toArray(),
      ]);
      return { ...s, waiting, current: current ? publicTicket(current) : null, currentDisplay: current?.displayNumber || '', next: next.map(d => ({ displayNumber: d.displayNumber })) };
    }));
    res.json({ sectors });
  });
  app.get('/api/customer-app/:tenant/queue', state);
  app.get('/api/customer-app-admin/:tenant/state', state);
  app.post('/api/customer-app/:tenant/tickets', wrap(async (req, res) => {
    const { t, db, cfg, base } = await scope(req), installId = clean(req.body?.installId), sectorId = clean(req.body?.sectorId, 40);
    const sector = cfg.sectors.find(s => s.id === sectorId);
    if (!installId || !sector) fail(400, 'Seleccioná una sección válida.');
    const kiosk = req.body?.source === 'kiosk';
    if (kiosk) guard(req, t);
    await prepare(db);
    const doc = await serial(t, async () => {
      const tickets = db.collection('queue_tickets');
      // Retries can retrieve the same ticket even after its QR has expired.
      const existing = await tickets.findOne({ ...base, installId, ...(kiosk ? {} : { status: { $in: active } }) });
      if (existing) return existing;
      if (!kiosk && cfg.queuePresence === 'qr' && !validPresence(req.body?.presence, t, secret)) fail(403, 'Escaneá el QR de la pantalla del local para sacar tu turno.');
      const counter = await db.collection('queue_counters').findOneAndUpdate({ _id: [t, base.dayKey, base.branchId, sectorId].join(':') }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: 'after' });
      const now = new Date(), doc = { ...base, sectorId, sectorName: sector.name, prefix: sector.prefix, number: counter.sequence, displayNumber: sector.prefix + String(counter.sequence).padStart(3, '0'), installId, status: 'WAITING', createdAt: now, queuedAt: now, updatedAt: now, source: kiosk ? 'kiosk' : 'mobile', history: [{ action: 'created', sectorId, at: now }] };
      doc._id = (await tickets.insertOne(doc)).insertedId;
      return doc;
    });
    res.json(await view(db, doc));
  }));
  app.get('/api/customer-app/:tenant/tickets/:id', wrap(async (req, res) => {
    const { t, db } = await scope(req);
    if (!ObjectId.isValid(req.params.id)) fail(404, 'Turno inexistente');
    await prepare(db);
    const doc = await db.collection('queue_tickets').findOne({ _id: new ObjectId(req.params.id), tenantId: t, installId: clean(req.query.installId) });
    if (!doc) fail(404, 'Turno inexistente');
    res.json(await view(db, doc));
  }));
  app.post('/api/customer-app-admin/:tenant/sectors/:sector/:action', wrap(async (req, res) => {
    const { t, db, cfg, base } = await scope(req); guard(req, t); await prepare(db);
    const sectorId = clean(req.params.sector, 40), action = req.params.action;
    if (!cfg.sectors.some(s => s.id === sectorId) || !['next', 'recall', 'finish', 'skip', 'transfer'].includes(action)) fail(400, 'Acción o sección inválida.');
    const destination = cfg.sectors.find(s => s.id === req.body?.destination);
    if (action === 'transfer' && (!destination || destination.id === sectorId)) fail(400, 'Elegí otra sección de destino.');
    const result = await serial(t, async () => {
      const tickets = db.collection('queue_tickets'), filter = { ...base, sectorId }, current = await tickets.findOne({ ...filter, status: 'CALLED' });
      if (req.body?.expectedTicketId !== (current ? String(current._id) : null)) fail(409, 'La atención cambió desde otra pantalla. Revisá el turno y reintentá.');
      const now = new Date(), who = clean(req.user.username || req.user.uid);
      if (action === 'next') {
        if (current) fail(409, 'Finalizá o trasladá el turno actual antes de llamar al siguiente.');
        const doc = await tickets.findOneAndUpdate({ ...filter, status: 'WAITING' }, { $set: { status: 'CALLED', desk: clean(req.body?.desk, 40), calledAt: now, updatedAt: now }, $push: { history: { action, at: now, who, sectorId } } }, { sort: order, returnDocument: 'after' });
        return { doc, notification: !!doc };
      }
      if (!current) fail(409, 'No hay un turno en atención.');
      const values = { updatedAt: now };
      if (action === 'recall') values.calledAt = now;
      if (action === 'finish' || action === 'skip') values.status = action === 'finish' ? 'DONE' : 'SKIPPED';
      if (action === 'transfer') Object.assign(values, { status: 'WAITING', sectorId: destination.id, sectorName: destination.name, desk: '', calledAt: null, queuedAt: now });
      const doc = await tickets.findOneAndUpdate({ _id: current._id, status: 'CALLED' }, { $set: values, $push: { history: { action, at: now, who, sectorId, ...(destination ? { destination: destination.id } : {}) } } }, { returnDocument: 'after' });
      return { doc, notification: action === 'recall' };
    });
    const notification = result.notification ? await notify(db, result.doc) : 'not_required';
    res.json({ ok: true, ticket: result.doc ? publicTicket(result.doc) : null, notification });
  }));
}
module.exports = { mountQueue, presenceToken, validPresence, serial };
