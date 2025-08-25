require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const { ObjectId } = require('mongodb');
const { getDb } = require('./db');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ------ UTILIDADES ------
function safeStr(v, fallback = '') { return (v === undefined || v === null) ? fallback : String(v); }
function money(n) { const v = Number(n || 0); return isNaN(v) ? '0.00' : v.toFixed(2); }
function pad(str = '', len = 32) { str = String(str); return (str + ' '.repeat(len)).slice(0, len); }

// Normaliza un documento de pedido para persistir
function normalizeOrder(waId, contactName, Pedido) {
  const items = Array.isArray(Pedido?.Items) ? Pedido.Items : [];
  const total = Number(Pedido?.Total || 0);
  const address = Pedido?.Direccion || '';
  const payment = Pedido?.Pago || '';
  const notes = Pedido?.Notas || '';

  return {
    waId,
    contactName: contactName || Pedido?.Nombre || '',
    items,
    address,
    payment,
    notes,
    total,
    processed: false,
    createdAt: new Date()
  };
}

// (Opcional) Guardado a Google Sheets - implementar tu versión real aquí
async function saveCompletedToSheets({ waId, data }) {
  // Colocá aquí tu integración real con Google Sheets.
  // Dejar stub para que no rompa si no configuraste credenciales.
  if (process.env.GOOGLE_SHEETS_ID) {
    console.log('→ (stub) Guardando en Sheets waId:', waId);
  }
}

// ------ FINALIZACIÓN CON RE-INTENTOS IDEMPOTENTES ------
// Marca la conversación como finalizada y asegura backfill a Sheets/Orders si hiciera falta.
async function finalizeConversationOnce(conversationId, finalPayload, estado) {
  const db = await getDb();

  // Intento marcar finalizada si aún no lo estaba, y además guardar el summary y flags.
  const res = await db.collection('conversations').findOneAndUpdate(
    { _id: new ObjectId(conversationId), finalized: { $ne: true } },
    {
      $set: {
        status: estado || 'COMPLETED',
        closedAt: new Date(),
        summary: {
          response: finalPayload?.response || '',
          Pedido: finalPayload?.Pedido || null,
          Bigdata: finalPayload?.Bigdata || null
        },
        // flags de persistencia
        sheetsSaved: false,
        orderSaved: false
      },
      $currentDate: { updatedAt: true }
    },
    { returnDocument: 'after' }
  );

  let conv = res?.value;
  if (!conv) {
    conv = await db.collection('conversations').findOne({ _id: new ObjectId(conversationId) });
    if (!conv) return { didFinalize: false };
  }

  // Guardado en Sheets (si falta)
  if (!conv.sheetsSaved) {
    try {
      await saveCompletedToSheets({ waId: conv.waId, data: finalPayload || {} });
      await db.collection('conversations').updateOne({ _id: conv._id }, { $set: { sheetsSaved: true } });
    } catch (e) {
      console.error('⚠️ Error guardando en Sheets:', e);
    }
  }

  // Guardado de order (si falta y hay Pedido)
  if (!conv.orderSaved && finalPayload?.Pedido) {
    try {
      const pedidoNombre = finalPayload.Pedido['Nombre'];
      if (pedidoNombre && !conv.contactName) {
        await db.collection('conversations').updateOne(
          { _id: conv._id },
          { $set: { contactName: pedidoNombre } }
        );
        conv.contactName = pedidoNombre;
      }
      const orderDoc = normalizeOrder(conv.waId, conv.contactName, finalPayload.Pedido);
      orderDoc.conversationId = conv._id;
      await db.collection('orders').updateOne(
        { conversationId: conv._id },
        { $setOnInsert: orderDoc },
        { upsert: true }
      );
      await db.collection('conversations').updateOne(
        { _id: conv._id },
        { $set: { orderSaved: true } }
      );
    } catch (e) {
      console.error('⚠️ Error guardando order:', e);
    }
  }

  // Asegura finalized=true al final
  if (!conv.finalized) {
    await db.collection('conversations').updateOne(
      { _id: conv._id },
      { $set: { finalized: true, finalizedAt: new Date() } }
    );
  }

  return { didFinalize: true };
}

// ---------------- API ADMIN -----------------

