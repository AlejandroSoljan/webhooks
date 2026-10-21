// Asisto | Private dashboard and authenticated hybrid read-only statistics | 2026-10-21
const { getProductInsights, buildProductInsights } = require('./product_insights');
function mountProductInsights(app, { scope, wrap, allowed, dayKey }) {
  app.get('/api/customer-app-admin/:tenant/product-stats', wrap(async (req, res) => {
    const { t, db } = await scope(req);
    if (!allowed(req, t)) return res.status(req.user?.uid ? 403 : 401).json({ error:'Iniciá sesión en Asisto para consultar el análisis comercial.' });
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
module.exports = { mountProductInsights, handleProductStatsSync };
