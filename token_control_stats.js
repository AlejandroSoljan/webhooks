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

function parseCsvFilter(raw, allowed = []) {
  const allow = new Set(allowed.map(v => String(v || "").trim().toLowerCase()).filter(Boolean));
  const values = String(raw || "")
    .split(",")
    .map(v => String(v || "").trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(values.filter(v => !allow.size || allow.has(v)))];
}

function tokenTypeMatches(item, types = []) {
  if (!types.length) return true;
  const botMode = String(item?.botMode || "").trim().toLowerCase();
  return types.some(type => type === "conversacional" ? botMode === "conversacional" : botMode !== "conversacional");
}

function tokenChannelMatches(item, channels = []) {
  if (!channels.length) return true;
  const channel = String(item?.channelType || "whatsapp").trim().toLowerCase() || "whatsapp";
  return channels.includes(channel);
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
        token_cost_audio_output_per_1k: 1,
        token_charge_chat_input_per_1k: 1,
        token_charge_chat_output_per_1k: 1,
        token_charge_audio_input_per_1k: 1,
        token_charge_audio_output_per_1k: 1
      }
    }).toArray();

  return new Map(rows.map((doc) => [String(doc._id || ""), doc]));
}

function calculateCostWithRates(row, tenantDoc = {}, mode = "real") {
  const messageInput = Number(row.message_input_tokens || 0);
  const messageOutput = Number(row.message_output_tokens || 0);
  const audioInput = Number(row.audio_input_tokens || 0);
  const audioOutput = Number(row.audio_output_tokens || 0);

  const charge = String(mode || "").toLowerCase() === "charge";
  const prefix = charge ? "token_charge_" : "token_cost_";
  const chatInput = toPositiveNumber(tenantDoc[prefix + "chat_input_per_1k"]);
  const chatOutput = toPositiveNumber(tenantDoc[prefix + "chat_output_per_1k"]);
  const audioInputRate = toPositiveNumber(tenantDoc[prefix + "audio_input_per_1k"]);
  const audioOutputRate = toPositiveNumber(tenantDoc[prefix + "audio_output_per_1k"]);

  return Number((
    (messageInput / 1000) * chatInput +
    (messageOutput / 1000) * chatOutput +
    (audioInput / 1000) * audioInputRate +
    (audioOutput / 1000) * audioOutputRate
  ).toFixed(6));
}

function calculateEstimatedCost(row, tenantDoc = {}) {
  return calculateCostWithRates(row, tenantDoc, "real");
}

function calculateBillableCost(row, tenantDoc = {}) {
  return calculateCostWithRates(row, tenantDoc, "charge");
}

function tenantChargeRatesConfigured(tenantDoc = {}) {
  return [
    "token_charge_chat_input_per_1k",
    "token_charge_chat_output_per_1k",
    "token_charge_audio_input_per_1k",
    "token_charge_audio_output_per_1k"
  ].some((field) => toPositiveNumber(tenantDoc[field]) > 0);
}


