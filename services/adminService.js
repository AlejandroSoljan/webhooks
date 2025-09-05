// services/adminService.js
const { ObjectId } = require("mongodb");
const { getDb } = require("./mongoService");

function escapeRegExp(s) { return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }

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
    waId, name, entrega, domicilio, items, amount: monto,
    estadoPedido, fechaEntrega, hora, createdAt: new Date(), processed: false
  };
}

async function renderAdminUI(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Admin - Conversaciones</title></head>
<body>
  <h1>Admin - Conversaciones</h1>
  <div>Usá los endpoints: /api/admin/conversations, /api/admin/messages/:id, /api/admin/order/:id</div>
</body>
</html>`);
}

async function getConversations(req, res) {
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
}

async function getMessages(req, res) {
  try {
    const id = req.params.id;
    const { getDb } = require("./mongoService");
    const db = await getDb();
    const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
    if (!conv) return res.status(404).send("Conversation not found");

    const msgs = await db.collection("messages")
      .find({ conversationId: new ObjectId(id) })
      .sort({ ts: 1 })
      .toArray();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Mensajes - ${conv.waId}</title>
</head>
<body>
  <h2>Mensajes - ${conv.contactName ? (conv.contactName + " • ") : ""}${conv.waId}</h2>
  <div>
    ${msgs.map(m => `
      <div style="margin-bottom:12px;">
        <div style="font-weight:bold;">${m.role.toUpperCase()} <span style="color:#666;font-size:12px;">(${new Date(m.ts).toLocaleString()})</span></div>
        <pre style="background:#f6f6f6;padding:8px;border-radius:4px;overflow:auto;">${(m.content || "").replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>
        ${m.meta && Object.keys(m.meta).length ? `<div style="color:#666;font-size:12px;">meta: <code>${JSON.stringify(m.meta)}</code></div>` : ""}
      </div>
    `).join("")}
  </div>
</body>
</html>`);
  } catch (e) {
    console.error("⚠️ /api/admin/messages error:", e);
    res.status(500).send("internal");
  }
}

async function getOrder(req, res) {
  try {
    const id = req.params.id;
    const db = await getDb();
    const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
    if (!conv) return res.status(404).json({ error: "not_found" });

    let order = await db.collection("orders").findOne({ conversationId: new ObjectId(id) });
    if (!order && conv.summary?.Pedido) {
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
}

async function processOrder(req, res) {
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
}

async function printTicket(req, res) {
  try {
    const id = req.params.id;
    const v = String(req.query.v || "kitchen").toLowerCase();
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
    console.error("⚠️ /admin/print error:", e);
    res.status(500).send("internal");
  }
}

module.exports = {
  renderAdminUI,
  getConversations,
  getMessages,
  getOrder,
  processOrder,
  printTicket,
  normalizeOrder,
};
