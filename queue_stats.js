const branding = require('./queue_branding');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => value ? +new Date(value) : null;
// Reconstruct each section visit from the persistent event history, including older tickets.
function ticketVisits(doc) {
  const history = doc.history || [];
  const initial = history.find(h => h.action === 'created');
  const activation = history.find(h => ['claimed', 'print_requested'].includes(h.action));
  const customerCancellation = history.find(h => h.action === 'customer_cancelled');
  if (doc.status === 'RESERVED' || (doc.status === 'CANCELLED' && !activation && !customerCancellation)) return [];
  let visit = { sectorId: initial?.sectorId || doc.sectorId, queuedAt: time(activation?.at || doc.createdAt), calledAt: null, endedAt: null, outcome: 'WAITING' };
  const visits = [];
  for (const h of history) {
    if (h.action === 'next') { visit.calledAt ??= time(h.at); visit.outcome = 'CALLED'; }
    if (['finish', 'skip', 'transfer', 'customer_cancelled'].includes(h.action)) {
      visit.endedAt = time(h.at); visit.outcome = h.action; visits.push(visit);
      visit = h.action === 'transfer' ? { sectorId: h.destination, queuedAt: time(h.at), calledAt: null, endedAt: null, outcome: 'WAITING' } : null;
      if (!visit) break;
    }
  }
  if (visit) visits.push(visit);
  return visits.map(v => ({ ...v, waitSeconds: v.calledAt && v.queuedAt ? Math.max(0, (v.calledAt - v.queuedAt) / 1000) : null, serviceSeconds: v.endedAt && v.calledAt ? Math.max(0, (v.endedAt - v.calledAt) / 1000) : null }));
}
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
async function listStatsTenants(db, fallback) {
  const out = new Set(), add = value => { const t = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 60); if (t && t !== 'DEFAULT' && !t.startsWith('__')) out.add(t); };
  add(fallback);
  const results = await Promise.allSettled([
    db.collection('tenant_config').find({}, { projection: { _id: 1, tenantId: 1, tenantid: 1 } }).limit(3000).toArray(),
    db.collection('customer_app_config').find({}, { projection: { tenantId: 1 } }).limit(3000).toArray(),
    db.collection('users').aggregate([{ $match: { tenantId: { $type: 'string' } } }, { $group: { _id: '$tenantId' } }]).toArray(),
    db.collection('queue_tickets').aggregate([{ $match: { tenantId: { $type: 'string' } } }, { $group: { _id: '$tenantId' } }]).toArray(),
  ]);
  for (const result of results) if (result.status === 'fulfilled') for (const doc of result.value) { add(doc._id); add(doc.tenantId); add(doc.tenantid); }
  return [...out].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true }));
}
function summarize(rows, sectors) {
  const hasAction = (doc, action) => (doc.history || []).some(h => h.action === action);
  const visits = rows.flatMap(doc => ticketVisits(doc).map(v => ({ ...v, day: doc.dayKey })));
  const waits = visits.map(v => v.waitSeconds).filter(v => v !== null).sort((a, b) => a - b);
  const services = visits.map(v => v.serviceSeconds).filter(v => v !== null);
  const groups = new Map();
  for (const s of sectors) groups.set(s.id, { sectorId: s.id, name: s.name, visits: 0, finished: 0, skipped: 0, transfers: 0, waits: [], services: [] });
  for (const v of visits) {
    if (!groups.has(v.sectorId)) groups.set(v.sectorId, { sectorId: v.sectorId, name: v.sectorId, visits: 0, finished: 0, skipped: 0, transfers: 0, waits: [], services: [] });
    const g = groups.get(v.sectorId); g.visits++;
    g.finished += Number(v.outcome === 'finish'); g.skipped += Number(v.outcome === 'skip'); g.transfers += Number(v.outcome === 'transfer');
    if (v.waitSeconds !== null) g.waits.push(v.waitSeconds);
    if (v.serviceSeconds !== null) g.services.push(v.serviceSeconds);
  }
  const days = new Map();
  for (const d of rows) { if (!days.has(d.dayKey)) days.set(d.dayKey, { day: d.dayKey, issued: 0, finished: 0, expired: 0 }); const g = days.get(d.dayKey); g.issued++; g.finished += Number(d.status === 'DONE'); g.expired += Number(d.status === 'CANCELLED' && !hasAction(d, 'customer_cancelled') && !hasAction(d, 'kiosk_closed')); }
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, issued: 0 }));
  for (const d of rows) if (d.createdAt) hours[Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hourCycle: 'h23' }).format(d.createdAt))].issued++;
  return {
    summary: { issued: rows.length, activated: rows.filter(d => ticketVisits(d).length).length, finished: rows.filter(d => d.status === 'DONE').length, skipped: rows.filter(d => d.status === 'SKIPPED').length, customerCancelled: rows.filter(d => hasAction(d, 'customer_cancelled')).length, expired: rows.filter(d => d.status === 'CANCELLED' && !hasAction(d, 'customer_cancelled') && !hasAction(d, 'kiosk_closed')).length, waiting: rows.filter(d => d.status === 'WAITING').length, called: rows.filter(d => d.status === 'CALLED').length, transfers: visits.filter(v => v.outcome === 'transfer').length, mobile: rows.filter(d => d.deliveryMode === 'mobile' || d.source === 'mobile').length, printed: rows.filter(d => d.deliveryMode === 'print').length, averageWaitSeconds: mean(waits), p90WaitSeconds: waits.length ? waits[Math.ceil(waits.length * .9) - 1] : null, averageServiceSeconds: mean(services), waitSamples: waits.length, serviceSamples: services.length },
    sectors: [...groups.values()].map(({ waits, services, ...g }) => ({ ...g, averageWaitSeconds: mean(waits), averageServiceSeconds: mean(services), waitSamples: waits.length, serviceSamples: services.length })),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), hours,
    tickets: rows.map(d => ({ id: String(d._id), number: d.displayNumber, day: d.dayKey, status: d.status, source: d.deliveryMode || d.source, createdAt: d.createdAt, visits: ticketVisits(d) })),
  };
}
function statsPage(tenant, today, { tenants = [tenant], isSuper = false } = {}) {
  const domainControl = isSuper ? `<label>Dominio<select id="statsTenant">${tenants.map(t => `<option value="${esc(t)}"${t === tenant ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Estadísticas de turnos · Asisto</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f4f4;color:#161616;font:16px/1.5 system-ui}header,main{max-width:1500px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}h1{font-size:32px;margin:0}p{color:#626262}.filters{display:flex;gap:16px;align-items:end;flex-wrap:wrap;margin:20px 0}label{display:grid;gap:6px}input,select,button{font:inherit;border:1px solid #ccc;border-radius:10px;padding:11px;background:white}button{background:#df0000;color:white;border:0;cursor:pointer}button:disabled{opacity:.5}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:14px}.card,section{background:white;border-radius:16px;padding:20px}.card strong{display:block;font-size:30px}section{margin:20px 0;overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{text-align:left;padding:12px;border-bottom:1px solid #eee}th{font-size:13px;color:#666}.bar{display:flex;gap:15px;align-items:center;margin:8px 0}.bar span{min-width:110px}.bar i{display:block;background:#e00000;min-width:2px;height:18px;border-radius:4px}.muted{font-size:13px;color:#666}#error{color:#ad0000}a{color:inherit}${branding.css}</style></head><body>
<header>${tenant === 'DEMO_FERRETERIA' ? branding.logo : '<strong>' + esc(tenant) + '</strong>'}<a href="/ui/turnero/${encodeURIComponent(tenant)}">Volver a atención</a></header><main><h1>Estadísticas de turnos</h1><p>Volumen, tiempos y recorridos por sección · ${esc(tenant)}</p><form id="filters" class="filters">${domainControl}<label>Desde<input id="from" type="date" value="${today}" required></label><label>Hasta<input id="to" type="date" value="${today}" required></label><button>Consultar</button><button type="button" id="csv" disabled>Exportar recorridos CSV</button></form><div id="error" role="alert"></div><div id="updated" class="muted"></div><div id="cards" class="cards"></div><section><h2>Por sección</h2><div id="sectors"></div></section><section><h2>Turnos por día</h2><div id="days"></div></section><section><h2>Horarios de emisión</h2><div id="hours"></div></section><p class="muted">Fechas y horarios de Argentina. Los filtros corresponden al día de emisión. La espera se mide desde la activación o traslado hasta el primer llamado; la atención, desde ese llamado hasta finalizar, marcar ausente o trasladar. Repetir un llamado no reinicia el reloj. Los promedios excluyen etapas sin cerrar. Los traslados cuentan como visitas a otra sección, conservando el mismo turno.</p></main><footer class="brandFooter">${branding.powered}</footer><script>
const API='/api/customer-app-admin/'+${JSON.stringify(tenant)}+'/stats',q=id=>document.getElementById(id);let data;
const node=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e},duration=s=>s===null?'—':(s/60).toLocaleString('es-AR',{maximumFractionDigits:1})+' min';
function table(id,headers,rows){const t=document.createElement('table'),head=document.createElement('tr');headers.forEach(h=>head.append(node('th',h)));t.append(head);rows.forEach(row=>{const tr=document.createElement('tr');row.forEach(v=>tr.append(node('td',v)));t.append(tr)});q(id).replaceChildren(t)}
async function load(e){e?.preventDefault();q('error').textContent='';q('csv').disabled=true;try{const r=await fetch(API+'?from='+q('from').value+'&to='+q('to').value),x=await r.json();if(!r.ok)throw Error(x.error||'No se pudo cargar');data=x;const s=x.summary;q('cards').replaceChildren();for(const [label,value] of [['Emitidos',s.issued],['Activados',s.activated],['Finalizados',s.finished],['Ausentes',s.skipped],['Cancelados por clientes',s.customerCancelled],['Reservas vencidas',s.expired],['En espera',s.waiting],['En atención',s.called],['Traslados',s.transfers],['En celular',s.mobile],['Impresos',s.printed],['Espera promedio',duration(s.averageWaitSeconds)],['Espera P90',duration(s.p90WaitSeconds)],['Atención promedio',duration(s.averageServiceSeconds)]]){const c=document.createElement('div');c.className='card';c.append(node('strong',value),node('span',label));q('cards').append(c)}table('sectors',['Sección','Visitas','Finalizados','Ausentes','Traslados','Espera prom.','Muestras espera','Atención prom.','Muestras atención'],x.sectors.map(s=>[s.name,s.visits,s.finished,s.skipped,s.transfers,duration(s.averageWaitSeconds),s.waitSamples,duration(s.averageServiceSeconds),s.serviceSamples]));q('days').replaceChildren();const max=Math.max(1,...x.days.map(d=>d.issued));for(const d of x.days){const row=document.createElement('div');row.className='bar';const bar=document.createElement('i');bar.style.width=(d.issued/max*65)+'%';row.append(node('span',d.day),bar,node('b',d.issued));q('days').append(row)}if(!x.days.length)q('days').textContent='No hay turnos en este período.';table('hours',['Hora','Turnos emitidos'],x.hours.filter(h=>h.issued).map(h=>[String(h.hour).padStart(2,'0')+':00',h.issued]));q('updated').textContent='Actualizado '+new Date().toLocaleString('es-AR')+' · '+s.waitSamples+' esperas y '+s.serviceSamples+' atenciones medidas. P90: el 90% de las esperas medidas no supera ese valor.';q('csv').disabled=false}catch(e){q('error').textContent=e.message}}
if(q('statsTenant'))q('statsTenant').onchange=()=>{top.location.href='/ui/turnero/'+encodeURIComponent(q('statsTenant').value)+'/estadisticas'};q('filters').onsubmit=load;q('csv').onclick=()=>{const rows=[['ID turno','Número','Día','Estado','Entrega','Sección','Ingreso','Primer llamado','Fin etapa','Resultado','Espera segundos','Atención segundos']];data.tickets.forEach(t=>(t.visits.length?t.visits:[{}]).forEach(v=>rows.push([t.id,t.number,t.day,t.status,t.source,v.sectorId,v.queuedAt?new Date(v.queuedAt).toISOString():'',v.calledAt?new Date(v.calledAt).toISOString():'',v.endedAt?new Date(v.endedAt).toISOString():'',v.outcome,v.waitSeconds,v.serviceSeconds])));const cell=v=>{let s=String(v??'');if(/^[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'};const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(cell).join(';')).join('\\r\\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=node('a','');a.href=url;a.download='turnos-'+q('from').value+'-'+q('to').value+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};load();
</script></body></html>`;
}
function mountQueueStats(app, { scope, wrap, allowed, dayKey, auth }) {
  app.get('/ui/turnero/:tenant/estadisticas', wrap(async (req, res) => {
    const { t, db } = await scope(req);
    if (!allowed(req, t)) return res.redirect('/login?to=' + encodeURIComponent(req.originalUrl));
    const isSuper = String(req.user?.role || '').toLowerCase() === 'superadmin';
    const tenants = isSuper ? await listStatsTenants(db, t) : [t];
    if (String(req.query.embed || '') === '1' || typeof auth?.appShell !== 'function') return res.type('html').send(statsPage(t, dayKey(), { tenants, isSuper }));
    const embed = `/ui/turnero/${encodeURIComponent(t)}/estadisticas?embed=1`;
    res.type('html').send(auth.appShell({ title: 'Estadísticas Turnero · Asisto', user: req.user, active: 'queue_stats', main: `<iframe title="Estadísticas Turnero" src="${embed}" style="display:block;width:100%;height:calc(100vh - 110px);min-height:720px;border:0;border-radius:18px;background:#f4f4f4"></iframe>` }));
  }));
  app.get('/api/customer-app-admin/:tenant/stats', wrap(async (req, res) => {
    const { t, db, cfg, base } = await scope(req);
    if (!allowed(req, t)) return res.status(req.user?.uid ? 403 : 401).json({ error: 'Iniciá sesión en Asisto para consultar estadísticas.' });
    const from = String(req.query.from || dayKey()), to = String(req.query.to || dayKey());
    const valid = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if (!valid(from) || !valid(to) || from > to || Date.parse(to) - Date.parse(from) > 92 * 86400000) return res.status(400).json({ error: 'Elegí un período válido de hasta 93 días.' });
    const rows = await db.collection('queue_tickets').find({ tenantId: t, branchId: base.branchId, dayKey: { $gte: from, $lte: to } }, { projection: { installId: 0, linkedInstallIds: 0, handoffHash: 0, usedHandoffHash: 0, queueNotifications: 0 } }).sort({ createdAt: 1, _id: 1 }).limit(50001).toArray();
    if (rows.length > 50000) return res.status(400).json({ error: 'Hay más de 50.000 turnos. Reducí el período para consultar todos los datos.' });
    res.json({ from, to, ...summarize(rows, cfg.sectors) });
  }));
}
module.exports = { mountQueueStats, ticketVisits, summarize, statsPage, listStatsTenants };
