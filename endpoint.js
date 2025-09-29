// endpoint.js
// Servidor Express y endpoints (webhook, behavior API/UI, cache, salud) con multi-tenant
// Incluye logs de fixReply en el loop de corrección.

require("dotenv").config();
const express = require("express");
const app = express();

const crypto = require("crypto");
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;

// ⬇️ Para catálogo en Mongo
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
const TENANT_ID = (process.env.TENANT_ID || "").trim();


const {
  loadBehaviorTextFromMongo,
  loadBehaviorConfigFromMongo,
  invalidateBehaviorCache,
  getGPTReply, hasActiveEndedFlag, markSessionEnded, isPoliteClosingMessage,
  START_FALLBACK, buildBackendSummary, coalesceResponse, recalcAndDetectMismatch,
  getEnvioItemFromCatalog,
  computeEnvioItemForPedido,
  putInCache, getFromCache, getMediaInfo, downloadMediaBuffer, transcribeAudioExternal,
  DEFAULT_TENANT_ID, setAssistantPedidoSnapshot,
  normalizeOrder,
} = require("./logic");

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

function isValidSignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");
  if (!appSecret || !signature) return false;
  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(req.rawBody);
  const expected = "sha256=" + hmac.digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}

function resolveTenantId(req) {
  return (req.query.tenant || req.headers["x-tenant-id"] || process.env.TENANT_ID || DEFAULT_TENANT_ID).toString().trim();
}

