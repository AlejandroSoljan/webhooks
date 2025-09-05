  const { getDb } = require('./db');
  const { ObjectId } = require('mongodb');

  function escapeHtml(s){ return String(s||'').replace(/[<>&]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

  module.exports = function(app){
    // UI (simple) - lista de conversaciones
    app.get("/admin", async (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html>
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
    .tag { display:inline-block; padding:2px 6px; border-radius: 4px; font-size: 12px; }
    .tag.OPEN { background: #e7f5ff; color: #1971c2; }
    .tag.COMPLETED { background: #e6fcf5; color: #2b8a3e; }
    .tag.CANCELLED { background: #fff0f6; color: #c2255c; }
  </style>
</head>
<body>
  <h1>Admin - Conversaciones</h1>
  <table id="tbl">
    <thead>
      <tr>
        <th>wa_id</th>
        <th>Nombre</th>
        <th>Estado</th>
        <th>Abierta</th>
        <th>Cerrada</th>
        <th>Turnos</th>
        <th>Acciones</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
  <script>
    async function load() {
      const r = await fetch('/api/admin/conversations');
      const data = await r.json();
      const tb = document.querySelector("#tbl tbody");
      tb.innerHTML = "";
      for (const c of data) {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${c.waId}</td>
          <td>\${c.contactName || ""}</td>
          <td><span class="tag \${c.status}">\${c.status}</span></td>
          <td>\${c.openedAt ? new Date(c.openedAt).toLocaleString() : ""}</td>
          <td>\${c.closedAt ? new Date(c.closedAt).toLocaleString() : ""}</td>
          <td>\${c.turns ?? 0}</td>
          <td>
            <button class="btn" onclick="openMessages('\${c._id}')">Mensajes</button>
            <button class="btn" onclick="openOrder('\${c._id}')">Pedido</button>
            <button class="btn" onclick="printTicket('\${c._id}')">Imprimir</button>
          </td>
        \`;
        tb.appendChild(tr);
      }
    }
    function openMessages(id){ window.open('/api/admin/messages/' + id, '_blank'); }
    async function openOrder(id){ window.open('/api/admin/order/' + id, '_blank'); }
    function printTicket(id){ window.open('/admin/print/' + id + '?v=kitchen', '_blank'); }
    load();
  </script>
</body>
</html>`);
    });

    // JSON convers
    app.get("/api/admin/conversations", async (_req, res) => {
      try {
        const db = await getDb();
        const convs = await db.collection("conversations")
          .find({}, { sort: { openedAt: -1 } })
          .project({ waId:1, status:1, openedAt:1, closedAt:1, turns:1, contactName:1 })
          .limit(500).toArray();
        res.json(convs.map(c => ({ ...c, _id: c._id.toString() })));
      } catch (e) {
        res.status(200).json([]);
      }
    });

    // HTML mensajes
    app.get("/api/admin/messages/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const db = await getDb();
        const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
        if (!conv) return res.status(404).send("Conversation not found");

        const msgs = await db.collection("messages")
          .find({ conversationId: new ObjectId(id) }).sort({ ts: 1 }).toArray();

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html>
  <html><head><meta charset="utf-8" /><title>Mensajes</title>
  <style> body{font-family: system-ui, Arial; margin: 24px;} .msg{margin:8px 0;} .role{font-weight:bold;} pre{background:#f6f6f6;padding:8px;border-radius:4px;} .meta{color:#666;font-size:12px;}</style>
  </head><body>
  <h2>${escapeHtml(conv.contactName || '')} • ${escapeHtml(conv.waId || '')}</h2>
  ${msgs.map(m => `<div class="msg"><div class="role">${escapeHtml(m.role.toUpperCase())} <span class="meta">(${new Date(m.ts).toLocaleString()})</span></div><pre>${escapeHtml(m.content || '')}</pre></div>`).join('')}
  </body></html>`);
      } catch (e) {
        res.status(500).send("internal");
      }
    });

    // JSON pedido normalizado (si existiera)
    app.get("/api/admin/order/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const db = await getDb();
        const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
        if (!conv) return res.status(404).json({ error: "not_found" });
        const ord = await db.collection("orders").findOne({ conversationId: new ObjectId(id) });
        res.json({ waId: conv.waId, order: ord || null, rawPedido: conv.summary?.Pedido || null });
      } catch (e) {
        res.status(500).json({ error: "internal" });
      }
    });

    // Ticket básico
    app.get("/admin/print/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const db = await getDb();
        const conv = await db.collection("conversations").findOne({ _id: new ObjectId(id) });
        const ord = await db.collection("orders").findOne({ conversationId: new ObjectId(id) });

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html>
  <html><head><meta charset="utf-8" /><title>Ticket</title>
  <style>@page{size:80mm auto;margin:0} body{margin:0} .ticket{width:80mm;padding:6px 8px;font-family:monospace;font-size:12px} .center{text-align:center} .hr{border-top:1px dashed #000;margin:6px 0} .big{font-size:14px;font-weight:bold} @media print{.noprint{display:none}}</style>
  </head><body>
  <div class="ticket">
    <div class="center big">PEDIDO</div>
    <div>${new Date().toLocaleString()}</div>
    <div class="hr"></div>
    <div>Cliente: ${(conv?.contactName||'')} (${(conv?.waId||'')})</div>
    <div class="hr"></div>
    <div>Detalle:</div>
    <pre>${escapeHtml(JSON.stringify(ord || conv?.summary?.Pedido || {}, null, 2))}</pre>
    <div class="hr"></div>
    <button class="noprint" onclick="window.print()">Imprimir</button>
  </div>
  </body></html>`);
      } catch (e) {
        res.status(500).send("internal");
      }
    });
  };
