// token_control_stats.js
// Panel y API para control de tokens por dominio, conversación y pedido completado.
 
const { ObjectId } = require("mongodb");

const { getDb } = require("./db");

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseDateStart(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return new Date(`${s}T00:00:00.000Z`);
}

function parseDateEnd(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return new Date(`${s}T23:59:59.999Z`);
}

function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clampInt(v, min, max, fallback = min) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function buildUsageMatch({ tenantId = "", from = "", to = "" } = {}) {
  const match = {};
  const safeTenant = String(tenantId || "").trim();
  if (safeTenant) match.tenantId = safeTenant;

  const createdAt = {};
  const fromDate = parseDateStart(from);
  const toDate = parseDateEnd(to);
  if (fromDate) createdAt.$gte = fromDate;
  if (toDate) createdAt.$lte = toDate;
   if (Object.keys(createdAt).length) match.createdAt = createdAt;
  return { match, safeTenant };
}

async function loadTenantCosts(db, tenantIds = []) {
  const ids = Array.from(new Set(
    (Array.isArray(tenantIds) ? tenantIds : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  ));

  if (!ids.length) return new Map();

  const rows = await db.collection("tenant_config")
    .find({ _id: { $in: ids } }, {
      projection: {
        _id: 1,
        nom_emp: 1,
        numero: 1,
        token_cost_chat_input_per_1k: 1,
        token_cost_chat_output_per_1k: 1,
        token_cost_audio_input_per_1k: 1,
        token_cost_audio_output_per_1k: 1
      }
    }).toArray();

  return new Map(rows.map((doc) => [String(doc._id || ""), doc]));
}

function calculateEstimatedCost(row, tenantDoc = {}) {
  const messageInput = Number(row.message_input_tokens || 0);
  const messageOutput = Number(row.message_output_tokens || 0);
  const audioInput = Number(row.audio_input_tokens || 0);
  const audioOutput = Number(row.audio_output_tokens || 0);

  const costChatInput = toPositiveNumber(tenantDoc.token_cost_chat_input_per_1k);
  const costChatOutput = toPositiveNumber(tenantDoc.token_cost_chat_output_per_1k);
  const costAudioInput = toPositiveNumber(tenantDoc.token_cost_audio_input_per_1k);
  const costAudioOutput = toPositiveNumber(tenantDoc.token_cost_audio_output_per_1k);

  return Number((
    (messageInput / 1000) * costChatInput +
    (messageOutput / 1000) * costChatOutput +
    (audioInput / 1000) * costAudioInput +
    (audioOutput / 1000) * costAudioOutput
  ).toFixed(6));
}

async function buildTokenSummary({ tenantId = "", from = "", to = "", isSuper = false } = {}) {
  const db = await getDb();
  const { match, safeTenant } = buildUsageMatch({ tenantId, from, to });


  const rows = await db.collection("ai_token_usage_log").aggregate([
    { $match: match },
    {
      $group: {
        _id: "$tenantId",
        message_input_tokens: {
          $sum: {
            $cond: [{ $eq: ["$kind", "message"] }, { $ifNull: ["$inputTokens", 0] }, 0]
          }
        },
        message_output_tokens: {
          $sum: {
            $cond: [{ $eq: ["$kind", "message"] }, { $ifNull: ["$outputTokens", 0] }, 0]
          }
        },
        audio_input_tokens: {
          $sum: {
            $cond: [{ $eq: ["$kind", "audio"] }, { $ifNull: ["$inputTokens", 0] }, 0]
          }
        },
        audio_output_tokens: {
          $sum: {
            $cond: [{ $eq: ["$kind", "audio"] }, { $ifNull: ["$outputTokens", 0] }, 0]
          }
        },
        total_tokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
        events: { $sum: 1 },
        last_at: { $max: "$createdAt" }
      }
    },
    { $sort: { _id: 1 } }
  ]).toArray();

  const cfgByTenant = await loadTenantCosts(
    db,
    rows.map((r) => String(r._id || "").trim())
  );

  
  const items = rows.map((row) => {

    const tenantKey = String(row._id || "");
    const doc = cfgByTenant.get(tenantKey) || {};
    const item = {
      tenantId: tenantKey,

      company: String(doc.nom_emp || "").trim(),
      number: String(doc.numero || "").trim(),
      message_input_tokens: Number(row.message_input_tokens || 0),
      message_output_tokens: Number(row.message_output_tokens || 0),
      audio_input_tokens: Number(row.audio_input_tokens || 0),
      audio_output_tokens: Number(row.audio_output_tokens || 0),
      total_tokens: Number(row.total_tokens || 0),
      events: Number(row.events || 0),
      
      last_at: row.last_at || null
    };

    item.estimated_cost = calculateEstimatedCost(item, doc);
    item.cost_chat_input_per_1k = toPositiveNumber(doc.token_cost_chat_input_per_1k);
    item.cost_chat_output_per_1k = toPositiveNumber(doc.token_cost_chat_output_per_1k);
    item.cost_audio_input_per_1k = toPositiveNumber(doc.token_cost_audio_input_per_1k);
    item.cost_audio_output_per_1k = toPositiveNumber(doc.token_cost_audio_output_per_1k);
    return item;
  });

  const totals = items.reduce((acc, item) => {
    acc.message_input_tokens += item.message_input_tokens;
    acc.message_output_tokens += item.message_output_tokens;
    acc.audio_input_tokens += item.audio_input_tokens;
    acc.audio_output_tokens += item.audio_output_tokens;
    acc.total_tokens += item.total_tokens;
    acc.events += item.events;
    acc.estimated_cost += item.estimated_cost;
    return acc;
  }, {
    message_input_tokens: 0,
    message_output_tokens: 0,
    audio_input_tokens: 0,
    audio_output_tokens: 0,
    total_tokens: 0,
    events: 0,
    estimated_cost: 0
  });

  totals.estimated_cost = Number(totals.estimated_cost.toFixed(6));

  return {
    ok: true,
    filters: {
      tenantId: safeTenant || null,
      from: from || null,
      to: to || null,
      isSuper: !!isSuper
    },
    items,
    totals
  };
}
function normalizeStatus(conv, order) {
  const raw = String(
    order?.estado ||
    order?.status ||
    conv?.pedidoEstado ||
    conv?.status ||
    (conv?.finalized ? "COMPLETED" : "OPEN")
  ).trim().toUpperCase();

  if (["COMPLETED", "COMPLETO", "CONFIRMADO"].includes(raw)) return "COMPLETED";
  if (["CANCELLED", "CANCELED", "CANCELADO", "CANCELADA"].includes(raw)) return "CANCELLED";
  if (raw.startsWith("PENDIENTE")) return "PENDIENTE";
  return raw || "OPEN";
}

function pedidoFromDocs(conv, order) {
  const p1 = order?.pedido;
  if (p1 && typeof p1 === "object") return p1;
  const p2 = conv?.lastPedidoSnapshot?.Pedido;
  if (p2 && typeof p2 === "object") return p2;
  return null;
}

async function buildTokenConversationSummary({
  tenantId = "",
  from = "",
  to = "",
  view = "all",
  limit = 500,
  isSuper = false
} = {}) {
  const db = await getDb();
  const { match, safeTenant } = buildUsageMatch({ tenantId, from, to });
  const safeView = String(view || "all").trim().toLowerCase() === "completed" ? "completed" : "all";
  const safeLimit = clampInt(limit, 1, 1000, 500);
  const aggregateLimit = Math.min(4000, Math.max(500, safeLimit * 4));

  const facetRows = await db.collection("ai_token_usage_log").aggregate([
    { $match: match },
    {
      $addFields: {
        _conversationId: {
          $convert: {
            input: { $ifNull: ["$conversationId", "$meta.conversationId"] },
            to: "string",
            onError: "",
            onNull: ""
          }
        },
        _waId: { $ifNull: ["$waId", "$meta.waId"] },
        _channelType: { $ifNull: ["$channelType", "$meta.channelType"] }
      }
    },
    {
      $facet: {
        assigned: [
          { $match: { _conversationId: { $ne: "" } } },
          {
            $group: {
              _id: {
                tenantId: "$tenantId",
                conversationId: "$_conversationId"
              },
              waId: { $last: "$_waId" },
              channelType: { $last: "$_channelType" },
              message_input_tokens: {
                $sum: {
                  $cond: [{ $eq: ["$kind", "message"] }, { $ifNull: ["$inputTokens", 0] }, 0]
                }
              },
              message_output_tokens: {
                $sum: {
                  $cond: [{ $eq: ["$kind", "message"] }, { $ifNull: ["$outputTokens", 0] }, 0]
                }
              },
              audio_input_tokens: {
                $sum: {
                  $cond: [{ $eq: ["$kind", "audio"] }, { $ifNull: ["$inputTokens", 0] }, 0]
                }
              },
              audio_output_tokens: {
                $sum: {
                  $cond: [{ $eq: ["$kind", "audio"] }, { $ifNull: ["$outputTokens", 0] }, 0]
                }
              },
              total_tokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
              events: { $sum: 1 },
              first_at: { $min: "$createdAt" },
              last_at: { $max: "$createdAt" },
              models: { $addToSet: "$model" }
            }
          },
          { $sort: { last_at: -1 } },
          { $limit: aggregateLimit }
        ],
        unassigned: [
          { $match: { _conversationId: "" } },
          {
            $group: {
              _id: null,
              total_tokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
              events: { $sum: 1 }
            }
          }
        ]
      }
    }
  ]).toArray();

  const assignedRows = Array.isArray(facetRows?.[0]?.assigned) ? facetRows[0].assigned : [];
  const unassignedRow = facetRows?.[0]?.unassigned?.[0] || {};

  const objectIds = [];
  for (const row of assignedRows) {
    const id = String(row?._id?.conversationId || "").trim();
    if (ObjectId.isValid(id) && !objectIds.some((x) => String(x) === id)) {
      objectIds.push(new ObjectId(id));
    }
  }

  const [conversationDocs, orderDocs, cfgByTenant] = await Promise.all([
    objectIds.length
      ? db.collection("conversations").find(
          { _id: { $in: objectIds } },
          {
            projection: {
              tenantId: 1,
              waId: 1,
              contactName: 1,
              status: 1,
              pedidoEstado: 1,
              finalized: 1,
              openedAt: 1,
              createdAt: 1,
              updatedAt: 1,
              closedAt: 1,
              channelType: 1,
              lastPedidoSnapshot: 1
            }
          }
        ).toArray()
      : [],
    objectIds.length
      ? db.collection("orders").find(
          { conversationId: { $in: objectIds } },
          {
            projection: {
              tenantId: 1,
              conversationId: 1,
              from: 1,
              pedido: 1,
              estado: 1,
              status: 1,
              createdAt: 1,
              updatedAt: 1
            }
          }
        ).sort({ updatedAt: -1, createdAt: -1 }).toArray()
      : [],
    loadTenantCosts(
      db,
      assignedRows.map((r) => String(r?._id?.tenantId || "").trim())
    )
  ]);

  const convById = new Map(conversationDocs.map((doc) => [String(doc._id || ""), doc]));
  const orderByConversation = new Map();
  for (const order of orderDocs) {
    const key = String(order.conversationId || "");
    if (key && !orderByConversation.has(key)) orderByConversation.set(key, order);
  }

  let items = assignedRows.map((row) => {
    const tenantKey = String(row?._id?.tenantId || "");
    const conversationId = String(row?._id?.conversationId || "");
    const conv = convById.get(conversationId) || null;
    const order = orderByConversation.get(conversationId) || null;
    const pedido = pedidoFromDocs(conv, order);
    const tenantDoc = cfgByTenant.get(tenantKey) || {};
   const status = normalizeStatus(conv, order);
    const contactName = String(
      pedido?.nombre_apellido ||
      conv?.contactName ||
      ""
    ).trim();
    const waId = String(
      row.waId ||
      conv?.waId ||
      order?.from ||
      ""
    ).trim();

    const item = {
      tenantId: tenantKey,
      company: String(tenantDoc.nom_emp || "").trim(),
      conversationId,
      orderId: order?._id ? String(order._id) : "",
      status,
      completed: status === "COMPLETED",
      contactName,
      waId,
      channelType: String(row.channelType || conv?.channelType || "whatsapp").trim().toLowerCase(),
      message_input_tokens: Number(row.message_input_tokens || 0),
      message_output_tokens: Number(row.message_output_tokens || 0),
      audio_input_tokens: Number(row.audio_input_tokens || 0),
      audio_output_tokens: Number(row.audio_output_tokens || 0),
      total_tokens: Number(row.total_tokens || 0),
      events: Number(row.events || 0),
      models: (Array.isArray(row.models) ? row.models : []).filter(Boolean),
      pedido_total: Number(pedido?.total_pedido || 0),
      pedido_fecha: String(pedido?.fecha_pedido || pedido?.Fecha || "").trim() || null,
      pedido_hora: String(pedido?.hora_pedido || pedido?.Hora || "").trim() || null,
      first_at: row.first_at || conv?.openedAt || conv?.createdAt || null,
      last_at: row.last_at || conv?.updatedAt || null,
      closed_at: conv?.closedAt || order?.updatedAt || null
    };

    item.estimated_cost = calculateEstimatedCost(item, tenantDoc);
    return item;
  });

  if (safeView === "completed") {
    items = items.filter((item) => item.completed);
  }

  items = items.slice(0, safeLimit);

  const completed = items.filter((item) => item.completed);
  const totals = items.reduce((acc, item) => {
    acc.conversations += 1;
    acc.completed_orders += item.completed ? 1 : 0;
    acc.total_tokens += item.total_tokens;
    acc.estimated_cost += item.estimated_cost;
    return acc;
  }, {
    conversations: 0,
    completed_orders: 0,
    total_tokens: 0,
    estimated_cost: 0,
    average_tokens_per_completed_order: 0,
    average_cost_per_completed_order: 0,
    unassigned_tokens: Number(unassignedRow.total_tokens || 0),
    unassigned_events: Number(unassignedRow.events || 0)
  });

  if (completed.length) {
    totals.average_tokens_per_completed_order = Math.round(
      completed.reduce((sum, item) => sum + item.total_tokens, 0) / completed.length
    );
    totals.average_cost_per_completed_order = Number((
      completed.reduce((sum, item) => sum + item.estimated_cost, 0) / completed.length
    ).toFixed(6));
  }

  totals.estimated_cost = Number(totals.estimated_cost.toFixed(6));

  return {
    ok: true,
    filters: {
      tenantId: safeTenant || null,
      from: from || null,
      to: to || null,
      view: safeView,
      limit: safeLimit,
      isSuper: !!isSuper
    },
    items,
    totals
  };
}

function renderTokenControlPage(user) {
  const isSuper = String(user?.role || "").toLowerCase() === "superadmin";
  const tenant = String(user?.tenantId || "").trim();
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Control de Tokens</title>
  <style>
    :root{
      --bg:#f8fafc;
      --card:#ffffff;
      --text:#0f172a;
      --muted:#64748b;
      --border:rgba(148,163,184,.28);
      --accent:#0f3b68;
      --accent-2:#2563eb;
      --ok:#0f766e;
      --warn:#b45309;
      --danger:#b42318;
    }
    *{box-sizing:border-box}
    body{margin:0;padding:22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text)}
    .shell{display:flex;flex-direction:column;gap:16px}
    .toolbar{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
    .small{font-size:13px;color:var(--muted)}
    .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;box-shadow:0 10px 24px rgba(15,23,42,.06)}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
    label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted);min-width:160px}
    input,select{height:40px;border-radius:12px;border:1px solid var(--border);padding:0 12px;font-size:14px;background:#fff;color:var(--text)}
    .btn,.btn2{height:40px;padding:0 14px;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px}
    .btn{background:var(--accent);color:#fff;border:1px solid var(--accent)}
    .btn2{background:#fff;color:var(--text);border:1px solid var(--border)}
    .kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .kpis.detail{grid-template-columns:repeat(4,minmax(0,1fr))}
    .kpi{background:#fff;border:1px solid var(--border);border-radius:14px;padding:14px}
    .kpi .t{font-size:12px;color:var(--muted);margin-bottom:6px}
    .kpi .v{font-size:26px;font-weight:800;line-height:1.1}
    .tableWrap{overflow:auto;border:1px solid var(--border);border-radius:14px}
    table{width:100%;border-collapse:collapse;background:#fff;min-width:1050px}
    th,td{padding:12px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle;font-size:14px}
    thead th{position:sticky;top:0;background:#f8fafc;color:var(--text);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
    tbody tr:last-child td{border-bottom:none}
    .pill{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;border:1px solid rgba(37,99,235,.18);background:rgba(37,99,235,.08);color:var(--accent-2);font-size:12px;font-weight:700}
    .status{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:800;border:1px solid var(--border)}
    .status.completed{color:var(--ok);background:rgba(15,118,110,.08);border-color:rgba(15,118,110,.2)}
    .status.cancelled{color:var(--danger);background:rgba(180,35,24,.07);border-color:rgba(180,35,24,.18)}
    .status.pending{color:var(--warn);background:rgba(180,83,9,.08);border-color:rgba(180,83,9,.2)}
    .tenantHead,.stack{display:flex;flex-direction:column;gap:4px}
     .money{color:var(--ok);font-weight:800}
    .sectionTitle{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:10px}
    .sectionTitle h2{margin:0;font-size:19px}
    .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
    #msg{min-height:20px}
    @media (max-width:1100px){.kpis.detail{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (max-width:900px){.kpis,.kpis.detail{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <div>
        <h1 style="margin:0 0 4px">Control de Tokens</h1>
        <div class="small">Consumo de tokens por dominio y detalle por conversación o pedido completado.</div>
      </div>
      <div class="small">${isSuper ? 'Superadmin' : 'Admin'} · dominio: <b>${esc(tenant)}</b></div>
    </div>

    <div class="card">
      <div class="row">
        ${isSuper ? `<label>Dominio<input id="fTenant" placeholder="Todos los dominios"/></label>` : `<label>Dominio<input id="fTenant" value="${esc(tenant)}" readonly/></label>`}
        <label>Desde<input id="fFrom" type="date"/></label>
        
        <label>Detalle
          <select id="fView">
            <option value="all">Todas las conversaciones</option>
            <option value="completed">Solo pedidos completados</option>
          </select>
        </label>
        <button class="btn" type="button" id="btnReload">Actualizar</button>
      </div>
      <div id="msg" class="small" style="margin-top:10px"></div>
    </div>

    <div class="kpis">
      <div class="kpi">
        <div class="t">Tokens mensajes</div>
        <div class="v" id="kpiMessages">0</div>
      </div>
      <div class="kpi">
        <div class="t">Tokens audios</div>
        <div class="v" id="kpiAudios">0</div>
      </div>
      <div class="kpi">
        <div class="t">Costo estimado</div>
        <div class="v money" id="kpiCost">0</div>
      </div>
    </div>

    <div class="card">
      <div class="small" style="margin-bottom:10px">Los costos por 1.000 tokens se toman desde <b>Dominio Config</b> usando estos campos: <code>token_cost_chat_input_per_1k</code>, <code>token_cost_chat_output_per_1k</code>, <code>token_cost_audio_input_per_1k</code> y <code>token_cost_audio_output_per_1k</code>.</div>
      <div class="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Dominio</th>
              <th>Mensajes entrada</th>
              <th>Mensajes salida</th>
              <th>Audios entrada</th>
              <th>Audios salida</th>
              <th>Total tokens</th>
              <th>Eventos</th>
              <th>Costo estimado</th>
              <th>Último uso</th>
            </tr>
          </thead>
          <tbody id="rows">
            <tr><td colspan="9" class="small">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="kpis detail">
      <div class="kpi">
        <div class="t">Conversaciones con tokens</div>
        <div class="v" id="kpiConversations">0</div>
      </div>
      <div class="kpi">
        <div class="t">Pedidos completados</div>
        <div class="v" id="kpiCompleted">0</div>
      </div>
      <div class="kpi">
        <div class="t">Promedio tokens por pedido</div>
        <div class="v" id="kpiAvgOrder">0</div>
      </div>
      <div class="kpi">
        <div class="t">Tokens históricos sin conversación</div>
        <div class="v" id="kpiUnassigned">0</div>
      </div>
    </div>

    <div class="card">
      <div class="sectionTitle">
        <div>
          <h2>Tokens por conversación / pedido</h2>
          <div class="small">Cada fila suma todas las llamadas de IA vinculadas a la misma conversación. Los pedidos completados se reconocen por el estado guardado en <code>conversations</code> u <code>orders</code>.</div>
        </div>
      </div>
      <div id="detailNote" class="small" style="margin-bottom:10px"></div>
      <div class="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Dominio / estado</th>
              <th>Cliente</th>
              <th>Conversación / pedido</th>
              <th>Mensajes entrada</th>
              <th>Mensajes salida</th>
              <th>Audios</th>
              <th>Total tokens</th>
              <th>Eventos</th>
              <th>Costo estimado</th>
              <th>Último uso</th>
            </tr>
          </thead>
          <tbody id="detailRows">
            <tr><td colspan="10" class="small">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

<script>
(function(){
  const isSuper = ${isSuper ? 'true' : 'false'};
  const tenantEl = document.getElementById('fTenant');
  const fromEl = document.getElementById('fFrom');
  const toEl = document.getElementById('fTo');
  const viewEl = document.getElementById('fView');
  const rowsEl = document.getElementById('rows');
  const detailRowsEl = document.getElementById('detailRows');
  const detailNoteEl = document.getElementById('detailNote');
  const msgEl = document.getElementById('msg');
  const kpiMessages = document.getElementById('kpiMessages');
  const kpiAudios = document.getElementById('kpiAudios');
  const kpiCost = document.getElementById('kpiCost');
  const kpiConversations = document.getElementById('kpiConversations');
  const kpiCompleted = document.getElementById('kpiCompleted');
  const kpiAvgOrder = document.getElementById('kpiAvgOrder');
  const kpiUnassigned = document.getElementById('kpiUnassigned');
  const btnReload = document.getElementById('btnReload');

  function esc(s){
    return String(s||'').replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); });
  }
  function num(v){
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function fmtInt(v){
    return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(num(v));
  }
  function fmtMoney(v){
    return new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(num(v));
}
  function fmtOrderMoney(v){
    return new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 }).format(num(v));
  }
  function fmtDate(v){
    const s = String(v || '').trim();
    if (!s) return '-';
    try { return new Date(s).toLocaleString('es-AR'); } catch { return s; }
  }

  function shortId(v){
    const s = String(v || '').trim();
    if (!s) return '-';
    return s.length > 12 ? s.slice(0,6) + '…' + s.slice(-6) : s;
  }
  function statusClass(status){
    const s = String(status || '').toUpperCase();
    if (s === 'COMPLETED') return 'completed';
    if (s === 'CANCELLED') return 'cancelled';
    if (s.indexOf('PENDIENTE') === 0) return 'pending';
    return '';
  }

  function buildQuery(includeView){
    const qs = new URLSearchParams();
    const tenant = String(tenantEl.value || '').trim();
    const from = String(fromEl.value || '').trim();
    const to = String(toEl.value || '').trim();
    if (tenant) qs.set('tenantId', tenant);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (includeView) {
      qs.set('view', String(viewEl.value || 'all'));
      qs.set('limit', '500');
    }
    return qs;
  }

  async function getJson(url){
    const r = await fetch(url, {
      headers: { 'Accept':'application/json' },
      credentials: 'same-origin'
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
    return j || {};
  }

  function renderDomainSummary(j){
    const items = Array.isArray(j.items) ? j.items : [];
    const totals = j.totals || {};

    kpiMessages.textContent = fmtInt(num(totals.message_input_tokens) + num(totals.message_output_tokens));
    kpiAudios.textContent = fmtInt(num(totals.audio_input_tokens) + num(totals.audio_output_tokens));
    kpiCost.textContent = fmtMoney(totals.estimated_cost || 0);

    if (!items.length) {
      rowsEl.innerHTML = '<tr><td colspan="9" class="small">No hay consumos para los filtros seleccionados.</td></tr>';
      return;
    }

    rowsEl.innerHTML = items.map(function(it){
     const company = String(it.company || '').trim();
      const number = String(it.number || '').trim();
      return '<tr>' +
        '<td><div class="tenantHead"><span class="pill">' + esc(it.tenantId || '') + '</span>' +
        (company ? '<span class="small">' + esc(company) + '</span>' : '') +
        (number ? '<span class="small">' + esc(number) + '</span>' : '') +
        '</div></td>' +
        '<td>' + fmtInt(it.message_input_tokens) + '</td>' +
        '<td>' + fmtInt(it.message_output_tokens) + '</td>' +
        '<td>' + fmtInt(it.audio_input_tokens) + '</td>' +
        '<td>' + fmtInt(it.audio_output_tokens) + '</td>' +
        '<td><b>' + fmtInt(it.total_tokens) + '</b></td>' +
        '<td>' + fmtInt(it.events) + '</td>' +
        '<td class="money">' + fmtMoney(it.estimated_cost) + '</td>' +
        '<td>' + esc(fmtDate(it.last_at)) + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderConversationSummary(j){
    const items = Array.isArray(j.items) ? j.items : [];
    const totals = j.totals || {};

    kpiConversations.textContent = fmtInt(totals.conversations || 0);
    kpiCompleted.textContent = fmtInt(totals.completed_orders || 0);
    kpiAvgOrder.textContent = fmtInt(totals.average_tokens_per_completed_order || 0);
    kpiUnassigned.textContent = fmtInt(totals.unassigned_tokens || 0);

    const unassigned = num(totals.unassigned_tokens);
    detailNoteEl.textContent = unassigned > 0
      ? 'Hay ' + fmtInt(unassigned) + ' tokens históricos sin conversationId. Siguen incluidos en el total por dominio, pero no pueden asignarse de forma confiable a un pedido anterior.'
      : 'Todos los consumos del rango seleccionado tienen conversación asociada.';

    if (!items.length) {
      detailRowsEl.innerHTML = '<tr><td colspan="10" class="small">No hay conversaciones con tokens para los filtros seleccionados.</td></tr>';
      return;
    }

    detailRowsEl.innerHTML = items.map(function(it){
      const status = String(it.status || 'OPEN').toUpperCase();
      const client = String(it.contactName || '').trim();
      const waId = String(it.waId || '').trim();
      const audio = num(it.audio_input_tokens) + num(it.audio_output_tokens);
      const orderInfo = it.orderId
        ? '<span class="small">Pedido: ' + esc(shortId(it.orderId)) + '</span>'
        : '<span class="small">Sin registro en orders</span>';
      const orderTotal = num(it.pedido_total) > 0
        ? '<span class="small">Total: ' + esc(fmtOrderMoney(it.pedido_total)) + '</span>'
        : '';

      return '<tr>' +
        '<td><div class="stack"><span class="pill">' + esc(it.tenantId || '') + '</span>' +
        '<span class="status ' + statusClass(status) + '">' + esc(status) + '</span></div></td>' +
        '<td><div class="stack">' +
        (client ? '<b>' + esc(client) + '</b>' : '<span class="small">Sin nombre</span>') +
        (waId ? '<span class="small">' + esc(waId) + '</span>' : '') +
        '<span class="small">' + esc(it.channelType || '') + '</span></div></td>' +
        '<td><div class="stack"><span class="mono">' + esc(shortId(it.conversationId)) + '</span>' +
        orderInfo + orderTotal + '</div></td>' +
        '<td>' + fmtInt(it.message_input_tokens) + '</td>' +
        '<td>' + fmtInt(it.message_output_tokens) + '</td>' +
        '<td>' + fmtInt(audio) + '</td>' +
        '<td><b>' + fmtInt(it.total_tokens) + '</b></td>' +
        '<td>' + fmtInt(it.events) + '</td>' +
        '<td class="money">' + fmtMoney(it.estimated_cost) + '</td>' +
        '<td>' + esc(fmtDate(it.last_at)) + '</td>' +
      '</tr>';
    }).join('');
  }

  async function load(){
    msgEl.textContent = '';
    rowsEl.innerHTML = '<tr><td colspan="9" class="small">Cargando…</td></tr>';
    detailRowsEl.innerHTML = '<tr><td colspan="10" class="small">Cargando…</td></tr>';

    try{
      const summaryUrl = '/api/token-control/summary?' + buildQuery(false).toString();
      const conversationsUrl = '/api/token-control/conversations?' + buildQuery(true).toString();
      const result = await Promise.all([
        getJson(summaryUrl),
        getJson(conversationsUrl)
      ]);
      renderDomainSummary(result[0]);
      renderConversationSummary(result[1]);
    } catch(e){
      msgEl.textContent = e && e.message ? e.message : String(e);
      rowsEl.innerHTML = '<tr><td colspan="9" class="small">Error cargando datos.</td></tr>';
      detailRowsEl.innerHTML = '<tr><td colspan="10" class="small">Error cargando detalle por conversación.</td></tr>';
    }
  }

  btnReload.addEventListener('click', load);
  viewEl.addEventListener('change', load);
  if (isSuper && tenantEl) tenantEl.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') load(); });
  load();
})();
</script>
</body>
</html>`;
}

function mountTokenControlRoutes(app, auth) {
  if (!app || app.__tokenControlRoutesMounted) return;
  app.__tokenControlRoutesMounted = true;

  const requireAuth = auth.requireAuth;
  const requireAdmin = auth.requireAdmin;

  app.get("/admin/token-control", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!req.user || (String(req.user.role || "").toLowerCase() !== "admin" && String(req.user.role || "").toLowerCase() !== "superadmin")) {
        return res.status(403).send("403 - No autorizado");
      }
      if (typeof auth.resolveTenantId === "function") {
        req._resolvedTenantId = auth.resolveTenantId(req);
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(renderTokenControlPage(req.user || {}));
    } catch (e) {
      console.error("[token-control] page error:", e);
      return res.status(500).send("internal");
    }
  });

  app.get("/api/token-control/summary", requireAuth, requireAdmin, async (req, res) => {
    try {
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const tenantId = isSuper
        ? String(req.query?.tenantId || "").trim()
        : (typeof auth.resolveTenantId === "function" ? auth.resolveTenantId(req) : String(req.user?.tenantId || "").trim());

      const data = await buildTokenSummary({
        tenantId,
        from: String(req.query?.from || "").trim(),
        to: String(req.query?.to || "").trim(),
        isSuper
      });
      return res.json(data);
    } catch (e) {
      console.error("[token-control] summary error:", e);
      return res.status(500).json({ ok: false, error: "internal" });
    }
  });

  app.get("/api/token-control/conversations", requireAuth, requireAdmin, async (req, res) => {
    try {
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const tenantId = isSuper
        ? String(req.query?.tenantId || "").trim()
        : (typeof auth.resolveTenantId === "function" ? auth.resolveTenantId(req) : String(req.user?.tenantId || "").trim());

      const data = await buildTokenConversationSummary({
        tenantId,
        from: String(req.query?.from || "").trim(),
        to: String(req.query?.to || "").trim(),
        view: String(req.query?.view || "all").trim(),
        limit: req.query?.limit,
        isSuper
      });
      return res.json(data);
    } catch (e) {
      console.error("[token-control] conversations error:", e);
      return res.status(500).json({ ok: false, error: "internal" });
    }
  });
}

module.exports = {
  mountTokenControlRoutes,
  buildTokenSummary,
  buildTokenConversationSummary,
};
