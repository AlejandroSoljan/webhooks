// Asisto | Turnero AWS | Fecha: 2026-09-14
// Dedicated single-writer service, using the existing Asisto session and database.
const express = require('express');
const auth = require('./auth_ui');
const { getDb, closeDb } = require('./db');
const { mountCustomerApp } = require('./customer_app_web');
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); next(); });
app.use(auth.attachUser);
const queue = mountCustomerApp(app, { auth });
let reconciling = false;
const notifications = setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const db = await getDb();
    const tenants = await db.collection('queue_tickets').aggregate([{ $match: { dayKey: require('./customer_app_web').dayKey(), status: { $in: ['WAITING', 'CALLED'] } } }, { $group: { _id: '$tenantId' } }]).toArray();
    for (const tenant of tenants) await queue.reconcileTenant(tenant._id);
  } catch (e) { console.error('[queue] notification sweep:', e.message); }
  finally { reconciling = false; }
}, 15000);
notifications.unref();
app.get('/healthz', async (_req, res) => {
  try { await (await getDb()).command({ ping: 1 }); res.json({ ok: true, service: 'turnero' }); }
  catch { res.status(503).json({ ok: false }); }
});
const server = app.listen(Number(process.env.QUEUE_PORT || 3102), '127.0.0.1');
process.on('SIGTERM', () => { server.close(async () => { if (closeDb) await closeDb(); process.exit(0); }); setTimeout(() => process.exit(1), 15000).unref(); });
