// Asisto | Private dashboard and authenticated hybrid read-only statistics | 2026-10-21
const { getProductInsights, buildProductInsights } = require('./product_insights');
function trustedLocalRequest(req) {
  let address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (address === '127.0.0.1' || address === '::1') address = String(req.get?.('x-real-ip') || address).replace(/^::ffff:/, '');
  return address === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(address) || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address);
}
function mountProductInsights(app, { scope, wrap, allowed, dayKey, isOpen = () => false }) {
  app.get('/api/customer-app-admin/:tenant/product-stats', wrap(async (req, res) => {
    const { t, db } = await scope(req);
    const localAccess = process.env.QUEUE_LOCAL_NETWORK_ACCESS === '1' && isOpen(t) && trustedLocalRequest(req);
    if (!allowed(req, t) && !localAccess) return res.status(req.user?.uid ? 403 : 401).json({ error:'Iniciá sesión en Asisto para consultar el análisis comercial.' });
    res.setHeader('Cache-Control','no-store');
    try { return res.json(await getProductInsights(db, t, String(req.query.from || dayKey()), String(req.query.to || dayKey()))); }
    catch (error) { return res.status(error.statusCode || 503).json({ error:error.statusCode === 400 ? error.message : 'No se pudo consultar el análisis comercial. Los turnos siguen disponibles.' }); }
  }));
}
async function handleProductStatsSync(req, res, { getDb }) {
  if (req.body?.mode !== 'product_stats') return false;
  try {
    if (process.env.QUEUE_LOCAL_NETWORK_ACCESS === '1') { res.status(503).json({ ok:false,error:'central_only' }); return true; }
    const db = await getDb();
    const result = await buildProductInsights(db, String(req.body.tenantId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,60), String(req.body.from || ''), String(req.body.to || ''));
    res.set('Cache-Control','no-store'); res.json(result);
  } catch (error) { res.status(error.statusCode || 503).json({ ok:false,error:error.statusCode === 400 ? error.message : 'product_stats_unavailable' }); }
  return true;
}
module.exports = { mountProductInsights, handleProductStatsSync, trustedLocalRequest };
