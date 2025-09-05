// routes/admin.js (compact clean)
const express = require('express');
const { ObjectId } = require('mongodb');
const router = express.Router();
const path = require('path');
let getDb;
try {
  ({ getDb } = require(path.join(__dirname, '..', 'services', 'db')));
  console.log('[admin] using ../services/db.js');
} catch (e1) {
  try {
    ({ getDb } = require(path.join(__dirname, '..', '..', 'services', 'db')));
    console.log('[admin] using ../../services/db.js');
  } catch (e2) {
    console.error('[admin] No se encontró services/db.js');
    console.error('Primero:', e1 && e1.message);
    console.error('Luego  :', e2 && e2.message);
    throw e2;
  }
}


function escapeHtml(s){ return String(s||'').replace(/[<>&]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

// ===== UI: /admin =====
router.get("/admin", async (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta charset="utf-8"/><title>Admin</title>
<style>body{font-family:system-ui,Arial;margin:24px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #ddd;padding:8px}th{background:#f6f6f6}tr:nth-child(even){background:#fafafa}.btn{padding:6px 10px;border:1px solid #333;background:#fff;cursor:pointer;border-radius:4px;font-size:12px}.tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:12px}.OPEN{background:#e7f5ff;color:#1971c2}</style>
</head><body>
<h1>Admin - Conversaciones</h1>
<table id="tbl"><thead><tr><th>wa_id</th><th>Nombre</th><th>Estado</th><th>Abierta</th><th>Cerrada</th><th>Turnos</th><th>Acciones</th></tr></thead><tbody></tbody></table>
<script>
async function load(){
  const r=await fetch('/api/admin/conversations'); const data=await r.json(); const tb=document.querySelector('#tbl tbody'); tb.innerHTML='';
  for(const c of data){
    const tr=document.createElement('tr');
    tr.innerHTML = \`<td>\${c.waId||''}</td><td>\${c.contactName||''}</td><td><span class="tag">\${c.status}</span></td><td>\${c.openedAt?new Date(c.openedAt).toLocaleString():''}</td><td>\${c.closedAt?new Date(c.closedAt).toLocaleString():''}</td><td>\${c.turns??0}</td><td><button class="btn" onclick="openMessages('\${c._id}')">Mensajes</button><button class="btn" onclick="openOrder('\${c._id}')">Pedido</button><button class="btn" onclick="printTicket('\${c._id}')">Imprimir</button></td>\`;
    tb.appendChild(tr);
  }
}
function openMessages(id){ window.open('/api/admin/messages/'+id,'_blank'); }
function openOrder(id){ window.open('/api/admin/order/'+id,'_blank'); }
function printTicket(id){ window.open('/admin/print/'+id+'?v=kitchen','_blank'); }
load();
</script></body></html>`);
});

// ===== API: conversations list =====
router.get("/api/admin/conversations", async (_req, res) => {
  try {
    const db = await getDb();
    const convs = await db.collection("conversations")
      .find({}, { sort: { openedAt: -1 } })
      .project({ waId:1, status:1, openedAt:1, closedAt:1, turns:1, contactName:1 })
      .limit(500).toArray();
    res.json(convs.map(c=>({ ...c, _id: c._id.toString() })));
  } catch (e) { res.status(200).json([]); }
});

// ===== API: messages of a conversation (HTML) =====
router.get("/api/admin/messages/:id", async (req, res) => {
  try {
    const db = await getDb();
    const id = new ObjectId(req.params.id);
    const conv = await db.collection("conversations").findOne({ _id: id });
    if (!conv) return res.status(404).send("Conversation not found");
    const msgs = await db.collection("messages").find({ conversationId: id }).sort({ ts:1 }).toArray();
    res.setHeader("Content-Type","text/html; charset=utf-8");
    const rows = msgs.map(m=>`<div class="msg"><div class="role">${escapeHtml((m.role||'').toUpperCase())} <span class="meta">(${new Date(m.ts).toLocaleString()})</span></div><pre>${escapeHtml(m.content||'')}</pre></div>`).join('');
    res.end(`<!doctype html><html><head><meta charset="utf-8"/><title>Mensajes</title>
<style>body{font-family:system-ui,Arial;margin:24px}.msg{margin:8px 0}.role{font-weight:bold}pre{background:#f6f6f6;padding:8px;border-radius:4px}.meta{color:#666;font-size:12px}</style>
</head><body><h2>${escapeHtml(conv.contactName||'')} • ${escapeHtml(conv.waId||'')}</h2>${rows}</body></html>`);
  } catch (e) { res.status(500).send("internal"); }
});

// ===== API: order summary (JSON) =====
router.get("/api/admin/order/:id", async (req, res) => {
  try {
    const db = await getDb();
    const id = new ObjectId(req.params.id);
    const conv = await db.collection("conversations").findOne({ _id: id });
    if (!conv) return res.status(404).json({ error:"not_found" });
    const ord = await db.collection("orders").findOne({ conversationId: id });
    res.json({ waId: conv.waId, order: ord || null, rawPedido: conv.summary?.Pedido || null });
  } catch (e) { res.status(500).json({ error:"internal" }); }
});

// ===== UI: printable ticket =====
router.get("/admin/print/:id", async (req, res) => {
  try {
    const db = await getDb();
    const id = new ObjectId(req.params.id);
    const conv = await db.collection("conversations").findOne({ _id: id });
    const ord = await db.collection("orders").findOne({ conversationId: id });
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"/><title>Ticket</title>
<style>@page{size:80mm auto;margin:0}body{margin:0}.ticket{width:80mm;padding:6px 8px;font-family:monospace;font-size:12px}.center{text-align:center}.hr{border-top:1px dashed #000;margin:6px 0}.big{font-size:14px;font-weight:bold}@media print{.noprint{display:none}}</style>
</head><body><div class="ticket"><div class="center big">PEDIDO</div><div>${new Date().toLocaleString()}</div><div class="hr"></div><div>Cliente: ${(conv?.contactName||'')} (${(conv?.waId||'')})</div><div class="hr"></div><div>Detalle:</div><pre>${escapeHtml(JSON.stringify(ord || conv?.summary?.Pedido || {}, null, 2))}</pre><div class="hr"></div><button class="noprint" onclick="window.print()">Imprimir</button></div></body></html>`);
  } catch (e) { res.status(500).send("internal"); }
});

// ===== Costs aggregation helpers =====
function parseDate(s){ if(!s) return null; const d=new Date(s+'T00:00:00.000Z'); return isNaN(d.getTime())?null:d; }

async function aggregateCosts(req){
  const { start, end, group_by, waId, model, role, type } = req.query;
  const endDate = parseDate(end) || new Date();
  const startDate = parseDate(start) || new Date(endDate.getTime()-7*24*60*60*1000);
  const endExclusive = new Date(endDate.getTime()+24*60*60*1000);
  const groups = String(group_by||'day,model').split(',').map(s=>s.trim()).filter(Boolean);
  const wantDay = groups.includes('day'), wantModel = groups.includes('model'), wantConversation = groups.includes('conversation');

  const db = await getDb();
  const matchBase = { ts:{ $gte:startDate, $lt:endExclusive }, "meta.cost_estimate.usd": { $gt:0 } };
  if (role && role!=='any') matchBase.role = role;
  if (type && type!=='any') matchBase.type = type;

  const pipeline = [
    { $match: matchBase },
    { $lookup: { from:"conversations", localField:"conversationId", foreignField:"_id", as:"conv" } },
    { $unwind: "$conv" },
  ];
  if (waId && String(waId).trim()) pipeline.push({ $match: { "conv.waId": String(waId).trim() } });
  pipeline.push({
    $project: {
      ts:1, conversationId:1,
      model: { $ifNull: [ "$meta.cost_estimate.breakdown.model", { $ifNull: ["$meta.model","unknown"] } ] },
      usd: { $ifNull: ["$meta.cost_estimate.usd",0] },
      prompt_tokens: { $ifNull: ["$meta.usage.prompt_tokens",0] },
      completion_tokens: { $ifNull: ["$meta.usage.completion_tokens",0] },
      day: { $dateToString: { format:"%Y-%m-%d", date:"$ts" } }
    }
  });
  if (model && String(model).trim()) pipeline.push({ $match: { model: { $regex: String(model).trim(), $options:"i" } } });

  const idObj = {};
  if (wantDay) idObj.day = "$day";
  if (wantModel) idObj.model = "$model";
  if (wantConversation) idObj.conversationId = "$conversationId";

  pipeline.push({ $group: {
    _id: idObj,
    totalUSD: { $sum:"$usd" },
    totalPromptTokens: { $sum:"$prompt_tokens" },
    totalCompletionTokens: { $sum:"$completion_tokens" },
    messages: { $sum:1 }
  }});
  pipeline.push({ $sort: { " _id.day":1, totalUSD:-1 } });

  const rows = await db.collection("messages").aggregate(pipeline).toArray();
  const mapped = rows.map(r=>{
    const o = {
      totalUSD: Number((r.totalUSD||0).toFixed(6)),
      messages: r.messages||0,
      prompt_tokens: r.totalPromptTokens||0,
      completion_tokens: r.totalCompletionTokens||0
    };
    if (wantDay) o.day = r._id.day;
    if (wantModel) o.model = r._id.model;
    if (wantConversation) o.conversationId = String(r._id.conversationId);
    return o;
  });

  return {
    range: { start: startDate.toISOString().slice(0,10), end: endDate.toISOString().slice(0,10) },
    group_by: groups,
    rows: mapped
  };
}

// ===== Costs API =====
router.get("/api/admin/costs", async (req, res) => {
  try { res.json(await aggregateCosts(req)); } catch(e){ console.error("costs",e); res.status(500).json({error:"internal"}); }
});

router.get("/api/admin/costs.csv", async (req, res) => {
  try {
    const data = await aggregateCosts(req);
    const group_by = data.group_by;
    const headers = []; if (group_by.includes('day')) headers.push('day'); if (group_by.includes('model')) headers.push('model'); if (group_by.includes('conversation')) headers.push('conversationId'); headers.push('totalUSD','messages','prompt_tokens','completion_tokens');
    function esc(v){ const s=(v==null)?'':String(v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
    const lines = [ headers.join(',') ];
    for (const r of data.rows){
      const line = [
        ...(group_by.includes('day')?[r.day]:[]),
        ...(group_by.includes('model')?[r.model]:[]),
        ...(group_by.includes('conversation')?[r.conversationId]:[]),
        r.totalUSD, r.messages, r.prompt_tokens, r.completion_tokens
      ].map(esc).join(',');
      lines.push(line);
    }
    res.setHeader("Content-Type","text/csv; charset=utf-8");
    res.setHeader("Content-Disposition","attachment; filename=costs.csv");
    res.end(lines.join("\n"));
  } catch(e){ console.error("costs.csv",e); res.status(500).send("internal"); }
});

// ===== Dashboard HTML =====
router.get("/admin/costs", async (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta charset="utf-8"/><title>Dashboard de Costos</title><meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
body{font-family:system-ui,-apple-system,Arial,sans-serif;margin:24px}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}label{font-size:14px}input,select,button{padding:6px 8px;font-size:14px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:16px 0}.card{border:1px solid #e5e5e5;border-radius:10px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:16px}th,td{border:1px solid #ddd;padding:6px}th{background:#f6f6f6;text-align:left}.chart-wrap{width:100%;max-width:900px}.muted{color:#666;font-size:12px}
</style><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head><body>
<h1>Dashboard de Costos</h1>
<div class="row">
  <label>Inicio <input type="date" id="start"></label>
  <label>Fin <input type="date" id="end"></label>
  <label>Group by
    <select id="group_by" multiple size="3">
      <option value="day" selected>Día</option>
      <option value="model" selected>Modelo</option>
      <option value="conversation">Conversación</option>
    </select>
  </label>
  <label>waId <input type="text" id="waId" placeholder="54911..." style="min-width:160px"></label>
  <label>Modelo <input type="text" id="model" placeholder="gpt-4o-mini" style="min-width:160px"></label>
  <label>Role
    <select id="role"><option value="any" selected>Todos</option><option value="user">user</option><option value="assistant">assistant</option></select>
  </label>
  <label>Tipo
    <select id="type"><option value="any" selected>Todos</option><option value="text">text</option><option value="audio">audio</option><option value="image">image</option></select>
  </label>
  <button id="refresh">Actualizar</button>
  <a id="csv" class="muted" href="#">Descargar CSV</a>
</div>
<div class="cards">
  <div class="card"><div class="muted">Total USD</div><div id="kpi_usd" style="font-size:28px;font-weight:600">-</div></div>
  <div class="card"><div class="muted">Mensajes</div><div id="kpi_msgs" style="font-size:28px;font-weight:600">-</div></div>
  <div class="card"><div class="muted">Prompt tokens</div><div id="kpi_in" style="font-size:28px;font-weight:600">-</div></div>
  <div class="card"><div class="muted">Completion tokens</div><div id="kpi_out" style="font-size:28px;font-weight:600">-</div></div>
</div>
<div class="chart-wrap"><canvas id="chartByDay"></canvas></div>
<div class="chart-wrap"><canvas id="chartByModel"></canvas></div>
<table id="tbl"><thead><tr></tr></thead><tbody></tbody></table>
<script>
let chartDay, chartModel;
function qs(s){return document.querySelector(s)} function qsa(s){return Array.from(document.querySelectorAll(s))}
function params(){const s=qs('#start').value,e=qs('#end').value,gb=Array.from(qs('#group_by').selectedOptions).map(o=>o.value).join(','),waId=qs('#waId').value.trim(),model=qs('#model').value.trim(),role=qs('#role').value,type=qs('#type').value;return new URLSearchParams({start:s,end:e,group_by:gb,waId,model,role,type}).toString()}
async function fetchData(){const r=await fetch('/api/admin/costs?'+params());return r.json()}
function toCSVLink(){qs('#csv').href='/api/admin/costs.csv?'+params()}
function sum(a,k){return a.reduce((x,y)=>x+Number(y[k]||0),0)}
function renderKPIs(rows){qs('#kpi_usd').textContent='$ '+sum(rows,'totalUSD').toFixed(6);qs('#kpi_msgs').textContent=sum(rows,'messages');qs('#kpi_in').textContent=sum(rows,'prompt_tokens');qs('#kpi_out').textContent=sum(rows,'completion_tokens')}
function renderTable(rows,g){const h=qs('#tbl thead tr'),b=qs('#tbl tbody');h.innerHTML='';b.innerHTML='';const cols=[];if(g.includes('day'))cols.push('day');if(g.includes('model'))cols.push('model');if(g.includes('conversation'))cols.push('conversationId');cols.push('totalUSD','messages','prompt_tokens','completion_tokens');for(const c of cols){const th=document.createElement('th');th.textContent=c;h.appendChild(th)}for(const r of rows){const tr=document.createElement('tr');for(const c of cols){const td=document.createElement('td');let v=r[c];if(c==='totalUSD')v=Number(v||0).toFixed(6);td.textContent=(v==null)?'':v;tr.appendChild(td)}b.appendChild(tr)}}
function groupSum(rows,key){const m=new Map();for(const r of rows){const k=r[key]||'unknown';const usd=Number(r.totalUSD||0);m.set(k,(m.get(k)||0)+usd)}return Array.from(m.entries()).map(([k,v])=>({key:k,usd:v}))}
function renderCharts(rows){const byDay=groupSum(rows,'day').sort((a,b)=>a.key<b.key?-1:1),byModel=groupSum(rows,'model').sort((a,b)=>b.usd-a.usd);if(chartDay)chartDay.destroy();if(chartModel)chartModel.destroy();chartDay=new Chart(qs('#chartByDay').getContext('2d'),{type:'line',data:{labels:byDay.map(r=>r.key),datasets:[{label:'USD por día',data:byDay.map(r=>r.usd)}]},options:{responsive:true,scales:{y:{beginAtZero:true}}}});chartModel=new Chart(qs('#chartByModel').getContext('2d'),{type:'bar',data:{labels:byModel.map(r=>r.key),datasets:[{label:'USD por modelo',data:byModel.map(r=>r.usd)}]},options:{responsive:true,scales:{y:{beginAtZero:true}}}})}
function initDates(){const t=new Date(),e=t.toISOString().slice(0,10),s=new Date(t.getTime()-7*24*60*60*1000).toISOString().slice(0,10);qs('#start').value=s;qs('#end').value=e;qsa('#group_by option').forEach(o=>{if(o.value==='day'||o.value==='model')o.selected=true})}
async function refresh(){const d=await fetchData();renderKPIs(d.rows);renderTable(d.rows,d.group_by);renderCharts(d.rows);toCSVLink()}
initDates();refresh();qs('#refresh').addEventListener('click',refresh);['start','end','group_by','waId','model','role','type'].forEach(id=>{const el=qs('#'+id);el.addEventListener('change',refresh);if(el.tagName==='INPUT')el.addEventListener('keyup',e=>{if(e.key==='Enter')refresh()})})
</script></body></html>`);
});

module.exports = router;
