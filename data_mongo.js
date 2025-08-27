/**
 * data_mongo_html.js
 * ---------------------------------------------
 * Mongo helpers (products, conversations, orders), Google Sheets,
 * behavior builder, and all HTML/Admin routes.
 * ---------------------------------------------
 */
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
const { google } = require("googleapis");

/* ======================= Productos (Mongo) ======================= */
const PRODUCTS_CACHE_TTL_MS = parseInt(process.env.PRODUCTS_CACHE_TTL_MS || "300000", 10); // 5 min
let productsCache = { at: 0, items: [] };

function normalizeImporte(v) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function loadProductsFromMongo({ force = false } = {}) {
  const now = Date.now();
  if (!force && (now - productsCache.at < PRODUCTS_CACHE_TTL_MS) && productsCache.items?.length) {
    return productsCache.items;
  }
  const db = await getDb();
  const items = await db.collection("products")
    .find({})
    .sort({ descripcion: 1 })
    .toArray();
  productsCache = { at: now, items };
  return items;
}

async function upsertProductMongo(payload) {
  const db = await getDb();
  const _id = payload._id;
  const doc = {
    descripcion: String(payload.descripcion || "").trim(),
    importe: normalizeImporte(payload.importe),
    observacion: String(payload.observacion || "").trim(),
    active: payload.active === false ? false : true,
    updatedAt: new Date()
  };
  if (!doc.descripcion) throw new Error("descripcion es requerida");

  if (_id) {
    await db.collection("products").updateOne(
      { _id: new ObjectId(String(_id)) },
      { $set: doc }
    );
  } else {
    await db.collection("products").updateOne(
      { descripcion: doc.descripcion },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  }
  productsCache = { at: 0, items: [] };
}

async function removeProductMongo(id) {
  const db = await getDb();
  await db.collection("products").deleteOne({ _id: new ObjectId(String(id)) });
  productsCache = { at: 0, items: [] };
}

function buildCatalogTextFromMongo(items) {
  const activos = (items || []).filter(it => it.active !== false);
  if (!activos.length) return "Catálogo de productos: (ninguno activo)";
  const lines = activos.map(it => {
    const precioTxt = (typeof it.importe === "number") ? ` — $${it.importe}` : (it.importe ? ` — $${it.importe}` : "");
    const obsTxt = it.observacion ? ` | Obs: ${it.observacion}` : "";
    return `- ${it.descripcion}${precioTxt}${obsTxt}`;
  });
  return "Catálogo de productos (descripcion — precio | Obs: observaciones):\n" + lines.join("\n");
}

/* ========== Behavior loaders (ENV & Mongo) ========== */
async function loadBehaviorTextFromEnv() {
  return (process.env.COMPORTAMIENTO || 'Sos un asistente claro, amable y conciso. Respondé en español.').trim();
}
async function loadBehaviorTextFromMongo() {
  const db = await getDb();
  const doc = await db.collection('settings').findOne({ _id: 'behavior' });
  if (doc?.text && String(doc.text).trim()) return String(doc.text).trim();
  const fallback = 'Sos un asistente claro, amable y conciso. Respondé en español.';
  await db.collection('settings').updateOne(
    { _id: 'behavior' },
    { $setOnInsert: { text: fallback, updatedAt: new Date() } },
    { upsert: true }
  );
  return fallback;
}

/* ======================= Google Sheets ======================= */
function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Faltan credenciales de Google (email/clave).");
  const auth = new google.auth.JWT(email, null, key, ["https://www.googleapis.com/auth/spreadsheets"]);
  return google.sheets({ version: "v4", auth });
}
function getSpreadsheetIdFromEnv() {
  const raw = (process.env.GOOGLE_SHEETS_ID || "").trim();
  if (!raw) throw new Error("Falta GOOGLE_SHEETS_ID.");
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw;
}
async function ensureHeaderIfEmpty({ sheetName, header }) {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const getResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!1:1` });
  const hasHeader = (getResp.data.values && getResp.data.values.length > 0);
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${sheetName}!A1`, valueInputOption: "RAW",
      requestBody: { values: [header] }
    });
  }
}
async function appendRow({ sheetName, values }) {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: `${sheetName}!A:A`,
    valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] }
  });
}