async function buildTokenSummary({
  tenantId = "",
  from = "",
  to = "",
  types = "",
  channels = "",
  isSuper = false
  } = {}) {
  const db = await getDb();
  const { match, safeTenant } = buildUsageMatch({ tenantId, from, to });
  const noTypes = String(types || "").trim().toLowerCase() === "none";
  const noChannels = String(channels || "").trim().toLowerCase() === "none";
  const safeTypes = noTypes ? [] : parseCsvFilter(types, ["pedidos", "conversacional"]);
  const safeChannels = noChannels ? [] : parseCsvFilter(channels, ["whatsapp", "qr_web"]);

  if (noTypes || noChannels) {
    return {
      ok: true,
      filters: { tenantId: safeTenant || null, from: from || null, to: to || null, types: [], channels: [], isSuper: !!isSuper },
      items: [],
      totals: {
        message_input_tokens: 0, message_output_tokens: 0, audio_input_tokens: 0, audio_output_tokens: 0,
        total_tokens: 0, events: 0, billed_cost: 0, real_cost: 0, gross_margin: 0, estimated_cost: 0, last_at: null
      }
    };
  }

  // Tipo y Canal dependen de la conversación asociada. Si hay filtros activos,
  // el resumen se arma desde el mismo detalle relacionado para que ambos coincidan.
  if (safeTypes.length || safeChannels.length) {
    const detail = await buildTokenConversationSummary({
      tenantId,
     from,
      to,
      types: safeTypes.join(","),
      channels: safeChannels.join(","),
      limit: 5000,
      isSuper
    });

    const grouped = new Map();
    for (const row of (Array.isArray(detail.items) ? detail.items : [])) {
      const key = String(row.tenantId || "").trim();
      if (!key) continue;
      let acc = grouped.get(key);
      if (!acc) {
        acc = {
          tenantId: key,
          company: String(row.company || "").trim(),
          number: "",
          message_input_tokens: 0,
          message_output_tokens: 0,
          audio_input_tokens: 0,
          audio_output_tokens: 0,
          total_tokens: 0,
          events: 0,
          last_at: null,
          billed_cost: 0,
          real_cost: 0,
          gross_margin: 0,
          billing_configured: row.billing_configured !== false
        };
        grouped.set(key, acc);
      }
      acc.message_input_tokens += Number(row.message_input_tokens || 0);
      acc.message_output_tokens += Number(row.message_output_tokens || 0);
      acc.audio_input_tokens += Number(row.audio_input_tokens || 0);
      acc.audio_output_tokens += Number(row.audio_output_tokens || 0);
      acc.total_tokens += Number(row.total_tokens || 0);
      acc.events += Number(row.events || 0);
      acc.billed_cost += Number(row.billed_cost || 0);
      if (isSuper) {
        acc.real_cost += Number(row.real_cost || 0);
        acc.gross_margin += Number(row.gross_margin || 0);
      }
      if (!acc.last_at || Date.parse(row.last_at || 0) > Date.parse(acc.last_at || 0)) acc.last_at = row.last_at || acc.last_at;
      if (row.billing_configured === false) acc.billing_configured = false;
    }

    const cfgByTenant = await loadTenantCosts(db, [...grouped.keys()]);
    const items = [...grouped.values()].sort((a, b) => String(a.tenantId).localeCompare(String(b.tenantId))).map(item => {
      const doc = cfgByTenant.get(item.tenantId) || {};
      item.company = String(doc.nom_emp || item.company || "").trim();
      item.number = String(doc.numero || "").trim();
      item.billed_cost = Number(item.billed_cost.toFixed(6));
      item.estimated_cost = isSuper ? Number(item.real_cost.toFixed(6)) : item.billed_cost;
      if (isSuper) {
        item.real_cost = Number(item.real_cost.toFixed(6));
        item.gross_margin = Number(item.gross_margin.toFixed(6));
      } else {
        delete item.real_cost;
        delete item.gross_margin;
      }
      return item;
    });

    const totals = items.reduce((acc, item) => {
      acc.message_input_tokens += item.message_input_tokens;
      acc.message_output_tokens += item.message_output_tokens;
      acc.audio_input_tokens += item.audio_input_tokens;
      acc.audio_output_tokens += item.audio_output_tokens;
      acc.total_tokens += item.total_tokens;
      acc.events += item.events;
      acc.billed_cost += item.billed_cost;
      if (!acc.last_at || Date.parse(item.last_at || 0) > Date.parse(acc.last_at || 0)) acc.last_at = item.last_at || acc.last_at;
      if (!acc.last_at || Date.parse(item.last_at || 0) > Date.parse(acc.last_at || 0)) acc.last_at = item.last_at || acc.last_at;
      if (isSuper) {
        acc.real_cost += Number(item.real_cost || 0);
        acc.gross_margin += Number(item.gross_margin || 0);
      }
      return acc;
    }, {
      message_input_tokens: 0,
      message_output_tokens: 0,
      audio_input_tokens: 0,
      audio_output_tokens: 0,
      total_tokens: 0,
      events: 0,
      billed_cost: 0,
      real_cost: 0,
      gross_margin: 0,
      last_at: null
    });
    totals.billed_cost = Number(totals.billed_cost.toFixed(6));
    totals.real_cost = Number(totals.real_cost.toFixed(6));
    totals.gross_margin = Number(totals.gross_margin.toFixed(6));
    totals.estimated_cost = isSuper ? totals.real_cost : totals.billed_cost;

    return {
      ok: true,
      filters: { tenantId: safeTenant || null, from: from || null, to: to || null, types: safeTypes, channels: safeChannels, isSuper: !!isSuper },
      items,
      totals
    };
  }

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
      
      last_at: row.last_at || null,
      billed_cost: calculateBillableCost(row, doc),
      billing_configured: tenantChargeRatesConfigured(doc)
    };

    // Compatibilidad: para usuarios no superadmin "estimated_cost" representa
    // el importe que Asisto le cobra al dominio, nunca el costo real interno.
    item.estimated_cost = isSuper ? calculateEstimatedCost(row, doc) : item.billed_cost;

    if (isSuper) {
      item.real_cost = calculateEstimatedCost(row, doc);
      item.gross_margin = Number((item.billed_cost - item.real_cost).toFixed(6));
      item.cost_chat_input_per_1k = toPositiveNumber(doc.token_cost_chat_input_per_1k);
      item.cost_chat_output_per_1k = toPositiveNumber(doc.token_cost_chat_output_per_1k);
      item.cost_audio_input_per_1k = toPositiveNumber(doc.token_cost_audio_input_per_1k);
      item.cost_audio_output_per_1k = toPositiveNumber(doc.token_cost_audio_output_per_1k);
    }

    return item;
  });

  const totals = items.reduce((acc, item) => {
    acc.message_input_tokens += item.message_input_tokens;
    acc.message_output_tokens += item.message_output_tokens;
    acc.audio_input_tokens += item.audio_input_tokens;
    acc.audio_output_tokens += item.audio_output_tokens;
    acc.total_tokens += item.total_tokens;
    acc.events += item.events;
    acc.billed_cost += item.billed_cost;
    if (isSuper) {
      acc.real_cost += Number(item.real_cost || 0);
      acc.gross_margin += Number(item.gross_margin || 0);
    }
    return acc;
  }, {
    message_input_tokens: 0,
    message_output_tokens: 0,
    audio_input_tokens: 0,
    audio_output_tokens: 0,
    total_tokens: 0,
    events: 0,
    billed_cost: 0,
    real_cost: 0,
    gross_margin: 0,
    last_at: null
  });

  totals.billed_cost = Number(totals.billed_cost.toFixed(6));
  totals.real_cost = Number(totals.real_cost.toFixed(6));
  totals.gross_margin = Number(totals.gross_margin.toFixed(6));
  totals.estimated_cost = isSuper ? totals.real_cost : totals.billed_cost;

  return {
    ok: true,
    filters: {
      tenantId: safeTenant || null,
      from: from || null,
      to: to || null,
      types: safeTypes,
      channels: safeChannels,
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
  types = "",
  channels = "",
  limit = 500,
  isSuper = false
} = {}) {
  const db = await getDb();
  const { match, safeTenant } = buildUsageMatch({ tenantId, from, to });
  const rawView = String(view || "all").trim().toLowerCase();
  const safeView = ["all", "completed", "conversational"].includes(rawView) ? rawView : "all";
  const noTypes = String(types || "").trim().toLowerCase() === "none";
  const noChannels = String(channels || "").trim().toLowerCase() === "none";
  let safeTypes = noTypes ? [] : parseCsvFilter(types, ["pedidos", "conversacional"]);
  const safeChannels = noChannels ? [] : parseCsvFilter(channels, ["whatsapp", "qr_web"]);
  if (!noTypes && !safeTypes.length && safeView === "conversational") safeTypes = ["conversacional"];
  const safeLimit = clampInt(limit, 1, 5000, 500);
  const aggregateLimit = Math.min(4000, Math.max(500, safeLimit * 6));

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

  const tenantIds = Array.from(new Set(
    assignedRows.map((r) => String(r?._id?.tenantId || "").trim()).filter(Boolean)
  ));

  const [conversationDocs, orderDocs, cfgByTenant, followupSettings] = await Promise.all([
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
              botMode: 1,
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
    loadTenantCosts(db, tenantIds),
    tenantIds.length
      ? db.collection("settings").find(
          { _id: { $in: tenantIds.map((id) => `conversation_followup:${id}`) } },
          { projection: { _id: 1, inactivityMinutes: 1 } }
        ).toArray()
      : []
  ]);

  const convById = new Map(conversationDocs.map((doc) => [String(doc._id || ""), doc]));
  const orderByConversation = new Map();
  for (const order of orderDocs) {
    const key = String(order.conversationId || "");
    if (key && !orderByConversation.has(key)) orderByConversation.set(key, order);
  }

  const inactivityByTenant = new Map();
  for (const id of tenantIds) inactivityByTenant.set(id, 30);
  for (const doc of followupSettings) {
    const tenant = String(doc?._id || "").replace(/^conversation_followup:/, "");
    const minutes = clampInt(doc?.inactivityMinutes, 1, 10080, 30);
    if (tenant) inactivityByTenant.set(tenant, minutes);
  }

  // Para bots conversacionales puede haber históricos donde un mismo conversationId
  // quedó abierto durante mucho tiempo. El panel los separa en sesiones usando la
  // misma inactividad configurada en Seguimiento (30 min por defecto).
  const conversationalIds = Array.from(new Set(
    assignedRows
      .map((row) => String(row?._id?.conversationId || "").trim())
      .filter((id) => String(convById.get(id)?.botMode || "").toLowerCase() === "conversacional")
  ));

  const rawUsageByConversation = new Map();
  if (conversationalIds.length) {
    const rawUsage = await db.collection("ai_token_usage_log").aggregate([
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
      { $match: { _conversationId: { $in: conversationalIds } } },
      {
        $project: {
          tenantId: 1,
          _conversationId: 1,
          _waId: 1,
          _channelType: 1,
          kind: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 1,
          model: 1,
          createdAt: 1
        }
     },
      { $sort: { tenantId: 1, _conversationId: 1, createdAt: 1 } },
      { $limit: 50000 }
    ]).toArray();

    for (const ev of rawUsage) {
      const key = `${String(ev.tenantId || "")}|${String(ev._conversationId || "")}`;
      if (!rawUsageByConversation.has(key)) rawUsageByConversation.set(key, []);
      rawUsageByConversation.get(key).push(ev);
    }
  }

  function aggregateSessionEvents(events) {
    const out = {
      waId: "",
      channelType: "",
      message_input_tokens: 0,
      message_output_tokens: 0,
      audio_input_tokens: 0,
      audio_output_tokens: 0,
      total_tokens: 0,
      events: 0,
      first_at: null,
      last_at: null,
      models: []
    };
    const modelSet = new Set();
    for (const ev of events) {
      const kind = String(ev.kind || "").toLowerCase();
      const input = Number(ev.inputTokens || 0);
      const output = Number(ev.outputTokens || 0);
      if (kind === "message") {
        out.message_input_tokens += input;
        out.message_output_tokens += output;
      } else if (kind === "audio") {
        out.audio_input_tokens += input;
       out.audio_output_tokens += output;
      }
      out.total_tokens += Number(ev.totalTokens || 0);
      out.events += 1;
      if (ev._waId) out.waId = String(ev._waId);
      if (ev._channelType) out.channelType = String(ev._channelType);
      if (ev.model) modelSet.add(String(ev.model));
      const at = ev.createdAt ? new Date(ev.createdAt) : null;
      if (at && !Number.isNaN(at.getTime())) {
        if (!out.first_at || at < out.first_at) out.first_at = at;
        if (!out.last_at || at > out.last_at) out.last_at = at;
      }
    }
    out.models = Array.from(modelSet);
    return out;
  }

  function splitConversationalRow(row, conv) {
    const tenantKey = String(row?._id?.tenantId || "");
    const conversationId = String(row?._id?.conversationId || "");
    const key = `${tenantKey}|${conversationId}`;
    const events = rawUsageByConversation.get(key) || [];
    if (!events.length) return [{ ...row, sessionNumber: 1, sessionCount: 1 }];

    const inactivityMinutes = inactivityByTenant.get(tenantKey) || 30;
    const gapMs = inactivityMinutes * 60 * 1000;
    const groups = [];
    let current = [];

    for (const ev of events) {
      const atMs = Date.parse(ev.createdAt || "");
      const prevMs = current.length ? Date.parse(current[current.length - 1].createdAt || "") : NaN;
      if (current.length && Number.isFinite(atMs) && Number.isFinite(prevMs) && (atMs - prevMs) > gapMs) {
        groups.push(current);
        current = [];
      }
      current.push(ev);
    }
    if (current.length) groups.push(current);

    return groups.map((group, index) => {
      const agg = aggregateSessionEvents(group);
      return {
        ...row,
        ...agg,
        waId: agg.waId || row.waId,
        channelType: agg.channelType || row.channelType,
        sessionNumber: index + 1,
        sessionCount: groups.length,
        inactivityMinutes
      };
    });
  }

  const expandedRows = [];
  for (const row of assignedRows) {
    const conversationId = String(row?._id?.conversationId || "");
    const conv = convById.get(conversationId) || null;
    if (String(conv?.botMode || "").toLowerCase() === "conversacional") {
      expandedRows.push(...splitConversationalRow(row, conv));
    } else {
      expandedRows.push({ ...row, sessionNumber: 1, sessionCount: 1 });
    }
  }

  let items = expandedRows.map((row) => {
    const tenantKey = String(row?._id?.tenantId || "");
    const conversationId = String(row?._id?.conversationId || "");
    const conv = convById.get(conversationId) || null;
    const order = orderByConversation.get(conversationId) || null;
    const pedido = pedidoFromDocs(conv, order);
    const tenantDoc = cfgByTenant.get(tenantKey) || {};
    const botMode = String(conv?.botMode || "pedidos").trim().toLowerCase();
    let status = normalizeStatus(conv, order);

    if (botMode === "conversacional" && Number(row.sessionCount || 1) > 1 && Number(row.sessionNumber || 1) < Number(row.sessionCount || 1)) {
      status = "CLOSED_INACTIVITY";
    }


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
      sessionId: botMode === "conversacional"
        ? `${conversationId}:S${Number(row.sessionNumber || 1)}`
        : conversationId,
      sessionNumber: Number(row.sessionNumber || 1),
      sessionCount: Number(row.sessionCount || 1),
      inactivityMinutes: Number(row.inactivityMinutes || inactivityByTenant.get(tenantKey) || 30),
      orderId: order?._id ? String(order._id) : "",
      botMode,
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
      closed_at: conv?.closedAt || order?.updatedAt || null,
      billed_cost: calculateBillableCost(row, tenantDoc),
      billing_configured: tenantChargeRatesConfigured(tenantDoc)
    };

    item.estimated_cost = isSuper ? calculateEstimatedCost(row, tenantDoc) : item.billed_cost;
    if (isSuper) {
      item.real_cost = calculateEstimatedCost(row, tenantDoc);
      item.gross_margin = Number((item.billed_cost - item.real_cost).toFixed(6));
    }
    return item;
  });

  if (noTypes || noChannels) {
    items = [];
  }
  if (safeView === "completed") {
    items = items.filter((item) => item.completed);
  }
  if (safeTypes.length) {
    items = items.filter((item) => tokenTypeMatches(item, safeTypes));
  }
  if (safeChannels.length) {
    items = items.filter((item) => tokenChannelMatches(item, safeChannels));
  }

  items.sort((a, b) => Date.parse(b.last_at || 0) - Date.parse(a.last_at || 0));
  items = items.slice(0, safeLimit);

  const completed = items.filter((item) => item.completed);
  const totals = items.reduce((acc, item) => {
    acc.conversations += 1;
    acc.completed_orders += item.completed ? 1 : 0;
    acc.total_tokens += item.total_tokens;
    acc.events += item.events;
    acc.billed_cost += item.billed_cost;
    if (isSuper) {
      acc.real_cost += Number(item.real_cost || 0);
      acc.gross_margin += Number(item.gross_margin || 0);
    }
    return acc;
  }, {
    conversations: 0,
    completed_orders: 0,
    total_tokens: 0,
    events: 0,
    billed_cost: 0,
    real_cost: 0,
    gross_margin: 0,
    average_tokens_per_conversation: 0,
    average_tokens_per_completed_order: 0,
    average_billed_cost_per_conversation: 0,
    average_billed_cost_per_completed_order: 0,
    unassigned_tokens: Number(unassignedRow.total_tokens || 0),
    unassigned_events: Number(unassignedRow.events || 0)
  });

  if (items.length) {
    totals.average_tokens_per_conversation = Math.round(
      items.reduce((sum, item) => sum + item.total_tokens, 0) / items.length
    );
    totals.average_billed_cost_per_conversation = Number((
      items.reduce((sum, item) => sum + item.billed_cost, 0) / items.length
    ).toFixed(6));
  }


  if (completed.length) {
    totals.average_tokens_per_completed_order = Math.round(
      completed.reduce((sum, item) => sum + item.total_tokens, 0) / completed.length
    );
    totals.average_billed_cost_per_completed_order = Number((
      completed.reduce((sum, item) => sum + item.billed_cost, 0) / completed.length
    ).toFixed(6));
  }

  totals.billed_cost = Number(totals.billed_cost.toFixed(6));
  totals.real_cost = Number(totals.real_cost.toFixed(6));
  totals.gross_margin = Number(totals.gross_margin.toFixed(6));
  totals.estimated_cost = isSuper ? totals.real_cost : totals.billed_cost;

  return {
    ok: true,
    filters: {
      tenantId: safeTenant || null,
      from: from || null,
      to: to || null,
      view: safeView,
      types: safeTypes,
      channels: safeChannels,
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
      --profit:#15803d;
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
    .multiFilter{position:relative;min-width:180px}
    .multiFilter summary{list-style:none;height:40px;border-radius:12px;border:1px solid var(--border);padding:10px 34px 10px 12px;background:#fff;color:var(--text);font-size:13px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative}
    .multiFilter summary::-webkit-details-marker{display:none}.multiFilter summary:after{content:'▾';position:absolute;right:12px;top:9px;color:var(--muted)}
    .multiMenu{position:absolute;z-index:30;top:44px;left:0;right:0;min-width:210px;background:#fff;border:1px solid var(--border);border-radius:12px;padding:8px;box-shadow:0 14px 32px rgba(15,23,42,.16)}
    .multiMenu label{min-width:0;display:flex;flex-direction:row;align-items:center;gap:8px;padding:6px 7px;color:var(--text);cursor:pointer}.multiMenu input{width:auto;height:auto;margin:0}
    .multiTools{display:flex;gap:6px;padding-bottom:6px;margin-bottom:3px;border-bottom:1px solid var(--border)}.multiTools button{border:0;border-radius:7px;background:#f1f5f9;color:#475569;font-size:11px;font-weight:800;padding:5px 8px;cursor:pointer}
    .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}

    .kpis.detail{grid-template-columns:repeat(4,minmax(0,1fr))}
    .kpi{background:#fff;border:1px solid var(--border);border-radius:14px;padding:14px}
    .kpi .t{font-size:12px;color:var(--muted);margin-bottom:6px}
    .kpi .v{font-size:25px;font-weight:800;line-height:1.1}
    .tableWrap{overflow:auto;border:1px solid var(--border);border-radius:14px}
    table{width:100%;border-collapse:collapse;background:#fff;min-width:${isSuper ? '1280px' : '760px'}}
    th,td{padding:12px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle;font-size:14px}
    thead th{position:sticky;top:0;background:#f8fafc;color:var(--text);font-size:12px;text-transform:uppercase;letter-spacing:.04em;z-index:1}
    tbody tr:last-child td{border-bottom:none}
    .pill{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;border:1px solid rgba(37,99,235,.18);background:rgba(37,99,235,.08);color:var(--accent-2);font-size:12px;font-weight:700}
    .status{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:800;border:1px solid var(--border)}
    .status.completed{color:var(--ok);background:rgba(15,118,110,.08);border-color:rgba(15,118,110,.2)}
    .status.cancelled{color:var(--danger);background:rgba(180,35,24,.07);border-color:rgba(180,35,24,.18)}
    .status.pending{color:var(--warn);background:rgba(180,83,9,.08);border-color:rgba(180,83,9,.2)}
    .status.closed{color:#475569;background:#f1f5f9;border-color:#cbd5e1}
    .tenantHead,.stack{display:flex;flex-direction:column;gap:4px}
    .money{color:var(--ok);font-weight:800;white-space:nowrap}
    .profit{color:var(--profit);font-weight:800;white-space:nowrap}
    .sectionTitle{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:10px}
    .sectionTitle h2{margin:0;font-size:19px}
    .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
    .warnBox{padding:10px 12px;border-radius:12px;background:#fffbeb;color:#92400e;border:1px solid #fde68a;font-size:13px}
    #msg{min-height:20px}
    @media (max-width:1100px){.kpis,.kpis.detail{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (max-width:760px){.kpis,.kpis.detail{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <div>
        <h1 style="margin:0 0 4px">Control de consumo IA</h1>
        <div class="small">${isSuper ? 'Vista administrativa: costo real, importe a cobrar y margen.' : 'Consumo del dominio e importe.'}</div>
      </div>
      <div class="small">${isSuper ? 'Superadmin' : esc(String(user?.role || 'usuario'))} · dominio: <b>${esc(tenant)}</b></div>
    </div>

    <div class="card">
      <div class="row">
        ${isSuper ? `<label>Dominio<input id="fTenant" placeholder="Todos los dominios"/></label>` : `<label>Dominio<input id="fTenant" value="${esc(tenant)}" readonly/></label>`}
        <label>Desde<input id="fFrom" type="date"/></label>
        <label>Hasta<input id="fTo" type="date"/></label>
        
        <details class="multiFilter" id="typeFilter">
          <summary>Tipo: Todos</summary>
          <div class="multiMenu">
            <div class="multiTools"><button type="button" data-select-all="tokenType">Todos</button><button type="button" data-clear-all="tokenType">Ninguno</button></div>
            <label><input type="checkbox" name="tokenType" value="pedidos" checked/>Pedidos</label>
            <label><input type="checkbox" name="tokenType" value="conversacional" checked/>Conversacional</label>
          </div>
        </details>
        <details class="multiFilter" id="channelFilter">
          <summary>Canal: Todos</summary>
          <div class="multiMenu">
            <div class="multiTools"><button type="button" data-select-all="tokenChannel">Todos</button><button type="button" data-clear-all="tokenChannel">Ninguno</button></div>
            <label><input type="checkbox" name="tokenChannel" value="whatsapp" checked/>WhatsApp</label>
            <label><input type="checkbox" name="tokenChannel" value="qr_web" checked/>QR Web</label>
          </div>
        </details>
        <button class="btn" type="button" id="btnReload">Actualizar</button>
      </div>
      <div id="msg" class="small" style="margin-top:10px"></div>
    </div>

    <div class="kpis">
      <div class="kpi">
        <div class="t">Tokens totales</div>
        <div class="v" id="kpiTokens">0</div>
      </div>
      ${isSuper ? `
      <div class="kpi"><div class="t">Costo real</div><div class="v money" id="kpiRealCost">US$ 0</div></div>
      <div class="kpi"><div class="t">Importe a cobrar</div><div class="v money" id="kpiBilledCost">US$ 0</div></div>
      <div class="kpi"><div class="t">Margen bruto</div><div class="v profit" id="kpiMargin">US$ 0</div></div>` : `
      <div class="kpi"><div class="t">Eventos</div><div class="v" id="kpiEvents">0</div></div>
      <div class="kpi"><div class="t">Importe</div><div class="v money" id="kpiBilledCost">US$ 0</div></div>
      <div class="kpi"><div class="t">Último uso</div><div class="v" id="kpiLastUse" style="font-size:16px">-</div></div>`}
    </div>

    <div class="card">
      <div class="sectionTitle">
        <div>
          <h2>Resumen por dominio</h2>
          <div class="small">${isSuper
            ? 'El costo real usa token_cost_* del dominio. El importe a cobrar usa token_charge_* del dominio.'
            : 'El importe mostrado usa la tarifa comercial configurada para tu dominio.'}</div>
        </div>
      </div>
      <div class="tableWrap">
        <table>
          <thead>
            ${isSuper ? `<tr>
              <th>Dominio</th><th>Entrada texto</th><th>Salida texto</th><th>Audio entrada</th><th>Audio salida</th><th>Total tokens</th><th>Eventos</th><th>Costo real</th><th>A cobrar</th><th>Margen</th><th>Último uso</th>
            </tr>` : `<tr>
              <th>Dominio</th><th>Total tokens</th><th>Eventos</th><th>Último uso</th><th>Importe</th>
            </tr>`}
          </thead>
          <tbody id="rows">
            <tr><td colspan="${isSuper ? 11 : 5}" class="small">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    ${isSuper ? `<div class="kpis detail">
      <div class="kpi">
        <div class="t">Conversaciones / sesiones</div>
        <div class="v" id="kpiConversations">0</div>
      </div>
      <div class="kpi">
        <div class="t">Pedidos completados</div>
        <div class="v" id="kpiCompleted">0</div>
      </div>
      <div class="kpi">
        <div class="t">Promedio tokens por conversación</div>
        <div class="v" id="kpiAvgConversation">0</div>
      </div>
      <div class="kpi">
        <div class="t">Promedio a cobrar por conversación</div>
        <div class="v money" id="kpiAvgBilled">US$ 0</div>
      </div>
    </div>` : ``}

    <div class="card">
      <div class="sectionTitle">
        <div>
          <h2>Detalle por conversación</h2>
          <div class="small">Pedidos: una fila por conversationId. Conversacionales: si un conversationId histórico quedó abierto, se separa en sesiones usando el tiempo de inactividad configurado en Seguimiento (30 min por defecto).</div>
        </div>
      </div>
      <div id="detailNote" class="small" style="margin-bottom:10px"></div>
      <div class="tableWrap">
        <table>
          <thead>
            ${isSuper ? `<tr>
              <th>Dominio / estado</th><th>Cliente</th><th>Conversación</th><th>Período</th><th>Entrada</th><th>Salida</th><th>Audios</th><th>Total tokens</th><th>Eventos</th><th>Costo real</th><th>A cobrar</th><th>Margen</th>
            </tr>` : `<tr>
              <th>Dominio / estado</th><th>Cliente</th><th>Período</th><th>Total tokens</th><th>Eventos</th><th>Importe</th>
            </tr>`}
          </thead>
          <tbody id="detailRows">
            <tr><td colspan="${isSuper ? 12 : 6}" class="small">Cargando…</td></tr>
           </tbody>
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
  const rowsEl = document.getElementById('rows');
  const detailRowsEl = document.getElementById('detailRows');
  const detailNoteEl = document.getElementById('detailNote');
  const msgEl = document.getElementById('msg');
  const kpiTokens = document.getElementById('kpiTokens');
  const kpiRealCost = document.getElementById('kpiRealCost');
  const kpiBilledCost = document.getElementById('kpiBilledCost');
  const kpiMargin = document.getElementById('kpiMargin');
  const kpiEvents = document.getElementById('kpiEvents');
  const kpiLastUse = document.getElementById('kpiLastUse');
  const kpiConversations = document.getElementById('kpiConversations');
  const kpiCompleted = document.getElementById('kpiCompleted');
  const kpiAvgConversation = document.getElementById('kpiAvgConversation');
  const kpiAvgBilled = document.getElementById('kpiAvgBilled');
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
    return new Intl.NumberFormat('es-AR', {
      style:'currency',
      currency:'USD',
      minimumFractionDigits:2,
      maximumFractionDigits:6
    }).format(num(v));
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
    if (s === 'CANCELLED' || s === 'CANCELED') return 'cancelled';
    if (s.indexOf('PENDIENTE') === 0) return 'pending';
    if (s.indexOf('CLOSED') === 0) return 'closed';
    return '';
  }

  function checkedValues(name){ return Array.from(document.querySelectorAll('input[name="' + name + '"]:checked')).map(function(x){ return x.value; }); }
  function allValues(name){ return Array.from(document.querySelectorAll('input[name="' + name + '"]')).map(function(x){ return x.value; }); }
  function updateMultiSummary(detailsId,name,prefix){
    const root=document.getElementById(detailsId); if(!root)return;
    const selected=checkedValues(name), all=allValues(name);
    root.querySelector('summary').textContent=prefix+': '+(!selected.length?'Ninguno':(selected.length===all.length?'Todos':selected.length+' seleccionados'));
  }
  function setupMulti(detailsId,name,prefix){
    const root=document.getElementById(detailsId); if(!root)return;
    const changed=function(){ updateMultiSummary(detailsId,name,prefix); load(); };
    root.querySelectorAll('input[name="'+name+'"]').forEach(function(x){x.addEventListener('change',changed);});
    root.querySelectorAll('[data-select-all]').forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();root.querySelectorAll('input[name="'+name+'"]').forEach(function(x){x.checked=true;});changed();});});
    root.querySelectorAll('[data-clear-all]').forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();root.querySelectorAll('input[name="'+name+'"]').forEach(function(x){x.checked=false;});changed();});});
    updateMultiSummary(detailsId,name,prefix);
  }


  function buildQuery(includeView){
    const qs = new URLSearchParams();
    const tenant = String(tenantEl.value || '').trim();
    const from = String(fromEl.value || '').trim();
    const to = String(toEl.value || '').trim();
    if (tenant) qs.set('tenantId', tenant);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const types=checkedValues('tokenType'), allTypes=allValues('tokenType');
    const channels=checkedValues('tokenChannel'), allChannels=allValues('tokenChannel');
    if (types.length !== allTypes.length) qs.set('types', types.length ? types.join(',') : 'none');
    if (channels.length !== allChannels.length) qs.set('channels', channels.length ? channels.join(',') : 'none');
    if (includeView) qs.set('limit', '500');
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

    kpiTokens.textContent = fmtInt(totals.total_tokens || 0);
    kpiBilledCost.textContent = fmtMoney(totals.billed_cost || 0);
    if (isSuper && kpiRealCost) kpiRealCost.textContent = fmtMoney(totals.real_cost || 0);
    if (isSuper && kpiMargin) kpiMargin.textContent = fmtMoney(totals.gross_margin || 0);
    if (!isSuper && kpiEvents) kpiEvents.textContent = fmtInt(totals.events || 0);
    if (!isSuper && kpiLastUse) kpiLastUse.textContent = fmtDate(totals.last_at);

    if (!items.length) {
      rowsEl.innerHTML = '<tr><td colspan="' + (isSuper ? '11' : '5') + '" class="small">No hay consumos para los filtros seleccionados.</td></tr>';
      return;
    }

    rowsEl.innerHTML = items.map(function(it){
     const company = String(it.company || '').trim();
      const number = String(it.number || '').trim();
      const billingWarning = it.billing_configured === false
        ? '<span class="small" style="color:#b45309">Tarifa comercial sin configurar</span>'
        : '';
        +      if (!isSuper) {
        return '<tr>' +
         '<td><div class="tenantHead"><span class="pill">' + esc(it.tenantId || '') + '</span>' +
          (company ? '<span class="small">' + esc(company) + '</span>' : '') + billingWarning + '</div></td>' +
          '<td><b>' + fmtInt(it.total_tokens) + '</b></td>' +
          '<td>' + fmtInt(it.events) + '</td>' +
          '<td>' + esc(fmtDate(it.last_at)) + '</td>' +
          '<td class="money">' + fmtMoney(it.billed_cost) + '</td>' +
        '</tr>';
      }
      return '<tr>' +
        '<td><div class="tenantHead"><span class="pill">' + esc(it.tenantId || '') + '</span>' +
        (company ? '<span class="small">' + esc(company) + '</span>' : '') +
        (number ? '<span class="small">' + esc(number) + '</span>' : '') + billingWarning + '</div></td>' +
        '<td>' + fmtInt(it.message_input_tokens) + '</td><td>' + fmtInt(it.message_output_tokens) + '</td>' +
        '<td>' + fmtInt(it.audio_input_tokens) + '</td><td>' + fmtInt(it.audio_output_tokens) + '</td>' +
        '<td><b>' + fmtInt(it.total_tokens) + '</b></td><td>' + fmtInt(it.events) + '</td>' +
        '<td class="money">' + fmtMoney(it.real_cost) + '</td><td class="money">' + fmtMoney(it.billed_cost) + '</td>' +
        '<td class="profit">' + fmtMoney(it.gross_margin) + '</td><td>' + esc(fmtDate(it.last_at)) + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderConversationSummary(j){
    const items = Array.isArray(j.items) ? j.items : [];
    const totals = j.totals || {};

    if (kpiConversations) kpiConversations.textContent = fmtInt(totals.conversations || 0);
    if (kpiCompleted) kpiCompleted.textContent = fmtInt(totals.completed_orders || 0);
    if (kpiAvgConversation) kpiAvgConversation.textContent = fmtInt(totals.average_tokens_per_conversation || 0);
    if (kpiAvgBilled) kpiAvgBilled.textContent = fmtMoney(totals.average_billed_cost_per_conversation || 0);

    const unassigned = num(totals.unassigned_tokens);
    detailNoteEl.innerHTML = unassigned > 0
      ? '<div class="warnBox">Hay ' + fmtInt(unassigned) + ' tokens históricos sin conversationId. Se incluyen en el total del dominio, pero no se pueden asignar a una conversación específica.</div>'
     : 'Todos los consumos del rango seleccionado tienen conversación asociada.';

    if (!items.length) {
      detailRowsEl.innerHTML = '<tr><td colspan="' + (isSuper ? '12' : '6') + '" class="small">No hay conversaciones con tokens para los filtros seleccionados.</td></tr>';
      return;
    }

    detailRowsEl.innerHTML = items.map(function(it){
      const status = String(it.status || 'OPEN').toUpperCase();
      const client = String(it.contactName || '').trim();
      const waId = String(it.waId || '').trim();
      const audio = num(it.audio_input_tokens) + num(it.audio_output_tokens);
      const isConversational = String(it.botMode || '').toLowerCase() === 'conversacional';
      const sessionInfo = isConversational
        ? '<span class="small">Sesión ' + fmtInt(it.sessionNumber || 1) + (num(it.sessionCount) > 1 ? (' de ' + fmtInt(it.sessionCount)) : '') + ' · corte ' + fmtInt(it.inactivityMinutes || 30) + ' min</span>'
        : '';
      const orderInfo = it.orderId
        ? '<span class="small">Pedido: ' + esc(shortId(it.orderId)) + '</span>'
        : (isConversational ? '<span class="small">Conversacional</span>' : '<span class="small">Sin pedido</span>');
      const orderTotal = num(it.pedido_total) > 0
        ? '<span class="small">Total pedido: ' + esc(fmtOrderMoney(it.pedido_total)) + '</span>'
        : '';
      if (!isSuper) {
        return '<tr>' +
          '<td><div class="stack"><span class="pill">' + esc(it.tenantId || '') + '</span><span class="status ' + statusClass(status) + '">' + esc(status) + '</span></div></td>' +
          '<td><div class="stack">' + (client ? '<b>' + esc(client) + '</b>' : '<span class="small">Sin nombre</span>') +
          (waId ? '<span class="small">' + esc(waId) + '</span>' : '') +
          '<span class="small">' + esc(it.channelType === 'qr_web' ? 'QR Web' : 'WhatsApp') + '</span></div></td>' +
          '<td><div class="stack"><span>' + esc(fmtDate(it.first_at)) + '</span><span class="small">hasta ' + esc(fmtDate(it.last_at)) + '</span></div></td>' +
          '<td><b>' + fmtInt(it.total_tokens) + '</b></td><td>' + fmtInt(it.events) + '</td><td class="money">' + fmtMoney(it.billed_cost) + '</td>' +
        '</tr>';
      }
      return '<tr>' +
        '<td><div class="stack"><span class="pill">' + esc(it.tenantId || '') + '</span><span class="status ' + statusClass(status) + '">' + esc(status) + '</span></div></td>' +
        '<td><div class="stack">' + (client ? '<b>' + esc(client) + '</b>' : '<span class="small">Sin nombre</span>') +
        (waId ? '<span class="small">' + esc(waId) + '</span>' : '') + '<span class="small">' + esc(it.channelType || '') + '</span></div></td>' +
        '<td><div class="stack"><span class="mono">' + esc(shortId(it.conversationId)) + '</span>' + sessionInfo + orderInfo + orderTotal + '</div></td>' +
        '<td><div class="stack"><span>' + esc(fmtDate(it.first_at)) + '</span><span class="small">hasta ' + esc(fmtDate(it.last_at)) + '</span></div></td>' +
        '<td>' + fmtInt(it.message_input_tokens) + '</td><td>' + fmtInt(it.message_output_tokens) + '</td><td>' + fmtInt(audio) + '</td>' +
        '<td><b>' + fmtInt(it.total_tokens) + '</b></td><td>' + fmtInt(it.events) + '</td>' +
        '<td class="money">' + fmtMoney(it.real_cost) + '</td><td class="money">' + fmtMoney(it.billed_cost) + '</td><td class="profit">' + fmtMoney(it.gross_margin) + '</td>' +

      '</tr>';
    }).join('');
  }

  async function load(){
    msgEl.textContent = '';
    rowsEl.innerHTML = '<tr><td colspan="' + (isSuper ? '11' : '5') + '" class="small">Cargando…</td></tr>';
    detailRowsEl.innerHTML = '<tr><td colspan="' + (isSuper ? '12' : '6') + '" class="small">Cargando…</td></tr>';

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
      rowsEl.innerHTML = '<tr><td colspan="' + (isSuper ? '11' : '5') + '" class="small">Error cargando datos.</td></tr>';
      detailRowsEl.innerHTML = '<tr><td colspan="' + (isSuper ? '12' : '6') + '" class="small">Error cargando detalle por conversación.</td></tr>';
    }
  }

  btnReload.addEventListener('click', load);+  setupMulti('typeFilter','tokenType','Tipo');
  setupMulti('channelFilter','tokenChannel','Canal');
  if (isSuper && tenantEl) tenantEl.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') load(); });
  load();
})();
</script>
</body>
</html>`;
}

function userCanAccessTokenControl(user) {
  const role = String(user?.role || "").toLowerCase();
  if (role === "superadmin") return true;
  if (!user || !Object.prototype.hasOwnProperty.call(user, "allowedPages")) return true;
  if (!Array.isArray(user.allowedPages)) return true;
  return user.allowedPages.includes("token_control");
}


function mountTokenControlRoutes(app, auth) {
  if (!app || app.__tokenControlRoutesMounted) return;
  app.__tokenControlRoutesMounted = true;

  const requireAuth = auth.requireAuth;
  const requireTokenControlAccess = (req, res, next) => {
    if (userCanAccessTokenControl(req.user)) return next();
    if (String(req.path || "").startsWith("/api/")) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    return res.status(403).send("403 - No autorizado");
  };

  app.get("/admin/token-control", requireAuth, requireTokenControlAccess, async (req, res) => {
    try {
      
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

  app.get("/api/token-control/summary", requireAuth, requireTokenControlAccess, async (req, res) => {
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
        types: String(req.query?.types || "").trim(),
        channels: String(req.query?.channels || "").trim(),
        isSuper
      });
      return res.json(data);
    } catch (e) {
      console.error("[token-control] summary error:", e);
      return res.status(500).json({ ok: false, error: "internal" });
    }
  });

  app.get("/api/token-control/conversations", requireAuth, requireTokenControlAccess, async (req, res) => {
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
        types: String(req.query?.types || "").trim(),
        channels: String(req.query?.channels || "").trim(),
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
