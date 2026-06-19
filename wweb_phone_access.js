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
    .title { font-size:22px; font-weight:700; margin:0 0 10px 0; }
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
    .btn.danger { background:#f8d7da; color:#842029; border-color:#f1aeb5; }
    .btn.ok { background:#d1e7dd; color:#0f5132; border-color:#a3cfbb; }
    .action-msg { margin-top:12px; padding:10px 12px; background:#e7f1ff; border:1px solid #b6d4fe; color:#084298; border-radius:6px; font-size:14px; }
    @media (max-width: 640px) {
      html, body { overflow:auto; }
      .box.qr-mode { display:block; min-height:auto; }
      .qr-left { flex:auto; }
      .qr-right { min-width:0; margin-top:10px; }
      .qr img { width:min(280px, 88vw); max-width:88vw; }
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
         <div class="title"><div class="asisto-wa-brand"><img class="asisto-wa-brand__logo" src="data:image/png;base64,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" alt="Asisto" /><span>Sesión WhatsApp</span></div></div>
         <div class="state ${escapeHtml(state)}">${escapeHtml(state.toUpperCase())}</div>
        <div class="msg">Escaneá el QR desde WhatsApp para iniciar sesión.</div>
        ${actionBox}
        ${adminButtons}
      </div>
    </div>` : `
    <div class="box info-mode">
      <div class="title">Sesión WhatsApp</div>
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
