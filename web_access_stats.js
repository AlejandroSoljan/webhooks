const { getDb } = require("./db");

const COLLECTION = "web_access_log";

function htmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function toDateStart(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateEnd(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (Array.isArray(xf) && xf.length) return String(xf[0]).split(",")[0].trim();
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  return String(req.socket?.remoteAddress || req.ip || "").trim() || null;
}

async function recordWebAccessLogin({ req, user, success = true, detail = null } = {}) {
  try {
    if (!req || !user || success !== true) return;
    const db = await getDb();
    await db.collection(COLLECTION).insertOne({
      userId: user._id ? String(user._id) : String(user.uid || ""),
      username: String(user.username || "").trim(),
      tenantId: String(user.tenantId || "default").trim() || "default",
      role: String(user.role || "user").trim() || "user",
      success: true,
      source: "login",
      path: "/login",
      ip: getClientIp(req),
      userAgent: String(req.headers["user-agent"] || "").trim() || null,
      detail: detail && typeof detail === "object" ? detail : null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error("[web_access] recordWebAccessLogin error:", e?.message || e);
  }
}

function resolveTenantFilter(req) {
  const role = String(req.user?.role || "").toLowerCase();
  const explicit = String(req.query?.tenant || "").trim();
  if (role === "superadmin") return explicit || null;
  return String(req.user?.tenantId || "").trim() || null;
}

function buildFilter(req) {
  const filter = { success: true, source: "login" };
  const tenantId = resolveTenantFilter(req);
  if (tenantId) filter.tenantId = tenantId;

  const username = String(req.query?.username || "").trim();
  if (username) {
    filter.username = { $regex: username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }

  const from = toDateStart(req.query?.from);
  const to = toDateEnd(req.query?.to);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
  return filter;
}

async function buildSummary(req) {
  const db = await getDb();
  const filter = buildFilter(req);
  const col = db.collection(COLLECTION);

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [total, today, uniqueUsersRows, uniqueTenantsRows, recent, topUsers, chartRows] = await Promise.all([
    col.countDocuments(filter),
    col.countDocuments({ ...filter, createdAt: { ...(filter.createdAt || {}), $gte: todayStart } }),
    col.aggregate([{ $match: filter }, { $group: { _id: "$username" } }, { $count: "total" }]).toArray(),
    col.aggregate([{ $match: filter }, { $group: { _id: "$tenantId" } }, { $count: "total" }]).toArray(),
    col.find(filter, { projection: { username: 1, tenantId: 1, role: 1, createdAt: 1, ip: 1, userAgent: 1 } }).sort({ createdAt: -1 }).limit(100).toArray(),
    col.aggregate([
      { $match: filter },
      { $group: { _id: { username: "$username", tenantId: "$tenantId" }, total: { $sum: 1 }, lastAt: { $max: "$createdAt" }, role: { $last: "$role" } } },
      { $sort: { total: -1, lastAt: -1 } },
      { $limit: 20 }
    ]).toArray(),
    col.aggregate([
      { $match: filter },
      { $group: { _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" }, d: { $dayOfMonth: "$createdAt" } }, total: { $sum: 1 } } },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
      { $limit: 90 }
    ]).toArray()
  ]);

  return {
    total,
    today,
    uniqueUsers: uniqueUsersRows?.[0]?.total || 0,
    uniqueTenants: uniqueTenantsRows?.[0]?.total || 0,
    filter: {
      tenantId: resolveTenantFilter(req),
      from: String(req.query?.from || "").trim() || null,
      to: String(req.query?.to || "").trim() || null,
      username: String(req.query?.username || "").trim() || null,
    },
    topUsers: (topUsers || []).map((row) => ({
      username: row?._id?.username || "-",
      tenantId: row?._id?.tenantId || "-",
      role: row?.role || "-",
      total: Number(row?.total || 0),
      lastAt: row?.lastAt || null,
    })),
    chart: (chartRows || []).map((row) => ({
      date: `${String(row._id.y).padStart(4, "0")}-${String(row._id.m).padStart(2, "0")}-${String(row._id.d).padStart(2, "0")}`,
      total: Number(row.total || 0),
    })),
    recent: (recent || []).map((row) => ({
      id: String(row._id || ""),
      username: row.username || "-",
      tenantId: row.tenantId || "-",
      role: row.role || "-",
      createdAt: row.createdAt || null,
      ip: row.ip || "-",
      userAgent: row.userAgent || "-",
    })),
  };
}

function renderPage(req) {
  const tenantValue = htmlEscape(String(req.query?.tenant || "").trim());
  const usernameValue = htmlEscape(String(req.query?.username || "").trim());
  const fromValue = htmlEscape(String(req.query?.from || "").trim());
  const toValue = htmlEscape(String(req.query?.to || "").trim());
  const isSuper = String(req.user?.role || "").toLowerCase() === "superadmin";

  const tenantField = isSuper
    ? `<div class="field"><label for="tenant">Dominio</label><input id="tenant" value="${tenantValue}" placeholder="ej: SDG" /></div>`
    : "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ingresos Web</title>
  <style>
    :root{--bg:#f5f8fb;--card:#fff;--line:#d9e3ec;--text:#16324a;--muted:#66788a;--accent:#0e6b66;--shadow:0 12px 26px rgba(15,23,42,.06);}
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text);padding:18px}
    .page{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
    .panel{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}
    .head{padding:18px 20px;display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap}
    .head h1{margin:0;font-size:30px;line-height:1.05}
    .head p{margin:6px 0 0;color:var(--muted);font-size:14px}
    .toolbar{padding:16px 18px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) auto;gap:10px;align-items:end}
    .field{display:flex;flex-direction:column;gap:5px}
    .field label{font-size:12px;font-weight:700;color:#486074}
    input{width:100%;min-height:40px;border:1px solid var(--line);border-radius:12px;padding:0 12px;font-size:14px;color:var(--text);background:#fff;outline:none}
    input:focus{border-color:#9fc0dd;box-shadow:0 0 0 4px rgba(14,107,102,.08)}
    .actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
    .btn{appearance:none;border:1px solid var(--line);background:#fff;color:var(--text);border-radius:12px;min-height:40px;padding:0 14px;font-size:14px;font-weight:700;cursor:pointer}
    .btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
    .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:0 18px 18px}
    .stat{border:1px solid var(--line);border-radius:16px;padding:14px;background:linear-gradient(180deg,#fff 0%,#fbfdff 100%)}
    .stat .k{font-size:12px;color:var(--muted);margin-bottom:4px}
    .stat .v{font-size:28px;font-weight:800;color:var(--text)}
    .grid{display:grid;grid-template-columns:1.15fr .85fr;gap:14px;padding:0 18px 18px}
    .box{border:1px solid var(--line);border-radius:16px;padding:14px;background:#fff}
    .box h3{margin:0 0 10px;font-size:16px}
    .chart{display:flex;align-items:flex-end;gap:8px;min-height:220px;padding:10px 6px 0;overflow-x:auto}
    .barWrap{min-width:46px;display:flex;flex-direction:column;align-items:center;gap:6px}
    .bar{width:100%;min-height:4px;border-radius:10px 10px 4px 4px;background:linear-gradient(180deg,#2c9d96,#0e6b66)}
    .barVal{font-size:11px;color:var(--muted)}
    .barLab{font-size:11px;color:var(--muted);text-align:center}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
    th{color:#4c6378;font-size:12px}
    .muted{color:var(--muted)}
    .empty{padding:18px;color:var(--muted);font-size:13px}
    @media (max-width:1000px){.toolbar{grid-template-columns:repeat(2,minmax(0,1fr))}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}}
    @media (max-width:640px){body{padding:12px}.toolbar,.cards,.grid{padding-left:12px;padding-right:12px}.toolbar{grid-template-columns:1fr}.cards{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="page">
    <section class="panel head">
      <div>
        <h1>Ingresos Web</h1>
        <p>Registro de accesos exitosos al panel. Se guarda cada login correcto con usuario, dominio, IP y navegador.</p>
      </div>
      <div class="muted">Usuario actual: ${htmlEscape(req.user?.username || "")}</div>
    </section>

    <section class="panel">
      <div class="toolbar">
        ${tenantField}
        <div class="field"><label for="username">Usuario</label><input id="username" value="${usernameValue}" placeholder="Buscar usuario" /></div>
        <div class="field"><label for="from">Desde</label><input id="from" type="date" value="${fromValue}" /></div>
        <div class="field"><label for="to">Hasta</label><input id="to" type="date" value="${toValue}" /></div>
        <div class="actions">
          <button class="btn" id="btnClear" type="button">Limpiar</button>
          <button class="btn btn-primary" id="btnLoad" type="button">Actualizar</button>
        </div>
      </div>
      <div class="cards" id="cards"></div>
      <div class="grid">
        <div class="box">
          <h3>Ingresos por día</h3>
          <div id="chart" class="chart"></div>
        </div>
        <div class="box">
          <h3>Usuarios con más ingresos</h3>
          <table>
            <thead><tr><th>Usuario</th><th>Dominio</th><th>Rol</th><th>Ingresos</th><th>Último</th></tr></thead>
            <tbody id="topUsersBody"></tbody>
          </table>
        </div>
      </div>
      <div class="grid" style="padding-top:0">
        <div class="box" style="grid-column:1 / -1">
          <h3>Ingresos recientes</h3>
          <table>
            <thead><tr><th>Fecha</th><th>Usuario</th><th>Dominio</th><th>Rol</th><th>IP</th><th>Navegador</th></tr></thead>
            <tbody id="recentBody"></tbody>
          </table>
        </div>
      </div>
    </section>
  </div>

  <script>
    const isSuper = ${isSuper ? "true" : "false"};
    const els = {
      tenant: document.getElementById("tenant"),
      username: document.getElementById("username"),
      from: document.getElementById("from"),
      to: document.getElementById("to"),
      cards: document.getElementById("cards"),
      chart: document.getElementById("chart"),
      topUsersBody: document.getElementById("topUsersBody"),
      recentBody: document.getElementById("recentBody"),
      btnLoad: document.getElementById("btnLoad"),
      btnClear: document.getElementById("btnClear")
    };

    function esc(value){
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function fmtDate(value){
      if (!value) return "-";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "-";
      return d.toLocaleString("es-AR");
    }

    function buildQuery(){
      const params = new URLSearchParams();
      if (isSuper && els.tenant && els.tenant.value.trim()) params.set("tenant", els.tenant.value.trim());
      if (els.username && els.username.value.trim()) params.set("username", els.username.value.trim());
      if (els.from && els.from.value) params.set("from", els.from.value);
      if (els.to && els.to.value) params.set("to", els.to.value);
      return params.toString();
    }

    function renderCards(data){
      const items = [["Ingresos", data.total || 0],["Hoy", data.today || 0],["Usuarios únicos", data.uniqueUsers || 0],["Dominios activos", data.uniqueTenants || 0]];
      els.cards.innerHTML = items.map(function(pair){ return '<div class="stat"><div class="k">' + esc(pair[0]) + '</div><div class="v">' + esc(pair[1]) + '</div></div>'; }).join("");
    }

    function renderChart(chart){
      const rows = Array.isArray(chart) ? chart : [];
      if (!rows.length) { els.chart.innerHTML = '<div class="empty">Sin ingresos en el rango elegido.</div>'; return; }
      const max = Math.max.apply(null, rows.map(function(r){ return Number(r.total || 0); }).concat([1]));
      els.chart.innerHTML = rows.map(function(row){
        const total = Number(row.total || 0);
        const h = Math.max(8, Math.round((total / max) * 170));
        return '<div class="barWrap"><div class="barVal">' + esc(total) + '</div><div class="bar" style="height:' + h + 'px"></div><div class="barLab">' + esc(String(row.date || "").slice(5)) + '</div></div>';
      }).join("");
    }

    function renderTopUsers(rows){
      const items = Array.isArray(rows) ? rows : [];
      els.topUsersBody.innerHTML = items.length ? items.map(function(row){ return '<tr><td>' + esc(row.username || '-') + '</td><td>' + esc(row.tenantId || '-') + '</td><td>' + esc(row.role || '-') + '</td><td>' + esc(row.total || 0) + '</td><td>' + esc(fmtDate(row.lastAt)) + '</td></tr>'; }).join("") : '<tr><td colspan="5" class="empty">Sin datos.</td></tr>';
    }

    function renderRecent(rows){
      const items = Array.isArray(rows) ? rows : [];
      els.recentBody.innerHTML = items.length ? items.map(function(row){
        const ua = String(row.userAgent || '-');
        return '<tr><td>' + esc(fmtDate(row.createdAt)) + '</td><td>' + esc(row.username || '-') + '</td><td>' + esc(row.tenantId || '-') + '</td><td>' + esc(row.role || '-') + '</td><td>' + esc(row.ip || '-') + '</td><td class="muted" title="' + esc(ua) + '">' + esc(ua.slice(0, 90)) + '</td></tr>';
      }).join("") : '<tr><td colspan="6" class="empty">Sin ingresos recientes.</td></tr>';
    }

    async function loadData(){
      els.btnLoad.disabled = true;
      try {
        const qs = buildQuery();
        const r = await fetch('/api/web-access/summary' + (qs ? ('?' + qs) : ''));
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'request_failed');
        renderCards(j.summary || {});
        renderChart(j.summary && j.summary.chart ? j.summary.chart : []);
        renderTopUsers(j.summary && j.summary.topUsers ? j.summary.topUsers : []);
        renderRecent(j.summary && j.summary.recent ? j.summary.recent : []);
      } catch (e) {
        els.cards.innerHTML = '<div class="empty">No se pudo cargar el panel.</div>';
        els.chart.innerHTML = '';
        els.topUsersBody.innerHTML = '<tr><td colspan="5" class="empty">Error cargando datos.</td></tr>';
        els.recentBody.innerHTML = '<tr><td colspan="6" class="empty">Error cargando datos.</td></tr>';
      } finally {
        els.btnLoad.disabled = false;
      }
    }

    els.btnLoad.addEventListener("click", loadData);
    els.btnClear.addEventListener("click", function(){
      if (els.tenant) els.tenant.value = "";
      if (els.username) els.username.value = "";
      if (els.from) els.from.value = "";
      if (els.to) els.to.value = "";
      loadData();
    });

    loadData();
  </script>
</body>
</html>`;
}

function mountWebAccessRoutes(app, auth) {
  if (!app || !auth) throw new Error("mountWebAccessRoutes_requires_app_and_auth");
  const { requireAuth, requireAdmin } = auth;

  app.get("/admin/web-access", requireAuth, requireAdmin, async (req, res) => {
    try {
      return res.status(200).send(renderPage(req));
    } catch (e) {
      console.error("[web_access] page error:", e?.message || e);
      return res.status(500).send("internal");
    }
  });

  app.get("/api/web-access/summary", requireAuth, requireAdmin, async (req, res) => {
    try {
      const summary = await buildSummary(req);
      return res.json({ ok: true, summary });
    } catch (e) {
      console.error("[web_access] summary error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "internal" });
    }
  });
}

module.exports = {
  mountWebAccessRoutes,
  recordWebAccessLogin,
};