function headerPedido() {
  return [
    "wa_id","response","Fecha y hora de inicio de conversacion","Fecha y hora fin de conversacion",
    "Estado pedido","Motivo cancelacion","Pedido pollo","Pedido papas","Milanesas comunes","Milanesas Napolitanas",
    "Ensaladas","Bebidas","Monto","Nombre","Entrega","Domicilio","Fecha y hora de entrega","Hora"
  ];
}
function flattenPedido({ waId, response, pedido }) {
  const p = pedido || {};
  return [
    waId || "", response || "",
    p["Fecha y hora de inicio de conversacion"] || "",
    p["Fecha y hora fin de conversacion"] || "",
    p["Estado pedido"] || "", p["Motivo cancelacion"] || "",
    p["Pedido pollo"] || "", p["Pedido papas"] || "",
    p["Milanesas comunes"] || "", p["Milanesas Napolitanas"] || "",
    p["Ensaladas"] || "", p["Bebidas"] || "", p["Monto"] ?? "",
    p["Nombre"] || "", p["Entrega"] || "", p["Domicilio"] || "",
    p["Fecha y hora de entrega"] || "", p["Hora"] || ""
  ];
}
function headerBigdata() {
  return [
    "wa_id","Sexo","Estudios","Satisfaccion del cliente","Motivo puntaje satisfaccion",
    "Cuanto nos conoce el cliente","Motivo puntaje conocimiento","Motivo puntaje general",
    "Perdida oportunidad","Sugerencias","Flujo","Facilidad en el proceso de compras","Pregunto por bot"
  ];
}
function flattenBigdata({ waId, bigdata }) {
  const b = bigdata || {};
  return [
    waId || "", b["Sexo"] || "", b["Estudios"] || "",
    b["Satisfaccion del cliente"] ?? "", b["Motivo puntaje satisfaccion"] || "",
    b["Cuanto nos conoce el cliente"] ?? "", b["Motivo puntaje conocimiento"] || "",
    b["Motivo puntaje general"] || "", b["Perdida oportunidad"] || "",
    b["Sugerencias"] || "", b["Flujo"] || "",
    b["Facilidad en el proceso de compras"] ?? "", b["Pregunto por bot"] || ""
  ];
}
async function saveCompletedToSheets({ waId, data }) {
  const response = data?.response || "";
  const pedido = data?.Pedido || {};
  const bigdata = data?.Bigdata || {};

  const hPedido = headerPedido();
  const vPedido = flattenPedido({ waId, response, pedido });
  await ensureHeaderIfEmpty({ sheetName: "Hoja 1", header: hPedido });
  await appendRow({ sheetName: "Hoja 1", values: vPedido });

  const hBig = headerBigdata();
  const vBig = flattenBigdata({ waId, bigdata });
  await ensureHeaderIfEmpty({ sheetName: "BigData", header: hBig });
  await appendRow({ sheetName: "BigData", values: vBig });
}

/* ======================= Comportamiento (ENV o Mongo + Catálogo) ======================= */
const BEHAVIOR_SOURCE = (process.env.BEHAVIOR_SOURCE || 'mongo').toLowerCase(); // "env" | "mongo"
const COMPORTAMIENTO_CACHE_TTL_MS = 5 * 60 * 1000;
let behaviorCache = { at: 0, text: null };

