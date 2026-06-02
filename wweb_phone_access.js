// wweb_phone_access.js
// Acceso web simple para PowerBuilder WebControl.
// Muestra QR si la sesión está en estado QR, o estado de sesión si ya está conectada.
//
// URLs:
//   /wa-session?numero=549...&apiKey=...&admin=1
//   /api/ext/wweb/phone-web?numero=549...&apiKey=...&admin=1
//
// Opcional:
//   tenantId=CHIAROTTO  -> si se conoce el tenant, busca lockId exacto TENANT:NUMERO.
//   refresh=5           -> segundos para refrescar la pantalla. Default 5.

const { getDb } = require("./db");

function onlyDigits(v) {
  return String(v || "").replace(/\D+/g, "");
}

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(v) {
  return String(v || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readApiKey(req) {
  const authz = String(req.headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(authz)) {
    return authz.replace(/^Bearer\s+/i, "").trim();
  }

  return String(
    req.headers["x-api-key"] ||
    req.headers["api-key"] ||
    req.query?.apiKey ||
    req.query?.apikey ||
    req.query?.api_key ||
    req.query?.["x-api-key"] ||
    ""
  ).trim();
}

function isAuthorized(req) {
  const expected = String(process.env.WWEB_API_KEY || "").trim();
  const provided = readApiKey(req);
  return !!expected && !!provided && provided === expected;
}

function normalizeState(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "sin_estado";
  if (s === "ready") return "online";
  if (s === "authenticated") return "online";
  if (s === "auth") return "online";
  return s;
}

function formatDate(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v || "");
  try {
    return d.toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return d.toISOString();
  }
}

function lockIdFromParts(tenantId, numero) {
  const t = String(tenantId || "").trim();
  const n = onlyDigits(numero);
  if (!t || !n) return "";
  return `${t}:${n}`;
}

async function findLockByPhone(db, { numero, tenantId }) {
  const locks = db.collection("wa_locks");
  const n = onlyDigits(numero);
  const t = String(tenantId || "").trim();

  if (!n) return null;

  const projection = {
    _id: 1,
    tenantId: 1,
    tenantid: 1,
    numero: 1,
    number: 1,
    phone: 1,
    state: 1,
    host: 1,
    hostname: 1,
    pcName: 1,
    holderId: 1,
    instanceId: 1,
    pid: 1,
    startedAt: 1,
    createdAt: 1,
    lastSeenAt: 1,
    updatedAt: 1,
    lastQrAt: 1,
    lastQrDataUrl: 1,
    runtimeVersion: 1,
    currentVersion: 1,
    desiredTag: 1,
    targetTag: 1,
  };

  if (t) {
    const exactId = lockIdFromParts(t, n);
    const byId = await locks.findOne({ _id: exactId }, { projection });
    if (byId) return byId;

    return locks.findOne(
      {
        $and: [
          { $or: [{ tenantId: t }, { tenantid: t }] },
          { $or: [{ numero: n }, { number: n }, { phone: n }] },
        ],
      },
      { projection, sort: { lastSeenAt: -1, updatedAt: -1, startedAt: -1 } }
    );
  }

  return locks.findOne(
    {
      $or: [
        { numero: n },
        { number: n },
        { phone: n },
        { _id: { $regex: new RegExp(`:${escapeRegExp(n)}$`) } },
      ],
    },
    { projection, sort: { lastSeenAt: -1, updatedAt: -1, startedAt: -1 } }
  );
}

function htmlPage({ lock, numero, tenantId, admin, refreshSeconds }) {
  const state = normalizeState(lock?.state);
  const hasQr = !!String(lock?.lastQrDataUrl || "").trim();
  const showQr = state === "qr" && hasQr;
  const pc = lock?.host || lock?.hostname || lock?.pcName || "";
  const startedAt = lock?.startedAt || lock?.createdAt || null;
  const lastSeenAt = lock?.lastSeenAt || lock?.updatedAt || null;
  const lastQrAt = lock?.lastQrAt || null;
  const lockId = String(lock?._id || "");
  const realTenantId = String(lock?.tenantId || lock?.tenantid || tenantId || "");
  const realNumero = String(lock?.numero || lock?.number || lock?.phone || numero || "");
  const isAdmin = String(admin || "0") === "1";
  const refresh = Math.max(0, Math.min(60, Number.parseInt(refreshSeconds, 10) || 5));

  const rows = [];
  rows.push(["Estado", state.toUpperCase()]);
  rows.push(["Teléfono", realNumero]);
  if (realTenantId) rows.push(["Dominio", realTenantId]);
  if (pc) rows.push(["PC", pc]);
  if (startedAt) rows.push(["Inicio script", formatDate(startedAt)]);
  if (lastSeenAt) rows.push(["Última señal", formatDate(lastSeenAt)]);
  if (lastQrAt && state === "qr") rows.push(["Fecha QR", formatDate(lastQrAt)]);
  if (isAdmin) {
    // No mostrar Lock, PID ni Instancia en esta vista embebida.
    if (lock?.runtimeVersion || lock?.currentVersion) rows.push(["Versión", String(lock.runtimeVersion || lock.currentVersion)]);
    if (lock?.desiredTag || lock?.targetTag) rows.push(["Target", String(lock.desiredTag || lock.targetTag)]);
  }

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refresh > 0 ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
  <title>WhatsApp</title>
  <style>
    html, body { margin:0; padding:0; background:#fff; color:#111; font-family:Arial, Helvetica, sans-serif; overflow:hidden; }
    .wrap { box-sizing:border-box; width:100vw; min-height:100vh; padding:10px; display:flex; align-items:center; justify-content:center; }
    .box { box-sizing:border-box; width:min(980px, 100%); min-height:260px; border:1px solid #ddd; border-radius:8px; padding:14px; }
    .box.qr-mode { width:min(760px, 100%); min-height:300px; display:flex; align-items:center; justify-content:center; gap:22px; }
    .qr-left { flex:0 0 330px; text-align:center; }
    .qr-right { flex:1; min-width:260px; }
    .title { font-size:22px; font-weight:700; margin:0 0 10px 0; }
    .state { display:inline-block; padding:7px 12px; border-radius:999px; font-size:14px; font-weight:700; background:#eee; }
    .state.qr { background:#fff3cd; color:#7a5200; }
    .state.online { background:#d1e7dd; color:#0f5132; }
    .state.offline, .state.error { background:#f8d7da; color:#842029; }
    .qr { text-align:center; margin:0; }
    .qr img { width:300px; max-width:42vw; height:auto; image-rendering:auto; }
    table { width:100%; border-collapse:collapse; margin-top:12px; font-size:15px; }
    td { padding:8px 6px; border-bottom:1px solid #eee; vertical-align:top; }
    td:first-child { width:34%; color:#555; font-weight:700; }
    .msg { margin-top:14px; padding:12px; background:#f6f6f6; border-radius:6px; font-size:15px; line-height:1.35; }
    .info-mode { display:block; }
    @media (max-width: 640px) {
      html, body { overflow:auto; }
      .box.qr-mode { display:block; min-height:auto; }
      .qr-left { flex:auto; }
      .qr-right { min-width:0; margin-top:10px; }
      .qr img { width:min(280px, 88vw); max-width:88vw; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    ${showQr ? `
    <div class="box qr-mode">
      <div class="qr-left">
        <div class="qr"><img alt="QR WhatsApp" src="${escapeHtml(lock.lastQrDataUrl)}"></div>
      </div>
      <div class="qr-right">
        <div class="title">Sesión WhatsApp</div>
        <div class="state ${escapeHtml(state)}">${escapeHtml(state.toUpperCase())}</div>
        <div class="msg">Escaneá el QR desde WhatsApp para iniciar sesión.</div>
      </div>
    </div>` : `
    <div class="box info-mode">
      <div class="title">Sesión WhatsApp</div>
      <div class="state ${escapeHtml(state)}">${escapeHtml(state.toUpperCase())}</div>
      ${state === "online" ? `<div class="msg">La sesión ya está iniciada.</div>` : `<div class="msg">QR no disponible en este momento. Estado actual: ${escapeHtml(state)}.</div>`}
      <table>
        ${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("\n        ")}
      </table>
    </div>`}
  </div>
</body>
</html>`;
}

function errorPage(message, status = 400) {
  return {
    status,
    html: `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp</title>
  <style>
    html, body { margin:0; padding:0; background:#fff; color:#111; font-family:Arial, Helvetica, sans-serif; }
    .wrap { box-sizing:border-box; width:100%; min-height:100vh; padding:16px; }
    .box { box-sizing:border-box; width:min(760px, 100%); margin:0 auto; border:1px solid #ddd; border-radius:8px; padding:16px; }
    .title { font-size:20px; font-weight:700; margin:0 0 12px 0; }
    .msg { padding:12px; background:#f8d7da; color:#842029; border-radius:6px; font-size:14px; }
  </style>
</head>
<body><div class="wrap"><div class="box"><div class="title">Sesión WhatsApp</div><div class="msg">${escapeHtml(message)}</div></div></div></body>
</html>`
  };
}

function mountWwebPhoneAccess(app, options = {}) {
  const routes = Array.isArray(options.routes) && options.routes.length
    ? options.routes
    : ["/wa-session", "/api/ext/wweb/phone-web"];

  async function handler(req, res) {
    try {
      try { res.set("Cache-Control", "no-store"); } catch {}

      if (!isAuthorized(req)) {
        const e = errorPage("Acceso no autorizado", 401);
        return res.status(e.status).type("html").send(e.html);
      }

      const numero = onlyDigits(req.query?.numero || req.query?.telefono || req.query?.phone || "");
      const tenantId = String(req.query?.tenantId || req.query?.tenant || req.query?.dominio || "").trim();
      const admin = String(req.query?.admin || "0").trim();
      const refresh = String(req.query?.refresh || "5").trim();

      if (!numero) {
        const e = errorPage("Falta parámetro numero", 400);
        return res.status(e.status).type("html").send(e.html);
      }

      const db = await getDb();
      const lock = await findLockByPhone(db, { numero, tenantId });

      if (!lock) {
        const e = errorPage("No se encontró sesión para el teléfono informado", 404);
        return res.status(e.status).type("html").send(e.html);
      }

      return res.status(200).type("html").send(htmlPage({ lock, numero, tenantId, admin, refreshSeconds: refresh }));
    } catch (err) {
      console.error("GET wweb phone access error:", err);
      const e = errorPage("Error interno consultando sesión", 500);
      return res.status(e.status).type("html").send(e.html);
    }
  }

  for (const route of routes) {
    app.get(route, handler);
  }
}

module.exports = { mountWwebPhoneAccess };
