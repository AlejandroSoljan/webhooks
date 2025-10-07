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

// ⬇️ Para páginas y formularios simples (admin)
const path = require("path");
app.use(express.urlencoded({ extended: true }));

const {
  loadBehaviorTextFromMongo,
  loadBehaviorConfigFromMongo,
  invalidateBehaviorCache,
  getGPTReply, hasActiveEndedFlag, markSessionEnded, isPoliteClosingMessage,
  START_FALLBACK, buildBackendSummary, coalesceResponse, recalcAndDetectMismatch,
  hydratePricesFromCatalog,
  putInCache, getFromCache, getMediaInfo, downloadMediaBuffer, transcribeAudioExternal,
  DEFAULT_TENANT_ID, setAssistantPedidoSnapshot, calcularDistanciaKm,
  geocodeAddress, getStoreCoords, pickEnvioProductByDistance,
  ensureEnvioSmart,
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

// ---------- LOGS: helpers ----------
const withTenant = (q = {}, tenantArg) => {
  const out = { ...q };
  const tid = (tenantArg || TENANT_ID || "").trim();
  if (tid) out.tenantId = tid;
  return out;
};

async function saveLog(entry) {
  try {
    const db = await getDb();
    const doc = {
      tenantId: (tenant || null),
      waId: entry.waId || null,
      role: entry.role,             // 'user' | 'assistant' | 'system'
      content: entry.content ?? "",
      payload: entry.payload ?? null, // cualquier JSON extra (Pedido/estado/trace)
    createdAt: new Date()
    };
    await db.collection("logs").insertOne(doc);
  } catch (e) {
    console.error("[logs] saveLog error:", e);
  }
}

 
// ================== Persistencia de conversaciones y mensajes ==================
// ================== Persistencia de conversaciones y mensajes ==================
async function upsertConversation(waId, attrs = {}, tenantArg) {
  const db = await getDb();
  const now = new Date();
  const filter = withTenant({ waId: String(waId || "").trim() }, tenantArg);
  const update = {
    $setOnInsert: {
      openedAt: now,
      status: "IN_PROGRESS",
      finalized: false,
      waId: String(waId || "").trim(),
      tenantId: (tenant || null)
    },
    $set: {
      updatedAt: now,      ...((tenantArg || TENANT_ID) ? { tenantId: (tenantArg || TENANT_ID) } : {}),
      ...("contactName" in attrs ? { contactName: attrs.contactName } : {})
    }
  };
  const opt = { upsert: true, returnDocument: "after" };
  const res = await db.collection("conversations").findOneAndUpdate(filter, update, opt);
  return res.value;
}

async function saveMessageDoc({ conversationId, waId, role, content, type = "text", meta = {}, tenantId }) {
  const db = await getDb();
  const now = new Date();
  const doc = {
    tenantId: (tenantId || TENANT_ID || null),
    conversationId: new ObjectId(String(conversationId)),
    waId: String(waId || ""),
    role: String(role),
    content: String(content ?? ""),
    type: String(type || "text"),
    meta: { ...meta },
    ts: now,
    createdAt: now
  };
  await db.collection("messages").insertOne(doc);
   const set = role === "user"
   ? { lastUserTs: now, updatedAt: now }
   : { lastAssistantTs: now, updatedAt: now };
 await db.collection("conversations").updateOne(
   { _id: new ObjectId(String(conversationId)) },
   { $set: { ...set, waId: String(waId || ""), ...((tenantId || TENANT_ID) ? { tenantId: (tenantId || TENANT_ID) } : {}) } }
 );
}



// Listado de conversaciones reales (colección `conversations`)
async function listConversations(limit = 50, tenantArg) {
  const db = await getDb();
  const q = withTenant({}, tenantArg);
  const rows = await db.collection("conversations")
    .find(q)
    .sort({ updatedAt: -1, closedAt: -1, openedAt: -1 })
    .limit(limit)
    .toArray();
  return rows.map(c => ({
    _id: String(c._id),
    waId: c.waId,
     contactName: c.contactName || "-",
     // Si la conversación está finalizada, forzamos COMPLETED para evitar falsos "OPEN"
     status: c.finalized ? "COMPLETED" : (c.status || "OPEN"),
     // Mejor heurística de última actividad
     lastAt: c.lastUserTs || c.lastAssistantTs || c.updatedAt || c.closedAt || c.openedAt

  }));
}

// Mensajes por conversación
// Mensajes por conversación (colección `messages`)
async function getConversationMessagesByConvId(convId, limit = 500, tenantArg) {
  const db = await getDb();
  const filter = withTenant({ conversationId: new ObjectId(String(convId)) }, tenantArg);
  return db.collection("messages")
    .find(filter).sort({ ts: 1, createdAt: 1 }).limit(limit).toArray();
}
async function getConversationMessagesByWaId(waId, limit = 500, tenantArg) {
  const db = await getDb();
  const conv = await db.collection("conversations").findOne(
    withTenant({ waId }, tenantArg),
    { sort: { updatedAt: -1, openedAt: -1 } }
  );
  if (!conv) return [];
  return getConversationMessagesByConvId(conv._id, limit, tenantArg);
}

// ---------- API de logs ----------
// Conversaciones (lista)
app.get("/api/logs/conversations", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "50", 10), 500));
    const rows = await listConversations(limit, resolveTenantId(req));
    res.json(rows);
  } catch (e) {
    console.error("GET /api/logs/conversations error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// Mensajes de una conversación
app.get("/api/logs/messages", async (req, res) => {
  try {
    const { convId, waId } = req.query;
    if (!convId && !waId) return res.status(400).json({ error: "convId or waId is required" });
    const t = resolveTenantId(req);
    const rows = convId
      ? await getConversationMessagesByConvId(convId, 500, t)
      : await getConversationMessagesByWaId(waId, 500, t);
    res.json(rows.map(m => ({
      _id: String(m._id),
      role: m.role,                     // "user" | "assistant" | "system"
      content: m.content,
      type: m.type,
      createdAt: m.ts || m.createdAt
    })));
  } catch (e) {
    console.error("GET /api/logs/messages error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// ---------- Página /admin (HTML liviano) ----------
app.get("/admin", async (req, res) => {
  try {
    const conversations = await listConversations(200, resolveTenantId(req));
    const urlConvId = String(req.query.convId || "");
   
    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Admin | Conversaciones</title>
  <style>
    body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin:20px;}
     header{display:flex; align-items:center; gap:12px; margin-bottom:16px;}
     input,button,select{font-size:14px; padding:6px 8px;}
     table{border-collapse:collapse; width:100%}
     th,td{border:1px solid #ddd; padding:8px; vertical-align:top}
     th{background:#f5f5f5; text-align:left}
     .row{display:flex; gap:16px; align-items:center}
     .muted{color:#666}
     .btn{padding:6px 10px; border:1px solid #333; background:#fff; border-radius:4px; cursor:pointer}

    table{border-collapse:collapse; width:100%; margin-top:12px}
    th,td{border:1px solid #ddd; padding:8px; vertical-align:top; font-size:14px}
    th{background:#f7f7f7; text-align:left}
    .btn{padding:6px 10px; border:1px solid #333; background:#fff; border-radius:6px; cursor:pointer}
    .actions{display:flex; gap:8px}
  </style>
</head>
<body>
  <header>
    <h2>Panel de conversaciones</h2>
  </header>

    <div class="row" style="gap:8px">
     <label>Buscar por waId:&nbsp;<input id="waIdI" placeholder="5493..."/></label>
     <button class="btn" id="btnBuscar">Buscar</button>
     <button class="btn" id="btnReload">Recargar tabla</button>
   </div>
   <p></p>
   <table id="tbl">
     <thead>
       <tr>
         <th>Fecha</th>
         <th>Teléfono</th>
         <th>Nombre</th>
         <th>Estado</th>
         <th>Acciones</th>
       </tr>
     </thead>
     <tbody></tbody>
   </table>
  

  <script>
     function goDetail(id){
      window.open('/admin/messages/' + encodeURIComponent(id), '_blank');
    }
    function openDetail(){
      const sel = document.getElementById('convSel');
      const id = sel ? sel.value : '';
      if(!id){ alert('Elegí una conversación'); return; }
      goDetail(id);
    }
    function goPrint(id){
      window.open('/admin/ticket/' + encodeURIComponent(id), '_blank');
    }
 
    async function reloadTable(){
      try{
        const r = await fetch('/api/logs/conversations?limit=200');
        const data = await r.json();
        // Recontruir tabla
        const tb = document.querySelector('#tbl tbody');
        tb.innerHTML = data.map(c => \`
          <tr>
            <td>\${new Date(c.lastAt||Date.now()).toLocaleString()}</td>
            <td>\${c.waId||'-'}</td>
            <td>\${c.contactName||'-'}</td>
            <td>\${c.status||'-'}</td>
            <td class="actions">
              <button class="btn" onclick="goDetail('\${c._id}')">Detalle</button>
              <button class="btn" onclick="goPrint('\${c._id}')">Imprimir</button>
            </td>
          </tr>\`).join('');
        // Refrescar selector
        const sel = document.getElementById('convSel');
        if(sel){
          sel.innerHTML = data.map(c => {
            const label = \`\${c.waId||'sin waId'} — \${new Date(c.lastAt||Date.now()).toLocaleString()}\${c.contactName ? ' — ' + c.contactName : ''}\`;
            return '<option value=\"'+c._id+'\">'+label+'</option>';
          }).join('');
        }
      }catch(e){ console.error('reloadTable error', e); }
    }
    // Auto-refresh de la tabla cada 10s
    setInterval(reloadTable, 10000);


     function fmt(d){ try{ return new Date(d).toLocaleString(); }catch{ return '-'; } }
     function openDetailByConv(convId){ window.open('/admin/conversation?convId='+encodeURIComponent(convId),'_blank'); }
     function openDetailByWaId(wa){ window.open('/admin/conversation?waId='+encodeURIComponent(wa),'_blank'); }
 
     async function loadTable(){
       const r = await fetch('/api/logs/conversations?limit=200');
       const data = await r.json();
       const tb = document.querySelector('#tbl tbody');
       tb.innerHTML = '';
       for(const c of data){
         const tr = document.createElement('tr');
         tr.innerHTML = \`
           <td>\${fmt(c.lastAt)}</td>
           <td>\${c.waId || '-'}</td>
           <td>\${c.contactName || '-'}</td>
           <td>\${c.status || '-'}</td>
           <td>
             <button class="btn" data-conv="\${c._id}">Detalle</button>
             <button class="btn" data-print="\${c._id}">Imprimir</button>
           </td>\`;
        tb.appendChild(tr);
       }
       // bind
       tb.querySelectorAll('button[data-conv]').forEach(b=>{
         b.addEventListener('click',()=>openDetailByConv(b.getAttribute('data-conv')));
       });
       tb.querySelectorAll('button[data-print]').forEach(b=>{
         b.addEventListener('click',()=>window.open('/admin/conversation?convId='+encodeURIComponent(b.getAttribute('data-print'))+'&print=1','_blank'));
       });
     }
 
     document.getElementById('btnReload').addEventListener('click', loadTable);
     document.getElementById('btnBuscar').addEventListener('click', ()=>{
       const v=(document.getElementById('waIdI').value||'').trim();
       if(!v){ alert('Ingresá un waId'); return; }
       openDetailByWaId(v);
     });
 
     // primera carga y refresco cada 20s para ver conversaciones nuevas
     loadTable();
     setInterval(loadTable, 20000);


  </script>
</body>
</html>`;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("GET /admin error:", e);
    res.status(500).send("Error interno");
  }
});
 // ---------- Ventana de detalle de conversación ----------
 app.get("/admin/conversation", async (req, res) => {
   try {
     const { convId, waId } = req.query;
     if (!convId && !waId) return res.status(400).send("convId o waId requerido");
     const qs = convId ? ("convId="+encodeURIComponent(convId)) : ("waId="+encodeURIComponent(waId));
     // página simple que consume /api/logs/messages y permite imprimir
     res.setHeader("content-type","text/html; charset=utf-8");
     res.end(`<!doctype html><html lang="es"><head>
       <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
       <title>Detalle de conversación</title>
       <style>
         body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin:20px;}
         .msg{border:1px solid #ddd;border-radius:8px;padding:10px;margin-bottom:10px}
         .role-user{background:#f0fafc}
         .role-assistant{background:#f8f6ff}
         small{color:#666}
         pre{white-space:pre-wrap}
         .toolbar{display:flex;gap:8px;margin-bottom:12px}
         .btn{padding:6px 10px; border:1px solid #333; background:#fff; border-radius:4px; cursor:pointer}
       </style></head><body>
       <div class="toolbar">
         <button class="btn" onclick="window.print()">Imprimir</button>
         <button class="btn" onclick="location.reload()">Recargar</button>
       </div>
       <div id="root"></div>
       <script>
         async function load(){
           const r=await fetch('/api/logs/messages?${qs}');
           const data=await r.json();
           const root=document.getElementById('root');
           root.innerHTML='';
           for(const m of data){
             const d=document.createElement('div');
             d.className='msg role-'+m.role;
             const when = new Date(m.createdAt).toLocaleString();
             d.innerHTML='<small>['+when+'] '+m.role+'</small><pre>'+(m.content||'')+'</pre>';
             root.appendChild(d);
           }
           if(!data.length){ root.innerHTML='<p class="muted">Sin mensajes para mostrar</p>'; }
         }
         load();
       </script>
     </body></html>`);
   } catch (e) {
     console.error("GET /admin/conversation error:", e);
     res.status(500).send("Error interno");
   }
 });

// ---------- Ventana separada de mensajes ----------
app.get("/admin/messages/:convId", async (req, res) => {
  try {
    const convId = String(req.params.convId || "").trim();
    if (!convId) return res.status(400).send("convId requerido");
    const msgs = await getConversationMessagesByConvId(convId, 1000);
    const html = `<!doctype html><html><head><meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <title>Mensajes</title>
      <style>
        body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial; margin:16px}
        .msg{border:1px solid #ddd; border-radius:8px; padding:10px; margin-bottom:10px}
        .role-user{background:#f0fafc}.role-assistant{background:#f8f6ff}
        small{color:#666} pre{white-space:pre-wrap; margin:4px 0 0}
      </style></head><body>
      <h3>Mensajes</h3>
      ${msgs.map(m => `
        <div class="msg role-${m.role}">
          <small>[${new Date(m.ts || m.createdAt).toLocaleString()}] ${m.role}</small>
          <pre>${(m.content || "").replace(/</g,"&lt;")}</pre>
        </div>`).join("") || "<em>Sin mensajes</em>"}
      </body></html>`;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("GET /admin/messages error:", e);
    res.status(500).send("Error interno");
 }
});







// ---------- Ticket imprimible (80mm) ----------
app.get("/admin/ticket/:convId", async (req, res) => {
  try {
    const convId = String(req.params.convId || "").trim();
    if (!convId) return res.status(400).send("convId requerido");
    const msgs = await getConversationMessagesByConvId(convId, 1000);
    // Buscar el último JSON válido con Pedido
    let pedido = null, nombre = "", waId = "";
    try {
      // opcional: traer conversación para teléfono/nombre
      const db = await getDb();
      const conv = await db.collection("conversations").findOne(withTenant({ _id: new ObjectId(convId) }));
      waId = conv?.waId || "";
      nombre = conv?.contactName || "";
    } catch {}
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      const s = String(m.content || "").trim();
      try {
        const j = JSON.parse(s);
        if (j && j.Pedido && Array.isArray(j.Pedido.items)) { pedido = j.Pedido; break; }
      } catch {}
    }
    const items = (pedido?.items || []).map(it => ({
      desc: String(it.descripcion||"").trim(),
      qty: Number(it.cantidad||0),
    }));
    const total = Number(pedido?.total_pedido || 0);
    const fecha = new Date().toLocaleString();
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>Ticket</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  @media print { .no-print{display:none} body{margin:0} }
  body{font-family: ui-monospace, Menlo, Consolas, monospace; width: 80mm; margin:0; padding:8px}
  h3{margin:0 0 8px 0; font-size:14px; text-align:center}
  .line{display:flex; justify-content:space-between; font-size:12px; margin:2px 0}
  .sep{border-top:1px dashed #000; margin:6px 0}
  .foot{font-size:11px; text-align:center; margin-top:8px}
  .btn{padding:6px 10px; border:1px solid #333; border-radius:6px; background:#fff; cursor:pointer}
  .warn{font-size:11px; margin-top:6px}
</style></head>
<body>
  <div class="no-print" style="display:flex; gap:8px; margin-bottom:6px">
    <button class="btn" onclick="window.print()">Imprimir</button>
    <button class="btn" onclick="window.close()">Cerrar</button>
  </div>
  <h3>Comanda Cliente</h3>
  <div class="line"><span>Fecha</span><span>${fecha}</span></div>
  <div class="line"><span>Teléfono</span><span>${waId || "-"}</span></div>
  <div class="line"><span>Nombre</span><span>${(nombre||"-")}</span></div>
  <div class="sep"></div>
  ${items.length ? items.map(i => `<div class="line"><span>${i.qty} x ${i.desc}</span><span></span></div>`).join("") : "<div class='line'><em>Sin ítems detectados</em></div>"}
  <div class="sep"></div>
  <div class="line"><strong>Total</strong><strong>$ ${total.toLocaleString("es-AR")}</strong></div>
  ${(items.some(x => /milanesa/i.test(x.desc)) ? `<div class="warn">* Las milanesas se pesan al entregar; el precio se informa al momento de la entrega.</div>` : ``)}
  <div class="foot">¡Gracias por tu compra!</div>
</body></html>`;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("GET /admin/ticket error:", e);
    res.status(500).send("Error interno");
  }
});

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
    let { descripcion, importe, observacion, active } = req.body || {};
    descripcion = String(descripcion || "").trim();
    observacion = String(observacion || "").trim();
    if (typeof active !== "boolean") active = !!active;
    let imp = null;
    if (typeof importe === "number") imp = importe;
    else if (typeof importe === "string") {
      const n = Number(importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      imp = Number.isFinite(n) ? n : null;
    }
    if (!descripcion) return res.status(400).json({ error: "descripcion requerida" });
    const now = new Date();
    const doc = { tenantId: (tenant || null), descripcion, observacion, active, createdAt: now, updatedAt: now };
    if (imp !== null) doc.importe = imp;
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
    ["descripcion","observacion","active","importe"].forEach(k => {
      if (req.body[k] !== undefined) upd[k] = req.body[k];
    });
    if (upd.importe !== undefined && typeof upd.importe === "string") {
      const n = Number(upd.importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      upd.importe = Number.isFinite(n) ? n : undefined;
    }
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
      </style></head><body>
      <h1>Productos</h1>
      <div class="row"><a class="btn" href="/productos${verTodos ? "" : "?all=true"}">${verTodos ? "Ver solo activos" : "Ver todos"}</a> <button id="btnAdd" class="btn">Agregar</button> <button id="btnReload" class="btn">Recargar</button></div>
      <p></p>
      <table id="tbl"><thead><tr><th>Descripción</th><th>Importe</th><th>Obs.</th><th>Activo</th><th>Acciones</th></tr></thead>
      <tbody>${productos.map(p => `<tr data-id="${p._id}">
        <td><input class="descripcion" type="text" value="${(p.descripcion||'').replace(/\"/g,'&quot;')}" /></td>
        <td><input class="importe" type="number" step="0.01" value="${p.importe ?? ''}" /></td>
        <td><textarea class="observacion">${(p.observacion||'').replace(/</g,'&lt;')}</textarea></td>
        <td><input class="active" type="checkbox" ${p.active!==false?'checked':''} /></td>
        <td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">${p.active!==false?'Inactivar':'Reactivar'}</button></td>
      </tr>`).join('')}</tbody></table>
      <template id="row-tpl"><tr data-id="">
        <td><input class="descripcion" type="text" /></td>
        <td><input class="importe" type="number" step="0.01" /></td>
        <td><textarea class="observacion"></textarea></td>
        <td><input class="active" type="checkbox" checked /></td>
        <td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">Inactivar</button></td>
      </tr></template>
      <script>
        function q(s,c){return (c||document).querySelector(s)}function all(s,c){return Array.from((c||document).querySelectorAll(s))}
        async function j(url,opts){const r=await fetch(url,opts||{});if(!r.ok)throw new Error('HTTP '+r.status);const ct=r.headers.get('content-type')||'';return ct.includes('application/json')?r.json():r.text()}
        async function reload(){const url=new URL(location.href);const allFlag=url.searchParams.get('all')==='true';const data=await j('/api/products'+(allFlag?'?all=true':''));const tb=q('#tbl tbody');tb.innerHTML='';for(const it of data){const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);tr.dataset.id=it._id||'';q('.descripcion',tr).value=it.descripcion||'';q('.importe',tr).value=typeof it.importe==='number'?it.importe:(it.importe||'');q('.observacion',tr).value=it.observacion||'';q('.active',tr).checked=it.active!==false;q('.toggle',tr).textContent=(it.active!==false)?'Inactivar':'Reactivar';bindRow(tr);tb.appendChild(tr);}if(!data.length){const r=document.createElement('tr');r.innerHTML='<td colspan="5" style="text-align:center;color:#666">Sin productos para mostrar</td>';tb.appendChild(r);}}
        async function saveRow(tr){const id=tr.dataset.id;const payload={descripcion:q('.descripcion',tr).value.trim(),importe:q('.importe',tr).value.trim(),observacion:q('.observacion',tr).value.trim(),active:q('.active',tr).checked};if(!payload.descripcion){alert('Descripción requerida');return;}if(id){await j('/api/products/'+encodeURIComponent(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}else{await j('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}await reload();}
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
    if (process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) {
      if (process.env.NODE_ENV === "production") return res.sendStatus(403);
      console.warn("⚠️ Webhook: firma inválida (ignorada en dev).");
    }



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

        // Asegurar conversación y guardar mensaje de usuario
    let conv = null;
    try { conv = await upsertConversation(from, {}, tenant); } catch (e) { console.error("upsertConversation:", e?.message); }
    const convId = conv?._id;
    if (convId) {
      try { await saveMessageDoc({ tenantId: tenant, conversationId: convId, waId: from, role: "user", content: text, type: entry.type || "text" }); } catch (e) { console.error("saveMessage(user):", e?.message); }
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
    const gptReply = await getGPTReply(tenant, from, text);
    // También dispara si el usuario pide "total" o está en fase de confirmar
   const wantsDetail = /\b(detalle|detall|resumen|desglose|total|confirm(a|o|ar))\b/i
      .test(String(text || ""));


    let responseText = "Perdón, hubo un error. ¿Podés repetir?";
    let estado = null;
    let pedido = null;

    try {
      const parsed = JSON.parse(gptReply);
      estado = parsed.estado;
      pedido = parsed.Pedido || { items: [] };
      // 💰 Hidratar precios desde catálogo ANTES de recalcular (evita “Pollo entero @ 0”)
      try { pedido = await hydratePricesFromCatalog(pedido, tenant || null); } catch {}
      // 🚚 Asegurar ítem Envío con geocoding/distancia (awaitable, sin race)
      try { pedido = await ensureEnvioSmart(pedido, tenant || null); } catch {}


      const { pedidoCorr, mismatch, hasItems } = recalcAndDetectMismatch(pedido);
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
          "- Si Pedido.Entrega = 'domicilio', DEBES incluir el ítem 'Envio' (id 6, precio 1500).",
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
             // 💰 Rehidratar también en el ciclo de fix
            try { pedidoFix = await hydratePricesFromCatalog(pedidoFix, TENANT_ID || null); } catch {}
         
            const { pedidoCorr: pedidoFixCorr, mismatch: mismatchFix, hasItems: hasItemsFix } = recalcAndDetectMismatch(pedidoFix);
            pedido = pedidoFixCorr;

            if (!mismatchFix && hasItemsFix) { fixedOk = true; break; }
          } catch (e2) {
            console.error("Error parse fixReply JSON:", e2.message);
          }
        }

        responseText = fixedOk && parsedFixLast
          ? coalesceResponse(parsedFixLast.response, pedido)
          // Solo mostrar resumen si el usuario pidió detalle/total/confirmar
          : (wantsDetail ? buildBackendSummary(pedido, { showEnvio: wantsDetail }) : "");
      } else {
        responseText = coalesceResponse(parsed.response, pedido);
      }
    } catch (e) {
      console.error("Error al parsear/corregir JSON:", e.message);
    }

    // Guardar respuesta del asistente (texto que se envía al cliente)
    if (convId) {
      try { await saveMessageDoc({ tenantId: tenant, conversationId: convId, waId: from, role: "assistant", content: responseText, type: "text" }); } catch (e) { console.error("saveMessage(assistant):", e?.message); }
    }

    try {
      const finalBody = String(responseText ?? "").trim();
      if (!finalBody) {
        // No forzar resumen a menos que lo pidan explícitamente
        if (wantsDetail && pedido && Array.isArray(pedido.items) && pedido.items.length > 0) {
          responseText = buildBackendSummary(pedido, { showEnvio: wantsDetail });
        } else {
          // Caer a un prompt breve según el estado, o fallback simple
          responseText = START_FALLBACK;
        }
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

    // 🔎 Añadir/quitar leyenda de milanesas y ocultar 'Envío' si no pidieron detalle
    try {
      const hasMilanesas = (pedido?.items || []).some(i =>
        String(i?.descripcion || "").toLowerCase().includes("milanesa")
      );
      if (!hasMilanesas) {
        // remueve la línea (con o sin asteriscos / variaciones menores)
        responseText = responseText
          .replace(/\*?\s*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega\.\s*\*?/i, "")
          .replace(/\n{3,}/g, "\n\n") // normaliza saltos extra
          .trim();
      } else {
        // si hay milanesas y NO está la leyenda, agregala al final
        if (!/\bse pesan al entregar\b/i.test(responseText)) {
          responseText = `${responseText}\n\n*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega.*`;
        }
      }
      // Ocultar renglones de "Envío" en resúmenes si no pidieron detalle
      if (!wantsDetail) {
        responseText = responseText
          .split("\n")
          .filter(line => !/^\s*-\s*.*env[ií]o/i.test(line))
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }
    } catch {}

    await require("./logic").sendWhatsAppMessage(from, responseText);
    // persistir respuesta del asistente
    if (convId) {
      try {
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "assistant",
          content: responseText,
          type: "text"
        });
      } catch (e) { console.error("saveMessage(assistant):", e?.message); }
    }

    try {
     // 🔹 Distancia + geocoding + Envío dinámico
      let distKm = null;
      if (pedido?.Entrega?.toLowerCase() === "domicilio" && pedido?.Domicilio) {
        const store = getStoreCoords();
        if (store) {
          let { lat, lon } = pedido.Domicilio;

          // Geocodificamos si faltan coords
          if (!(typeof lat === "number" && typeof lon === "number")) {
            const addrParts = [
              pedido.Domicilio.direccion,
              [pedido.Domicilio.calle, pedido.Domicilio.numero].filter(Boolean).join(" "),
              pedido.Domicilio.barrio,
              pedido.Domicilio.ciudad || pedido.Domicilio.localidad,
              pedido.Domicilio.provincia,
              pedido.Domicilio.cp
            ].filter(Boolean);
            const address = addrParts.join(", ").trim();
            if (address) {
              // ➕ Si el usuario solo escribió "Moreno 2862", agregamos localidad por defecto
              const DEF_CITY = process.env.DEFAULT_CITY || "Venado Tuerto";
              const DEF_PROVINCE = process.env.DEFAULT_PROVINCE || "Santa Fe";
              const DEF_COUNTRY = process.env.DEFAULT_COUNTRY || "Argentina";
              const addressFinal = /,/.test(address) ? address : [address, DEF_CITY, DEF_PROVINCE, DEF_COUNTRY].filter(Boolean).join(", ");
              console.log(`[geo] Direccion compilada='${addressFinal}'`);
             
              const geo = await geocodeAddress(addressFinal);
              if (geo) {
                lat = geo.lat; lon = geo.lon;
                pedido.Domicilio.lat = lat;
                pedido.Domicilio.lon = lon;
                console.log(`[geo] OK lat=${lat}, lon=${lon}`);
              } else {
                console.warn("[geo] No hubo resultado de geocoding (¿API key/billing/localidad?)");
          
              }
            }
          }

          // Si ya tenemos coords → calcular distancia
          if (typeof lat === "number" && typeof lon === "number") {
            distKm = calcularDistanciaKm(store.lat, store.lon, lat, lon);
            pedido.distancia_km = distKm;
            console.log(`📍 Distancia calculada al domicilio: ${distKm} km`);

            // Buscar producto de Envío según km
            const db = await getDb();
            const envioProd = await pickEnvioProductByDistance(db, TENANT_ID || null, distKm);
            if (envioProd && typeof envioProd.importe === "number") {
                 console.log(`[envio] Seleccionado por distancia: '${envioProd.descripcion}' @ ${envioProd.importe}`);
            
              const idx = (pedido.items || []).findIndex(i =>
                String(i.descripcion || "").toLowerCase().includes("envio")
              );
              if (idx >= 0) {
                 const cantidad = Number(pedido.items[idx].cantidad || 1);
                const prevImporte = Number(pedido.items[idx].importe_unitario || 0);
                const prevDesc = String(pedido.items[idx].descripcion || "");

                // ✅ Actualizar TODO: id, descripción, unitario y total
                pedido.items[idx].id = envioProd._id || pedido.items[idx].id || 0;
                pedido.items[idx].descripcion = envioProd.descripcion;
                pedido.items[idx].importe_unitario = Number(envioProd.importe);
                pedido.items[idx].total = cantidad * Number(envioProd.importe);

                const changed = (prevImporte !== Number(envioProd.importe)) || (prevDesc !== envioProd.descripcion);
                if (changed) console.log(`[envio] Ajustado item existente: '${prevDesc}' @ ${prevImporte} -> '${envioProd.descripcion}' @ ${envioProd.importe}`);
                } else {
                // 🆕 No existía el item Envío: lo insertamos ahora
                (pedido.items ||= []).push({
                  id: envioProd._id || 0,
                  descripcion: envioProd.descripcion,
                  cantidad: 1,
                  importe_unitario: Number(envioProd.importe),
                  total: Number(envioProd.importe),
                });
                console.log(`[envio] Insertado item envío: '${envioProd.descripcion}' @ ${envioProd.importe}`);
            
              }
              // Recalcular total localmente
              let totalCalc = 0;
              (pedido.items || []).forEach(it => {
                const cant = Number(String(it.cantidad).replace(/[^\d.-]/g,'')) || 0;
                const unit = Number(String(it.importe_unitario).replace(/[^\d.-]/g,'')) || 0;
                it.total = cant * unit;
                totalCalc += it.total;
              });
              pedido.total_pedido = totalCalc;

              // 🔔 (opcional pero útil): si hubo cambio de envío, avisar al cliente con total correcto
            /*  try {
                const totalStr = (Number(pedido.total_pedido)||0).toLocaleString("es-AR");
                await require("./logic").sendWhatsAppMessage(
                  from,
                  `Actualicé el envío según tu dirección (${distKm} km): ${envioProd.descripcion}. Total: $${totalStr}.`
                );
              } catch (e) {
                console.warn("[envio] No se pudo notificar ajuste de envío:", e?.message);
              }*/

            }
          }
        }
      }
      // 🔹 Mantener snapshot del asistente
      setAssistantPedidoSnapshot(tenant, from, pedido, estado);

      // 🔹 Persistir pedido (y distancia) en MongoDB (upsert)
      const db = await require("./db").getDb();
      await db.collection("orders").updateOne(
        { tenantId: (tenant || null), from },
        {
          $set: {
            tenantId: (tenant || null),
            from,
            pedido,
            estado: estado || null,
            distancia_km: typeof pedido?.distancia_km === "number" ? pedido.distancia_km : distKm,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );
    } catch {}
    try {
      if (estado === "COMPLETED" || estado === "CANCELLED") {
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