async function buildSystemPrompt({ force = false } = {}) {
  const now = Date.now();
  if (!force && (now - behaviorCache.at < COMPORTAMIENTO_CACHE_TTL_MS) && behaviorCache.text) {
    return behaviorCache.text;
  }

  // 1) Comportamiento desde ENV o desde Mongo
  const baseText = BEHAVIOR_SOURCE === 'mongo' ? await loadBehaviorTextFromMongo() : await loadBehaviorTextFromEnv();

  // 2) Catálogo desde Mongo
  let catalogText = "";
  try {
    const products = await loadProductsFromMongo({ force });
    catalogText = buildCatalogTextFromMongo(products);
  } catch (e) {
    console.warn("⚠️ No se pudo leer Productos Mongo:", e.message);
    catalogText = "Catálogo de productos: (error al leer)";
  }

  // 3) Reglas de uso de observaciones
  const reglasVenta =
    "Instrucciones de venta (OBLIGATORIAS):\n" +
    "- Usá las Observaciones para decidir qué ofrecer, sugerir complementos, aplicar restricciones o proponer sustituciones.\n" +
    "- Respetá limitaciones (stock/horarios/porciones/preparación) indicadas en Observaciones.\n" +
    "- Si sugerís bundles o combos, ofrecé esas opciones con precio estimado cuando corresponda.\n" +
    "- Si falta un dato (sabor/tamaño/cantidad), pedilo brevemente.\n";

  // 4) Esquema JSON
  const jsonSchema =
    "FORMATO DE RESPUESTA (OBLIGATORIO - SOLO JSON, sin ```):\n" +
    '{ "response": "texto para WhatsApp", "estado": "IN_PROGRESS|COMPLETED|CANCELLED", ' +
    '  "Pedido"?: { "Fecha y hora de inicio de conversacion": string, "Fecha y hora fin de conversacion": string, "Estado pedido": string, "Motivo cancelacion": string, "Pedido pollo": string, "Pedido papas": string, "Milanesas comunes": string, "Milanesas Napolitanas": string, "Ensaladas": string, "Bebidas": string, "Monto": number, "Nombre": string, "Entrega": string, "Domicilio": string, "Fecha y hora de entrega": string, "Hora": string }, ' +
    '  "Bigdata"?: { "Sexo": string, "Estudios": string, "Satisfaccion del cliente": number, "Motivo puntaje satisfaccion": string, "Cuanto nos conoce el cliente": number, "Motivo puntaje conocimiento": string, "Motivo puntaje general": string, "Perdida oportunidad": string, "Sugerencias": string, "Flujo": string, "Facilidad en el proceso de compras": number, "Pregunto por bot": string } }';

  const fullText = [
    "[COMPORTAMIENTO]\n" + baseText,
    "[REGLAS]\n" + reglasVenta,
    "[CATALOGO]\n" + catalogText,
    "[SALIDA]\n" + jsonSchema,
    "RECORDATORIOS: Respondé en español. No uses bloques de código. Devolvé SOLO JSON plano."
  ].join("\n\n").trim();

  behaviorCache = { at: now, text: fullText };
  return fullText;
}

/* ======================= Mongo: conversaciones, mensajes, orders ======================= */
async function ensureOpenConversation(waId, { contactName = null } = {}) {
  const db = await getDb();
  let conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
  if (!conv) {
    const doc = {
      waId,
      status: "OPEN",         // OPEN | COMPLETED | CANCELLED
      finalized: false,       // idempotencia para Sheets/orden
      contactName: contactName || null,
      openedAt: new Date(),
      closedAt: null,
      lastUserTs: null,
      lastAssistantTs: null,
      turns: 0
    };
    const ins = await db.collection("conversations").insertOne(doc);
    conv = { _id: ins.insertedId, ...doc };
  } else if (contactName && !conv.contactName) {
    await db.collection("conversations").updateOne(
      { _id: conv._id },
      { $set: { contactName } }
    );
    conv.contactName = contactName;
  }
  return conv;
}

async function appendMessage(conversationId, {
  role,
  content,
  type = "text",
  meta = {},
  ttlDays = null
}) {
  const db = await getDb();
  const doc = {
    conversationId: new ObjectId(conversationId),
    role, content, type, meta,
    ts: new Date()
  };
  if (ttlDays && Number.isFinite(ttlDays)) {
    doc.expireAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  }
  await db.collection("messages").insertOne(doc);

  const upd = { $inc: { turns: 1 }, $set: {} };
  if (role === "user") upd.$set.lastUserTs = doc.ts;
  if (role === "assistant") upd.$set.lastAssistantTs = doc.ts;
  await db.collection("conversations").updateOne({ _id: new ObjectId(conversationId) }, upd);
}

// Normalizar “Pedido” a estructura de order
function normalizeOrder(waId, contactName, pedido) {
  const entrega = pedido?.["Entrega"] || "";
  const domicilio = pedido?.["Domicilio"] || "";
  const monto = Number(pedido?.["Monto"] ?? 0) || 0;

  const items = [];
  const mappedFields = [
    "Pedido pollo",
    "Pedido papas",
    "Milanesas comunes",
    "Milanesas Napolitanas",
    "Ensaladas",
    "Bebidas"
  ];
  for (const key of mappedFields) {
    const val = (pedido?.[key] || "").toString().trim();
    if (val && val.toUpperCase() !== "NO") {
      items.push({ name: key, selection: val });
    }
  }

  const name = pedido?.["Nombre"] || contactName || "";
  const fechaEntrega = pedido?.["Fecha y hora de entrega"] || "";
  const hora = pedido?.["Hora"] || "";
  const estadoPedido = pedido?.["Estado pedido"] || "";

  return {
    waId,
    name,
    entrega,
    domicilio,
    items,
    amount: monto,
    estadoPedido,
    fechaEntrega,
    hora,
    createdAt: new Date(),
    processed: false
  };
}

