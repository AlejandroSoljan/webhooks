// ========================= app.js (endpoints) =========================
// Mantiene las rutas originales, pero importando la lógica desde logic.js

const express = require("express");
const app = express();
require("dotenv").config();

const {
  // utils
  escapeRegExp,
  // cache/public
  fileCache, getFromCache,
  // behavior/catalog
  BEHAVIOR_SOURCE, loadBehaviorTextFromEnv, loadBehaviorTextFromSheet, loadBehaviorTextFromMongo, saveBehaviorTextToMongo,
  invalidateBehaviorCache,
  // whatsapp
  GRAPH_VERSION, getPhoneNumberId, markAsRead, sendSafeText,
  getMediaInfo, downloadMediaBuffer, transcribeAudioExternal, transcribeImageWithOpenAI, synthesizeTTS, sendAudioLink,
  // db and convo
  ObjectId, ensureOpenConversation, appendMessage, chatWithHistoryJSON, finalizeConversationOnce,
  // extras
 buildSystemPrompt, bumpConversationTokenCounters, putInCache, resetSession, ensureMessageOnce} = require("./logic");

const { getDb } = require("./db");

// Middlewares básicos
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static('public'));

// Firma de Webhook (si corresponde)
const crypto2 = require("crypto");
function isValidSignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");
  if (!appSecret || !signature) return false;
  const hmac = crypto2.createHmac("sha256", appSecret); hmac.update(req.rawBody);
  const expected = "sha256=" + hmac.digest("hex");
  try { return crypto2.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}

// -------- Cache público (binario/tts) --------
app.get("/cache/audio/:id", (req, res) => {
  const item = getFromCache(req.params.id); if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream"); res.setHeader("Cache-Control", "no-store"); res.send(item.buffer);
});
app.get("/cache/image/:id", (req, res) => {
  const item = getFromCache(req.params.id); if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream"); res.setHeader("Cache-Control", "no-store"); res.send(item.buffer);
});
app.get("/cache/tts/:id", (req, res) => {
  const item = getFromCache(req.params.id); if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "audio/mpeg"); res.setHeader("Cache-Control", "no-store"); res.send(item.buffer);
});