// Health
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Cache público (audio)
app.get("/cache/audio/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});

// ===================================================================
// ===============       Catálogo de productos        ================
// ===================================================================

// GET /api/products  → lista (activos por defecto; ?all=true para todos)
app.get("/api/products", async (req, res) => {
  try {
    const db = await getDb();
    const q = req.query.all === "true" ? {} : { active: { $ne: false } };
    if (TENANT_ID) q.tenantId = TENANT_ID;
    const items = await db.collection("products")
      .find(q).sort({ createdAt: -1, descripcion: 1 }).toArray();
    res.json(items.map(it => ({ ...it, _id: String(it._id) })));
  } catch (e) {
    console.error("GET /api/products error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/products  → crear
app.post("/api/products", async (req, res) => {
  try {
    const db = await getDb();
    let { descripcion, importe, observacion, active, min_km, max_km } = req.body || {};
    descripcion = String(descripcion || "").trim();
    observacion = String(observacion || "").trim();
    if (typeof active !== "boolean") active = !!active;
    let imp = null;
    if (typeof importe === "number") imp = importe;
    else if (typeof importe === "string") {
      const n = Number(importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      imp = Number.isFinite(n) ? n : null;
    }
    // parseo de min/max km
    const toNum = (v) => {
      if (v === undefined || v === null || v === "") return undefined;
      const n = Number(String(v).replace(",", "."));
      return Number.isFinite(n) ? n : undefined;
    };
    min_km = toNum(min_km);
    max_km = toNum(max_km);
    if (!descripcion) return res.status(400).json({ error: "descripcion requerida" });
    const now = new Date();
    const doc = { tenantId: TENANT_ID || null, descripcion, observacion, active, createdAt: now, updatedAt: now };
    if (imp !== null) doc.importe = imp;
    if (min_km !== undefined) doc.min_km = min_km;
    if (max_km !== undefined) doc.max_km = max_km;
    const ins = await db.collection("products").insertOne(doc);
    res.json({ ok: true, _id: String(ins.insertedId) });
  } catch (e) {
    console.error("POST /api/products error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// PUT /api/products/:id  → actualizar
app.put("/api/products/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const upd = {};
    ["descripcion","observacion","active","importe","min_km","max_km"].forEach(k => { if (req.body[k] !== undefined) upd[k] = req.body[k]; });
     if (upd.importe !== undefined) {
       const v = upd.importe;
       if (typeof v === "string") {
         const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", "."));
         upd.importe = Number.isFinite(n) ? n : undefined;
       }
     }
    // parseo min/max km si vienen en string
    const toNum = (v) => {
      if (v === undefined || v === null || v === "") return undefined;
      const n = Number(String(v).replace(",", "."));
      return Number.isFinite(n) ? n : undefined;
    };
    if (upd.min_km !== undefined) upd.min_km = toNum(upd.min_km);
    if (upd.max_km !== undefined) upd.max_km = toNum(upd.max_km);
    
    if (Object.keys(upd).length === 0) return res.status(400).json({ error: "no_fields" });
    upd.updatedAt = new Date();
    const filter = { _id: new ObjectId(String(id)) };
    if (TENANT_ID) filter.tenantId = TENANT_ID;
    const result = await db.collection("products").updateOne(filter, { $set: upd });
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /api/products/:id error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// DELETE /api/products/:id  → eliminar
app.delete("/api/products/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const filter = { _id: new ObjectId(String(id)) };
    if (TENANT_ID) filter.tenantId = TENANT_ID;
    const result = await db.collection("products").deleteOne(filter);
    if (!result.deletedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/products/:id error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/products/:id/inactivate  → inactivar
app.post("/api/products/:id/inactivate", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const filter = { _id: new ObjectId(String(id)) };
    if (TENANT_ID) filter.tenantId = TENANT_ID;
    const result = await db.collection("products").updateOne(filter, { $set: { active: false, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/products/:id/inactivate error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/products/:id/reactivate  → reactivar
app.post("/api/products/:id/reactivate", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const filter = { _id: new ObjectId(String(id)) };
    if (TENANT_ID) filter.tenantId = TENANT_ID;
    const result = await db.collection("products").updateOne(filter, { $set: { active: true, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/products/:id/reactivate error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// GET /productos  → UI HTML simple para administrar
app.get("/productos", async (req, res) => {
  try {
    const db = await getDb();
    const verTodos = req.query.all === "true";
    const filtro = verTodos ? {} : { active: { $ne: false } };
    if (TENANT_ID) filtro.tenantId = TENANT_ID;
    const productos = await db.collection("products").find(filtro).sort({ createdAt: -1 }).toArray();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" /><title>Productos</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:1100px}
        table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
        th{background:#f5f5f5;text-align:left}input,textarea{width:100%;box-sizing:border-box}
        textarea{min-height:56px}.row{display:flex;gap:8px;align-items:center}.btn{padding:6px 10px;border:1px solid #333;background:#fff;border-radius:4px;cursor:pointer}
      .num{max-width:120px}
        </style></head><body>
      <h1>Productos</h1>
      <div class="row"><a class="btn" href="/productos${verTodos ? "" : "?all=true"}">${verTodos ? "Ver solo activos" : "Ver todos"}</a> <button id="btnAdd" class="btn">Agregar</button> <button id="btnReload" class="btn">Recargar</button></div>
      <p></p>
      <table id="tbl"><thead><tr><th>Descripción</th><th>Importe</th><th>Min km</th><th>Max km</th><th>Obs.</th><th>Activo</th><th>Acciones</th></tr></thead>
      <tbody>${productos.map(p => `<tr data-id="${p._id}">
        <td><input class="descripcion" type="text" value="${(p.descripcion||'').replace(/\"/g,'&quot;')}" /></td>
        <td><input class="importe num" type="number" step="0.01" value="${(typeof p.importe==='number'?p.importe:(p.importe??''))}" /></td>
        <td><input class="min_km num" type="number" step="0.01" value="${p.min_km ?? ''}" /></td>
        <td><input class="max_km num" type="number" step="0.01" value="${p.max_km ?? ''}" /></td>
        <td><textarea class="observacion">${(p.observacion||'').replace(/</g,'&lt;')}</textarea></td>
        <td><input class="active" type="checkbox" ${p.active!==false?'checked':''} /></td>
        <td>
          <button class="save btn">Guardar</button>
          <button class="del btn">Eliminar</button>
          <button class="toggle btn">${p.active!==false?'Inactivar':'Reactivar'}</button>
        </td>
      </tr>`).join('')}</tbody></table>

      <template id="row-tpl"><tr data-id="">
        <td><input class="descripcion" type="text" /></td>
        <td><input class="importe num" type="number" step="0.01" /></td>
        <td><input class="min_km num" type="number" step="0.01" /></td>
        <td><input class="max_km num" type="number" step="0.01" /></td>
        <td><textarea class="observacion"></textarea></td>
        <td><input class="active" type="checkbox" checked /></td>
        <td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">Inactivar</button></td>
   </tr></template>
      <script>
        function q(s,c){return (c||document).querySelector(s)}function all(s,c){return Array.from((c||document).querySelectorAll(s))}
        async function j(url,opts){const r=await fetch(url,opts||{});if(!r.ok)throw new Error('HTTP '+r.status);const ct=r.headers.get('content-type')||'';return ct.includes('application/json')?r.json():r.text()}
         async function reload(){const url=new URL(location.href);const allFlag=url.searchParams.get('all')==='true';const data=await j('/api/products'+(allFlag?'?all=true':''));const tb=q('#tbl tbody');tb.innerHTML='';for(const it of data){const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);tr.dataset.id=it._id||'';q('.descripcion',tr).value=it.descripcion||'';q('.importe',tr).value=typeof it.importe==='number'?it.importe:(it.importe||'');q('.min_km',tr).value=(it.min_km ?? '');q('.max_km',tr).value=(it.max_km ?? '');q('.observacion',tr).value=it.observacion||'';q('.active',tr).checked=it.active!==false;q('.toggle',tr).textContent=(it.active!==false)?'Inactivar':'Reactivar';bindRow(tr);tb.appendChild(tr);}if(!data.length){const r=document.createElement('tr');r.innerHTML='<td colspan="7" style="text-align:center;color:#666">Sin productos para mostrar</td>';tb.appendChild(r);}}
        async function saveRow(tr){const id=tr.dataset.id;const payload={descripcion:q('.descripcion',tr).value.trim(),importe:q('.importe',tr).value.trim(),min_km:q('.min_km',tr).value.trim(),max_km:q('.max_km',tr).value.trim(),observacion:q('.observacion',tr).value.trim(),active:q('.active',tr).checked};if(!payload.descripcion){alert('Descripción requerida');return;}if(id){await j('/api/products/'+encodeURIComponent(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}else{await j('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}await reload();}
       async function deleteRow(tr){const id=tr.dataset.id;if(!id){tr.remove();return;}if(!confirm('¿Eliminar definitivamente?'))return;await j('/api/products/'+encodeURIComponent(id),{method:'DELETE'});await reload();}
        async function toggleRow(tr){const id=tr.dataset.id;if(!id){alert('Primero guardá el nuevo producto.');return;}const active=q('.active',tr).checked;const path=active?('/api/products/'+encodeURIComponent(id)+'/inactivate'):('/api/products/'+encodeURIComponent(id)+'/reactivate');await j(path,{method:'POST'});await reload();}
        function bindRow(tr){q('.save',tr).addEventListener('click',()=>saveRow(tr));q('.del',tr).addEventListener('click',()=>deleteRow(tr));q('.toggle',tr).addEventListener('click',()=>toggleRow(tr));}
        document.getElementById('btnReload').addEventListener('click',reload);
        document.getElementById('btnAdd').addEventListener('click',()=>{const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);q('#tbl tbody').prepend(tr);bindRow(tr);});
        all('#tbl tbody tr').forEach(bindRow);
      </script></body></html>`);
  } catch (e) {
    console.error("/productos error:", e);
    res.status(500).send("internal");
  }
});





// Behavior UI
app.get("/comportamiento", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const cfg = await loadBehaviorConfigFromMongo(tenant);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" />
      <title>Comportamiento del Bot (${tenant})</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:960px}
      textarea{width:100%;min-height:360px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}
      .row{display:flex;gap:8px;align-items:center}.hint{color:#666;font-size:12px}.tag{padding:2px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px}
      input[type=text]{padding:6px 8px}</style></head><body>
      <h1>Comportamiento del Bot</h1>
      <div class="row">
        <label>Tenant:&nbsp;<input id="tenant" type="text" value="${tenant}" /></label>
        <button id="btnReload">Recargar</button>
        <button id="btnSave">Guardar</button>
      </div>
      <div class="row" style="margin-top:8px">
        <label>Modo de historial:&nbsp;
          <select id="historyMode">
            <option value="standard">standard (completo)</option>
            <option value="minimal">minimal (solo user + assistant Pedido)</option>
          </select>
        </label>
      </div>
      <p></p><textarea id="txt" placeholder="Escribí aquí el comportamiento para este tenant..."></textarea>
      <script>
        async function load(){
          const t = document.getElementById('tenant').value || '';
          const r=await fetch('/api/behavior?tenant='+encodeURIComponent(t));
          const j=await r.json();
          document.getElementById('txt').value=j.text||'';
          document.getElementById('historyMode').value = (j.history_mode || 'standard');
        }
        async function save(){
          const t=document.getElementById('tenant').value||'';
          const v=document.getElementById('txt').value||'';
          const m=document.getElementById('historyMode').value||'standard';
          const r=await fetch('/api/behavior?tenant='+encodeURIComponent(t),{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({text:v,tenantId:t,history_mode:m})
          });
          alert(r.ok?'Guardado ✅':'Error al guardar');
        }
        document.getElementById('btnSave').addEventListener('click',save);
        document.getElementById('btnReload').addEventListener('click',load);
        document.addEventListener('DOMContentLoaded', () => {
          document.getElementById('historyMode').value='${(cfg.history_mode || 'standard').replace(/"/g,'&quot;')}';
        });
        load();
      </script></body></html>`);
  } catch (e) { console.error("/comportamiento error:", e); res.status(500).send("internal"); }
});

app.get("/api/behavior", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const cfg = await loadBehaviorConfigFromMongo(tenant);
    res.json({ source: "mongo", tenant, text: cfg.text, history_mode: cfg.history_mode });
  } catch {
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/behavior", async (req, res) => {
  try {
    const tenant = (req.body?.tenantId || resolveTenantId(req)).toString().trim();
    const text = String(req.body?.text || "").trim();
    const history_mode = String(req.body?.history_mode || "").trim() || "standard";
    const db = await require("./db").getDb();
    const _id = `behavior:${tenant}`;
    await db.collection("settings").updateOne(
      { _id },
      { $set: { text, history_mode, tenantId: tenant, updatedAt: new Date() } },
      { upsert: true }
    );
    invalidateBehaviorCache(tenant);
    res.json({ ok: true, tenant, history_mode });
  } catch (e) {
    console.error("POST /api/behavior error:", e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/behavior/refresh-cache", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    invalidateBehaviorCache(tenant);
    res.json({ ok: true, tenant, cache: "invalidated" });
  } catch (e) { console.error("refresh-cache error:", e); res.status(500).json({ error: "internal" }); }
});




// Util: asegura una conversación abierta o devuelve la última
async function ensureConversation(tenantId, waId) {
  const db = await getDb();
  const now = new Date();
  const upd = await db.collection("conversations").findOneAndUpdate(
    { tenantId, waId, closedAt: { $exists: false } },
    { $setOnInsert: { tenantId, waId, openedAt: now, status: "OPEN" } },
    { upsert: true, returnDocument: "after" }
  );
  if (upd && upd.value) return upd.value;
  // Fallback: algunos drivers/versiones pueden no devolver 'value' en upsert
  return await db.collection("conversations").findOne({ tenantId, waId, closedAt: { $exists: false } });
}

// ---------- ADMIN UI ----------
// Listado simple de conversaciones
app.get("/admin", async (req, res) => {
  try {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html><head>
  <meta charset="utf-8"/><title>Admin</title>
  <style>
    body{font-family:system-ui,Arial;margin:20px}
    table{border-collapse:collapse;width:100%}
    td,th{border:1px solid #ddd;padding:8px}
    th{background:#f3f3f3;text-align:left}
    .btn{padding:.25rem .5rem;border:1px solid #888;background:#fff;cursor:pointer}
  </style>
</head><body>
  <h2>Conversaciones</h2>
  <table id="tb">
    <thead><tr><th>Fecha</th><th>Teléfono</th><th>Estado</th><th>Imp.</th><th>Total</th><th>Acciones</th></tr></thead>
    <tbody></tbody>
  </table>
  <script>
   async function markPrinted(id, printed){
      await fetch('/api/admin/order/'+encodeURIComponent(id)+'/'+(printed?'printed':'unprinted'), {method:'POST'});
      await loadConversations();
    }
    async function loadConversations(){
      const r = await fetch('/api/admin/conversations');
      const list = await r.json();
      const tb = document.querySelector('#tb tbody'); tb.innerHTML='';
      for (const row of list){
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>'+(row.openedAt? new Date(row.openedAt).toLocaleString(): '-')+'</td>'+
          '<td>'+row.waId+'</td>'+
          '<td>'+row.status+(row.processed?' ✓':'')+'</td>'+
          '<td>'+(row.printedAt ? '🖨️ '+new Date(row.printedAt).toLocaleTimeString() : '—')+'</td>'+
          '<td>'+(row.lastPedido?.total_pedido ?? '-')+'</td>'+
          '<td>'+
             '<button class="btn" onclick="openMessages(\\''+row._id+'\\')">Mensajes</button> '+
             '<button class="btn" onclick="openOrder(\\''+row._id+'\\')">Ver pedido</button> '+
             '<button class="btn" onclick="printOrder(\\''+row._id+'\\')">Imprimir</button>'+
             (row.printedAt
               ? ' <button class="btn" onclick="markPrinted(\\''+row._id+'\\', false)">Desmarcar</button>'
               : ' <button class="btn" onclick="markPrinted(\\''+row._id+'\\', true)">Marcar impreso</button>'
             )+
        
          '</td>';
        tb.appendChild(tr);
      }
    }
    function openMessages(id){ window.open('/api/admin/messages/'+encodeURIComponent(id),'_blank'); }
    function openOrder(id){ window.open('/admin/order/'+encodeURIComponent(id),'_blank'); }
    function printOrder(id){ window.open('/admin/order/'+encodeURIComponent(id)+'?print=1','_blank'); }
  
    loadConversations();
  </script>
</body></html>`);
  } catch (e) { res.status(500).send("internal"); }
});

// API: conversaciones
app.get("/api/admin/conversations", async (req, res) => {
  try {
    const db = await getDb();
    const list = await db.collection("conversations")
      .find({})
      .sort({ openedAt: -1 })
      .limit(300)
      .toArray();
    res.json(list.map(x => ({ ...x, _id: String(x._id) })));
  } catch (e) {
    console.error("/api/admin/conversations error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// API: pedido normalizado (JSON) de una conversación
app.get("/api/admin/order/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const db = await getDb();
    const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
    if (!conv) return res.status(404).json({ error: "not_found" });
    if (!conv.lastPedido) return res.status(404).json({ error: "no_order" });
    const order = normalizeOrder(conv.waId, conv.contactName, conv.lastPedido);
    res.json({ _id: id, waId: conv.waId, createdAt: conv.openedAt, status: conv.status, order });
  } catch (e) {
    console.error("/api/admin/order error:", e);
    res.status(500).json({ error: "internal" });
  }
});
// Marcar / desmarcar como impreso
app.post("/api/admin/order/:id/printed", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const db = await getDb();
    const r = await db.collection("conversations").updateOne(
      { _id: new ObjectId(id) },
      { $set: { printedAt: new Date() } }
    );
    if (!r.matchedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, printedAt: new Date() });
  } catch (e) {
    console.error("/api/admin/order/:id/printed error:", e);
    res.status(500).json({ error: "internal" });
  }
});
app.post("/api/admin/order/:id/unprinted", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const db = await getDb();
    const r = await db.collection("conversations").updateOne(
      { _id: new ObjectId(id) },
      { $unset: { printedAt: "" } }
    );
    if (!r.matchedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("/api/admin/order/:id/unprinted error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// UI: vista del pedido + formato impresión (comandera 80mm)
app.get("/admin/order/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const isPrint = req.query.print === "1";
    const db = await getDb();
    const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
    if (!conv) return res.status(404).send("not_found");
    if (!conv.lastPedido) return res.status(404).send("Esta conversación no tiene pedido final.");
    const ord = normalizeOrder(conv.waId, conv.contactName, conv.lastPedido);

    const fmtDate = conv.openedAt ? new Date(conv.openedAt).toLocaleString() : "-";
    const itemsHtml = (ord.items || []).map(it =>
      `<tr><td>${it.cantidad}</td><td>${it.descripcion}</td><td class="num">${it.importe_unitario?.toLocaleString?.('es-AR') ?? it.importe_unitario}</td><td class="num">${it.total?.toLocaleString?.('es-AR') ?? it.total}</td></tr>`
    ).join("");
    const totalStr = (ord.amount || 0).toLocaleString('es-AR');

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html><head>
  <meta charset="utf-8"/><title>Pedido ${id}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    :root{--w:80mm}
    body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:${isPrint?'0':'20px'}}
    .wrap{max-width:${isPrint?'var(--w)':'720px'};margin:0 auto}
    h1,h2,h3{margin:.25rem 0}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #ddd;padding:6px}
    th{background:#f5f5f5;text-align:left}
    .num{text-align:right}
    .muted{color:#666;font-size:.9em}
    .row{display:flex;gap:8px;align-items:center;margin:.5rem 0}
    .btn{padding:.35rem .6rem;border:1px solid #555;background:#fff;cursor:pointer;border-radius:4px}
    @media print{
      @page{size: ${isPrint?'80mm auto':'auto'}; margin:${isPrint?'4mm':'10mm'}}
      .noprint{display:none!important}
      body{margin:0}
      th,td{border:0;padding:2px 0}
      table{border:0}
      .card{border:0}
    }
    .ticket{
      border:${isPrint?'0':'1px solid #ddd'};
      padding:${isPrint?'0 6px':'12px'};
    }
    .hdr{display:flex;justify-content:space-between;align-items:flex-start}
    .big{font-size:1.1rem;font-weight:600}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="row noprint">
      <button class="btn" onclick="window.print()">Imprimir</button>
      <a class="btn" href="/api/admin/order/${id}" target="_blank">Ver JSON</a>
      <a class="btn" href="/admin" target="_self">Volver</a>
      ${conv.printedAt
        ? `<button class="btn" onclick="fetch('/api/admin/order/${id}/unprinted',{method:'POST'}).then(()=>location.reload())">Desmarcar impreso</button>`
        : `<button class="btn" onclick="fetch('/api/admin/order/${id}/printed',{method:'POST'}).then(()=>location.reload())">Marcar impreso</button>`
      }
    </div>
    <div class="ticket">
      <div class="hdr">
        <div>
          <div class="big">Rotisería Caryco</div>
          <div class="muted">Pedido de ${ord.name || '-'}</div>
        </div>
        <div class="muted" style="text-align:right">
          <div>${fmtDate}</div>
          <div>ID ${id.slice(-6)}</div>
        </div>
      </div>
      <hr/>
     <div><b>Entrega:</b> ${ord.entrega || '-'}</div>
      ${ord.entrega==='domicilio' ? `<div><b>Domicilio:</b> ${ord.domicilio || '-'}</div>` : ''}
      ${ord.fechaEntrega ? `<div><b>Fecha:</b> ${ord.fechaEntrega}</div>` : ''}
      ${ord.hora ? `<div><b>Hora:</b> ${ord.hora}</div>` : ''}
      <p></p>
      <table>
        <thead><tr><th>Cant</th><th>Descripción</th><th class="num">P. Unit</th><th class="num">Total</th></tr></thead>
        <tbody>${itemsHtml || '<tr><td colspan="4" class="muted">Sin ítems</td></tr>'}</tbody>
        <tfoot><tr><th colspan="3" class="num">TOTAL</th><th class="num">$ ${totalStr}</th></tr></tfoot>
      </table>
      <p class="muted">Estado: ${ord.estadoPedido}</p>
      <p class="muted">Tel: ${conv.waId}</p>
      ${conv.printedAt ? `<p class="muted">Imp: ${new Date(conv.printedAt).toLocaleString()}</p>` : ''}
      <p style="text-align:center">¡Gracias por su compra! 🧾</p>
    </div>
  </div>
  ${isPrint ? '<script>window.onload=()=>window.print()</script>' : ''}
</body></html>`);
  } catch (e) {
    console.error("/admin/order error:", e);
    res.status(500).send("internal");
  }
});



// API: mensajes de una conversación
app.get("/api/admin/messages/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const db = await getDb();
    const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
    if (!conv) return res.status(404).send("not_found");
    const msgs = await db.collection("messages")
      .find({ conversationId: new ObjectId(id) })
      .sort({ ts: 1 })
      .toArray();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Mensajes</title>
      <style>body{font-family:system-ui,Arial;margin:20px}pre{white-space:pre-wrap}</style>
    </head><body>
      <h3>Conv ${conv.waId} — ${new Date(conv.openedAt).toLocaleString()}</h3>
      ${msgs.map(m => (
        '<p><b>'+m.role+'</b> <small>'+new Date(m.ts).toLocaleString()+'</small><br><pre>'+(
          (typeof m.content==='string'?m.content:JSON.stringify(m.content,null,2))
        )+'</pre></p>'
      )).join('')}
    </body></html>`);
  } catch (e) {
    console.error("/api/admin/messages error:", e);
    res.status(500).send("internal");
  }
});

// ---------- WEBHOOK ----------


// Webhook Verify (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook Entrante (POST)
app.post("/webhook", async (req, res) => {
  try {
    if (process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) return res.sendStatus(403);

    const entry = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!entry) return res.sendStatus(200);

    const tenant = resolveTenantId(req);
    const from = entry.from;
    let text = (entry.text?.body || "").trim();

    if (entry.type === "text" && entry.text?.body) {
      text = entry.text.body;
    } else if (entry.type === "audio" && entry.audio?.id) {
      try {
        const info = await getMediaInfo(entry.audio.id);
        const buf = await downloadMediaBuffer(info.url);
        const id = putInCache(buf, info.mime_type || "audio/ogg");
        const publicAudioUrl = `${req.protocol}://${req.get("host")}/cache/audio/${id}`;
        const tr = await transcribeAudioExternal({ publicAudioUrl, buffer: buf, mime: info.mime_type });
        text = String(tr?.text || "").trim() || "(audio sin texto)";
      } catch (e) {
        console.error("Audio/transcripción:", e.message);
        text = "(no se pudo transcribir el audio)";
      }
    }

    if (hasActiveEndedFlag(tenant, from)) {
      if (isPoliteClosingMessage(text)) {
        await require("./logic").sendWhatsAppMessage(from, "¡Gracias! 😊 Cuando quieras hacemos otro pedido.");
        return res.sendStatus(200);
      }
    }

        // ⚡ Fast-path: si el usuario confirma explícitamente, cerramos sin llamar al modelo
    const userConfirms = /\bconfirm(ar|o|a|ame|alo|alo\.?|alo!|ado)\b/i.test(text) || /^si(s|,)?\s*confirm/i.test(text);
    if (userConfirms) {
      // Tomamos último snapshot si existe
      let snapshot = null;
      try { snapshot = JSON.parse(require("./logic").__proto__ ? "{}" : "{}"); } catch {}
      // En minimal guardamos snapshot siempre; si no lo tenés a mano, seguimos y dejamos que el modelo lo complete
    }
        // Persistir mensaje de usuario
    try {
      const conv = await ensureConversation(tenant, from);
      if (conv && conv._id) {
        await (await getDb()).collection("messages").insertOne({
          conversationId: conv._id,
          role: "user",
          content: text,
          ts: new Date(),
         type: entry.type || "text",
          meta: { raw: entry }
        });
      } else {
        console.warn("persist user msg: conversación no disponible aún (conv undefined)");
      }
    } catch (e) { console.warn("persist user msg:", e.message); }

    const gptReply = await getGPTReply(tenant, from, text);

    let responseText = "Perdón, hubo un error. ¿Podés repetir?";
    let estado = null;
    let pedido = null;

    try {
      const parsed = JSON.parse(gptReply);
      estado = parsed.estado;
      pedido = parsed.Pedido || { items: [] };
      // Ítem Envío según distancia (tramos). Si no se puede calcular, cae al Envío genérico.
      let envioItem = await computeEnvioItemForPedido(tenant, pedido);
      if (!envioItem) {
        envioItem = await getEnvioItemFromCatalog(tenant);
      }
      const { pedidoCorr, mismatch, hasItems } = recalcAndDetectMismatch(pedido, { envioItem });
      pedido = pedidoCorr;

      if (mismatch && hasItems) {
        let fixedOk = false;
        let parsedFixLast = null;

        const itemsForModel = (pedido.items || [])
          .map(i => `- ${i.cantidad} x ${i.descripcion} @ ${i.importe_unitario}`)
          .join("\n");

        const baseCorrection = [
          "[CORRECCION_DE_IMPORTES]",
          "Detectamos que los importes de tu JSON no coinciden con la suma de ítems según el catálogo.",
          "Usá EXACTAMENTE estos ítems interpretados por backend (cantidad y precio unitario):",
          itemsForModel,
          `Total esperado por backend (total_pedido): ${pedido.total_pedido}`,
          "Reglas OBLIGATORIAS:",
          "- Recalculá todo DESDE CERO usando esos precios (no arrastres totales previos).",
          "- Si Pedido.Entrega = 'domicilio', DEBES incluir el ítem 'Envio' con el precio del catálogo correspondiente al tramo por distancia.",
          "- Si Pedido.Entrega != 'domicilio', DEBES QUITAR cualquier ítem 'Envio'.",
          "Devolvé UN ÚNICO objeto JSON con: response, estado (IN_PROGRESS|COMPLETED|CANCELLED),",
          "y Pedido { Entrega, Domicilio, items[ {id, descripcion, cantidad, importe_unitario, total} ], total_pedido }.",
          "No incluyas texto fuera del JSON."
        ].join("\n");

        for (let attempt = 1; attempt <= (Number(process.env.CALC_FIX_MAX_RETRIES || 3)); attempt++) {
          const fixReply = await getGPTReply(tenant, from, `${baseCorrection}\n[INTENTO:${attempt}/${process.env.CALC_FIX_MAX_RETRIES || 3}]`);
          console.log(`[fix][${attempt}] assistant.content =>\n${fixReply}`);
          try {
            const parsedFix = JSON.parse(fixReply);
            parsedFixLast = parsedFix;
            estado = parsedFix.estado || estado;

            let pedidoFix = parsedFix.Pedido || { items: [] };
           // const { pedidoCorr: pedidoFixCorr, mismatch: mismatchFix, hasItems: hasItemsFix } = recalcAndDetectMismatch(pedidoFix);
            const { pedidoCorr: pedidoFixCorr, mismatch: mismatchFix, hasItems: hasItemsFix } = recalcAndDetectMismatch(pedidoFix, { envioItem });
            pedido = pedidoFixCorr;

            if (!mismatchFix && hasItemsFix) { fixedOk = true; break; }
          } catch (e2) {
            console.error("Error parse fixReply JSON:", e2.message);
          }
        }

        responseText = fixedOk && parsedFixLast
          ? coalesceResponse(parsedFixLast.response, pedido)
          : buildBackendSummary(pedido);
      } else {
        responseText = coalesceResponse(parsed.response, pedido);
      }
    } catch (e) {
      console.error("Error al parsear/corregir JSON:", e.message);
    }

    try {
      const finalBody = String(responseText ?? "").trim();
      if (!finalBody) {
        if (pedido && Array.isArray(pedido.items) && pedido.items.length > 0) responseText = buildBackendSummary(pedido);
        else responseText = START_FALLBACK;
      }
    } catch {}

    /*   // 🔒 Normalización: si ya está COMPLETED, no vuelvas a preguntar
    if (estado === "COMPLETED") {
      const asks = /¿\s*confirm(a|as|as\?|amos|an)\??/i.test(responseText) || responseText.includes("¿Confirmas?");
      if (asks) {
        const total = (pedido?.total_pedido ?? 0).toLocaleString("es-AR");
        const itemsTxt = (pedido?.items || []).map(i => `${i.cantidad} ${i.descripcion}`).join(", ");
        responseText = `Perfecto, tu pedido quedó confirmado ✅: ${itemsTxt}. Total: ${total}. ¡Gracias!`;
      }
    }*/

    await require("./logic").sendWhatsAppMessage(from, responseText);

    // Persistir mensaje del asistente
    try {
      const conv = await ensureConversation(tenant, from);
      await (await getDb()).collection("messages").insertOne({
        conversationId: conv._id, role: "assistant", content: String(responseText || ""), ts: new Date(), type: "text"
      });
    } catch (e) { console.warn("persist assistant msg:", e.message); }


    try { setAssistantPedidoSnapshot(tenant, from, pedido, estado); } catch {}

    try {
      if (estado === "COMPLETED" || estado === "CANCELLED") {
                // Guardar cierre + pedido en conversación
        try {
          const db = await getDb();
          const conv = await ensureConversation(tenant, from);
          await db.collection("conversations").updateOne(
            { _id: conv._id },
            { $set: { status: estado, closedAt: new Date(), lastPedido: pedido } }
          );
        } catch (e) { console.warn("persist completion:", e.message); }
        markSessionEnded(tenant, from);
      }
    } catch {}

    res.sendStatus(200);
  } catch (e) {
    console.error("POST /webhook error:", e?.message || e);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
