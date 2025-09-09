/* Carga lógica sin modificar el código original */
eval(require('fs').readFileSync(require('path').join(__dirname,'logic.split.js'),'utf8'));

const express = require("express");const app = express();app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/public', express.static('public'));


app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.get("/cache/audio/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});
app.get("/cache/image/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});
app.get("/cache/tts/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});

app.post("/api/behavior/refresh-cache", async (_req, res) => {
  try {
    invalidateBehaviorCache();
    res.json({ ok: true, cache: "invalidated" });
  } catch (e) {
    console.error("⚠️ refresh-cache error:", e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/", (_req, res) => res.status(200).send("WhatsApp Webhook up ✅"));

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Verificación fallida");
  return res.sendStatus(403);
});


app.get("/comportamiento", async (_req, res) => {
  try {
    const text = (BEHAVIOR_SOURCE === "env")
      ? await loadBehaviorTextFromEnv()
      : (BEHAVIOR_SOURCE === "mongo")
        ? await loadBehaviorTextFromMongo()
        : await loadBehaviorTextFromSheet();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Comportamiento del Bot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; max-width: 960px; }
    textarea { width: 100%; min-height: 360px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace; font-size: 14px; }
    .row { display:flex; gap:8px; align-items:center; }
    .hint { color:#666; font-size: 12px; }
    .tag { padding:2px 6px; border:1px solid #ccc; border-radius:4px; font-size:12px; }
  </style>
</head>
<body>
  <h1>Comportamiento del Bot</h1>
  <p class="hint">Fuente actual: <span class="tag">${BEHAVIOR_SOURCE}</span>. ${BEHAVIOR_SOURCE !== "mongo" ? 'Para editar aquí, seteá <code>BEHAVIOR_SOURCE=mongo</code> y reiniciá.' : ''}</p>
  <div class="row">
    <button id="btnReload">Recargar</button>
    ${BEHAVIOR_SOURCE === "mongo" ? '<button id="btnSave">Guardar</button>' : ''}
  </div>
  <p></p>
  <textarea id="txt"></textarea>
  <script>
    async function load() {
      const r = await fetch('/api/behavior');
      const j = await r.json();
      document.getElementById('txt').value = j.text || '';
    }
    ${BEHAVIOR_SOURCE === "mongo" ? `
    async function save() {
      const v = document.getElementById('txt').value || '';
      const r = await fetch('/api/behavior', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: v })
      });
      if (r.ok) alert('Guardado ✅'); else alert('Error al guardar');
    }
    document.getElementById('btnSave').addEventListener('click', save);
    ` : ``}
    document.getElementById('btnReload').addEventListener('click', load);
    load();
  </script>
</body>
</html>`);
  } catch (e) {
    console.error("⚠️ /comportamiento error:", e);
    res.status(500).send("internal");
  }
});

app.get("/api/behavior", async (_req, res) => {
  try {
    const text = (BEHAVIOR_SOURCE === "env")
      ? await loadBehaviorTextFromEnv()
      : (BEHAVIOR_SOURCE === "mongo")
        ? await loadBehaviorTextFromMongo()
        : await loadBehaviorTextFromSheet();
    res.json({ source: BEHAVIOR_SOURCE, text });
  } catch (e) {
    res.status(500).json({ error: "internal" });
  }
});
app.post("/api/behavior", async (req, res) => {
  try {
    if (BEHAVIOR_SOURCE !== "mongo") {
      return res.status(400).json({ error: "behavior_source_not_mongo" });
    }
    const text = String(req.body?.text || "").trim();
    await saveBehaviorTextToMongo(text);
    res.json({ ok: true });
  } catch (e) {
    console.error("⚠️ POST /api/behavior error:", e);
    res.status(500).json({ error: "internal" });
  }
});
app.post("/webhook", async (req, res) => {
  try {
    if (process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) {
      console.warn("❌ Firma inválida");
      return res.sendStatus(403);
    }
    const body = req.body;
    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(404);
    }
    res.sendStatus(200); // responder rápido

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const messages = value.messages || [];
        const contactName = value?.contacts?.[0]?.profile?.name || null;

        if (!messages.length) continue;

        for (const msg of messages) {
          const from = msg.from; // E.164 sin '+'
          const type = msg.type;
          const messageId = msg.id;

          // markAsRead
          const phoneNumberIdForRead = getPhoneNumberId(value);
          if (messageId && phoneNumberIdForRead) {
            markAsRead(messageId, phoneNumberIdForRead).catch(() => {});
          }

          // normalizar entrada
          let userText = "";
          let userMeta = {};
          try {
            if (type === "text") {
              userText = msg.text?.body || "";
            } else if (type === "interactive") {
              const it = msg.interactive;
              if (it?.type === "button_reply") userText = it.button_reply?.title || "";
              if (it?.type === "list_reply")   userText = it.list_reply?.title || "";
              if (!userText) userText = "Seleccionaste una opción. ¿En qué puedo ayudarte?";
            } else if (type === "audio") {
              const mediaId = msg.audio?.id;
              if (!mediaId) {
                userText = "Recibí un audio, pero no pude obtenerlo. ¿Podés escribir tu consulta?";
              } else {
                const info = await getMediaInfo(mediaId); // { url, mime_type }
                const buffer = await downloadMediaBuffer(info.url);
                const id = putInCache(buffer, info.mime_type);
                const baseUrl = getBaseUrl(req);
                const publicUrl = `${baseUrl}/cache/audio/${id}`;
                userMeta.mediaUrl = publicUrl;

                try {
                  const trData = await transcribeAudioExternal({ publicAudioUrl: publicUrl, buffer, mime: info.mime_type, filename: "audio.ogg" });
                  const transcript = trData.text || trData.transcript || trData.transcription || trData.result || "";
                  if (transcript) {
                    userMeta.transcript = transcript;
                    userText = `Transcripción del audio del usuario: "${transcript}"`;
                  } else {
                    userText = "No obtuve texto de la transcripción. ¿Podés escribir tu consulta?";
                  }
                } catch (e) {
                  console.error("❌ Transcribe API error:", e.message);
                  userText = "No pude transcribir tu audio. ¿Podés escribir tu consulta?";
                }
              }
            } else if (type === "image") {
              const mediaId = msg.image?.id;
              if (!mediaId) {
                userText = "Recibí una imagen pero no pude descargarla. ¿Podés describir lo que dice?";
              } else {
                const info = await getMediaInfo(mediaId);
                const buffer = await downloadMediaBuffer(info.url);
                const id = putInCache(buffer, info.mime_type);
                const baseUrl = getBaseUrl(req);
                const publicUrl = `${baseUrl}/cache/image/${id}`;
                userMeta.mediaUrl = publicUrl;

                const text = await transcribeImageWithOpenAI(publicUrl);
                if (text) {
                  userMeta.ocrText = text;
                  userText = `Texto detectado en la imagen: "${text}"`;
                } else {
                  userText = "No pude detectar texto en la imagen. ¿Podés escribir lo que dice?";
                }
              }
            } else if (type === "document") {
              userText = "Recibí un documento. Pegá el texto relevante o contame tu consulta.";
            } else {
              userText = "Hola 👋 ¿Podés escribir tu consulta en texto?";
            }
          } catch (e) {
            console.error("⚠️ Error normalizando entrada:", e);
            userText = "Hola 👋 ¿Podés escribir tu consulta en texto?";
          }

          console.log("📩 IN:", { from, type, preview: (userText || "").slice(0, 120) });
         // tokens de OpenAI
        
/*
          // tokens de OpenAI (usage) capturados más arriba en el flujo
          const _usage = (raw && raw.usage) || (out && out.usage) || null;
          const _tokens = _usage ? {
            prompt: _usage.prompt_tokens || 0,
            completion: _usage.completion_tokens || 0,
            total: _usage.total_tokens || 0
          } : null

*/
          // persistencia usuario: aseguro conv abierta y guardo nombre si viene
          const conv = await ensureOpenConversation(from, { contactName });
          await appendMessage(conv._id, {
            role: "user",
            content: userText,
            type,
            meta: userMeta
          });

          // modelo
          let responseText = "Perdón, no pude generar una respuesta. ¿Podés reformular?";
          let estado = "IN_PROGRESS";
          let raw = null;
          let out = null;
          try {
            out = await chatWithHistoryJSON(from, userText);
            responseText = out.response || responseText;
            estado = (out.estado || "IN_PROGRESS").toUpperCase();
            raw = out.raw || null;
            console.log("✅ modelo respondió, estado:", estado);
          } catch (e) {
            console.error("❌ OpenAI error:", e);
          }

          // enviar siempre con fallback a phone_number_id
          await sendSafeText(from, responseText, value);
          console.log("OUT →", from, "| estado:", estado);

          // tokens de OpenAI (usage) a partir de la salida real del modelo
          const _usage = out?.usage || null;
          const _tokens = _usage ? {
            prompt: _usage.prompt_tokens || 0,
            completion: _usage.completion_tokens || 0,
            total: _usage.total_tokens || 0
          } : null;

          // persistencia assistant
          await appendMessage(conv._id, {
            role: "assistant",
            content: responseText,
            type: "text",
            meta: { estado, tokens: _tokens }
          });
           // acumular tokens a nivel conversación
          if (conv && conv._id) {
            await bumpConversationTokenCounters(conv._id, _tokens, "assistant");
          }

          // TTS si el usuario envió audio
          if (type === "audio" && (process.env.ENABLE_TTS_FOR_AUDIO || "true").toLowerCase() === "true") {
            try {
              const { buffer, mime } = await synthesizeTTS(responseText);
              const ttsId = putInCache(buffer, mime || "audio/mpeg");
              const baseUrl = getBaseUrl(req);
              const ttsUrl = `${baseUrl}/cache/tts/${ttsId}`;
              const phoneId = getPhoneNumberId(value);
              if (phoneId) await sendAudioLink(from, ttsUrl, phoneId);
            } catch (e) {
              console.error("⚠️ Error generando/enviando TTS:", e);
            }
          }

          // cierre + Sheets + order (idempotente)
          const shouldFinalize =
            (estado && estado !== "IN_PROGRESS") ||
            ((raw?.Pedido?.["Estado pedido"] || "").toLowerCase().includes("cancel"));

          if (shouldFinalize) {
            try {
              const result = await finalizeConversationOnce(conv._id, raw, estado);
              if (result.didFinalize) {
                resetSession(from); // limpia historial en memoria
                console.log("🔁 Historial reiniciado para", from, "| estado:", estado);
              } else {
                console.log("ℹ️ Ya estaba finalizada; no se guarda en Sheets de nuevo.");
              }
            } catch (e) {
              console.error("⚠️ Error al finalizar conversación:", e);
            }
          }

          console.log("⏹ end task", from, "msg:" + (messageId || ""));
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error en webhook:", err);
  }
});

app.get("/admin", async (req, res) => {
  // HTML minimal con fetch al endpoint JSON
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
    /* modal */
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
  <title>Mensajes - ${conv.waId}</title>
  <style>
    body { font-family: system-ui, -apple-system, Arial, sans-serif; margin: 24px; }
    .msg { margin-bottom: 12px; }
    .role { font-weight: bold; }
    .meta { color: #666; font-size: 12px; }
    pre { background:#f6f6f6; padding:8px; border-radius:4px; overflow:auto; }
  </style>
</head>
<body>
  <h2>Mensajes - ${conv.contactName ? (conv.contactName + " • ") : ""}${conv.waId}</h2>
  <div>
    ${msgs.map(m => `
      <div class="msg">
        <div class="role">${m.role.toUpperCase()} <span class="meta">(${new Date(m.ts).toLocaleString()})</span></div>
        <pre>${(m.content || "").replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>
        ${m.meta && Object.keys(m.meta).length ? `<div class="meta">meta: <code>${JSON.stringify(m.meta)}</code></div>` : ""}
      </div>
    `).join("")}
  </div>
</body>
</html>
    `);
  } catch (e) {
    console.error("⚠️ /api/admin/messages error:", e);
    res.status(500).send("internal");
  }
});

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
      // si no hay order, intentamos construirla desde summary y crearla procesada
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
    console.error("⚠️ /admin/print error:", e);
    res.status(500).send("internal");
  }
});


app.get("/api/products", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const q = req.query.all === "true" ? {} : { active: { $ne: false } };
    const items = await database.collection("products")
      .find(q).sort({ createdAt: -1, descripcion: 1 }).toArray();

    res.json(items.map(it => ({ ...it, _id: String(it._id) })));
  } catch (e) {
    console.error("GET /api/products error:", e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/products", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

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
    const doc = { descripcion, observacion, active, createdAt: now, updatedAt: now };
    if (imp !== null) doc.importe = imp;

    const ins = await database.collection("products").insertOne(doc);
     invalidateBehaviorCache();
    res.json({ ok: true, _id: String(ins.insertedId) });
  } catch (e) {
    console.error("POST /api/products error:", e);
    res.status(500).json({ error: "internal" });
  }
});

app.put("/api/products/:id", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const { id } = req.params;
    const upd = {};
    ["descripcion","observacion","active","importe"].forEach(k => {
      if (req.body[k] !== undefined) upd[k] = req.body[k];
    });
    if (upd.importe !== undefined) {
      const v = upd.importe;
      if (typeof v === "string") {
        const n = Number(v.replace(/[^\d.,-]/g, "").replace(",", "."));
        upd.importe = Number.isFinite(n) ? n : undefined;
      }
    }
    if (Object.keys(upd).length === 0) return res.status(400).json({ error: "no_fields" });
    upd.updatedAt = new Date();

    const result = await database.collection("products").updateOne(
      { _id: new ObjectId(String(id)) },
      { $set: upd }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    
    invalidateBehaviorCache();
    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /api/products/:id error:", e);
    res.status(500).json({ error: "internal" });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const { id } = req.params;
    const result = await database.collection("products").deleteOne({ _id: new ObjectId(String(id)) });
    if (!result.deletedCount) return res.status(404).json({ error: "not_found" });
    rinvalidateBehaviorCache();
   res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/products/:id error:", e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/products/:id/inactivate", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const { id } = req.params;
    const result = await database.collection("products").updateOne(
      { _id: new ObjectId(String(id)) },
      { $set: { active: false, updatedAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    invalidateBehaviorCache();
   res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/products/:id/inactivate error:", e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/products/:id/reactivate", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    const { id } = req.params;
    const result = await database.collection("products").updateOne(
      { _id: new ObjectId(String(id)) },
      { $set: { active: true, updatedAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    invalidateBehaviorCache();
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/products/:id/reactivate error:", e);
    res.status(500).json({ error: "internal" });
  }
});
app.get("/productos", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;

    if (!database) throw new Error("DB no inicializada");

    const verTodos = req.query.all === "true";
    const filtro = verTodos ? {} : { active: { $ne: false } };

    const productos = await database
      .collection("products")
      .find(filtro)
      .sort({ createdAt: -1 })
      .toArray();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Productos</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:1100px}
    table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
    th{background:#f5f5f5;text-align:left}
    input[type="text"],input[type="number"],textarea{width:100%;box-sizing:border-box}
    textarea{min-height:56px}
    .row{display:flex;gap:8px;align-items:center}
    .muted{color:#666;font-size:12px}.pill{border:1px solid #ccc;border-radius:999px;padding:2px 8px;font-size:12px}
    .btn{padding:6px 10px;border:1px solid #333;background:#fff;border-radius:4px;cursor:pointer}
    .btn + .btn{margin-left:6px}
  </style>
</head>
<body>
  <h1>Productos</h1>
  <p class="muted">Fuente: <span class="pill">MongoDB (colección <code>products</code>)</span></p>

  <div class="row">
    <a class="btn" href="/productos${verTodos ? "" : "?all=true"}">${verTodos ? "Ver solo activos" : "Ver todos"}</a>
    <button id="btnAdd" class="btn">Agregar</button>
    <button id="btnReload" class="btn">Recargar</button>
  </div>
  <p></p>

  <table id="tbl">
    <thead>
      <tr>
        <th>Descripción</th><th>Importe</th><th>Observación</th><th>Activo</th><th>Acciones</th>
      </tr>
    </thead>
    <tbody>
      ${
        productos.length ? productos.map(p => `
          <tr data-id="${p._id}">
            <td><input type="text" class="descripcion" value="${(p.descripcion ?? "").toString().replace(/"/g,'&quot;')}" /></td>
            <td><input type="number" class="importe" step="0.01" value="${typeof p.importe==='number'?p.importe:(p.importe??'')}" /></td>
            <td><textarea class="observacion">${(p.observacion ?? "").toString().replace(/</g,'&lt;')}</textarea></td>
            <td style="text-align:center;"><input type="checkbox" class="active" ${p.active!==false?"checked":""} /></td>
            <td>
              <button class="btn save">Guardar</button>
              <button class="btn del">Eliminar</button>
              <button class="btn toggle">${p.active!==false?"Inactivar":"Reactivar"}</button>
            </td>
          </tr>
        `).join("") : `<tr><td colspan="5" style="text-align:center;color:#666">Sin productos para mostrar</td></tr>`
      }
    </tbody>
  </table>

  <template id="row-tpl">
    <tr>
      <td><input type="text" class="descripcion" placeholder="Ej: Pollo entero" /></td>
      <td><input type="number" class="importe" step="0.01" placeholder="0.00" /></td>
      <td><textarea class="observacion" placeholder="Observaciones / reglas"></textarea></td>
      <td style="text-align:center;"><input type="checkbox" class="active" checked /></td>
      <td>
        <button class="btn save">Guardar</button>
        <button class="btn del">Eliminar</button>
        <button class="btn toggle">Inactivar</button>
      </td>
    </tr>
  </template>

  <script>
    function q(sel, ctx){ return (ctx||document).querySelector(sel) }
    function all(sel, ctx){ return Array.from((ctx||document).querySelectorAll(sel)) }

    async function j(url, opts){
      const r = await fetch(url, opts||{});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const ct = r.headers.get('content-type')||'';
      return ct.includes('application/json') ? r.json() : r.text();
    }

    async function reload(){
      const url = new URL(location.href);
      const allFlag = url.searchParams.get('all') === 'true';
      const data = await j('/api/products' + (allFlag ? '?all=true' : ''));
      const tb = q('#tbl tbody');
      tb.innerHTML = '';
      for (const it of data){
        const tr = q('#row-tpl').content.firstElementChild.cloneNode(true);
        tr.dataset.id = it._id || '';
        q('.descripcion', tr).value = it.descripcion || '';
        q('.importe', tr).value = typeof it.importe==='number' ? it.importe : (it.importe||'');
        q('.observacion', tr).value = it.observacion || '';
        q('.active', tr).checked = it.active !== false;
        q('.toggle', tr).textContent = (it.active !== false) ? 'Inactivar' : 'Reactivar';

        bindRow(tr);
        tb.appendChild(tr);
      }
      if (!data.length){
        const r = document.createElement('tr');
        r.innerHTML = '<td colspan="5" style="text-align:center;color:#666">Sin productos para mostrar</td>';
        tb.appendChild(r);
      }
    }

    async function saveRow(tr){
      const id = tr.dataset.id;
      const payload = {
        descripcion: q('.descripcion', tr).value.trim(),
        importe: q('.importe', tr).value.trim(),
        observacion: q('.observacion', tr).value.trim(),
        active: q('.active', tr).checked
      };
      if (!payload.descripcion){ alert('Descripción requerida'); return; }
      if (id){
        await j('/api/products/'+encodeURIComponent(id), {
          method:'PUT',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
      } else {
        await j('/api/products', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
      }
      await reload();
    }

    async function deleteRow(tr){
      const id = tr.dataset.id;
      if (!id) { tr.remove(); return; }
      if (!confirm('¿Eliminar definitivamente?')) return;
      await j('/api/products/'+encodeURIComponent(id), { method:'DELETE' });
      await reload();
    }

    async function toggleRow(tr){
      const id = tr.dataset.id;
      if (!id) { alert('Primero guardá el nuevo producto.'); return; }
      const active = q('.active', tr).checked;
      const path = active ? '/api/products/'+encodeURIComponent(id)+'/inactivate'
                          : '/api/products/'+encodeURIComponent(id)+'/reactivate';
      await j(path, { method:'POST' });
      await reload();
    }

    function bindRow(tr){
      q('.save', tr).addEventListener('click', ()=> saveRow(tr));
      q('.del', tr).addEventListener('click', ()=> deleteRow(tr));
      q('.toggle', tr).addEventListener('click', ()=> toggleRow(tr));
    }

    // Bind inicial a filas SSR
    all('#tbl tbody tr').forEach(bindRow);

    // Botones generales
    q('#btnAdd').addEventListener('click', ()=>{
      const tb = q('#tbl tbody');
      const tr = q('#row-tpl').content.firstElementChild.cloneNode(true);
      bindRow(tr);
      tb.prepend(tr);
      q('.descripcion', tr).focus();
    });
    q('#btnReload').addEventListener('click', reload);
  </script>
</body>
</html>`);
  } catch (err) {
    console.error("❌ /productos error:", err);
    res.status(500).send("Error al obtener productos");
  }
});





app.get("/productos.json", async (req, res) => {
  try {
    const database =
      (typeof getDb === "function" && await getDb()) ||
      req.app?.locals?.db ||
      global.db;
    const data = await database.collection("products").find({}).limit(50).toArray();
    res.json(data);
  } catch (e) {
    console.error(e); res.status(500).json({ error: String(e) });
  }
});


const PORT = process.env.PORT || 3000;app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));