// -------- Behavior (UI + API) --------
app.get("/comportamiento", async (req, res) => {
  try {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" /><title>Comportamiento del Bot</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:960px}
      textarea{width:100%;min-height:360px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}
      .row{display:flex;gap:8px;align-items:center}.hint{color:#666;font-size:12px}.tag{padding:2px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px}
      </style></head><body>
      <h1>Comportamiento del Bot</h1>
      <p class="hint">Fuente actual: <span class="tag">${BEHAVIOR_SOURCE}</span>. ${BEHAVIOR_SOURCE !== "mongo" ? 'Para editar aquí, seteá <code>BEHAVIOR_SOURCE=mongo</code> y reiniciá.' : ''}</p>
      <div class="row"><button id="btnReload">Recargar</button>${BEHAVIOR_SOURCE === "mongo" ? '<button id="btnSave">Guardar</button>' : ''}</div>
      <p></p><textarea id="txt"></textarea>
      <script>
        async function load(){ const r=await fetch('/api/behavior'); const j=await r.json(); document.getElementById('txt').value=j.text||''; }
        ${BEHAVIOR_SOURCE === "mongo" ? `async function save(){ const v=document.getElementById('txt').value||''; const r=await fetch('/api/behavior',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v})}); alert(r.ok?'Guardado ✅':'Error al guardar'); } document.getElementById('btnSave').addEventListener('click',save);` : ``}
        document.getElementById('btnReload').addEventListener('click',load); load();
      </script></body></html>`);
  } catch (e) { console.error("/comportamiento error:", e); res.status(500).send("internal"); }
});
app.get("/api/behavior", async (_req, res) => {
  try {
    const text = (BEHAVIOR_SOURCE === "env") ? await loadBehaviorTextFromEnv() : (BEHAVIOR_SOURCE === "mongo") ? await loadBehaviorTextFromMongo() : await loadBehaviorTextFromSheet();
    res.json({ source: BEHAVIOR_SOURCE, text });
  } catch { res.status(500).json({ error: "internal" }); }
});
app.post("/api/behavior", async (req, res) => {
  try {
    if (BEHAVIOR_SOURCE !== "mongo") return res.status(400).json({ error: "behavior_source_not_mongo" });
    const text = String(req.body?.text || "").trim(); await saveBehaviorTextToMongo(text); res.json({ ok: true });
  } catch (e) { console.error("POST /api/behavior error:", e); res.status(500).json({ error: "internal" }); }
});
app.post("/api/behavior/refresh-cache", async (_req, res) => {
  try { invalidateBehaviorCache(); res.json({ ok: true, cache: "invalidated" }); }
  catch (e) { console.error("refresh-cache error:", e); res.status(500).json({ error: "internal" }); }
});

// -------- Productos (CRUD + vista) --------
app.get("/api/products", async (req, res) => {
  try {
    const db = await getDb();
    const q = req.query.all === "true" ? {} : { active: { $ne: false } };
    const items = await db.collection("products").find(q).sort({ createdAt: -1, descripcion: 1 }).toArray();
    res.json(items.map(it => ({ ...it, _id: String(it._id) })));
  } catch (e) { console.error("GET /api/products error:", e); res.status(500).json({ error: "internal" }); }
});
app.post("/api/products", async (req, res) => {
  try {
    const db = await getDb();
    let { descripcion, importe, observacion, active } = req.body || {};
    descripcion = String(descripcion || "").trim(); observacion = String(observacion || "").trim(); if (typeof active !== "boolean") active = !!active;
    let imp = null; if (typeof importe === "number") imp = importe; else if (typeof importe === "string") { const n = Number(importe.replace(/[^\d.,-]/g, "").replace(",", ".")); imp = Number.isFinite(n) ? n : null; }
    if (!descripcion) return res.status(400).json({ error: "descripcion requerida" });
    const now = new Date(); const doc = { descripcion, observacion, active, createdAt: now, updatedAt: now }; if (imp !== null) doc.importe = imp;
    const ins = await db.collection("products").insertOne(doc); invalidateBehaviorCache(); res.json({ ok: true, _id: String(ins.insertedId) });
  } catch (e) { console.error("POST /api/products error:", e); res.status(500).json({ error: "internal" }); }
});
app.put("/api/products/:id", async (req, res) => {
  try {
    const db = await getDb(); const { id } = req.params; const upd = {};
    ["descripcion","observacion","active","importe"].forEach(k => { if (req.body[k] !== undefined) upd[k] = req.body[k]; });
    if (upd.importe !== undefined) { const v = upd.importe; if (typeof v === "string") { const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", ".")); upd.importe = Number.isFinite(n) ? n : undefined; } }
    if (Object.keys(upd).length === 0) return res.status(400).json({ error: "no_fields" }); upd.updatedAt = new Date();
    const result = await db.collection("products").updateOne({ _id: new ObjectId(String(id)) }, { $set: upd });
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    invalidateBehaviorCache(); res.json({ ok: true });
  } catch (e) { console.error("PUT /api/products/:id error:", e); res.status(500).json({ error: "internal" }); }
});
app.delete("/api/products/:id", async (req, res) => {
  try {
    const db = await getDb(); const { id } = req.params;
    const result = await db.collection("products").deleteOne({ _id: new ObjectId(String(id)) });
    if (!result.deletedCount) return res.status(404).json({ error: "not_found" });
    invalidateBehaviorCache(); res.json({ ok: true });
  } catch (e) { console.error("DELETE /api/products/:id error:", e); res.status(500).json({ error: "internal" }); }
});
app.post("/api/products/:id/inactivate", async (req, res) => {
  try {
    const db = await getDb(); const { id } = req.params;
    const result = await db.collection("products").updateOne({ _id: new ObjectId(String(id)) }, { $set: { active: false, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" }); invalidateBehaviorCache(); res.json({ ok: true });
  } catch (e) { console.error("POST /api/products/:id/inactivate error:", e); res.status(500).json({ error: "internal" }); }
});
app.post("/api/products/:id/reactivate", async (req, res) => {
  try {
    const db = await getDb(); const { id } = req.params;
    const result = await db.collection("products").updateOne({ _id: new ObjectId(String(id)) }, { $set: { active: true, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" }); invalidateBehaviorCache(); res.json({ ok: true });
  } catch (e) { console.error("POST /api/products/:id/reactivate error:", e); res.status(500).json({ error: "internal" }); }
});
app.get("/productos", async (req, res) => {
  try {
    const db = await getDb(); if (!db) throw new Error("DB no inicializada");
    const verTodos = req.query.all === "true"; const filtro = verTodos ? {} : { active: { $ne: false } };
    const productos = await db.collection("products").find(filtro).sort({ createdAt: -1 }).toArray();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" /><title>Productos</title><meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:1100px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;vertical-align:top}th{background:#f5f5f5;text-align:left}input[type="text"],input[type="number"],textarea{width:100%;box-sizing:border-box}textarea{min-height:56px}.row{display:flex;gap:8px;align-items:center}.muted{color:#666;font-size:12px}.pill{border:1px solid #ccc;border-radius:999px;padding:2px 8px;font-size:12px}.btn{padding:6px 10px;border:1px solid #333;background:#fff;border-radius:4px;cursor:pointer}.btn + .btn{margin-left:6px}</style>
      </head><body><h1>Productos</h1><p class="muted">Fuente: <span class="pill">MongoDB (colección <code>products</code>)</span></p>
      <div class="row"><a class="btn" href="/productos${verTodos ? "" : "?all=true"}">${verTodos ? "Ver solo activos" : "Ver todos"}</a> <button id="btnAdd" class="btn">Agregar</button> <button id="btnReload" class="btn">Recargar</button></div>
      <p></p><table id="tbl"><thead><tr><th>Descripción</th><th>Importe</th><th>Observación</th><th>Activo</th><th>Acciones</th></tr></thead>
      <tbody>${productos.map(p => `<tr data-id="${p._id}"><td><input class="descripcion" type="text" value="${(p.descripcion||'').replace(/\"/g,'&quot;')}"/></td><td><input class="importe" type="number" step="0.01" value="${p.importe ?? ''}"/></td><td><textarea class="observacion">${(p.observacion||'').replace(/</g,'&lt;')}</textarea></td><td><input class="active" type="checkbox" ${p.active!==false?'checked':''}/></td><td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">${p.active!==false?'Inactivar':'Reactivar'}</button></td></tr>`).join('')}</tbody></table>
      <template id="row-tpl"><tr data-id=""><td><input class="descripcion" type="text"/></td><td><input class="importe" type="number" step="0.01"/></td><td><textarea class="observacion"></textarea></td><td><input class="active" type="checkbox" checked/></td><td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">Inactivar</button></td></tr></template>
      <script>function q(s,c){return(c||document).querySelector(s)}function all(s,c){return Array.from((c||document).querySelectorAll(s))}async function j(url,opts){const r=await fetch(url,opts||{});if(!r.ok) throw new Error('HTTP '+r.status);const ct=r.headers.get('content-type')||'';return ct.includes('application/json')?r.json():r.text()}async function reload(){const url=new URL(location.href);const allFlag=url.searchParams.get('all')==='true';const data=await j('/api/products'+(allFlag?'?all=true':''));const tb=q('#tbl tbody');tb.innerHTML='';for(const it of data){const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);tr.dataset.id=it._id||'';q('.descripcion',tr).value=it.descripcion||'';q('.importe',tr).value=typeof it.importe==='number'?it.importe:(it.importe||'');q('.observacion',tr).value=it.observacion||'';q('.active',tr).checked=it.active!==false;q('.toggle',tr).textContent=(it.active!==false)?'Inactivar':'Reactivar';bindRow(tr);tb.appendChild(tr);}if(!data.length){const r=document.createElement('tr');r.innerHTML='<td colspan="5" style="text-align:center;color:#666">Sin productos para mostrar</td>';tb.appendChild(r);}}async function saveRow(tr){const id=tr.dataset.id;const payload={descripcion:q('.descripcion',tr).value.trim(),importe:q('.importe',tr).value.trim(),observacion:q('.observacion',tr).value.trim(),active:q('.active',tr).checked};if(!payload.descripcion){alert('Descripción requerida');return;}if(id){await j('/api/products/'+encodeURIComponent(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}else{await j('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}await reload();}async function deleteRow(tr){const id=tr.dataset.id;if(!id){tr.remove();return;}if(!confirm('¿Eliminar definitivamente?')) return;await j('/api/products/'+encodeURIComponent(id),{method:'DELETE'});await reload();}async function toggleRow(tr){const id=tr.dataset.id;if(!id){alert('Primero guardá el nuevo producto.');return;}const active=q('.active',tr).checked;const path=active?('/api/products/'+encodeURIComponent(id)+'/inactivate'):('/api/products/'+encodeURIComponent(id)+'/reactivate');await j(path,{method:'POST'});await reload();}function bindRow(tr){q('.save',tr).addEventListener('click',()=>saveRow(tr));q('.del',tr).addEventListener('click',()=>deleteRow(tr));q('.toggle',tr).addEventListener('click',()=>toggleRow(tr));}all('#tbl tbody tr').forEach(bindRow);document.getElementById('btnReload').addEventListener('click',reload);document.getElementById('btnAdd').addEventListener('click',()=>{const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);q('#tbl tbody').prepend(tr);bindRow(tr);});</script>
      </body></html>`);
  } catch (e) { console.error("/productos error:", e); res.status(500).send("internal"); }
});

// -------- Admin (conversaciones / mensajes / órdenes / impresión) --------
app.get("/admin", async (_req, res) => {
  try {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<!doctype html>\n<html>\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n  <title>Admin - Conversaciones</title>\n  <style>\n    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:1100px}\n    table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;vertical-align:top}th{background:#f5f5f5;text-align:left}\n    .btn{padding:6px 10px;border:1px solid #333;background:#fff;border-radius:4px;cursor:pointer}.btn + .btn{margin-left:6px}\n    .muted{color:#666;font-size:12px} .tag{padding:2px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px}\n    .no-print{display:block}@media print{.no-print{display:none}}\n  </style>\n</head>\n<body>\n  <h1>Admin - Conversaciones</h1>\n  <div class=\"muted\">Actualiza la p\u00e1gina para refrescar.</div>\n  <div class=\"no-print\" style=\"margin:8px 0 12px;\">\n    <label>Filtrar: </label>\n    <select id=\"filterProcessed\" class=\"btn\" onchange=\"loadConversations()\">\n      <option value=\"\">Todas</option>\n      <option value=\"false\">No procesadas</option>\n      <option value=\"true\">Procesadas</option>\n    </select>\n  </div>\n  <table id=\"tbl\">\n    <thead>\n      <tr><th>Tel\u00e9fono</th><th>Nombre</th><th>Estado</th><th>Inicio</th><th>Cierre</th><th>Turnos</th><th>Proc.</th><th>Acciones</th></tr>\n    </thead>\n    <tbody></tbody>\n  </table>\n  <script>\n    async function loadConversations(){\n      const sel=document.getElementById(\"filterProcessed\");\n      const p=sel? sel.value : \"\";\n      const url=p? (\"/api/admin/conversations?processed=\"+encodeURIComponent(p)) : \"/api/admin/conversations\";\n      const r=await fetch(url); const data=await r.json();\n      const tb=document.querySelector(\"#tbl tbody\"); tb.innerHTML=\"\";\n      for(const row of data){\n        const tr=document.createElement(\"tr\");\n        tr.innerHTML = \"<td>\"+(row.waId||\"\")+\"</td>\" +\n          \"<td>\"+(row.contactName||\"\")+\"</td>\" +\n          \"<td><span class=\\\"tag \"+row.status+\"\\\">\"+row.status+\"</span></td>\" +\n          \"<td>\"+(row.openedAt?new Date(row.openedAt).toLocaleString():\"\")+\"</td>\" +\n          \"<td>\"+(row.closedAt?new Date(row.closedAt).toLocaleString():\"\")+\"</td>\" +\n          \"<td>\"+(row.turns??0)+\"</td>\" +\n          \"<td>\"+(row.processed?\"\u2705\":\"\u2014\")+\"</td>\" +\n          \"<td>\"+\n            \"<button class=\\\"btn\\\" onclick=\\\"openMessages(\\'\"+row._id+\"\\')\\\">Mensajes</button>\"+\n            \"<button class=\\\"btn\\\" onclick=\\\"openOrder(\\'\"+row._id+\"\\')\\\">Pedido</button>\"+\n            \"<button class=\\\"btn\\\" onclick=\\\"markProcessed(\\'\"+row._id+\"\\')\\\">Procesado</button>\"+\n            \"<select id=\\\"pm-\"+row._id+\"\\\" class=\\\"btn\\\"><option value=\\\"kitchen\\\">Cocina</option><option value=\\\"client\\\">Cliente</option><option value=\\\"invoice\\\">Factura</option></select>\"+\n            \"<button class=\\\"btn\\\" onclick=\\\"printTicketOpt(\\'\"+row._id+\"\\')\\\">Imprimir</button>\"+\n          \"</td>\";\n        tb.appendChild(tr);\n      }\n    }\n    async function openMessages(id){ window.open(\"/api/admin/messages/\"+encodeURIComponent(id), \"_blank\"); }\n    async function openOrder(id){ const r=await fetch(\"/api/admin/order/\"+encodeURIComponent(id)); const j=await r.json(); alert(JSON.stringify(j,null,2)); }\n    async function markProcessed(id){ await fetch(\"/api/admin/order/\"+encodeURIComponent(id)+\"/process\", {method:\"POST\"}); await loadConversations(); }\n    async function printTicketOpt(id){ const v=document.getElementById(\"pm-\"+id).value; window.open(\"/admin/print/\"+encodeURIComponent(id)+\"?v=\"+encodeURIComponent(v), \"_blank\"); }\n    loadConversations();\n  </script>\n</body>\n</html>");
  } catch (e) { res.status(500).send("internal"); }
});

app.get("/api/admin/conversations", async (req, res) => {
  try {
    const db = await getDb(); const q = {}; const { processed, phone, status, date_field, from, to } = req.query;
    if (typeof processed === "string") { if (processed === "true") q.processed = true; else if (processed === "false") q.processed = { $ne: true }; }
    if (phone && String(phone).trim()) { const esc = escapeRegExp(String(phone).trim()); q.waId = { $regex: esc, $options: "i" }; }
    if (status && String(status).trim()) { q.status = String(status).trim().toUpperCase(); }
    // filtros de fecha (simple)
    if (date_field && (from || to)) {
      const f = {}; if (from) f.$gte = new Date(from); if (to) f.$lte = new Date(to);
      if (Object.keys(f).length) q[date_field] = f;
    }
    const list = await db.collection("conversations").find(q).sort({ openedAt: -1 }).limit(300).toArray();
    res.json(list.map(x => ({ ...x, _id: String(x._id) })));
  } catch (e) { console.error("/api/admin/conversations error:", e); res.status(500).json({ error: "internal" }); }
});
app.get("/api/admin/messages/:id", async (req, res) => {
  try {
    const id = req.params.id; const db = await getDb();
    const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) }); if (!conv) return res.status(404).send("not_found");
    const msgs = await db.collection("messages").find({ conversationId: new ObjectId(id) }).sort({ ts: 1 }).toArray();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" /><title>Mensajes - ${conv.waId}</title><style>body{font-family:system-ui,-apple-system,Arial,sans-serif;margin:24px}.msg{margin-bottom:12px}.role{font-weight:bold}.meta{color:#666;font-size:12px}pre{background:#f6f6f6;padding:8px;border-radius:4px;overflow:auto}</style></head><body><h2>Mensajes - ${conv.contactName ? (conv.contactName + " • ") : ""}${conv.waId}</h2><div>${msgs.map(m => `<div class="msg"><div class="role">${m.role.toUpperCase()} <span class="meta">(${new Date(m.ts).toLocaleString()})</span></div><pre>${(m.content||"").replace(/[<>&]/g,s=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>${m.meta&&Object.keys(m.meta).length?`<div class="meta">meta: <code>${JSON.stringify(m.meta)}</code></div>`:""}</div>`).join("")}</div></body></html>`);
  } catch (e) { console.error("/api/admin/messages error:", e); res.status(500).send("internal"); }
});
app.get("/api/admin/order/:id", async (req, res) => {
  try {
    const id = req.params.id; const db = await getDb(); const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) }); if (!conv) return res.status(404).json({ error: "not_found" });
    let order = await db.collection("orders").findOne({ conversationId: new ObjectId(id) });
    if (!order && conv.summary?.Pedido) order = require("./logic").normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
    res.json({ waId: conv.waId, order: order ? { name: order.name || conv.contactName || "", entrega: order.entrega || "", domicilio: order.domicilio || "", items: order.items || [], amount: order.amount ?? null, estadoPedido: order.estadoPedido || "", fechaEntrega: order.fechaEntrega || "", hora: order.hora || "", processed: !!order.processed } : null, rawPedido: conv.summary?.Pedido || null });
  } catch (e) { console.error("/api/admin/order error:", e); res.status(500).json({ error: "internal" }); }
});
app.post("/api/admin/order/:id/process", async (req, res) => {
  try {
    const id = req.params.id; const db = await getDb(); const convId = new ObjectId(id);
    const upd = await db.collection("orders").updateOne({ conversationId: convId }, { $set: { processed: true, processedAt: new Date() } }, { upsert: true });
    res.json({ ok: true, upserted: !!upd.upsertedId });
  } catch (e) { console.error("/api/admin/order/:id/process error:", e); res.status(500).json({ error: "internal" }); }
});
app.get("/admin/print/:id", async (req, res) => {
  try {
    const id = req.params.id; const db = await getDb(); const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) }); if (!conv) return res.status(404).send("not_found");
    let order = await db.collection("orders").findOne({ conversationId: new ObjectId(id) }); if (!order && conv.summary?.Pedido) order = require("./logic").normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
    const v = (req.query.v || "kitchen");
    const html = `<!doctype html><html><head><meta charset="utf-8" /><title>${v==='invoice'?'Factura':'Ticket'}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px}.printable{max-width:480px}.muted{color:#666}.hr{height:1px;background:#ddd;margin:12px 0}</style></head><body><div class="printable"><div>${v==='invoice'?"¡Gracias por su compra!":"TICKET COCINA"}</div><div class="hr"></div><button class="noprint" onclick="window.print()">Imprimir</button></div></body></html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html);
  } catch (e) { console.error("/admin/print error:", e); res.status(500).send("internal"); }
});

// -------- Webhook WhatsApp --------
app.get("/webhook", (req, res) => { // verificación
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"]; const token = req.query["hub.verify_token"]; const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === verifyToken) return res.status(200).send(challenge);
  return res.sendStatus(403);
});
app.post("/webhook", async (req, res) => {
  try {
    if (process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) return res.sendStatus(403);
    const body = req.body; if (body.object !== "whatsapp_business_account") return res.sendStatus(404);
    res.sendStatus(200); // responder rápido
    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {}; const messages = value.messages || []; const contactName = value?.contacts?.[0]?.profile?.name || null;
        if (!messages.length) continue;
        for (const msg of messages) {
          const from = msg.from; const type = msg.type; const messageId = msg.id;
          const phoneNumberIdForRead = getPhoneNumberId(value); if (messageId && phoneNumberIdForRead) markAsRead(messageId, phoneNumberIdForRead).catch(()=>{});
          // asegurar conversación
          const conv = await ensureOpenConversation(from, { contactName });
          await appendMessage(conv._id, { role: "user", content: JSON.stringify(msg), type: type || "text", meta: { raw: true } });
          // soportar texto / audio / imagen con OCR
          let userText = "";
          if (type === "text" && msg.text?.body) userText = msg.text.body;
          else if (type === "audio" && msg.audio?.id) {
            try {
              const info = await getMediaInfo(msg.audio.id);
              const buf = await downloadMediaBuffer(info.url);
              const id = putInCache(buf, info.mime_type || "audio/ogg");
              const publicAudioUrl = `${req.protocol}://${req.get('host')}/cache/audio/${id}`;
              const { text } = await transcribeAudioExternal({ publicAudioUrl, buffer: buf, mime: info.mime_type });
              userText = text || "(audio sin texto)";
            } catch (e) { userText = "(no se pudo transcribir el audio)"; }
          } else if (type === "image" && msg.image?.id) {
            try {
              const info = await getMediaInfo(msg.image.id);
              const buf = await downloadMediaBuffer(info.url);
              const id = putInCache(buf, info.mime_type || "image/jpeg");
              const publicUrl = `${req.protocol}://${req.get('host')}/cache/image/${id}`;
              const txt = await transcribeImageWithOpenAI(publicUrl);
              userText = txt || "(sin texto detectable)";
            } catch (e) { userText = "(no se pudo leer la imagen)"; }
          } else {
            userText = "(mensaje no soportado)";
          }

          // Chat con historial
          const { json, content, usage } = await chatWithHistoryJSON(from, userText);
          // guardar respuesta del asistente
          const textToSend = (json && json.response) ? String(json.response) : String(content || "").slice(0, 4096);
          await appendMessage(conv._id, { role: "assistant", content: textToSend, type: "text" });
          if (usage) await bumpConversationTokenCounters(conv._id, usage, "assistant");
          await sendSafeText(from, textToSend, value);

          // Finalización (COMPLETED/CANCELLED)
          const estado = json?.estado;
          if (estado === "COMPLETED" || estado === "CANCELLED") {
            await finalizeConversationOnce(conv._id, json, estado);
            resetSession(from); // ← limpia el historial para que la próxima consulta arranque de cero
          }
        }
      }
    }
  } catch (e) { console.error("POST /webhook error:", e); /* 200 ya enviado */ }
});

// -------- Inicio --------
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`✅ API escuchando en :${PORT}`));
}

module.exports = app;
