// Asisto | Turnero AWS | Fecha: 2026-09-14
const { ObjectId } = require('mongodb');
const { createHmac, timingSafeEqual, randomBytes, createHash } = require('node:crypto');
const QRCode = require('qrcode');
const { queuePage } = require('./queue_pages');
const { createQueueNotifications } = require('./queue_notifications');
const { mountQueueStats } = require('./queue_stats');
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
    sectorId: doc.sectorId, sectorName: doc.sectorName, desk: doc.desk || '', calledAt: doc.calledAt || null, claimed: !!doc.claimedAt };
}
function mountQueue(app, { getDb, configFor, invalidateConfig = () => {}, dayKey, firebaseSender, auth, secret = process.env.QUEUE_PRESENCE_SECRET || '', publicBase = process.env.PUBLIC_BASE_URL || 'https://asistobot.com.ar', openTenants = (process.env.QUEUE_OPEN_TENANTS || '').split(',').map(tenant).filter(Boolean) }) {
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
  const isOpen = t => openTenants.includes(t);
  const guard = (req, t) => { if (!isOpen(t) && !allowed(req, t)) fail(req.user?.uid ? 403 : 401, 'Iniciá sesión con un usuario del comercio.'); };
  const { reconcile } = createQueueNotifications({ firebaseSender, publicBase });
  const reconcileBase = (db, base) => serial(base.tenantId, () => reconcile(db, base));
  const reconcileTenant = async t => { const db = await getDb(), cfg = await configFor(db, t); return reconcileBase(db, { tenantId: t, branchId: cfg.branchId, dayKey: dayKey() }); };
  mountQueueStats(app, { scope, wrap, allowed, dayKey, auth });
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
  const claimCode = doc => createHmac('sha256', secret).update(['ticket', doc.tenantId, String(doc._id), +doc.reservationExpiresAt].join(':')).digest('base64url');
  const hash = value => createHash('sha256').update(String(value || '')).digest('hex');
  const owns = (doc, id) => !!id && (doc.installId === id || (doc.linkedInstallIds || []).includes(id));
  const validCode = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  async function expire(db, base) { await db.collection('queue_tickets').updateMany({ ...base, status: 'RESERVED', reservationExpiresAt: { $lte: new Date() } }, { $set: { status: 'CANCELLED', updatedAt: new Date() } }); }
  async function delivery(doc) {
    const url = new URL('/customer-app/' + encodeURIComponent(doc.tenantId), publicBase);
    url.searchParams.set('claim', String(doc._id)); url.hash = 'code=' + claimCode(doc);
    return { claimUrl: url.href, claimQr: await QRCode.toDataURL(url.href, { width: 440, margin: 4, errorCorrectionLevel: 'M' }), reservationExpiresAt: doc.reservationExpiresAt };
  }
  async function view(db, doc) {
    const ahead = doc.status === 'WAITING' ? await db.collection('queue_tickets').countDocuments({
      tenantId: doc.tenantId, branchId: doc.branchId, dayKey: doc.dayKey, sectorId: doc.sectorId, status: { $in: active },
      $or: [{ status: 'CALLED' }, { queuedAt: { $lt: doc.queuedAt } }, { queuedAt: doc.queuedAt, _id: { $lt: doc._id } }],
    }) : 0;
    const current = await db.collection('queue_tickets').findOne({ tenantId: doc.tenantId, branchId: doc.branchId, dayKey: doc.dayKey, sectorId: doc.sectorId, status: 'CALLED' });
    return { ...publicTicket(doc), peopleAhead: ahead, estimatedMinutes: ahead * 5, currentDisplay: current?.displayNumber || '—', createdAt: doc.createdAt };
  }
  for (const mode of ['kiosk', 'display']) app.get('/customer-app/:tenant/' + mode, wrap(async (req, res) => {
    const t = tenant(req.params.tenant);
    if (mode === 'kiosk' && !isOpen(t) && !allowed(req, t)) return res.redirect('/login?to=' + encodeURIComponent(req.originalUrl));
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
    if (!isOpen(t) && !['admin', 'superadmin'].includes(req.user?.role)) fail(403, 'Solo un administrador puede cambiar la configuración.');
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
    await expire(db, base);
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
    const reserve = kiosk && req.body?.delivery === 'qr_or_print';
    if (reserve && !secret) fail(503, 'Falta configurar la vinculación del turno.');
    await prepare(db);
    await expire(db, base);
    const doc = await serial(t, async () => {
      const tickets = db.collection('queue_tickets');
      // Retries can retrieve the same ticket even after its QR has expired.
      const existing = await tickets.findOne({ ...base, ...(kiosk ? { kioskRequestId: installId } : { $or: [{ installId }, { linkedInstallIds: installId }], status: { $in: active } }) });
      const legacy = kiosk && !existing ? await tickets.findOne({ ...base, installId, source: 'kiosk' }) : null;
      if (existing) return existing;
      if (legacy) return legacy;
      if (!kiosk && cfg.queuePresence === 'qr' && !validPresence(req.body?.presence, t, secret)) fail(403, 'Escaneá el QR de la pantalla del local para sacar tu turno.');
      const counter = await db.collection('queue_counters').findOneAndUpdate({ _id: [t, base.dayKey, base.branchId, sectorId].join(':') }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: 'after' });
      const now = new Date(), doc = { ...base, sectorId, sectorName: sector.name, prefix: sector.prefix, number: counter.sequence, displayNumber: sector.prefix + String(counter.sequence).padStart(3, '0'), installId, status: 'WAITING', createdAt: now, queuedAt: now, updatedAt: now, source: kiosk ? 'kiosk' : 'mobile', history: [{ action: 'created', sectorId, at: now }] };
      if (kiosk) doc.kioskRequestId = installId;
      if (reserve) Object.assign(doc, { status: 'RESERVED', reservationExpiresAt: new Date(+now + 180000), deliveryMode: 'pending' });
      doc._id = (await tickets.insertOne(doc)).insertedId;
      return doc;
    });
    await reconcileBase(db, base);
    res.json({ ...await view(db, doc), ...(reserve && doc.status === 'RESERVED' ? await delivery(doc) : {}) });
  }));
  app.get('/api/customer-app-admin/:tenant/tickets/:id/delivery', wrap(async (req, res) => {
    const { t, db, base } = await scope(req); guard(req, t); await expire(db, base);
    if (!ObjectId.isValid(req.params.id)) fail(404, 'Turno inexistente');
    const doc = await db.collection('queue_tickets').findOne({ ...base, _id: new ObjectId(req.params.id) });
    if (!doc) fail(404, 'Turno inexistente');
    res.json({ status: doc.status, claimed: !!doc.claimedAt, deliveryMode: doc.deliveryMode || '' });
  }));
  app.post('/api/customer-app-admin/:tenant/tickets/:id/cancel', wrap(async (req, res) => {
    const { t, db, base } = await scope(req); guard(req, t);
    if (!ObjectId.isValid(req.params.id)) fail(404, 'Turno inexistente');
    const doc = await serial(t, async () => {
      await expire(db, base);
      const tickets = db.collection('queue_tickets'), current = await tickets.findOne({ ...base, _id: new ObjectId(req.params.id) });
      if (!current) fail(404, 'Turno inexistente');
      if (current.status !== 'RESERVED') return current;
      const now = new Date();
      return tickets.findOneAndUpdate({ _id: current._id, status: 'RESERVED' }, { $set: { status: 'CANCELLED', deliveryMode: 'dismissed', updatedAt: now }, $push: { history: { action: 'kiosk_closed', at: now } } }, { returnDocument: 'after' });
    });
    res.json({ ok: true, cancelled: doc.status === 'CANCELLED' && doc.deliveryMode === 'dismissed', status: doc.status });
  }));
  app.post('/api/customer-app-admin/:tenant/tickets/:id/print', wrap(async (req, res) => {
    const { t, db, cfg, base } = await scope(req); guard(req, t);
    if (!ObjectId.isValid(req.params.id)) fail(404, 'Turno inexistente');
    const doc = await serial(t, async () => {
      await expire(db, base);
      const tickets = db.collection('queue_tickets'), doc = await tickets.findOne({ ...base, _id: new ObjectId(req.params.id) });
      if (!doc) fail(404, 'Turno inexistente');
      if (doc.status === 'CANCELLED') fail(410, 'La reserva venció. Elegí nuevamente la sección.');
      if (doc.deliveryMode === 'print') return doc;
      if (doc.status !== 'RESERVED' || doc.claimedAt) fail(409, 'Este turno ya fue entregado al celular.');
      return tickets.findOneAndUpdate({ _id: doc._id, status: 'RESERVED' }, { $set: { status: 'WAITING', queuedAt: new Date(), deliveryMode: 'print', updatedAt: new Date() }, $push: { history: { action: 'print_requested', at: new Date() } } }, { returnDocument: 'after' });
    });
    await reconcileBase(db, base);
    res.json({ ...publicTicket(doc), businessName: cfg.businessName, createdAt: doc.createdAt });
  }));
  app.post('/api/customer-app/:tenant/tickets/:id/claim', wrap(async (req, res) => {
    const { t, db, base } = await scope(req), installId = clean(req.body?.installId), code = clean(req.body?.code, 200);
    if (!installId || !ObjectId.isValid(req.params.id)) fail(400, 'Vinculación inválida.');
    const doc = await serial(t, async () => {
      await expire(db, base);
      const tickets = db.collection('queue_tickets'), doc = await tickets.findOne({ ...base, _id: new ObjectId(req.params.id) });
      if (!doc?.reservationExpiresAt) fail(404, 'Turno inexistente');
      const original = secret && validCode(code, claimCode(doc));
      const handoff = !!doc.handoffHash && hash(code) === doc.handoffHash && +doc.handoffExpiresAt > Date.now();
      if (doc.usedHandoffHash === hash(code) && doc.usedHandoffInstallId === installId && +doc.usedHandoffExpiresAt > Date.now()) return doc;
      if (!original && !handoff) fail(403, 'El QR no es válido.');
      if (doc.claimedAt && owns(doc, installId)) return doc;
      if (doc.claimedAt && !handoff) fail(409, 'Este turno ya está asociado a otro celular.');
      if (!handoff && +doc.reservationExpiresAt <= Date.now()) fail(410, 'El QR venció. Volvé al turnero.');
      if (!['RESERVED', 'WAITING', 'CALLED'].includes(doc.status)) fail(410, 'El turno ya no está disponible.');
      const updated = { installId, claimedAt: doc.claimedAt || new Date(), deliveryMode: 'mobile', updatedAt: new Date(), ...(doc.status === 'RESERVED' ? { status: 'WAITING', queuedAt: new Date() } : {}) };
      if (handoff) Object.assign(updated, { usedHandoffHash: doc.handoffHash, usedHandoffInstallId: installId, usedHandoffExpiresAt: doc.handoffExpiresAt });
      return tickets.findOneAndUpdate({ _id: doc._id }, { $set: updated, $unset: { handoffHash: '', handoffExpiresAt: '' }, ...(handoff ? { $addToSet: { linkedInstallIds: doc.installId } } : {}), $push: { history: { action: handoff ? 'linked_app' : 'claimed', at: new Date() } } }, { returnDocument: 'after' });
    });
    await reconcileBase(db, base);
    res.json(await view(db, doc));
  }));
  app.post('/api/customer-app/:tenant/tickets/:id/handoff', wrap(async (req, res) => {
    const { t, db, base } = await scope(req), installId = clean(req.body?.installId);
    if (!ObjectId.isValid(req.params.id)) fail(404, 'Turno inexistente');
    const code = randomBytes(32).toString('base64url');
    await serial(t, async () => {
      const tickets = db.collection('queue_tickets'), doc = await tickets.findOne({ ...base, _id: new ObjectId(req.params.id) });
      if (!doc?.claimedAt || !owns(doc, installId)) fail(403, 'No autorizado para este turno.');
      if (!active.includes(doc.status)) fail(410, 'El turno finalizó.');
      await tickets.updateOne({ _id: doc._id }, { $set: { handoffHash: hash(code), handoffExpiresAt: new Date(Date.now() + 180000) } });
    });
    res.json({ code });
  }));
  app.get('/api/customer-app/:tenant/tickets/:id', wrap(async (req, res) => {
    const { t, db } = await scope(req);
    if (!ObjectId.isValid(req.params.id)) fail(404, 'Turno inexistente');
    await prepare(db);
    const installId = clean(req.query.installId);
    const doc = installId && await db.collection('queue_tickets').findOne({ _id: new ObjectId(req.params.id), tenantId: t, $or: [{ installId }, { linkedInstallIds: installId }] });
    if (!doc) fail(404, 'Turno inexistente');
    res.json(await view(db, doc));
  }));
  app.post('/api/customer-app/:tenant/tickets/:id/cancel', wrap(async (req, res) => {
    const { t, db, base } = await scope(req), installId = clean(req.body?.installId);
    if (!installId || !ObjectId.isValid(req.params.id)) fail(400, 'Cancelación inválida.');
    const doc = await serial(t, async () => {
      const tickets = db.collection('queue_tickets');
      const current = await tickets.findOne({ ...base, _id: new ObjectId(req.params.id) });
      if (!current || !owns(current, installId)) fail(404, 'Turno inexistente');
      if (current.status === 'CANCELLED' && current.history?.some(h => h.action === 'customer_cancelled')) return current;
      if (!active.includes(current.status)) fail(409, 'Este turno ya finalizó y no se puede cancelar.');
      const now = new Date();
      return tickets.findOneAndUpdate({ _id: current._id, status: { $in: active } }, { $set: { status: 'CANCELLED', updatedAt: now }, $push: { history: { action: 'customer_cancelled', at: now, sectorId: current.sectorId } } }, { returnDocument: 'after' });
    });
    await reconcileBase(db, base);
    res.json({ ...await view(db, doc), cancelled: true });
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
      const now = new Date(), who = clean(req.user?.username || req.user?.uid || 'operador-sin-login');
      if (action === 'next') {
        if (current) fail(409, 'Finalizá o trasladá el turno actual antes de llamar al siguiente.');
        const doc = await tickets.findOneAndUpdate({ ...filter, status: 'WAITING' }, { $set: { status: 'CALLED', desk: clean(req.body?.desk, 40), calledAt: now, updatedAt: now }, $push: { history: { action, at: now, who, sectorId, desk: clean(req.body?.desk, 40) } } }, { sort: order, returnDocument: 'after' });
        return { doc, notification: !!doc };
      }
      if (!current) fail(409, 'No hay un turno en atención.');
      const values = { updatedAt: now };
      if (action === 'recall') values.calledAt = now;
      if (action === 'finish' || action === 'skip') values.status = action === 'finish' ? 'DONE' : 'SKIPPED';
      if (action === 'transfer') Object.assign(values, { status: 'WAITING', sectorId: destination.id, sectorName: destination.name, desk: '', calledAt: null, queuedAt: now });
      const doc = await tickets.findOneAndUpdate({ _id: current._id, status: 'CALLED' }, { $set: values, $push: { history: { action, at: now, who, sectorId, desk: current.desk || '', ...(destination ? { destination: destination.id } : {}) } } }, { returnDocument: 'after' });
      return { doc, notification: action === 'recall' };
    });
    const notification = await reconcileBase(db, base) ? 'sent' : 'not_required';
    res.json({ ok: true, ticket: result.doc ? publicTicket(result.doc) : null, notification });
  }));
  return { reconcileTenant };
}
module.exports = { mountQueue, presenceToken, validPresence, serial };