// Cierre idempotente + guardado en Sheets y en orders
async function finalizeConversationOnce(conversationId, finalPayload, estado) {
  const db = await getDb();
  const res = await db.collection("conversations").findOneAndUpdate(
    { _id: new ObjectId(conversationId), finalized: { $ne: true } },
    {
      $set: {
        status: estado || "COMPLETED",
        finalized: true,
        closedAt: new Date(),
        summary: {
          response: finalPayload?.response || "",
          Pedido: finalPayload?.Pedido || null,
          Bigdata: finalPayload?.Bigdata || null
        }
      }
    },
    { returnDocument: "after" }
  );

  const didFinalize = !!res?.value?.finalized;
  if (!didFinalize) {
    return { didFinalize: false };
  }

  const conv = res.value;
  try {
    await saveCompletedToSheets({
      waId: conv.waId,
      data: finalPayload || {}
    });
  } catch (e) {
    console.error("⚠️ Error guardando en Sheets tras finalizar:", e);
  }

  try {
    if (finalPayload?.Pedido) {
      const pedidoNombre = finalPayload.Pedido["Nombre"];
      if (pedidoNombre && !conv.contactName) {
        await db.collection("conversations").updateOne(
          { _id: conv._id },
          { $set: { contactName: pedidoNombre } }
        );
        conv.contactName = pedidoNombre;
      }

      const orderDoc = normalizeOrder(conv.waId, conv.contactName, finalPayload.Pedido);
      orderDoc.conversationId = conv._id;
      await db.collection("orders").insertOne(orderDoc);
    }
  } catch (e) {
    console.error("⚠️ Error guardando order:", e);
  }

  return { didFinalize: true };
}

/* ======================= Utilidades varias ======================= */
function escapeRegExp(s) { return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }

