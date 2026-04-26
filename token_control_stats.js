// token_control_stats.js
// Panel y API para control de tokens por dominio.

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

async function buildTokenSummary({ tenantId = "", from = "", to = "", isSuper = false } = {}) {
  const db = await getDb();
  const match = {};
  const safeTenant = String(tenantId || "").trim();
  if (safeTenant) match.tenantId = safeTenant;

  const createdAt = {};
  const fromDate = parseDateStart(from);
  const toDate = parseDateEnd(to);
  if (fromDate) createdAt.$gte = fromDate;
  if (toDate) createdAt.$lte = toDate;
  if (Object.keys(createdAt).length) match.createdAt = createdAt;

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

  const tenantIds = rows.map((r) => String(r._id || "").trim()).filter(Boolean);
  const tenantCfgRows = tenantIds.length
    ? await db.collection("tenant_config")
        .find({ _id: { $in: tenantIds } }, {
          projection: {
            _id: 1,
            nom_emp: 1,
            numero: 1,
            token_cost_chat_input_per_1k: 1,
            token_cost_chat_output_per_1k: 1,
            token_cost_audio_input_per_1k: 1,
            token_cost_audio_output_per_1k: 1
          }
        }).toArray()
    : [];

  const cfgByTenant = new Map(tenantCfgRows.map((doc) => [String(doc._id || ""), doc]));
  const items = rows.map((row) => {
    const doc = cfgByTenant.get(String(row._id || "")) || {};
    const messageInput = Number(row.message_input_tokens || 0);
    const messageOutput = Number(row.message_output_tokens || 0);
    const audioInput = Number(row.audio_input_tokens || 0);
    const audioOutput = Number(row.audio_output_tokens || 0);

    const costChatInput = toPositiveNumber(doc.token_cost_chat_input_per_1k);
    const costChatOutput = toPositiveNumber(doc.token_cost_chat_output_per_1k);
    const costAudioInput = toPositiveNumber(doc.token_cost_audio_input_per_1k);
    const costAudioOutput = toPositiveNumber(doc.token_cost_audio_output_per_1k);

    const estimatedCost =
      (messageInput / 1000) * costChatInput +
      (messageOutput / 1000) * costChatOutput +
      (audioInput / 1000) * costAudioInput +
      (audioOutput / 1000) * costAudioOutput;

    return {
      tenantId: String(row._id || ""),
      company: String(doc.nom_emp || "").trim(),
      number: String(doc.numero || "").trim(),
      message_input_tokens: messageInput,
      message_output_tokens: messageOutput,
      audio_input_tokens: audioInput,
      audio_output_tokens: audioOutput,
      total_tokens: Number(row.total_tokens || 0),
      events: Number(row.events || 0),
      estimated_cost: Number(estimatedCost.toFixed(6)),
      cost_chat_input_per_1k: costChatInput,
      cost_chat_output_per_1k: costChatOutput,
      cost_audio_input_per_1k: costAudioInput,
      cost_audio_output_per_1k: costAudioOutput,
      last_at: row.last_at || null
    };
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
    }
    *{box-sizing:border-box}
    body{margin:0;padding:22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text)}
    .shell{display:flex;flex-direction:column;gap:16px}
    .toolbar{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
    .small{font-size:13px;color:var(--muted)}
    .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;box-shadow:0 10px 24px rgba(15,23,42,.06)}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
    label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted);min-width:160px}
    input{height:40px;border-radius:12px;border:1px solid var(--border);padding:0 12px;font-size:14px;background:#fff;color:var(--text)}
    .btn,.btn2{height:40px;padding:0 14px;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px}
    .btn{background:var(--accent);color:#fff;border:1px solid var(--accent)}
    .btn2{background:#fff;color:var(--text);border:1px solid var(--border)}
    .kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .kpi{background:#fff;border:1px solid var(--border);border-radius:14px;padding:14px}
    .kpi .t{font-size:12px;color:var(--muted);margin-bottom:6px}
    .kpi .v{font-size:26px;font-weight:800;line-height:1.1}
    .tableWrap{overflow:auto;border:1px solid var(--border);border-radius:14px}
    table{width:100%;border-collapse:collapse;background:#fff}
    th,td{padding:12px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle;font-size:14px}
    thead th{position:sticky;top:0;background:#f8fafc;color:var(--text);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
    tbody tr:last-child td{border-bottom:none}
    .pill{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;border:1px solid rgba(37,99,235,.18);background:rgba(37,99,235,.08);color:var(--accent-2);font-size:12px;font-weight:700}
    .tenantHead{display:flex;flex-direction:column;gap:4px}
    .money{color:var(--ok);font-weight:800}
    #msg{min-height:20px}
    @media (max-width:900px){.kpis{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <div>
        <h1 style="margin:0 0 4px">Control de Tokens</h1>
        <div class="small">Consumo de tokens de mensajes y audios por dominio, con costo estimado según la configuración del dominio.</div>
      </div>
      <div class="small">${isSuper ? 'Superadmin' : 'Admin'} · dominio: <b>${esc(tenant)}</b></div>
    </div>

    <div class="card">
      <div class="row">
        ${isSuper ? `<label>Dominio<input id="fTenant" placeholder="Todos los dominios"/></label>` : `<label>Dominio<input id="fTenant" value="${esc(tenant)}" readonly/></label>`}
        <label>Desde<input id="fFrom" type="date"/></label>
        <label>Hasta<input id="fTo" type="date"/></label>
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
  </div>

<script>
(function(){
  const isSuper = ${isSuper ? 'true' : 'false'};
  const tenantEl = document.getElementById('fTenant');
  const fromEl = document.getElementById('fFrom');
  const toEl = document.getElementById('fTo');
  const rowsEl = document.getElementById('rows');
  const msgEl = document.getElementById('msg');
  const kpiMessages = document.getElementById('kpiMessages');
  const kpiAudios = document.getElementById('kpiAudios');
  const kpiCost = document.getElementById('kpiCost');
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
  function fmtDate(v){
    const s = String(v || '').trim();
    if (!s) return '-';
    try { return new Date(s).toLocaleString('es-AR'); } catch { return s; }
  }

  async function load(){
    msgEl.textContent = '';
    rowsEl.innerHTML = '<tr><td colspan="9" class="small">Cargando…</td></tr>';
    try{
      const qs = new URLSearchParams();
      const tenant = String(tenantEl.value || '').trim();
      const from = String(fromEl.value || '').trim();
      const to = String(toEl.value || '').trim();
      if (tenant) qs.set('tenantId', tenant);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);

      const r = await fetch('/api/token-control/summary?' + qs.toString(), {
        headers: { 'Accept':'application/json' },
        credentials: 'same-origin'
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));

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
    } catch(e){
      msgEl.textContent = e && e.message ? e.message : String(e);
      rowsEl.innerHTML = '<tr><td colspan="9" class="small">Error cargando datos.</td></tr>';
    }
  }

  btnReload.addEventListener('click', load);
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
}

module.exports = {
  mountTokenControlRoutes,
  buildTokenSummary,
};
