// src/web/web_admin.routes.js
// Rutas Web/Admin (productos + comportamiento + horarios).
// Código movido 1:1 desde endpoint.js para facilitar mantenimiento.
// IMPORTANTÍSIMO: no cambia funcionalidad.

module.exports = function mountWebAdminRoutes(app, deps) {
  const {
    getDb,
    ObjectId,
    resolveTenantId,
    TENANT_ID,
    DEFAULT_TENANT_ID,
    // from logic.js
    loadBehaviorConfigFromMongo,
    invalidateBehaviorCache,
    STORE_HOURS_DAYS,
  } = deps;

// GET /api/products  → lista (activos por defecto; ?all=true para todos)
app.get("/api/products", async (req, res) => {
  try {
    const db = await getDb();
    const tenant = resolveTenantId(req);
    const q = req.query.all === "true" ? {} : { active: { $ne: false } };
    if (tenant) q.tenantId = tenant; else if (TENANT_ID) q.tenantId = TENANT_ID;
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
    let { descripcion, importe, cantidad, observacion, active } = req.body || {};
    descripcion = String(descripcion || "").trim();
    observacion = String(observacion || "").trim();
    if (typeof active !== "boolean") active = !!active;
    let imp = null;
    if (typeof importe === "number") imp = importe;
    else if (typeof importe === "string") {
      const n = Number(importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      imp = Number.isFinite(n) ? n : null;
    }
    // cantidad (stock/limite) opcional
    // - si viene vacío, no se guarda
    // - si viene numérico, se guarda como entero
    let qty = null;
    if (typeof cantidad === "number") {
      qty = Number.isFinite(cantidad) ? Math.trunc(cantidad) : null;
    } else if (typeof cantidad === "string") {
      const t = cantidad.trim();
      if (t) {
       // Solo entero (permitimos que el usuario cargue "10" o "10,0")
        const n = parseInt(t.replace(/[^\d-]/g, ""), 10);
        qty = Number.isFinite(n) ? n : null;
      }
    }

    if (!descripcion) return res.status(400).json({ error: "descripcion requerida" });
    const now = new Date();
    const tenant = resolveTenantId(req);
    const doc = { tenantId: (tenant || TENANT_ID || DEFAULT_TENANT_ID || null), descripcion, observacion, active, createdAt: now, updatedAt: now };
     if (qty !== null) doc.cantidad = qty;
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
    ["descripcion","observacion","active","importe","cantidad"].forEach(k => {
      if (req.body[k] !== undefined) upd[k] = req.body[k];
    });
    if (upd.importe !== undefined && typeof upd.importe === "string") {
      const n = Number(upd.importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      upd.importe = Number.isFinite(n) ? n : undefined;
    }
    // cantidad: permitir "" para limpiar (null)
    if (upd.cantidad !== undefined) {
      if (typeof upd.cantidad === "string") {
        const t = upd.cantidad.trim();
        if (!t) {
          upd.cantidad = null;
        } else {
          const n = parseInt(t.replace(/[^\d-]/g, ""), 10);
          upd.cantidad = Number.isFinite(n) ? n : null;
        }
      } else if (typeof upd.cantidad === "number") {
        upd.cantidad = Number.isFinite(upd.cantidad) ? Math.trunc(upd.cantidad) : null;
      } else {
        upd.cantidad = null;
      }
    }
    if (Object.keys(upd).length === 0) return res.status(400).json({ error: "no_fields" });
    upd.updatedAt = new Date();
    const tenant = resolveTenantId(req);
    const filter = { _id: new ObjectId(String(id)) };
    if (tenant) filter.tenantId = tenant; else if (TENANT_ID) filter.tenantId = TENANT_ID;
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
    const tenant = resolveTenantId(req);
    const filter = { _id: new ObjectId(String(id)) };
    if (tenant) filter.tenantId = tenant; else if (TENANT_ID) filter.tenantId = TENANT_ID;
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
    const tenant = resolveTenantId(req);
    const filter = { _id: new ObjectId(String(id)) };
    if (tenant) filter.tenantId = tenant; else if (TENANT_ID) filter.tenantId = TENANT_ID;
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
    const tenant = resolveTenantId(req);
    const filter = { _id: new ObjectId(String(id)) };
    if (tenant) filter.tenantId = tenant; else if (TENANT_ID) filter.tenantId = TENANT_ID;
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
    const tenant = resolveTenantId(req);
    const filtro = verTodos ? {} : { active: { $ne: false } };
    if (tenant) filtro.tenantId = tenant; else if (TENANT_ID) filtro.tenantId = TENANT_ID;
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
      <table id="tbl"><thead><tr><th>Descripción</th><th>Importe</th><th>Cantidad</th><th>Obs.</th><th>Activo</th><th>Acciones</th></tr></thead>
      <tbody>${productos.map(p => `<tr data-id="${p._id}">
        <td><input class="descripcion" type="text" value="${(p.descripcion||'').replace(/\"/g,'&quot;')}" /></td>
        <td><input class="importe" type="number" step="0.01" value="${p.importe ?? ''}" /></td>
        <td><input class="cantidad" type="number" step="1" value="${p.cantidad ?? ''}" /></td>
        <td><textarea class="observacion">${(p.observacion||'').replace(/</g,'&lt;')}</textarea></td>
        <td><input class="active" type="checkbox" ${p.active!==false?'checked':''} /></td>
        <td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">${p.active!==false?'Inactivar':'Reactivar'}</button></td>
      </tr>`).join('')}</tbody></table>
      <template id="row-tpl"><tr data-id="">
        <td><input class="descripcion" type="text" /></td>
        <td><input class="importe" type="number" step="0.01" /></td>
        <td><input class="cantidad" type="number" step="1" /></td>
        <td><textarea class="observacion"></textarea></td>
        <td><input class="active" type="checkbox" checked /></td>
        <td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">Inactivar</button></td>
      </tr></template>
      <script>
        function q(s,c){return (c||document).querySelector(s)}function all(s,c){return Array.from((c||document).querySelectorAll(s))}
        async function j(url,opts){const r=await fetch(url,opts||{});if(!r.ok)throw new Error('HTTP '+r.status);const ct=r.headers.get('content-type')||'';return ct.includes('application/json')?r.json():r.text()}
        async function reload(){const url=new URL(location.href);const allFlag=url.searchParams.get('all')==='true';const data=await j('/api/products'+(allFlag?'?all=true':''));const tb=q('#tbl tbody');tb.innerHTML='';for(const it of data){const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);tr.dataset.id=it._id||'';q('.descripcion',tr).value=it.descripcion||'';q('.importe',tr).value=typeof it.importe==='number'?it.importe:(it.importe||'');q('.cantidad',tr).value=typeof it.cantidad==='number'?it.cantidad:(it.cantidad||'');q('.observacion',tr).value=it.observacion||'';q('.active',tr).checked=it.active!==false;q('.toggle',tr).textContent=(it.active!==false)?'Inactivar':'Reactivar';bindRow(tr);tb.appendChild(tr);}if(!data.length){const r=document.createElement('tr');r.innerHTML='<td colspan="6" style="text-align:center;color:#666">Sin productos para mostrar</td>';tb.appendChild(r);}}
        async function saveRow(tr){const id=tr.dataset.id;const payload={descripcion:q('.descripcion',tr).value.trim(),importe:q('.importe',tr).value.trim(),cantidad:q('.cantidad',tr).value.trim(),observacion:q('.observacion',tr).value.trim(),active:q('.active',tr).checked};if(!payload.descripcion){alert('Descripción requerida');return;}if(id){await j('/api/products/'+encodeURIComponent(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}else{await j('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}await reload();}
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


 
// ================== Horarios de atención (UI L-V) ==================
// Página simple para cargar horarios de lunes a viernes (hasta 2 franjas por día)
app.get("/horarios", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const db = await getDb();
    const _id = `store_hours:${tenant}`;
    const doc = (await db.collection("settings").findOne({ _id })) || {};
    const hours = doc.hours || {};
    const hoursJson = JSON.stringify(hours).replace(/</g, "\\u003c");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" />
      <title>Horarios de atención (${tenant})</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:960px}
        table{border-collapse:collapse;width:100%}
        th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}
        th{background:#f5f5f5}
        input[type=time]{width:100%;box-sizing:border-box;padding:4px}
        input[type=checkbox]{transform:scale(1.1)}
        .row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
        .btn{padding:6px 10px;border-radius:4px;border:1px solid #333;background:#fff;cursor:pointer}
        .btn:active{transform:scale(.97)}
        .hint{color:#555;font-size:13px}
      </style></head><body>
      <h1>Horarios de atención</h1>
      <p class="hint">Configurá las franjas horarias disponibles de <strong>lunes a domingo</strong>. Cada día puede tener hasta dos rangos horarios.</p>
      <div class="row">
        <label>Tenant:&nbsp;<input id="tenant" type="text" value="${tenant.replace(/"/g,'&quot;')}" /></label>
        <button id="btnReload" class="btn">Recargar</button>
        <button id="btnSave" class="btn">Guardar</button>
      </div>
      <table>
        <thead><tr>
          <th>Día</th>
          <th>Habilitado</th>
          <th>Desde 1</th>
          <th>Hasta 1</th>
          <th>Desde 2</th>
          <th>Hasta 2</th>
        </tr></thead>
        <tbody>
          ${STORE_HOURS_DAYS.map(d => `
          <tr data-day="${d.key}">
            <td>${d.label}</td>
            <td style="text-align:center"><input type="checkbox" class="enabled" /></td>
            <td><input type="time" class="from1" /></td>
            <td><input type="time" class="to1" /></td>
            <td><input type="time" class="from2" /></td>
            <td><input type="time" class="to2" /></td>
          </tr>`).join("")}
        </tbody>
      </table>
      <p class="hint">Dejá un día deshabilitado o sin horarios para que no se pueda seleccionar. Los horarios se guardan en el backend y se usarán para validar nuevos pedidos.</p>
      <script>
        const DAYS = ${JSON.stringify(STORE_HOURS_DAYS).replace(/</g,"\\u003c")};

        function setForm(data){
          DAYS.forEach(d => {
            const row = document.querySelector('tr[data-day="'+d.key+'"]');
            if (!row) return;
            const ranges = Array.isArray(data[d.key]) ? data[d.key] : [];
            const r1 = ranges[0] || {};
            const r2 = ranges[1] || {};
            row.querySelector('.enabled').checked = ranges.length > 0;
            row.querySelector('.from1').value = r1.from || "";
            row.querySelector('.to1').value   = r1.to   || "";
            row.querySelector('.from2').value = r2.from || "";
            row.querySelector('.to2').value   = r2.to   || "";
          });
        }

        function collectForm(){
          const out = {};
          DAYS.forEach(d => {
            const row = document.querySelector('tr[data-day="'+d.key+'"]');
            if (!row) return;
            const enabled = row.querySelector('.enabled').checked;
            const f1 = row.querySelector('.from1').value;
            const t1 = row.querySelector('.to1').value;
            const f2 = row.querySelector('.from2').value;
            const t2 = row.querySelector('.to2').value;
            if (!enabled) return;
            const ranges = [];
            if (f1 && t1) ranges.push({ from:f1, to:t1 });
            if (f2 && t2) ranges.push({ from:f2, to:t2 });
            if (ranges.length) out[d.key] = ranges;
          });
          return out;
        }

        async function reloadHours(){
          const t = document.getElementById('tenant').value || '';
          const r = await fetch('/api/hours?tenant=' + encodeURIComponent(t));
          if (!r.ok) { alert('Error recargando horarios'); return; }
          const j = await r.json();
          setForm(j.hours || {});
        }

        async function saveHours(){
          const t = document.getElementById('tenant').value || '';
          const hours = collectForm();
          const r = await fetch('/api/hours', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ tenantId:t, hours })
          });
          if (!r.ok) { alert('Error al guardar'); return; }
          const j = await r.json();
          setForm(j.hours || {});
          alert('Horarios guardados ✅');
        }

        document.getElementById('btnReload').addEventListener('click', reloadHours);
        document.getElementById('btnSave').addEventListener('click', saveHours);
        // Inicializar con lo que vino del servidor
        setForm(${hoursJson});
      </script></body></html>`);
  } catch (e) {
    console.error("/horarios error:", e);
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
    const db = await getDb();
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

// ===================================================================
// ===============      Horarios de atención (L-V)     ================
// ===================================================================
// Permite guardar y leer los horarios disponibles de lunes a viernes.
// Cada día puede tener hasta dos franjas horarias [{ from, to }, ...]
// Formato de hora: "HH:MM" (24h).

function normalizeHoursPayload(raw) {
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday","saturday","sunday"];
  const out = {};
  const isHHMM = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "").trim());

  for (const d of days) {
    const ranges = Array.isArray(raw?.[d]) ? raw[d] : [];
    const normRanges = [];

    for (const r of ranges) {
      if (!r) continue;
      // Soportar tanto { from, to } como { desde, hasta }
      const from = String(r.from ?? r.desde ?? "").trim();
      const to   = String(r.to   ?? r.hasta ?? "").trim();

      // Validar formato y que from < to
      if (!isHHMM(from) || !isHHMM(to)) continue;
      if (from >= to) continue;

      normRanges.push({ from, to });
      // Máximo 2 franjas por día
      if (normRanges.length >= 2) break;
    }

    if (normRanges.length) {
      out[d] = normRanges;
    }
  }

  return out;
}

// GET /api/hours  → devuelve horarios configurados para el tenant actual
app.get("/api/hours", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const db = await getDb();
    const _id = `store_hours:${tenant}`;
    const doc = (await db.collection("settings").findOne({ _id })) || {};

    res.json({
      ok: true,
      tenant,
      hours: doc.hours || {},
      updatedAt: doc.updatedAt || null,
    });
  } catch (e) {
    console.error("GET /api/hours error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/hours  → guarda horarios (sobrescribe los existentes para ese tenant)
app.post("/api/hours", async (req, res) => {
  try {
    const tenant = (req.body?.tenantId || resolveTenantId(req)).toString().trim();
    const hours = normalizeHoursPayload(req.body?.hours || req.body || {});

    const db = await getDb();
    const _id = `store_hours:${tenant}`;
    await db.collection("settings").updateOne(
      { _id },
      { $set: { hours, tenantId: tenant, updatedAt: new Date() } },
      { upsert: true }
    );

    res.json({ ok: true, tenant, hours });
  } catch (e) {
    console.error("POST /api/hours error:", e);
    res.status(500).json({ error: "internal" });
  }
});







};
