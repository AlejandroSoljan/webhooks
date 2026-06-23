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


const ASISTO_LOGO_DATA_URI = "data:image/png;base64,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";

function renderAsistoTitle() {
  return `<div class="asisto-title-row"><div class="title">Sesión WhatsApp</div><img class="asisto-logo" src="${ASISTO_LOGO_DATA_URI}" alt="Asisto"></div>`;
}


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
  if (s === "authenticated") return "iniciando";
  if (s === "auth") return "iniciando";
  if (s === "authenticating") return "iniciando";
  if (s === "starting") return "iniciando";
  if (s === "initializing") return "iniciando";
  if (s === "loading") return "iniciando";
  if (s === "connecting") return "iniciando";

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

function buildUrl(route, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || String(v) === "") continue;
    qs.set(k, String(v));
  }
  const q = qs.toString();
  return q ? `${route}?${q}` : route;
}

function getLockId(lock, tenantId, numero) {
  const existing = String(lock?._id || "").trim();
  if (existing) return existing;
  return lockIdFromParts(tenantId, numero);
}

async function findPolicyByLockId(db, lockId) {
  const id = String(lockId || "").trim();
  if (!id) return null;
  return db.collection("wa_wweb_policies").findOne({ _id: id });
}

async function saveHistory(db, { lockId, tenantId, numero, event, detail }) {
  try {
    await db.collection("wa_wweb_history").insertOne({
      lockId,
      tenantId,
      numero,
      event,
      host: "webcontrol",
      by: "webcontrol",
      detail: detail || null,
      at: new Date(),
    });
  } catch {}
}

async function enqueueWwebAction(db, { lockId, tenantId, numero, action, reason }) {
  await db.collection("wa_wweb_actions").insertOne({
    lockId,
    tenantId,
    numero,
    action,
    reason: reason || "phone_web",
    requestedBy: "webcontrol",
    requestedAt: new Date(),
  });
}

async function applyAdminAction(db, { action, lock, tenantId, numero }) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (!normalizedAction) return "";

  const lockId = getLockId(lock, tenantId, numero);
  const parsedTenant = String(lock?.tenantId || lock?.tenantid || tenantId || "").trim();
  const parsedNumero = String(lock?.numero || lock?.number || lock?.phone || numero || "").trim();

  if (!lockId || !parsedTenant || !parsedNumero) {
    return "No se pudo resolver la sesión para ejecutar la acción.";
  }

  const policies = db.collection("wa_wweb_policies");

  if (normalizedAction === "restart" || normalizedAction === "reiniciar") {
    await enqueueWwebAction(db, {
      lockId,
      tenantId: parsedTenant,
      numero: parsedNumero,
      action: "restart",
      reason: "phone_web_restart",
    });
    await saveHistory(db, { lockId, tenantId: parsedTenant, numero: parsedNumero, event: "phone_web_restart", detail: null });
    return "Reinicio solicitado.";
  }

  if (["pause", "pausar", "block", "bloquear"].includes(normalizedAction)) {
    // Pausa lógica: NO cierra WhatsApp ni libera el lock.
    // Solo deja marcada la sesión para que app_asisto_ws no responda mensajes
    // y no ejecute ConsultaApiMensajes mientras esté bloqueada.
    await policies.updateOne(
      { _id: lockId },
      {
        $setOnInsert: { _id: lockId, tenantId: parsedTenant, numero: parsedNumero },
        $set: {
          blocked: true,
          messagesBlocked: true,
          paused: true,
          disabled: false,
          blockMode: "messages",
          updatedAt: new Date(),
          updatedBy: "webcontrol",
        },
      },
      { upsert: true }
    );

    await enqueueWwebAction(db, {
      lockId,
      tenantId: parsedTenant,
      numero: parsedNumero,
      action: "resume",
      reason: "phone_web_resume_messages",
    });

    await saveHistory(db, {
      lockId,
      tenantId: parsedTenant,
      numero: parsedNumero,
      event: "phone_web_pause_messages",
      detail: { paused: true, blocked: true, disabled: false, blockMode: "messages" },
    });
    return "Bot pausado. No se enviarán mensajes.";
  }

  if (["enable", "habilitar", "resume", "reanudar"].includes(normalizedAction)) {
    await policies.updateOne(
      { _id: lockId },
      {
        $setOnInsert: { _id: lockId, tenantId: parsedTenant, numero: parsedNumero },
        $set: {
          blocked: false,
          messagesBlocked: false,
          mensajes_bloqueados: false,
          bloqueado: false,
          paused: false,
          pausado: false,
          disabled: false,
          updatedAt: new Date(),
          updatedBy: "webcontrol",
        },
        $unset: {
          blockMode: "",
        },
      },
      { upsert: true }
    );

    await enqueueWwebAction(db, {
      lockId,
      tenantId: parsedTenant,
      numero: parsedNumero,
      action: "resume",
      reason: "phone_web_resume_messages",
    });
    await saveHistory(db, {
      lockId,
      tenantId: parsedTenant,
      numero: parsedNumero,
      event: "phone_web_resume_messages",
      detail: { paused: false, blocked: false, messagesBlocked: false, disabled: false },
    });
    return "Bot reanudado. Se vuelven a enviar mensajes.";
  }

  if (["clear_auth", "delete_auth", "borrar_auth", "borrar_autenticacion", "reset_auth", "nuevo_qr"].includes(normalizedAction)) {
    // La limpieza real de autenticación la ejecuta app_asisto_ws al consumir
    // wa_wweb_actions. Esta vista solo encola la orden y deja trazabilidad.
    await enqueueWwebAction(db, {
      lockId,
      tenantId: parsedTenant,
      numero: parsedNumero,
      action: "clear_auth",
      reason: "phone_web_clear_auth",
    });
    await saveHistory(db, {
      lockId,
      tenantId: parsedTenant,
      numero: parsedNumero,
      event: "phone_web_clear_auth",
      detail: { requested: true, action: "clear_auth" },
    });
    return "Borrado de autenticación solicitado. El script pedirá QR nuevamente.";
  }

  return "Acción no reconocida.";
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