// Listado de conversaciones con filtro por procesadas / no procesadas
app.get('/api/admin/conversations', async (req, res) => {
  try {
    const db = await getDb();
    const q = {};
    if (typeof req.query.processed === 'string') {
      if (req.query.processed === 'true') q.processed = true;
      if (req.query.processed === 'false') q.processed = { $ne: true };
    }
    const convs = await db.collection('conversations')
      .find(q, { sort: { openedAt: -1 } })
      .project({ waId: 1, status: 1, openedAt: 1, closedAt: 1, turns: 1, contactName: 1, processed: 1 })
      .toArray();

    const out = convs.map(c => ({
      _id: c._id.toString(),
      waId: c.waId,
      contactName: c.contactName || '',
      status: c.status || 'OPEN',
      openedAt: c.openedAt || null,
      closedAt: c.closedAt || null,
      turns: c.turns || 0,
      processed: !!c.processed
    }));
    res.json(out);
  } catch (e) {
    console.error('⚠️ /api/admin/conversations error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Obtener detalle del pedido asociado a una conversación
app.get('/api/admin/order/:id', async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const db = await getDb();
    const order = await db.collection('orders').findOne({ conversationId: id });
    const conv = await db.collection('conversations').findOne({ _id: id });

    // Fallback al summary.Pedido si no hay order
    let payload = order;
    if (!payload && conv?.summary?.Pedido) {
      const o = normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
      o.conversationId = id;
      payload = o;
    }

    if (!payload) return res.status(404).json({ error: 'pedido_no_encontrado' });
    res.json(payload);
  } catch (e) {
    console.error('⚠️ /api/admin/order/:id error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Marcar pedido como procesado y también la conversación
app.post('/api/admin/order/:id/process', async (req, res) => {
  try {
    const convId = new ObjectId(req.params.id);
    const db = await getDb();

    // Marca order como procesada (y crea si no existiera a partir del summary)
    let upd = await db.collection('orders').updateOne(
      { conversationId: convId },
      { $set: { processed: true, processedAt: new Date() } }
    );

    if (!upd.matchedCount) {
      const conv = await db.collection('conversations').findOne({ _id: convId });
      if (!conv) return res.status(404).json({ error: 'conversation_not_found' });
      const Pedido = conv?.summary?.Pedido || {};
      const orderDoc = normalizeOrder(conv.waId, conv.contactName, Pedido);
      orderDoc.conversationId = convId;
      orderDoc.processed = true;
      orderDoc.processedAt = new Date();
      await db.collection('orders').insertOne(orderDoc);
    }

    // Marca conversación como procesada
    await db.collection('conversations').updateOne(
      { _id: convId },
      { $set: { processed: true } }
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('⚠️ /api/admin/order/:id/process error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ---------------- UI ADMIN -----------------

// Página simple de administración con filtro y acciones
app.get('/admin', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin Pedidos</title>
  <style>
    :root { --bg:#0b0c10; --fg:#e9eef1; --muted:#9aa4ad; --acc:#3fb389; }
    body { background:var(--bg); color:var(--fg); font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif; margin:16px; }
    h1 { margin:0 0 12px; font-size:20px; }
    .btn { background:#1d2127; color:var(--fg); border:1px solid #2b3037; padding:6px 10px; border-radius:8px; cursor:pointer; }
    .btn:hover { background:#242a31; }
    table { width:100%; border-collapse: collapse; margin-top:8px; }
    th, td { border-bottom:1px solid #2b3037; padding:8px; font-size:14px; text-align:left; }
    th { color:#b7c0c8; font-weight:600; }
    .tag { padding:2px 6px; border-radius:6px; font-size:12px; background:#1f2430; border:1px solid #2b3037; }
    .row-actions button { margin-right:6px; }
    .toolbar { display:flex; gap:8px; align-items:center; margin: 8px 0 12px; }
    select.btn { padding-right:28px; }
    .printmenu { display:inline-flex; gap:6px; align-items:center; }
  </style>
</head>
<body>
  <h1>Panel de Administración</h1>
  <div class="toolbar">
    <label>Filtrar</label>
    <select id="filterProcessed" class="btn" onchange="loadConversations()">
      <option value="">Todas</option>
      <option value="false">No procesadas</option>
      <option value="true">Procesadas</option>
    </select>
    <button class="btn" onclick="loadConversations()">Actualizar</button>
  </div>
  <table id="tbl">
    <thead>
      <tr>
        <th>waId</th>
        <th>Contacto</th>
        <th>Estado</th>
        <th>Abre</th>
        <th>Cierra</th>
        <th>Turnos</th>
        <th>Procesado</th>
        <th>Acciones</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

<script>
async function loadConversations() {
  const sel = document.getElementById('filterProcessed');
  const p = sel ? sel.value : '';
  const url = p === '' ? '/api/admin/conversations' : ('/api/admin/conversations?processed=' + p);
  const r = await fetch(url);
  const data = await r.json();
  renderTable(data);
}

function renderTable(rows) {
  const tb = document.querySelector('#tbl tbody');
  tb.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.waId}</td>
      <td>${row.contactName || ''}</td>
      <td><span class="tag">${row.status}</span></td>
      <td>${row.openedAt ? new Date(row.openedAt).toLocaleString() : ''}</td>
      <td>${row.closedAt ? new Date(row.closedAt).toLocaleString() : ''}</td>
      <td>${row.turns ?? 0}</td>
      <td>${row.processed ? '✅' : '—'}</td>
      <td class="row-actions">
        <button class="btn" onclick="openMessages('${row._id}')">Mensajes</button>
        <button class=\"btn\" onclick=\"openOrder('${row._id}')\">Pedido</button>
        <button class=\"btn\" onclick=\"markProcessed('${row._id}')\">Procesado</button>
        <div class=\"printmenu\">
          <select id=\"pm-${row._id}\" class=\"btn\">
            <option value=\"kitchen\">Cocina</option>
            <option value=\"client\">Cliente</option>
          </select>
          <button class=\"btn\" onclick=\"printTicketOpt('${row._id}')\">Imprimir</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  }
}

function openMessages(id) { window.open('/admin/messages/' + id, '_blank'); }
function openOrder(id) { window.open('/admin/order/' + id, '_blank'); }
async function markProcessed(id) {
  const r = await fetch('/api/admin/order/' + id + '/process', { method: 'POST' });
  if (r.ok) { alert('Marcado como procesado.'); await function printTicketOpt(id){
  const sel = document.getElementById('pm-' + id);
  const v = sel ? sel.value : 'kitchen';
  window.open('/admin/print/' + id + '?v=' + encodeURIComponent(v), '_blank');
}

loadConversations(); }
  else alert('No se pudo marcar.');
}
function printTicket(id) { window.open('/admin/print/' + id, '_blank'); }

loadConversations();
</script>
</body>
</html>`);
});

// ---------------- IMPRESIÓN EN COMANDERA (80mm) -----------------
// Ruta que arma un ticket minimalista para comandera térmica (ancho 80mm)
// Nota: si tu impresora es 58mm, cambiá 80mm -> 58mm en el CSS @page y .ticket.
// Página de detalle de pedido con botón de impresión
app.get('/admin/order/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const html = `<!doctype html>
<html lang=\"es\">
<head>
  <meta charset=\"utf-8\"/>
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>
  <title>Pedido</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:16px;color:#e9eef1;background:#0b0c10}
    .card{background:#11151b;border:1px solid #2b3037;border-radius:12px;padding:16px;max-width:720px}
    .row{display:flex;gap:12px;margin:6px 0;align-items:center}
    .kvs{display:grid;grid-template-columns:140px 1fr;gap:6px 12px}
    .btn{background:#1d2127;color:#e9eef1;border:1px solid #2b3037;padding:8px 12px;border-radius:10px;cursor:pointer}
    .btn:hover{background:#242a31}
    pre{white-space:pre-wrap;word-break:break-word;background:#0f1318;border:1px solid #2b3037;border-radius:8px;padding:12px}
    .actions{display:flex;gap:8px;margin-top:12px}
  </style>
</head>
<body>
  <div class=\"card\">
    <h2>Detalle del pedido</h2>
    <div id=\"meta\" class=\"kvs\"></div>
    <h3>Items</h3>
    <pre id=\"items\"></pre>
    <div class=\"actions\">
      <button class=\"btn\" onclick=\"window.open('/admin/print/${id}?v=kitchen','_blank')\">Imprimir Cocina</button>
      <button class=\"btn\" onclick=\"window.open('/admin/print/${id}?v=client','_blank')\">Imprimir Cliente</button>
    </div>
  </div>
<script>
(async function(){
  const r = await fetch('/api/admin/order/${id}');
  if(!r.ok){document.body.innerHTML='<p>No se pudo cargar el pedido</p>';return;}
  const o = await r.json();
  const meta = document.getElementById('meta');
  function row(k,v){ const dk=document.createElement('div'); dk.textContent=k; const dv=document.createElement('div'); dv.textContent=v||''; meta.appendChild(dk); meta.appendChild(dv);}
  row('Cliente', o.contactName||'');
  row('Dirección', o.address||'');
  row('Pago', o.payment||'');
  row('Total', '$'+Number(o.total||0).toFixed(2));
  const items=Array.isArray(o.items)?o.items:[];
  const lines=[];
  for(const it of items){
    const name=(it.nombre||it.name||it.producto||'Item');
    const qty=(it.cantidad||it.qty||1);
    const price=Number(it.precio||it.price||0);
    const sub=(price*qty).toFixed(2);
    lines.push(`${name}`);
    lines.push(`  ${qty} x $${price.toFixed(2)}   →   $${sub}`);
  }
  document.getElementById('items').textContent=lines.join('
');
})();
</script>
</body>
</html>`;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(html);
  } catch(e){
    console.error('⚠️ /admin/order/:id error', e);
    res.status(500).send('internal error');
  }
});

// Impresión de comandera con variantes: cocina (oculta precios) y cliente (con precios)
app.get('/admin/print/:id', async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const v = (req.query.v||'kitchen').toLowerCase(); // 'kitchen' o 'client'
    const db = await getDb();
    const conv = await db.collection('conversations').findOne({ _id: id });
    const order = await db.collection('orders').findOne({ conversationId: id });

    let src = order;
    if (!src && conv?.summary?.Pedido) { src = normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido); }
    if (!src) { res.status(404).send('Pedido no encontrado'); return; }

    const negocio = safeStr(process.env.BUSINESS_NAME, 'HELADERÍA');
    const direccionNegocio = safeStr(process.env.BUSINESS_ADDRESS, 'S/D');
    const telNegocio = safeStr(process.env.BUSINESS_PHONE, '');

    const cliente = safeStr(src.contactName || conv?.contactName, '');
    const direccion = safeStr(src.address || conv?.summary?.Pedido?.Direccion, '');
    const pago = safeStr(src.payment || conv?.summary?.Pedido?.Pago, '');
    const notas = safeStr(src.notes || conv?.summary?.Pedido?.Notas, '');

    const items = Array.isArray(src.items) ? src.items : [];

    // helper de línea monoespaciada a 32 cols
    function pad(str='', len=32){ str=String(str); return (str + ' '.repeat(len)).slice(0,len); }
    function money(n){ const v=Number(n||0); return isNaN(v)?'0.00':v.toFixed(2); }

    const lines = [];
    for (const it of items) {
      const name = safeStr(it.nombre || it.name || it.producto || 'Item');
      const qty = Number(it.cantidad || it.qty || 1);
      const price = Number(it.precio || it.price || 0);
      // Cocina: no mostramos precios ni subtotal
      if (v === 'kitchen') {
        lines.push(pad(name, 32));
        lines.push(pad('x'+qty + (it.toppings? '  '+it.toppings: ''), 32));
      } else {
        lines.push(pad(name, 32));
        const left = qty + ' x $' + money(price);
        const right = '$' + money(price*qty);
        const spac = Math.max(0, 32 - left.length - right.length);
        lines.push(left + ' '.repeat(spac) + right);
      }
    }

    const now = new Date();

    const showPrices = (v === 'client');
    const totalTxt = '$' + money(src.total);
    const totalLeft = 'TOTAL';
    const totalSpac = Math.max(0, 32 - totalLeft.length - totalTxt.length);
    const totalLine = totalLeft + ' '.repeat(totalSpac) + totalTxt;

    const html = `<!doctype html>
<html>
<head>
<meta charset=\"utf-8\">
<title>Ticket</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  body { margin: 0; }
  .ticket { width: 80mm; padding: 6px 8px; font-family: monospace; font-size: 12px; }
  .center { text-align: center; }
  .row { display: flex; justify-content: space-between; }
  .hr { border-top: 1px dashed #000; margin: 6px 0; }
  .big { font-size: 14px; font-weight: bold; }
  .noprint{ margin-top:8px }
  @media print { .noprint { display: none; } }
</style>
</head>
<body>
  <div class=\"ticket\">
    <div class=\"center big\">${negocio}</div>
    <div class=\"center\">${direccionNegocio}</div>
    ${telNegocio ? `<div class=\"center\">${telNegocio}</div>` : ''}
    <div class=\"hr\"></div>
    <div>Cliente: ${cliente}</div>
    ${direccion ? `<div>Dirección: ${direccion}</div>` : ''}
    ${showPrices ? (pago ? `<div>Pago: ${pago}</div>` : '') : ''}
    ${notas ? `<div>Notas: ${notas}</div>` : ''}
    <div class=\"hr\"></div>
    <div>Pedido:</div>
    <pre>${lines.join('\n')}</pre>
    <div class=\"hr\"></div>
    ${showPrices ? `<div class=\"row big\"><span>${totalLeft}</span><span>${totalTxt}</span></div><div class=\"hr\"></div>` : ''}
    <div>${now.toLocaleString()}</div>
    <div>waId: ${safeStr(conv?.waId, '')}</div>
    <div class=\"center\">${showPrices ? '¡Gracias por su compra!' : 'TICKET COCINA'}</div>
    <div class=\"hr\"></div>
    <button class=\"noprint\" onclick=\"window.print()\">Imprimir</button>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  } catch (e) {
    console.error('⚠️ /admin/print error:', e);
    res.status(500).send('internal error');
  }
});
    const order = await db.collection('orders').findOne({ conversationId: id });

    // Fallback al summary.Pedido si no hay order
    let src = order;
    if (!src && conv?.summary?.Pedido) {
      src = normalizeOrder(conv.waId, conv.contactName, conv.summary.Pedido);
    }

    if (!src) {
      res.status(404).send('Pedido no encontrado');
      return;
    }

    const negocio = safeStr(process.env.BUSINESS_NAME, 'HELADERÍA');
    const direccionNegocio = safeStr(process.env.BUSINESS_ADDRESS, 'S/D');
    const telNegocio = safeStr(process.env.BUSINESS_PHONE, '');

    const cliente = safeStr(src.contactName || conv?.contactName, '');
    const direccion = safeStr(src.address || conv?.summary?.Pedido?.Direccion, '');
    const pago = safeStr(src.payment || conv?.summary?.Pedido?.Pago, '');
    const notas = safeStr(src.notes || conv?.summary?.Pedido?.Notas, '');

    const items = Array.isArray(src.items) ? src.items : [];

    // Armado de líneas para 32 caracteres aproximados (80mm típico)
    const lines = [];
    for (const it of items) {
      const name = safeStr(it.nombre || it.name || it.producto || 'Item');
      const qty = safeStr(it.cantidad || it.qty || 1);
      const price = money(it.precio || it.price || 0);
      // Primera línea: nombre
      lines.push(pad(name, 32));
      // Segunda:  qty x precio    subtotal
      const subtotal = money((Number(it.precio || it.price || 0)) * (Number(it.cantidad || it.qty || 1)));
      const left = `${qty} x $${price}`;
      const right = `$${subtotal}`;
      const spac = Math.max(0, 32 - left.length - right.length);
      lines.push(left + ' '.repeat(spac) + right);
    }

    const totalTxt = `$${money(src.total)}`;
    const totalLeft = 'TOTAL';
    const totalSpac = Math.max(0, 32 - totalLeft.length - totalTxt.length);
    const totalLine = totalLeft + ' '.repeat(totalSpac) + totalTxt;

    const now = new Date();

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Ticket</title>
<style>
  /* Ajustar a tu impresora: 80mm (o 58mm) */
  @page { size: 80mm auto; margin: 0; }
  body { margin: 0; }
  .ticket { width: 80mm; padding: 6px 8px; font-family: monospace; font-size: 12px; }
  .center { text-align: center; }
  .right { text-align: right; }
  .row { display: flex; justify-content: space-between; }
  .hr { border-top: 1px dashed #000; margin: 6px 0; }
  .big { font-size: 14px; font-weight: bold; }
  @media print { .noprint { display: none; } }
</style>
</head>
<body>
  <div class="ticket">
    <div class="center big">${negocio}</div>
    <div class="center">${direccionNegocio}</div>
    ${telNegocio ? `<div class="center">${telNegocio}</div>` : ''}
    <div class="hr"></div>
    <div>Cliente: ${cliente}</div>
    ${direccion ? `<div>Dirección: ${direccion}</div>` : ''}
    ${pago ? `<div>Pago: ${pago}</div>` : ''}
    ${notas ? `<div>Notas: ${notas}</div>` : ''}
    <div class="hr"></div>
    <div>Pedido:</div>
    <pre>${lines.join('\n')}</pre>
    <div class="hr"></div>
    <div class="row big"><span>${totalLeft}</span><span>${totalTxt}</span></div>
    <div class="hr"></div>
    <div>${now.toLocaleString()}</div>
    <div>waId: ${safeStr(conv?.waId, '')}</div>
    <div class="center">¡Gracias por su compra!</div>
    <div class="hr"></div>
    <button class="noprint" onclick="window.print()">Imprimir</button>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  } catch (e) {
    console.error('⚠️ /admin/print error:', e);
    res.status(500).send('internal error');
  }
});

// ---------------- SERVER -----------------
app.get('/', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server listening on :' + PORT);
});