/* ======================= UI /productos + API ======================= */
function registerProductRoutes(app) {
  app.get("/productos", async (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Productos</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; max-width: 1100px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #f5f5f5; text-align: left; }
    input[type="text"], input[type="number"], textarea { width: 100%; box-sizing: border-box; }
    textarea { min-height: 56px; }
    .row { display:flex; gap:8px; align-items:center; }
    .muted { color:#666; font-size:12px; }
    .pill { border:1px solid #ccc; border-radius: 999px; padding:2px 8px; font-size:12px; }
  </style>
</head>
<body>
  <h1>Productos</h1>
  <p class="muted">Fuente: <span class="pill">MongoDB (colección <code>products</code>)</span></p>
  <div class="row">
    <button id="btnReload">Recargar</button>
    <button id="btnAdd">Agregar</button>
  </div>
  <p></p>
  <table id="tbl">
    <thead>
      <tr>
        <th>Descripción</th><th>Importe</th><th>Observación (comportamiento de venta)</th><th>Activo</th><th>Acciones</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
  <template id="row-tpl">
    <tr>
      <td><input type="text" class="descripcion" placeholder="Ej: Helado 1/2 kg" /></td>
      <td><input type="number" class="importe" step="0.01" placeholder="0.00" /></td>
      <td><textarea class="observacion" placeholder="Reglas/comportamiento para vender este producto"></textarea></td>
      <td style="text-align:center;"><input type="checkbox" class="active" checked /></td>
      <td>
        <button class="save">Guardar</button>
        <button class="del">Borrar</button>
      </td>
    </tr>
  </template>
  <script>
    async function j(url, opts){ const r=await fetch(url, opts); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
    async function load(){
      const data = await j('/api/products');
      const tb = document.querySelector('#tbl tbody');
      tb.innerHTML = '';
      for (const it of data.items) {
        const tr = document.querySelector('#row-tpl').content.firstElementChild.cloneNode(true);
        tr.dataset.id = it._id;
        tr.querySelector('.descripcion').value = it.descripcion || '';
        tr.querySelector('.importe').value = (typeof it.importe==='number') ? it.importe : (it.importe || '');
        tr.querySelector('.observacion').value = it.observacion || '';
        tr.querySelector('.active').checked = it.active !== false;
        tr.querySelector('.save').addEventListener('click', async ()=>{ await saveRow(tr); });
        tr.querySelector('.del').addEventListener('click', async ()=>{
          if (confirm('¿Borrar "'+(it.descripcion||'')+'"?')){
            await j('/api/products/'+encodeURIComponent(it._id), { method:'DELETE' });
            await load();
          }
        });
        tb.appendChild(tr);
      }
    }
    async function saveRow(tr){
      const payload = {
        _id: tr.dataset.id || undefined,
        descripcion: tr.querySelector('.descripcion').value.trim(),
        importe: tr.querySelector('.importe').value.trim(),
        observacion: tr.querySelector('.observacion').value.trim(),
        active: tr.querySelector('.active').checked
      };
      await j('/api/products', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      alert('Guardado ✅'); await load();
    }
    document.getElementById('btnReload').addEventListener('click', load);
    document.getElementById('btnAdd').addEventListener('click', ()=>{
      const tb = document.querySelector('#tbl tbody');
      const tr = document.querySelector('#row-tpl').content.firstElementChild.cloneNode(true);
      tr.querySelector('.save').addEventListener('click', async ()=>{ await saveRow(tr); });
      tr.querySelector('.del').addEventListener('click', ()=> tr.remove());
      tb.prepend(tr);
    });
    load();
  </script>
</body>
</html>`);
  });

  app.get("/api/products", async (_req, res) => {
    try {
      const items = await loadProductsFromMongo({ force: true });
      res.json({ items: items.map(it => ({ ...it, _id: String(it._id) })) });
    } catch (e) {
      console.error("GET /api/products error:", e);
      res.status(500).json({ error: "internal" });
    }
  });
  app.post("/api/products", async (req, res) => {
    try {
      await upsertProductMongo(req.body || {});
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message || "bad_request" });
    }
  });
  app.delete("/api/products/:id", async (req, res) => {
    try {
      await removeProductMongo(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /api/products/:id error:", e);
      res.status(500).json({ error: "internal" });
    }
  });
}

/* ======================= Admin UI + APIs ======================= */
function registerAdminRoutes(app) {

  app.get("/admin", async (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Admin - Conversaciones</title>
  <style>
    body { font-family: system-ui, -apple-system, Arial, sans-serif; margin: 24px; }
    h1 { margin-top: 0; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { background: #f6f6f6; text-align: left; }
    tr:nth-child(even) { background: #fafafa; }
    .btn { padding: 6px 10px; border: 1px solid #333; background: #fff; cursor: pointer; border-radius: 4px; font-size: 12px; }
    .btn + .btn { margin-left: 6px; }
    .printmenu { display:inline-flex; gap:6px; align-items:center; }
    .muted { color: #666; }
    .tag { display:inline-block; padding:2px 6px; border-radius: 4px; font-size: 12px; }
    .tag.OPEN { background: #e7f5ff; color: #1971c2; }
    .tag.COMPLETED { background: #e6fcf5; color: #2b8a3e; }
    .tag.CANCELLED { background: #fff0f6; color: #c2255c; }
    .modal-backdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); align-items:center; justify-content:center; }
    .modal { background:#fff; width: 720px; max-width: calc(100% - 32px); border-radius:8px; overflow:hidden; }
    .modal header { padding:12px 16px; background:#f6f6f6; display:flex; align-items:center; justify-content:space-between;}
    .modal header h3{ margin:0; font-size:16px;}
    .modal .content { padding:16px; max-height:70vh; overflow:auto; }
    .modal .actions { padding:12px 16px; text-align:right; border-top:1px solid #eee;}
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace; font-size: 12px; }
    .printable { background: #fff; color: #000; }
    @media print {
      .no-print { display: none; }
      .printable { padding: 0; }
    }
  </style>
</head>
<body>
  <h1>Admin - Conversaciones</h1>
  <div class="muted">Actualiza la página para refrescar.</div>
  <div class="no-print" id="filterBar" style="margin:8px 0 12px;">
  <label>Filtrar: </label>
  <select id="filterProcessed" class="btn" onchange="loadConversations()">
    <option value="">Todas</option>
    <option value="false">No procesadas</option>
    <option value="true">Procesadas</option>
  </select>
</div>
<table id="tbl">
    <thead>
      <tr>
        <th>wa_id</th>
        <th>Nombre</th>
        <th>Estado</th>
        <th>Abierta</th>
        <th>Cerrada</th>
        <th>Turnos</th>
        <th>Procesado</th>
        <th>Acciones</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal">
      <header>
        <h3>Pedido</h3>
        <button class="btn no-print" onclick="closeModal()">✕</button>
      </header>
      <div class="content" id="modalContent"></div>
      <div class="actions no-print">
        <button class="btn" onclick="window.print()">Imprimir</button>
        <button class="btn" onclick="closeModal()">Cerrar</button>
      </div>
    </div>
  </div>

  <script>
    async function loadConversations() {
      const sel = document.getElementById('filterProcessed');
      const p = sel ? sel.value : '';
      const url = p ? ('/api/admin/conversations?processed=' + p) : '/api/admin/conversations';
      const r = await fetch(url);

      const data = await r.json();
      const tb = document.querySelector("#tbl tbody");
      tb.innerHTML = "";
      for (const row of data) {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${row.waId}</td>
          <td>\${row.contactName || ""}</td>
          <td><span class="tag \${row.status}">\${row.status}</span></td>
          <td>\${row.openedAt ? new Date(row.openedAt).toLocaleString() : ""}</td>
          <td>\${row.closedAt ? new Date(row.closedAt).toLocaleString() : ""}</td>
          <td>\${row.turns ?? 0}</td>
          <td>\${row.processed ? '✅' : '—'}</td>
          <td>
            <button class="btn" onclick="openMessages('\${row._id}')">Mensajes</button>
            <button class="btn" onclick="openOrder('\${row._id}')">Pedido</button>
            <button class="btn" onclick="markProcessed('\${row._id}')">Procesado</button>
            <div class="printmenu">
              <select id="pm-\${row._id}" class="btn">
                <option value="kitchen">Cocina</option>
                <option value="client">Cliente</option>
              </select>
              <button class="btn" onclick="printTicketOpt('\${row._id}')">Imprimir</button>
            </div>
          </td>
        \`;
        tb.appendChild(tr);
      }
    }

    function openMessages(id) {
      window.open('/api/admin/messages/' + id, '_blank');
    }

    async function openOrder(id) {
      const r = await fetch('/api/admin/order/' + id);
      const data = await r.json();
      const root = document.getElementById('modalContent');
      root.innerHTML = renderOrder(data);
      openModal();
    }

    async function markProcessed(id) {
      const r = await fetch('/api/admin/order/' + id + '/process', { method: 'POST' });
      if (r.ok) {
        alert('Pedido marcado como procesado.');
      } else {
        alert('No se pudo marcar como procesado.');
      }
    }

    function renderOrder(o) {
      if (!o || !o.order) return '<div class="mono">No hay pedido para esta conversación.</div>';
      const ord = o.order;
      const itemsHtml = (ord.items || []).map(it => \`<li>\${it.name}: <strong>\${it.selection}</strong></li>\`).join('') || '<li>(sin ítems)</li>';
      const rawHtml = o.rawPedido ? '<pre class="mono">' + JSON.stringify(o.rawPedido, null, 2) + '</pre>' : '';
      return \`
        <div class="printable">
          <h2>Pedido</h2>
          <p><strong>Cliente:</strong> \${ord.name || ''} <span class="muted">(\${o.waId})</span></p>
          <p><strong>Entrega:</strong> \${ord.entrega || ''}</p>
          <p><strong>Domicilio:</strong> \${ord.domicilio || ''}</p>
          <p><strong>Monto:</strong> \${(ord.amount!=null)?('$'+ord.amount):''}</p>
          <p><strong>Estado pedido:</strong> \${ord.estadoPedido || ''}</p>
          <p><strong>Fecha/Hora entrega:</strong> \${ord.fechaEntrega || ''} \${ord.hora || ''}</p>
          <h3>Ítems</h3>
          <ul>\${itemsHtml}</ul>
          <h3>Detalle crudo del Pedido</h3>
          \${rawHtml}
        </div>
      \`;
    }

    function openModal() {
      document.getElementById('modalBackdrop').style.display = 'flex';
    }
    function closeModal() {
      document.getElementById('modalBackdrop').style.display = 'none';
    }

    function printTicketOpt(id) {
      const sel = document.getElementById('pm-' + id);
      const v = sel ? sel.value : 'kitchen';
      window.open('/admin/print/' + id + '?v=' + encodeURIComponent(v), '_blank');
    }

    loadConversations();
  </script>
</body>
</html>
    `);
  });

  // JSON de conversaciones para Admin
  app.get("/api/admin/conversations", async (req, res) => {
    try {
      const db = await getDb();
      const q = {};
      const { processed, phone, status, date_field, from, to } = req.query;

      if (typeof processed === "string") {
        if (processed === "true") q.processed = true;
        else if (processed === "false") q.processed = { $ne: true };
      }

      if (phone && String(phone).trim()) {
        const esc = escapeRegExp(String(phone).trim());
        q.waId = { $regex: esc, $options: "i" };
      }

      if (status && String(status).trim()) {
        q.status = String(status).trim().toUpperCase();
      }

      const field = (date_field === "closed") ? "closedAt" : "openedAt";
      const range = {};
      if (from) {
        const d1 = new Date(`${from}T00:00:00.000Z`);
        if (!isNaN(d1)) range.$gte = d1;
      }
      if (to) {
        const d2 = new Date(`${to}T23:59:59.999Z`);
        if (!isNaN(d2)) range.$lte = d2;
      }
      if (Object.keys(range).length) q[field] = range;

      const convs = await db.collection("conversations")
        .find(q, { sort: { openedAt: -1 } })
        .project({ waId:1, status:1, openedAt:1, closedAt:1, turns:1, contactName:1, processed:1 })
        .limit(500)
        .toArray();

      const out = convs.map(c => ({
        _id: c._id && c._id.toString ? c._id.toString() : String(c._id),
        waId: c.waId,
        contactName: c.contactName || "",
        status: c.status || "OPEN",
        openedAt: c.openedAt,
        closedAt: c.closedAt,
        turns: typeof c.turns === "number" ? c.turns : 0,
        processed: !!c.processed
      }));
      res.json(out);
    } catch (e) {
      console.error("⚠️ /api/admin/conversations error:", e);
      res.status(200).json([]);
    }
  });

  // HTML con mensajes
  app.get("/api/admin/messages/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const db = await getDb();
      const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
      if (!conv) return res.status(404).send("Conversation not found");

      const msgs = await db.collection("messages")
        .find({ conversationId: new ObjectId(id) })
        .sort({ ts: 1 })
        .toArray();

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Mensajes - ${"${conv.waId}"}</title>
  <style>
    body { font-family: system-ui, -apple-system, Arial, sans-serif; margin: 24px; }
    .msg { margin-bottom: 12px; }
    .role { font-weight: bold; }
    .meta { color: #666; font-size: 12px; }
    pre { background:#f6f6f6; padding:8px; border-radius:4px; overflow:auto; }
  </style>
</head>
<body>
  <h2>Mensajes - ${"${conv.contactName ? (conv.contactName + ' • ') : ''}"}${"${conv.waId}"}</h2>
  <div>
    ${"${msgs.map(m => `"} 
      <div class="msg">
        <div class="role">${"${m.role.toUpperCase()}"} <span class="meta">(${ "${new Date(m.ts).toLocaleString()}" })</span></div>
        <pre>${"${(m.content || '').replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}"}</pre>
        ${"${m.meta && Object.keys(m.meta).length ? `<div class=\"meta\">meta: <code>${JSON.stringify(m.meta)}</code></div>` : ``}"} 
      </div>
    ${"`).join('')}"}
  </div>
</body>
</html>
      `);
    } catch (e) {
      console.error("⚠️ /api/admin/messages error:", e);
      res.status(500).send("internal");
    }
  });

  // JSON del pedido normalizado
  app.get("/api/admin/order/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const db = await getDb();
      const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
      if (!conv) return res.status(404).json({ error: "not_found" });

      // Buscar order por conversationId si existe
      let order = await db.collection("orders").findOne({ conversationId: new ObjectId(id) });
      if (!order && conv.summary?.Pedido) {
        // normalizar on the fly si no se grabó orders (backfill)
        order = normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
      }

      res.json({
        waId: conv.waId,
        order: order ? {
          name: order.name || conv.contactName || "",
          entrega: order.entrega || "",
          domicilio: order.domicilio || "",
          items: order.items || [],
          amount: order.amount ?? null,
          estadoPedido: order.estadoPedido || "",
          fechaEntrega: order.fechaEntrega || "",
          hora: order.hora || "",
          processed: !!order.processed
        } : null,
        rawPedido: conv.summary?.Pedido || null
      });
    } catch (e) {
      console.error("⚠️ /api/admin/order error:", e);
      res.status(500).json({ error: "internal" });
    }
  });

  // marcar pedido como procesado
  app.post("/api/admin/order/:id/process", async (req, res) => {
    try {
      const id = req.params.id;
      const db = await getDb();
      const convId = new ObjectId(id);

      const upd = await db.collection("orders").updateOne(
        { conversationId: convId },
        { $set: { processed: true, processedAt: new Date() } }
      );
      if (!upd.matchedCount) {
        const conv = await db.collection("conversations").findOne({ _id: convId });
        if (!conv || !conv.summary?.Pedido) return res.status(404).json({ error: "order_not_found" });
        const orderDoc = normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
        orderDoc.conversationId = convId;
        orderDoc.processed = true;
        orderDoc.processedAt = new Date();
        await db.collection("orders").insertOne(orderDoc);
      }
      await db.collection("conversations").updateOne({ _id: convId }, { $set: { processed: true } });
      res.json({ ok: true });
    } catch (e) {
      console.error("⚠️ /api/admin/order/:id/process error:", e);
      res.status(500).json({ error: "internal" });
    }
  });

  // Impresión ticket térmico 80mm / 58mm
  app.get("/admin/print/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const v = String(req.query.v || "kitchen").toLowerCase(); // kitchen | client
      const db = await getDb();
      const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
      if (!conv) return res.status(404).send("Conversación no encontrada");
      let order = await db.collection("orders").findOne({ conversationId: new ObjectId(id) });
      if (!order && conv.summary?.Pedido) {
        order = normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
      }
      const negocio = process.env.BUSINESS_NAME || "NEGOCIO";
      const direccionNegocio = process.env.BUSINESS_ADDRESS || "";
      const telNegocio = process.env.BUSINESS_PHONE || "";

      const cliente = (order?.name || conv.contactName || "") + " (" + (conv.waId || "") + ")";
      const domicilio = order?.domicilio || "";
      const pago = order?.pago || order?.payment || "";
      const monto = (order?.amount != null) ? Number(order.amount) : null;

      const items = Array.isArray(order?.items) ? order.items : [];
      function esc(s){ return String(s==null? "": s); }

      const itemLines = items.map(it => {
        const name = esc(it.name || it.nombre || it.producto || it.title || "Item");
        const sel = esc(it.selection || it.seleccion || it.detalle || it.toppings || "");
        return sel ? (name + " - " + sel) : name;
      }).join("\n");

      const showPrices = (v === "client");
      const totalHtml = showPrices && (monto != null) ? `<div class="row big"><span>TOTAL</span><span>$${monto.toFixed(2)}</span></div>` : "";

      const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Ticket</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  body { margin: 0; }
  .ticket { width: 80mm; padding: 6px 8px; font-family: monospace; font-size: 12px; }
  .center { text-align: center; }
  .row { display: flex; justify-content: space-between; }
  .hr { border-top: 1px dashed #000; margin: 6px 0; }
  .big { font-size: 14px; font-weight: bold; }
  @media print { .noprint { display: none; } }
</style>
</head>
<body>
  <div class="ticket">
    <div class="center big">${esc(negocio)}</div>
    ${direccionNegocio ? `<div class="center">${esc(direccionNegocio)}</div>` : ""}
    ${telNegocio ? `<div class="center">${esc(telNegocio)}</div>` : ""}
    <div class="hr"></div>
    <div>Cliente: ${esc(cliente)}</div>
    ${domicilio ? `<div>Dirección: ${esc(domicilio)}</div>` : ""}
    ${showPrices && pago ? `<div>Pago: ${esc(pago)}</div>` : ""}
    <div class="hr"></div>
    <div>Pedido:</div>
    <pre>${esc(itemLines)}</pre>
    <div class="hr"></div>
    ${totalHtml}
    <div class="hr"></div>
    <div>${new Date().toLocaleString()}</div>
    <div class="center">${showPrices ? "¡Gracias por su compra!" : "TICKET COCINA"}</div>
    <div class="hr"></div>
    <button class="noprint" onclick="window.print()">Imprimir</button>
  </div>
</body>
</html>`;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
    } catch (e) {
      console.error("⚠️ /admin/print/:id error:", e);
      res.status(500).send("internal");
    }
  });
}

/* ======================= Exports ======================= */
module.exports = {
  // behavior
  buildSystemPrompt,
  // conversations/messages/orders
  ensureOpenConversation,
  appendMessage,
  finalizeConversationOnce,
  // html routes
  registerProductRoutes,
  registerAdminRoutes
};
