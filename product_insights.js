// Asisto | Product interest, not sales or unique customers | 2026-10-21
const crypto = require('node:crypto');
const indexes = new WeakMap();
const text = (value, max = 180) => String(value || '').trim().slice(0, max);
const TOPICS = [
  ['alternatives', 'Alternativas y comparaciones', 'similar|alternativ|compar|otro|otra|opcion|opción|barat|econom'],
  ['price_stock', 'Precio y disponibilidad', 'precio|cuesta|vale|stock|disponib|cantidad'],
  ['compatibility', 'Compatibilidad y repuestos', 'compatib|repuesto|bateria|batería|cargador|sirve para'],
  ['technical', 'Uso y características', 'uso|usar|funcion|potencia|medida|caracter|t[eé]cnic|manual|diferencia'],
];
function period(from, to) {
  const valid = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(from) || !valid(to) || from > to || Date.parse(to) - Date.parse(from) > 92 * 86400000) throw Object.assign(new Error('Elegí un período válido de hasta 93 días.'), { statusCode: 400 });
  return { start: new Date(from + 'T00:00:00-03:00'), end: new Date(+new Date(to + 'T00:00:00-03:00') + 86400000) };
}
async function recordLookup(db, event) {
  if (!indexes.has(db)) indexes.set(db, db.collection('qr_product_events').createIndex({ tenantId: 1, kind: 1, at: 1 }).catch(error => { indexes.delete(db); throw error; }));
  await indexes.get(db);
  const tenantId = text(event.tenantId, 60), eventId = text(event.eventId, 180) || crypto.randomUUID();
  const id = crypto.createHash('sha256').update(tenantId + '|' + eventId).digest('hex');
  await db.collection('qr_product_events').updateOne({ _id: id }, { $setOnInsert: {
    tenantId, kind: 'lookup', at: event.at || new Date(),
    via: ['scan', 'sku', 'photo', 'qr'].includes(event.via) ? event.via : 'other',
    outcome: ['available', 'unavailable', 'error'].includes(event.outcome) ? event.outcome : 'error',
    code: text(event.code), sku: text(event.product?.code), description: text(event.product?.description, 300),
  } }, { upsert: true, maxTimeMS: 1000 });
}
function trackLookup(db, event) {
  // Telemetry never blocks a price lookup, bills a customer or sends data to AI.
  void recordLookup(db, event).catch(() => console.warn('[product-insights] lookup telemetry unavailable'));
}
const hour = field => ({ $hour: { date: field, timezone: 'America/Argentina/Buenos_Aires' } });
async function buildProductInsights(db, tenantId, from, to) {
  const { start, end } = period(from, to);
  const first = await db.collection('qr_product_events').findOne({ tenantId, kind: 'lookup' }, { sort: { at: 1 }, projection: { at: 1 } });
  const cutoff = first?.at ? new Date(first.at) : end;
  const legacyEnd = new Date(Math.min(+end, +cutoff));
  const topicExpression = { $cond: [{ $eq: ['$meta.initial', true] }, 'info', { $switch: {
    branches: TOPICS.map(([id, , regex]) => ({ case: { $regexMatch: { input: { $ifNull: ['$content', ''] }, regex, options: 'i' } }, then: id })), default: 'other',
  } }] };
  const [legacy, lookups, questions] = await Promise.all([
    db.collection('monetization_events').aggregate([
      { $match: { tenantId, eventKey: { $in: ['catalog.qr_read', 'catalog.code_lookup'] }, occurredAt: { $gte: start, $lt: legacyEnd } } },
      { $facet: {
        totals: [{ $group: { _id: null, total: { $sum: '$quantity' } } }],
        products: [{ $group: { _id: '$metadata.code', count: { $sum: '$quantity' } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 100 }],
        hours: [{ $group: { _id: hour('$occurredAt'), count: { $sum: '$quantity' } } }],
      } },
    ], { maxTimeMS: 6000 }).toArray(),
    db.collection('qr_product_events').aggregate([
      { $match: { tenantId, kind: 'lookup', at: { $gte: start, $lt: end } } },
      { $facet: {
        totals: [{ $group: { _id: '$outcome', count: { $sum: 1 }, camera: { $sum: { $cond: [{ $eq: ['$via', 'scan'] }, 1, 0] } } } }],
        products: [{ $match: { outcome: 'available' } }, { $group: { _id: '$sku', description: { $first: '$description' }, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 100 }],
        hours: [{ $match: { outcome: 'available' } }, { $group: { _id: hour('$at'), count: { $sum: 1 } } }],
      } },
    ], { maxTimeMS: 6000 }).toArray(),
    db.collection('messages').aggregate([
      { $match: { tenantId, role: 'user', 'meta.from': 'qr_web', $or: [{ ts: { $gte: start, $lt: end } }, { ts: null, createdAt: { $gte: start, $lt: end } }] } },
      { $project: { topic: topicExpression, code: '$meta.qrProductCode', description: '$meta.qrProductDescription' } },
      { $facet: {
        topics: [{ $group: { _id: '$topic', count: { $sum: 1 } } }],
        products: [{ $match: { topic: { $ne: 'info' } } }, { $group: { _id: '$code', description: { $first: '$description' }, questions: { $sum: 1 } } }, { $sort: { questions: -1, _id: 1 } }, { $limit: 100 }],
      } },
    ], { maxTimeMS: 6000 }).toArray(),
  ]);
  const old = legacy[0] || {}, current = lookups[0] || {}, chats = questions[0] || {};
  const codes = (old.products || []).map(p => text(p._id).toUpperCase()).filter(Boolean);
  const aliases = new Map();
  if (codes.length) {
    const catalog = await db.collection('qr_product_catalog').find({ tenantId, $or: [{ Codigo: { $in: codes } }, { CodigoNorm: { $in: codes } }, { Codbarra: { $in: codes } }] }, { projection: { Codigo: 1, CodigoNorm: 1, Codbarra: 1, raw: 1 } }).sort({ fetchedAt: -1 }).limit(2000).toArray();
    for (const row of catalog) for (const key of [row.Codigo, row.CodigoNorm, row.Codbarra].filter(Boolean).map(v=>String(v).toUpperCase())) {
      const value = { code: text(row.Codigo), description: text(row.raw?.Descripcion || row.raw?.descripcion, 300) };
      if (!aliases.has(key)) aliases.set(key, value);
      else if (aliases.get(key)?.code !== value.code) aliases.set(key, null);
    }
  }
  return summarizeProductInsights({ old, current, chats, aliases, from, to, trackingSince: first?.at || null });
}
function summarizeProductInsights({ old = {}, current = {}, chats = {}, aliases = new Map(), from, to, trackingSince = null }) {
  const totals = Object.fromEntries((current.totals || []).map(x => [x._id, Number(x.count) || 0]));
  const legacySuccessful = Number(old.totals?.[0]?.total) || 0;
  const successful = legacySuccessful + (totals.available || 0), attempts = Object.values(totals).reduce((a,b) => a+b, 0);
  const camera = (current.totals || []).reduce((n,x) => n + (Number(x.camera) || 0), 0);
  const topics = Object.fromEntries((chats.topics || []).map(x => [x._id, Number(x.count) || 0]));
  const written = Object.entries(topics).filter(([k]) => k !== 'info').reduce((n,[,v]) => n+v, 0);
  const products = new Map();
  function add(code, description, views = 0, questions = 0) {
    code = String(code || '').toUpperCase();
    if (!code || code === 'CONSULTA_GENERAL') return;
    const p = products.get(code) || { code, description: description || 'Artículo sin descripción registrada', views: 0, questions: 0 };
    if (description) p.description = description;
    p.views += views; p.questions += questions; products.set(code, p);
  }
  for (const p of old.products || []) { const item = aliases.get(text(p._id).toUpperCase()); add(item?.code || text(p._id), item?.description, Number(p.count) || 0); }
  for (const p of current.products || []) add(text(p._id), text(p.description, 300), Number(p.count) || 0);
  for (const p of chats.products || []) add(text(p._id), text(p.description, 300), 0, Number(p.questions) || 0);
  const top = [...products.values()].sort((a,b) => b.views-a.views || b.questions-a.questions || a.code.localeCompare(b.code)).slice(0,5);
  const insights = [];
  if (top[0]?.views && successful) {
    const share = Math.round(top[0].views/successful*100);
    insights.push({ title: share < 15 ? 'El interés está repartido' : 'Dónde se concentra el interés', finding: `${top[0].description} encabeza el ranking de fichas,${share < 15 ? ' pero representa una parte pequeña del total.' : ' con una participación destacada.'}`, evidence: `${top[0].views} consultas; ${share}% de las fichas consultadas con resultado.`, action: share < 15 ? 'Revisar el surtido y la exhibición por familias; no concentrar decisiones en un solo artículo con pocos registros.' : 'Revisar su exhibición y disponibilidad. Este interés no confirma una venta.', tone: 'positive' });
  }
  const dominant = TOPICS.map(([id,label]) => ({ id, label, count: topics[id] || 0 })).sort((a,b) => b.count-a.count)[0];
  if (dominant?.count) insights.push({ title: 'Qué necesitan saber los clientes', finding: `Entre los temas identificados destacan las preguntas sobre ${dominant.label.toLocaleLowerCase('es')}.`, evidence: `${dominant.count} de ${written} preguntas escritas (${Math.round(dominant.count/written*100)}%). ${topics.other || 0} quedaron en otras preguntas. Clasificación orientativa, sin IA.`, action: dominant.id === 'alternatives' ? 'Ofrecer opciones comparables con stock y señalizar sus diferencias.' : dominant.id === 'compatibility' ? 'Mejorar las fichas de compatibilidad, accesorios y repuestos.' : dominant.id === 'price_stock' ? 'Revisar la claridad de precios y disponibilidad en góndola.' : 'Sumar usos y características claras a la ficha y la cartelería.', tone: 'positive' });
  else if (written) insights.push({ title:'Hay dudas que todavía no se pueden clasificar', finding:`Se registraron ${written} preguntas escritas sin un tema identificado por las reglas.`, evidence:'No se analizan con IA ni se exponen sus textos en este panel.', action:'Revisar la claridad de las fichas y ampliar las reglas antes de sacar conclusiones sobre los temas.', tone:'neutral' });
  if (totals.unavailable) insights.push({ title: 'Interés que no encontró una ficha disponible', finding: `${totals.unavailable} consultas terminaron sin stock o sin un código disponible.`, evidence: `${Math.round(totals.unavailable/Math.max(1,attempts)*100)}% de ${attempts} intentos medidos con el registro nuevo. No distingue un código inexistente de falta de stock.`, action: 'Revisar disponibilidad y correspondencia de los códigos; no asumir automáticamente que hay que reponer.', tone: 'warning' });
  if (totals.error) insights.push({ title: 'Hay fricción técnica para consultar productos', finding: `${totals.error} intentos terminaron con un error de consulta.`, evidence: 'Medición del registro nuevo; no se cuentan como falta de stock.', action: 'Revisar conectividad y respuesta del servicio de artículos.', tone: 'warning' });
  if (!insights.length) insights.push({ title: 'Todavía no hay evidencia para una conclusión comercial', finding: 'No se registró suficiente actividad en el período seleccionado.', evidence: 'Podés ampliar el período. La ausencia de registros no demuestra ausencia de interés.', action: 'Promover el escaneo y revisar nuevamente cuando haya consultas.', tone: 'neutral' });
  return { ok: true, from, to, generatedAt: new Date().toISOString(), metrics: { successful, written, infoRequests: topics.info || 0, camera, measuredAttempts: attempts, unavailable: totals.unavailable || 0, errors: totals.error || 0, legacySuccessful }, insights: insights.slice(0,4), topProducts: top, topics: [...TOPICS.map(([id,label]) => ({ id,label,count:topics[id] || 0 })), { id:'other',label:'Otras preguntas',count:topics.other || 0 }].filter(x=>x.count), coverage: { trackingSince, measuredInPeriod:Boolean(trackingSince && to && +new Date(trackingSince)<+new Date(to+'T00:00:00-03:00')+86400000), legacy: legacySuccessful > 0, rankingCandidateLimit: 100, note: 'Interés observado, no ventas ni clientes únicos. Actividad de todo el dominio, sin atribución a una sucursal o vendedor. Las recargas pueden generar nuevas consultas, no se miden escaneos físicos únicos. Antes del registro nuevo no se separaban cámara, búsquedas manuales ni intentos sin resultado. El histórico de fichas depende de eventos comerciales habilitados. Las preguntas se clasifican con reglas, no con IA. Ranking sobre los 100 códigos con más actividad de cada fuente; con pocos registros, las conclusiones son orientativas. Sin textos ni datos personales de clientes.' } };
}
async function getProductInsights(db, tenantId, from, to, env = process.env) {
  period(from, to);
  if (env.QUEUE_LOCAL_NETWORK_ACCESS === '1') {
    if (!env.QUEUE_SYNC_URL || String(env.QUEUE_SYNC_SECRET || '').length < 20) throw new Error('No está configurada la consulta central de productos.');
    const response = await fetch(env.QUEUE_SYNC_URL, { method: 'POST', redirect: 'error', headers: { 'Content-Type':'application/json', 'x-queue-sync-key':env.QUEUE_SYNC_SECRET }, body:JSON.stringify({ mode:'product_stats',tenantId,from,to }), signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('No se pudo consultar el análisis comercial central. Los turnos siguen funcionando.');
    const result = await response.json();
    if (!result.ok) throw new Error('El análisis comercial central no está disponible.');
    return result;
  }
  return buildProductInsights(db, tenantId, from, to);
}
module.exports = { period, trackLookup, recordLookup, buildProductInsights, summarizeProductInsights, getProductInsights };
