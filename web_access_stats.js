// Asisto | Version: 5.00.185 | Fecha: 2026-09-22
const crypto = require('crypto');
const { getDb } = require("./db");

const COLLECTION = "web_access_log";
const VISIT_COLLECTION = 'web_visit_log';
const VISITOR_COOKIE = 'asisto_vid';
const REPORT_TIMEZONE = 'America/Argentina/Buenos_Aires';
const REPORT_OFFSET = '-03:00';

function clean(value, limit = 120) { return String(value || '').trim().slice(0, limit); }
function cookieValue(req, name) {
  const raw = String(req?.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return '';
}
function referrerInfo(req) {
  const referrer = clean(req?.headers?.referer || req?.headers?.referrer, 500);
  if (!referrer) return { referrer: '', host: '' };
  try { return { referrer, host: clean(new URL(referrer).hostname.toLowerCase().replace(/^www\./, ''), 160) }; }
  catch { return { referrer: '', host: '' }; }
}
function inferSource(explicit, host) {
  const value = clean(explicit, 80).toLowerCase();
  if (value) return value;
  if (/instagram|l\.instagram/.test(host)) return 'instagram';
  if (/facebook|fb\.com/.test(host)) return 'facebook';
  if (host) return host;
  return 'directo';
}
function poweredLink({ app = 'aplicacion', placement = 'powered_by', tenant = '' } = {}) {
  const params = new URLSearchParams({ source: 'powered_asisto', app: clean(app, 80), placement: clean(placement, 80) });
  if (tenant) params.set('tenant', clean(tenant, 120));
  return '/r?' + params.toString();
}

async function recordPublicVisit({ req, res, overrides = {} } = {}) {
  try {
    if (!req) return null;
    let visitorId = clean(cookieValue(req, VISITOR_COOKIE), 80);
    if (!/^[a-f0-9]{32}$/i.test(visitorId)) {
      visitorId = crypto.randomBytes(16).toString('hex');
      res?.cookie?.(VISITOR_COOKIE, visitorId, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 365 * 86400000, path: '/' });
    }
    const ref = referrerInfo(req), query = req.query || {};
    const doc = {
      visitorId,
      source: inferSource(overrides.source ?? query.utm_source ?? query.source, ref.host),
      medium: clean(overrides.medium ?? query.utm_medium ?? query.medium, 80),
      campaign: clean(overrides.campaign ?? query.utm_campaign ?? query.campaign, 120),
      content: clean(overrides.content ?? query.utm_content ?? query.content, 120),
      app: clean(overrides.app ?? query.app, 80) || 'sitio_asisto',
      placement: clean(overrides.placement ?? query.placement, 100) || 'entrada',
      tenantId: clean(overrides.tenantId ?? query.tenant, 120),
      destination: clean(overrides.destination ?? query.to, 200) || '/login',
      referrer: ref.referrer || null,
      referrerHost: ref.host || null,
      path: clean(req.path || '/', 200),
      ip: getClientIp(req),
      userAgent: clean(req.headers?.['user-agent'], 500) || null,
      createdAt: new Date(),
    };
    await (await getDb()).collection(VISIT_COLLECTION).insertOne(doc);
    return doc;
  } catch (error) {
    console.error('[web_access] recordPublicVisit error:', error?.message || error);
    return null;
  }
}

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
  const d = new Date(`${s}T00:00:00.000${REPORT_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateEnd(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T23:59:59.999${REPORT_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function todayStartInReportTimezone(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return toDateStart(`${values.year}-${values.month}-${values.day}`);
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

function buildVisitFilter(req) {
  const filter = {};
  const tenantId = resolveTenantFilter(req);
  if (tenantId) filter.tenantId = tenantId;
  const from = toDateStart(req.query?.from), to = toDateEnd(req.query?.to);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
  return filter;
}

async function buildPublicVisitSummary(req) {
  const db = await getDb(), col = db.collection(VISIT_COLLECTION), filter = buildVisitFilter(req);
  const todayStart = todayStartInReportTimezone();
  const [total, today, visitors, sources, placements, recent] = await Promise.all([
    col.countDocuments(filter),
    col.countDocuments({ ...filter, createdAt: { ...(filter.createdAt || {}), $gte: todayStart } }),
    col.aggregate([{ $match: filter }, { $group: { _id: '$visitorId' } }, { $count: 'total' }]).toArray(),
    col.aggregate([{ $match: filter }, { $group: { _id: '$source', visits: { $sum: 1 }, visitors: { $addToSet: '$visitorId' }, lastAt: { $max: '$createdAt' } } }, { $sort: { visits: -1 } }, { $limit: 25 }]).toArray(),
    col.aggregate([{ $match: filter }, { $group: { _id: { app: '$app', placement: '$placement', tenantId: '$tenantId' }, visits: { $sum: 1 }, visitors: { $addToSet: '$visitorId' }, lastAt: { $max: '$createdAt' } } }, { $sort: { visits: -1 } }, { $limit: 50 }]).toArray(),
    col.find(filter, { projection: { visitorId: 1, source: 1, medium: 1, campaign: 1, app: 1, placement: 1, tenantId: 1, referrerHost: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(100).toArray(),
  ]);
  return {
    total, today, uniqueVisitors: visitors[0]?.total || 0,
    sources: sources.map(row => ({ source: row._id || 'directo', visits: row.visits || 0, visitors: row.visitors?.length || 0, lastAt: row.lastAt || null })),
    placements: placements.map(row => ({ app: row._id?.app || '-', placement: row._id?.placement || '-', tenantId: row._id?.tenantId || '-', visits: row.visits || 0, visitors: row.visitors?.length || 0, lastAt: row.lastAt || null })),
    recent: recent.map(row => ({ visitor: String(row.visitorId || '').slice(0, 8), source: row.source || 'directo', medium: row.medium || '', campaign: row.campaign || '', app: row.app || '-', placement: row.placement || '-', tenantId: row.tenantId || '-', referrerHost: row.referrerHost || '-', createdAt: row.createdAt || null })),
  };
}

async function buildSummary(req) {
  const db = await getDb();
  const filter = buildFilter(req);
  const col = db.collection(COLLECTION);

  const todayStart = todayStartInReportTimezone();

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
      { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: REPORT_TIMEZONE } }, total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $limit: 90 }
    ]).toArray()
  ]);

  const publicVisits = await buildPublicVisitSummary(req);
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
      date: String(row._id || ""),
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
    publicVisits,
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
        <p>Ingresos al sitio y accesos al panel: origen, aplicación, ubicación del enlace y dominio.</p>
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
          <h3>Visitas públicas por origen</h3>
          <table><thead><tr><th>Origen</th><th>Visitas</th><th>Personas</th><th>Última</th></tr></thead><tbody id="sourcesBody"></tbody></table>
        </div>
        <div class="box">
          <h3>Enlaces y pantallas que generaron visitas</h3>
          <table><thead><tr><th>Aplicación / ubicación</th><th>Dominio</th><th>Visitas</th><th>Personas</th></tr></thead><tbody id="placementsBody"></tbody></table>
        </div>
      </div>
      <div class="grid" style="padding-top:0">
        <div class="box" style="grid-column:1 / -1">
          <h3>Visitas públicas recientes</h3>
          <table><thead><tr><th>Fecha</th><th>Origen</th><th>Campaña</th><th>Aplicación</th><th>Ubicación</th><th>Dominio</th><th>Referencia</th></tr></thead><tbody id="visitsBody"></tbody></table>
        </div>
      </div>
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
      btnClear: document.getElementById("btnClear"),
      sourcesBody: document.getElementById("sourcesBody"),
      placementsBody: document.getElementById("placementsBody"),
      visitsBody: document.getElementById("visitsBody")
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
      const pv = data.publicVisits || {};
      const items = [["Logins", data.total || 0],["Logins hoy", data.today || 0],["Visitas públicas", pv.total || 0],["Visitantes únicos", pv.uniqueVisitors || 0]];
      els.cards.innerHTML = items.map(function(pair){ return '<div class="stat"><div class="k">' + esc(pair[0]) + '</div><div class="v">' + esc(pair[1]) + '</div></div>'; }).join("");
    }

    function renderPublicVisits(data){
      const pv = data.publicVisits || {};
      const sources = Array.isArray(pv.sources) ? pv.sources : [];
      const placements = Array.isArray(pv.placements) ? pv.placements : [];
      const recent = Array.isArray(pv.recent) ? pv.recent : [];
      els.sourcesBody.innerHTML = sources.length ? sources.map(function(row){return '<tr><td>'+esc(row.source)+'</td><td>'+esc(row.visits)+'</td><td>'+esc(row.visitors)+'</td><td>'+esc(fmtDate(row.lastAt))+'</td></tr>';}).join('') : '<tr><td colspan="4" class="empty">Sin visitas registradas.</td></tr>';
      els.placementsBody.innerHTML = placements.length ? placements.map(function(row){return '<tr><td><b>'+esc(row.app)+'</b><br><span class="muted">'+esc(row.placement)+'</span></td><td>'+esc(row.tenantId)+'</td><td>'+esc(row.visits)+'</td><td>'+esc(row.visitors)+'</td></tr>';}).join('') : '<tr><td colspan="4" class="empty">Sin enlaces registrados.</td></tr>';
      els.visitsBody.innerHTML = recent.length ? recent.map(function(row){return '<tr><td>'+esc(fmtDate(row.createdAt))+'</td><td>'+esc(row.source)+'</td><td>'+esc(row.campaign || '-')+'</td><td>'+esc(row.app)+'</td><td>'+esc(row.placement)+'</td><td>'+esc(row.tenantId)+'</td><td>'+esc(row.referrerHost)+'</td></tr>';}).join('') : '<tr><td colspan="7" class="empty">Sin visitas recientes.</td></tr>';
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
        renderPublicVisits(j.summary || {});
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

  app.get('/r', async (req, res) => {
    const requested = clean(req.query?.to, 200);
    const destination = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/login';
    await recordPublicVisit({ req, res, overrides: { destination } });
    return res.redirect(302, destination);
  });

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
  recordPublicVisit,
  poweredLink,
  _test: { toDateStart, toDateEnd, todayStartInReportTimezone, buildFilter, buildVisitFilter },
};