function htmlPage({ lock, policy, numero, tenantId, admin, refreshSeconds, route, apiKey, actionMessage, clearMsgParam }) {
  const isDisabled = !!policy?.disabled;
  const isBlocked = !!(policy?.paused || policy?.pausado || policy?.blocked || policy?.messagesBlocked);
  const rawState = normalizeState(lock?.state);
  const state = isDisabled ? "disabled" : (isBlocked ? "paused" : rawState);
  const isStarting = state === "iniciando";
  const hasQr = !!String(lock?.lastQrDataUrl || "").trim();
  const showQr = rawState === "qr" && hasQr;
  const pc = lock?.host || lock?.hostname || lock?.pcName || "";
  const startedAt = lock?.startedAt || lock?.createdAt || null;
  const lastSeenAt = lock?.lastSeenAt || lock?.updatedAt || null;
  const lastQrAt = lock?.lastQrAt || null;
  const lockId = String(lock?._id || "");
  const realTenantId = String(lock?.tenantId || lock?.tenantid || tenantId || "");
  const realNumero = String(lock?.numero || lock?.number || lock?.phone || numero || "");
  const isAdmin = String(admin || "0") === "1";
  const refresh = Math.max(0, Math.min(60, Number.parseInt(refreshSeconds, 10) || 5));
  const baseParams = {
    tenantId: realTenantId,
    numero: realNumero,
    admin: isAdmin ? "1" : "0",
    refresh,
    apiKey,
  };

  const rows = [];
  rows.push(["Estado", state.toUpperCase()]);
  rows.push(["Teléfono", realNumero]);
  if (realTenantId) rows.push(["Dominio", realTenantId]);
  if (pc) rows.push(["PC", pc]);
  if (isDisabled) rows.push(["Sesión cerrada", "SI"]);
  if (isBlocked) rows.push(["Bot pausado", "SI"]);
  if (startedAt) rows.push(["Inicio script", formatDate(startedAt)]);
  if (lastSeenAt) rows.push(["Última señal", formatDate(lastSeenAt)]);
  if (lastQrAt && state === "qr") rows.push(["Fecha QR", formatDate(lastQrAt)]);
  if (isAdmin) {
    // No mostrar Lock, PID ni Instancia en esta vista embebida.
    if (lock?.runtimeVersion || lock?.currentVersion) rows.push(["Versión", String(lock.runtimeVersion || lock.currentVersion)]);
    if (lock?.desiredTag || lock?.targetTag) rows.push(["Target", String(lock.desiredTag || lock.targetTag)]);
  }

  const clearAuthUrl = buildUrl(route, { ...baseParams, action: "clear_auth" });
  const adminButtons = isAdmin ? `
    <div class="actions">
      <a class="btn" href="${escapeHtml(buildUrl(route, { ...baseParams, action: "restart" }))}">Reiniciar</a>
      ${isBlocked
        ? `<a class="btn ok" href="${escapeHtml(buildUrl(route, { ...baseParams, action: "resume" }))}">Reanudar</a>`
        : `<a class="btn danger" href="${escapeHtml(buildUrl(route, { ...baseParams, action: "pause" }))}">Pausar</a>`}
      <a class="btn danger" href="${escapeHtml(clearAuthUrl)}" onclick="return confirm('Se borrará la autenticación de WhatsApp y se pedirá QR nuevamente. ¿Continuar?')">Borrar autenticación</a>

    </div>` : "";

  const actionBox = actionMessage ? `<div class="action-msg">${escapeHtml(actionMessage)}</div>` : "";

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
    .title { font-size:22px; font-weight:700; margin:0; }
    .asisto-title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin:0 0 10px 0; }
    .asisto-logo { width:64px; height:auto; object-fit:contain; display:block; margin-left:auto; flex:0 0 auto; }
    .state { display:inline-block; padding:7px 12px; border-radius:999px; font-size:14px; font-weight:700; background:#eee; }
    .state.qr { background:#fff3cd; color:#7a5200; }
    .state.online { background:#d1e7dd; color:#0f5132; }
    .state.iniciando { background:#cff4fc; color:#055160; }
    .state.offline, .state.error, .state.disabled { background:#f8d7da; color:#842029; }
    .state.blocked, .state.paused { background:#ffe5d0; color:#7a3b00; }
    .qr { text-align:center; margin:0; }
    .qr img { width:300px; max-width:42vw; height:auto; image-rendering:auto; }
    table { width:100%; border-collapse:collapse; margin-top:12px; font-size:15px; }
    td { padding:8px 6px; border-bottom:1px solid #eee; vertical-align:top; }
    td:first-child { width:34%; color:#555; font-weight:700; }
    .msg { margin-top:14px; padding:12px; background:#f6f6f6; border-radius:6px; font-size:15px; line-height:1.35; }
    .info-mode { display:block; }
    .actions { margin-top:14px; display:flex; gap:10px; flex-wrap:wrap; }
    .btn { display:inline-block; border:1px solid #999; border-radius:7px; padding:10px 14px; text-decoration:none; font-weight:700; color:#111; background:#f4f4f4; font-size:15px; }
    .btn.danger { background:#f4f4f4; color:#111; border-color:#999; }
    .btn.ok { background:#d1e7dd; color:#0f5132; border-color:#a3cfbb; }
    .action-msg { margin-top:12px; padding:10px 12px; background:#e7f1ff; border:1px solid #b6d4fe; color:#084298; border-radius:6px; font-size:14px; }
    @media (max-width: 640px) {
      html, body { overflow:auto; }
      .box.qr-mode { display:block; min-height:auto; }
      .qr-left { flex:auto; }
      .qr-right { min-width:0; margin-top:10px; }
      .qr img { width:min(280px, 88vw); max-width:88vw; }
      .asisto-title-row { gap:10px; }
      .asisto-logo { width:52px; }
    }
  
      .asisto-wa-brand{display:flex;align-items:center;gap:14px;flex-wrap:wrap;}
      .asisto-wa-brand__logo{width:56px;height:56px;object-fit:contain;display:block;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.08);background:#12355b;padding:4px;}
      .asisto-wa-brand h1,.asisto-wa-brand h2{margin:0;}
      @media (max-width:640px){
        .asisto-wa-brand{gap:10px;}
        .asisto-wa-brand__logo{width:46px;height:46px;border-radius:10px;}
      }
      .asisto-wa-brand{display:flex;align-items:center;gap:14px;flex-wrap:wrap;}
      .asisto-wa-brand__logo{width:56px;height:56px;object-fit:contain;display:block;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.08);background:#12355b;padding:4px;}
      .asisto-wa-brand h1,.asisto-wa-brand h2{margin:0;}
      @media (max-width:640px){
        .asisto-wa-brand{gap:10px;}
        .asisto-wa-brand__logo{width:46px;height:46px;border-radius:10px;}
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
       ${renderAsistoTitle()}
           <div class="state ${escapeHtml(state)}">${escapeHtml(state.toUpperCase())}</div>
        <div class="msg">Escaneá el QR desde WhatsApp para iniciar sesión.</div>
        ${actionBox}
        ${adminButtons}
      </div>
    </div>` : `
    <div class="box info-mode">
     ${renderAsistoTitle()}
      <div class="state ${escapeHtml(state)}">${escapeHtml(state.toUpperCase())}</div>
      ${state === "online"
        ? `<div class="msg">La sesión ya está iniciada.</div>`
        : isStarting
          ? `<div class="msg">QR escaneado. La sesión está iniciando, aguardá unos segundos hasta que quede ONLINE.</div>`
          : `<div class="msg">QR no disponible en este momento. Estado actual: ${escapeHtml(state)}.</div>`}
      ${actionBox}
      ${adminButtons}
      <table>
        ${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("\n        ")}
      </table>
    </div>`}
  </div>
  ${clearMsgParam ? `<script>
    try {
      var u = new URL(window.location.href);
      u.searchParams.delete("msg");
      window.history.replaceState(null, "", u.toString());
    } catch (e) {}
  </script>` : ""}
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
    .title { font-size:20px; font-weight:700; margin:0; }
    .asisto-title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin:0 0 12px 0; }
    .asisto-logo { width:60px; height:auto; object-fit:contain; display:block; margin-left:auto; flex:0 0 auto; }
   .msg { padding:12px; background:#f8d7da; color:#842029; border-radius:6px; font-size:14px; }
  </style>
</head>
<body><div class="wrap"><div class="box">${renderAsistoTitle()}<div class="msg">${escapeHtml(message)}</div></div></div></body>
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
      const action = String(req.query?.action || req.query?.accion || "").trim();
      const apiKey = readApiKey(req);

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

      let policy = await findPolicyByLockId(db, getLockId(lock, tenantId, numero));
      let actionMessage = String(req.query?.msg || "").trim();
      let clearMsgParam = false;

      // Si quedó msg=Reinicio solicitado en la URL, no lo sigas mostrando
      // cuando el script ya volvió a iniciar y generó QR o está online.
      // Además limpiamos el parámetro msg del WebControl para que el auto-refresh
      // no lo vuelva a mostrar más adelante.
      if (actionMessage) {
        const msgNorm = actionMessage.toLowerCase();
        const stateNorm = normalizeState(lock?.state);
        const scriptStarted = stateNorm === "qr" || stateNorm === "online" || !!lock?.lastQrAt || !!lock?.startedAt;

        if (msgNorm.includes("reinicio") && scriptStarted) {
          actionMessage = "";
         clearMsgParam = true;
        }
      }

      if (action) {
        if (String(admin) !== "1") {
          const e = errorPage("Acción no permitida", 403);
          return res.status(e.status).type("html").send(e.html);
        }

        actionMessage = await applyAdminAction(db, { action, lock, tenantId, numero });

        // IMPORTANTE:
        // Esta pantalla tiene auto-refresh. Si queda action=restart/block/enable
        // en la URL, cada refresh vuelve a ejecutar la misma acción.
        // Luego de ejecutar, redireccionamos a la misma pantalla SIN action.
        const cleanUrl = buildUrl(req.path, {
          tenantId: String(lock?.tenantId || lock?.tenantid || tenantId || ""),
          numero: String(lock?.numero || lock?.number || lock?.phone || numero || ""),
          admin: String(admin) === "1" ? "1" : "0",
          refresh,
          apiKey,
          msg: actionMessage,
        });

        return res.redirect(303, cleanUrl);
      }

      return res.status(200).type("html").send(htmlPage({
        lock,
        policy,
        numero,
        tenantId,
        admin,
        refreshSeconds: refresh,
        route: req.path,
        apiKey,
        actionMessage,
        clearMsgParam,
      }));
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
