// auth_ui.js
// Login + sesiones firmadas + menú (/app) + administración de usuarios (/admin/users)
// Requiere MongoDB (getDb) y la colección "users".
//
// Documento esperado en "users":
// { username, role: 'admin'|'user'|'superadmin', tenantId, password: { salt, hash }, createdAt }

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "asisto_sess";
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || "dev-unsafe-secret-change-me";

function base64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64urlDecode(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return Buffer.from(s + pad, "base64");
}

function sign(value) {
  const mac = crypto.createHmac("sha256", COOKIE_SECRET).update(value).digest();
  return base64urlEncode(mac);
}

function timingSafeEq(a, b) {
  try {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function makeSessionPayload(user) {
  return {
    uid: String(user._id),
    username: String(user.username),
    role: String(user.role || "user"),
    tenantId: String(user.tenantId || "default"),
    iat: Date.now(),
  };
}

function setSessionCookie(res, payload) {
  const json = JSON.stringify(payload);
  const token = base64urlEncode(json) + "." + sign(json);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 días
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

function readSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return null;
  let json;
  try {
    json = base64urlDecode(b64).toString("utf8");
  } catch {
    return null;
  }
  const expected = sign(json);
  if (!timingSafeEq(sig, expected)) return null;
  try {
    const payload = JSON.parse(json);
    if (!payload?.uid) return null;
    return payload;
  } catch {
    return null;
  }
}

// ===== Password hashing (scrypt) =====
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}
function verifyPassword(plain, passwordDoc) {
  try {
    if (!passwordDoc?.salt || !passwordDoc?.hash) return false;
    const salt = Buffer.from(passwordDoc.salt, "hex");
    const expected = Buffer.from(passwordDoc.hash, "hex");
    const actual = crypto.scryptSync(String(plain), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ===== Middleware =====
async function attachUser(req, res, next) {
  try {
    const sess = readSession(req);
    if (!sess) {
      req.user = null;
      return next();
    }

    // Refrescamos desde DB para que cambios (rol/tenant/bloqueo) impacten al instante.
    const db = await getDb();
    let userDoc = null;

    const uid = String(sess.uid || "").trim();
    if (ObjectId.isValid(uid)) {
      userDoc = await db.collection("users").findOne(
        { _id: new ObjectId(uid) },
        { projection: { username: 1, role: 1, tenantId: 1, isLocked: 1 } }
      );
    }

    // Fallback por username si no hay uid válido (por compatibilidad)
    if (!userDoc && sess.username) {
      userDoc = await db.collection("users").findOne(
        { username: String(sess.username) },
        { projection: { username: 1, role: 1, tenantId: 1, isLocked: 1 } }
      );
    }

    if (!userDoc || userDoc.isLocked) {
      req.user = null;
      try { clearSessionCookie(res); } catch {}
      return next();
    }

    // Usamos el snapshot de DB como fuente de verdad.
    req.user = makeSessionPayload(userDoc);
    return next();
  } catch {
    req.user = null;
    return next();
  }
}

function requireAuth(req, res, next) {
  if (req.user?.uid) return next();
  const to = encodeURIComponent(req.originalUrl || "/app");
  return res.redirect(`/login?to=${to}`);
}

function requireAdmin(req, res, next) {
  const role = String(req.user?.role || "");
  if (role === "admin" || role === "superadmin") return next();
  return res.status(403).send("403 - No autorizado");
}

// ===== Tenant resolver =====
function resolveTenantId(req, { defaultTenantId = "default", envTenantId = "" } = {}) {
  // Si el usuario NO es superadmin -> el tenant del usuario manda.
  const role = String(req.user?.role || "");
  const userTenant = (req.user?.tenantId || "").toString().trim();

  const pick = (req.query?.tenant || req.headers?.["x-tenant-id"] || envTenantId || defaultTenantId);
  const picked = (pick || defaultTenantId).toString().trim();

  if (role === "superadmin") return picked;
  if (userTenant) return userTenant;
  return picked;
}

// ===== HTML helpers =====
function htmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function pageShell({ title, user, body }) {
  const u = user ? `${htmlEscape(user.username)} · ${htmlEscape(user.tenantId)} · ${htmlEscape(user.role)}` : "";
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${htmlEscape(title || "Asisto")}</title>
  <style>
    :root{
      --bg:#0f2741;
      --bg2:#0b1f35;
      --card:#ffffff;
      --muted:#7b8794;
      --text:#0b1726;
      --primary:#0e6b66;
      --primary2:#0a5a56;
      --border:#e6eaef;
      --shadow: 0 12px 32px rgba(0,0,0,.18);
      --radius: 18px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      background: radial-gradient(1200px 700px at 20% 10%, rgba(33,140,255,.12), transparent 60%),
                  radial-gradient(900px 500px at 70% 80%, rgba(0,210,160,.10), transparent 55%),
                  linear-gradient(180deg, var(--bg), var(--bg2));
      min-height:100vh;
      color:#fff;
    }
    a{color:inherit}
    .wrap{min-height:100vh; display:flex; align-items:center; justify-content:center; padding:28px;}
    .grid{
      width:min(1100px, 100%);
      display:grid;
      grid-template-columns: 1.1fr .9fr;
      gap:26px;
      align-items:stretch;
    }
    @media (max-width: 900px){
      .grid{grid-template-columns: 1fr; }
    }
    .brand{
      border-radius: var(--radius);
      padding:0;
      position:relative;
      overflow:hidden;
      background: rgba(255,255,255,.04);
      border:1px solid rgba(255,255,255,.06);
      display:flex;
      align-items:center;
      justify-content:center;
    }
    .brand .brandHero{
      width:100%;
      height:100%;
      object-fit:contain;
      padding:18px;
      filter: drop-shadow(0 8px 16px rgba(0,0,0,.25));
    }
    .card{
      background: var(--card);
      color: var(--text);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 26px;
      border:1px solid rgba(16,24,40,.06);
    }
    .card h2{margin:0 0 14px; font-size:28px}
    .row{display:flex; gap:12px}
    .field{margin:14px 0}
    label{display:block; font-size:13px; color: #475467; margin-bottom:7px}
    input, select{
      width:100%;
      border:1px solid var(--border);
      border-radius: 12px;
      padding: 12px 12px;
      font-size: 15px;
      outline:none;
    }
    input:focus, select:focus{border-color: rgba(14,107,102,.6); box-shadow: 0 0 0 4px rgba(14,107,102,.14)}
    .btn{
      display:inline-flex; align-items:center; justify-content:center;
      width:100%;
      border:0;
      background: var(--primary);
      color:#fff;
      padding: 12px 14px;
      border-radius: 12px;
      font-weight:700;
      cursor:pointer;
    }
    .btn:hover{background: var(--primary2)}
    .link{color:#475467; font-size:13px; text-decoration:none}
    .topbar{
      position:fixed; left:0; right:0; top:0;
      display:flex; align-items:center; justify-content:space-between;
      padding: 16px 18px;
      background: rgba(8,16,28,.20);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid rgba(255,255,255,.06);
    }
    .pill{display:inline-flex; gap:10px; align-items:center; color:rgba(255,255,255,.86); font-size:13px}
    .pill strong{color:#fff}
    .content{padding-top:74px;}
    .app{
      width:min(1100px, 100%);
      margin: 0 auto;
      padding: 22px;
    }
    .cards{
      display:grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    @media (max-width: 700px){
      .cards{grid-template-columns: 1fr;}
    }
    .tile{
      background:#fff;
      color:#0b1726;
      border:1px solid rgba(16,24,40,.08);
      border-radius: 16px;
      padding:16px;
      text-decoration:none;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .tile:hover{transform: translateY(-1px); box-shadow: 0 10px 26px rgba(0,0,0,.14)}
    .tile h3{margin:0; font-size:16px}
    .tile p{margin:6px 0 0; color:#667085; font-size:13px}
    .badge{
      font-size:12px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(14,107,102,.10);
      color: var(--primary);
      border: 1px solid rgba(14,107,102,.18);
      white-space:nowrap;
    }
    .msg{
      background: rgba(14,107,102,.08);
      border: 1px solid rgba(14,107,102,.18);
      color: #0b1726;
      padding: 10px 12px;
      border-radius: 12px;
      margin: 12px 0;
      font-size: 14px;
    }
    .err{
      background: rgba(240,68,56,.10);
      border: 1px solid rgba(240,68,56,.25);
    }
    table{
      width:100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td{
      padding: 10px;
      border-bottom: 1px solid var(--border);
      text-align:left;
      vertical-align: top;
    }
    th{color:#475467; font-weight:700}
    .actions form{display:block}
    .btn2{
      border:1px solid rgba(16,24,40,.12);
      background:#fff;
      border-radius: 10px;
      padding: 8px 10px;
      cursor:pointer;
      font-weight: 650;
      margin-right: 6px;
    }
    .btnDanger{border-color: rgba(240,68,56,.32); color:#b42318}
    .btnOk{border-color: rgba(14,107,102,.28); color: var(--primary)}
    .small{font-size:12px; color:#667085}
  </style>
</head>
<body>
  ${user ? `
  <div class="topbar">
    <div class="pill">
      <img src="/static/logo.png" alt="Asisto" style="width:28px;height:28px;object-fit:contain"/>
      <strong>Asisto</strong>
      <span>·</span>
      <span>${u}</span>
    </div>
    <form method="POST" action="/logout" style="margin:0">
      <button class="btn2" type="submit">Cerrar sesión</button>
    </form>
  </div>` : ``}

  <div class="${user ? "content" : ""}">
    ${body}
  </div>
</body>
</html>`;
}

function loginPage({ error, to }) {
  const err = error ? `<div class="msg err">${htmlEscape(error)}</div>` : "";
  return pageShell({
    title: "Login · Asisto",
    user: null,
    body: `
    <div class="wrap">
      <div class="grid">
        <div class="brand">
          <img class="brandHero" src="/static/logo.png" alt="Asisto"/>
        </div>
        <div class="card">
          <h2>Iniciar sesión</h2>
          ${err}
          <form method="POST" action="/login">
            <input type="hidden" name="to" value="${htmlEscape(to || "/app")}"/>
            <div class="field">
              <label>Usuario</label>
              <input name="username" autocomplete="username" placeholder="usuario" required/>
            </div>
            <div class="field">
              <label>Contraseña</label>
              <input name="password" type="password" autocomplete="current-password" placeholder="••••••••" required/>
            </div>
            <button class="btn" type="submit">Iniciar sesión</button>
          </form>
          <div style="margin-top:12px">
            <span class="link small">Si no tenés usuario, pedile acceso al administrador.</span>
          </div>
        </div>
      </div>
    </div>
    `,
  });
}

function appMenuPage({ user, routes }) {
  const tiles = routes.map(r => `
    <a class="tile" href="${htmlEscape(r.href)}">
      <div>
        <h3>${htmlEscape(r.title)}</h3>
        <p>${htmlEscape(r.desc || "")}</p>
      </div>
      <span class="badge">${htmlEscape(r.badge || "")}</span>
    </a>
  `).join("");

  const adminTiles = (user.role === "admin" || user.role === "superadmin")
    ? `<a class="tile" href="/admin/users">
         <div><h3>Usuarios</h3><p>Alta/baja y reseteo de contraseñas</p></div>
         <span class="badge">Admin</span>
       </a>` : "";

  return pageShell({
    title: "Inicio · Asisto",
    user,
    body: `
    <div class="app">
      <h2 style="margin:0 0 6px">Bienvenido, ${htmlEscape(user.username)}</h2>
      <div class="small" style="margin-bottom:18px">Elegí una opción para gestionar Asisto.</div>
      <div class="cards">
        ${adminTiles}
        ${tiles}
      </div>
    </div>
    `,
  });
}

function usersAdminPage({ user, users, msg, err }) {
  const message = msg ? `<div class="msg">${htmlEscape(msg)}</div>` : "";
  const error = err ? `<div class="msg err">${htmlEscape(err)}</div>` : "";

  const isSuper = String(user?.role || "") === "superadmin";
  const myTenant = String(user?.tenantId || "default");

  const roleOptionsForCreate = isSuper
    ? `<option value="user">user</option><option value="admin">admin</option><option value="superadmin">superadmin</option>`
    : `<option value="user">user</option><option value="admin">admin</option>`;

  const createTenantField = isSuper
    ? `<input name="tenantId" required placeholder="default"/>`
    : `<input name="tenantId" required value="${htmlEscape(myTenant)}" readonly/>`;

  const rows = (users || []).map(u => {
    const id = String(u._id);
    const username = String(u.username || "");
    const tenantId = String(u.tenantId || "");
    const role = String(u.role || "user");
    const locked = !!u.isLocked;
    const isSelf = String(user?.uid) === id;

    const canEditTenant = isSuper;
    const canEditRole = isSuper;
    const canEditLock = !isSelf; // evitamos que se bloquee solo desde UI

    const roleSelect = (() => {
      // Admin sólo ve user/admin (y no debería ver superadmins por server-side, pero por si acaso)
      const opts = isSuper
        ? ["user", "admin", "superadmin"]
        : ["user", "admin"];
      const options = opts.map(r => `<option value="${r}" ${r === role ? "selected" : ""}>${r}</option>`).join("");
      const disabled = (!isSuper && role === "superadmin") ? "disabled" : "";
      return `<select name="role" ${disabled} style="width:120px; display:inline-block; margin-right:6px">${options}</select>`;
    })();

    const tenantInput = canEditTenant
      ? `<input name="tenantId" value="${htmlEscape(tenantId)}" style="width:140px; display:inline-block; margin-right:6px" />`
      : `<input name="tenantId" value="${htmlEscape(tenantId)}" readonly style="width:140px; display:inline-block; margin-right:6px" />`;

    const lockToggle = canEditLock
      ? `<label class="small" style="display:inline-flex; align-items:center; gap:6px; margin-right:8px">
           <input type="checkbox" name="isLocked" value="1" ${locked ? "checked" : ""}/>
           Bloqueado
         </label>`
      : `<span class="small" style="margin-right:8px">${locked ? "Bloqueado" : "Activo"} (vos)</span>`;

    const saveDisabled = isSelf ? "disabled" : "";

    return `
      <tr>
        <td>
          <strong>${htmlEscape(username)}</strong>
          <div class="small">${htmlEscape(id)}</div>
        </td>
        <td>${htmlEscape(tenantId)}</td>
        <td>${htmlEscape(role)}</td>
        <td>${locked ? "Bloqueado" : "Activo"}</td>
        <td class="actions">
          <form method="POST" action="/admin/users/update" style="margin:0 0 8px 0">
            <input type="hidden" name="userId" value="${htmlEscape(id)}"/>
            ${tenantInput}
            ${roleSelect}
            ${lockToggle}
            <button class="btn2 btnOk" type="submit" ${saveDisabled}>Guardar</button>
            ${isSelf ? `<div class="small" style="margin-top:6px">No se permite cambiar tu rol/tenant/bloqueo desde acá.</div>` : ``}
          </form>

          <form method="POST" action="/admin/users/reset-password" style="margin:0 0 8px 0">
            <input type="hidden" name="userId" value="${htmlEscape(id)}"/>
            <input name="newPassword" placeholder="Nueva contraseña" required style="width:190px; display:inline-block; margin-right:6px"/>
            <button class="btn2 btnOk" type="submit">Reset</button>
          </form>

          <form method="POST" action="/admin/users/delete" style="margin:0" onsubmit="return confirm('¿Eliminar usuario ${htmlEscape(username)}?')">
            <input type="hidden" name="userId" value="${htmlEscape(id)}"/>
            <button class="btn2 btnDanger" type="submit" ${isSelf ? "disabled" : ""}>Eliminar</button>
          </form>
        </td>
      </tr>
    `;
  }).join("");

  return pageShell({
    title: "Usuarios · Asisto",
    user,
    body: `
    <div class="app">
      <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:10px">
        <div>
          <h2 style="margin:0 0 6px">Usuarios</h2>
          <div class="small">Alta/baja, edición de tenant/rol y bloqueo de cuentas (colección <code>users</code>).</div>
          <div class="small">Reglas: <strong>admin</strong> gestiona sólo su tenant; <strong>superadmin</strong> puede gestionar todos.</div>
        </div>
        <a class="btn2" href="/app" style="text-decoration:none">Volver</a>
      </div>

      ${message}
      ${error}

      <div class="card" style="margin-top:14px">
        <h2 style="font-size:18px; margin:0 0 10px">Dar de alta usuario</h2>
        <form method="POST" action="/admin/users/create">
          <div class="row">
            <div style="flex:1" class="field">
              <label>Usuario</label>
              <input name="username" required placeholder="ej: tenai"/>
            </div>
            <div style="flex:1" class="field">
              <label>Contraseña</label>
              <input name="password" type="password" required placeholder="••••••••"/>
            </div>
          </div>
          <div class="row">
            <div style="flex:1" class="field">
              <label>Tenant</label>
              ${createTenantField}
            </div>
            <div style="flex:1" class="field">
              <label>Rol</label>
              <select name="role">
                ${roleOptionsForCreate}
              </select>
            </div>
          </div>
          <div class="field">
            <label style="display:flex; align-items:center; gap:10px">
              <input type="checkbox" name="isLocked" value="1" style="width:auto"/>
              Crear como “bloqueado” (no podrá iniciar sesión)
            </label>
          </div>
          <button class="btn" type="submit">Crear usuario</button>
          <div class="small" style="margin-top:10px">Tip: el <code>tenantId</code> del usuario define el tenant de los endpoints (salvo <code>superadmin</code>).</div>
        </form>
      </div>

      <div class="card" style="margin-top:14px">
        <h2 style="font-size:18px; margin:0 0 10px">Listado</h2>
        <table>
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Tenant</th>
              <th>Rol</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="5" class="small">No hay usuarios cargados.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    `,
  });
}


// ===== Routes mounting =====
function mountAuthRoutes(app) {
  // login
  app.get("/login", (req, res) => {
    const to = req.query?.to || "/app";
    return res.status(200).send(loginPage({ to }));
  });

  app.post("/login", async (req, res) => {
    try {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      const to = String(req.body?.to || req.query?.to || "/app");

      if (!username || !password) return res.status(400).send(loginPage({ error: "Completa usuario y contraseña.", to }));

      const db = await getDb();
      const user = await db.collection("users").findOne({ username });
      if (!user) return res.status(401).send(loginPage({ error: "Usuario o contraseña inválidos.", to }));

      
if (!verifyPassword(password, user.password)) {
        return res.status(401).send(loginPage({ error: "Usuario o contraseña inválidos.", to }));
      }

      // Si está bloqueado, no permitimos login aunque la contraseña sea correcta.
      if (user.isLocked) {
        return res.status(403).send(loginPage({ error: "Usuario bloqueado. Contactá al administrador.", to }));
      }

      const payload = makeSessionPayload(user);
      setSessionCookie(res, payload);
      return res.redirect(to.startsWith("/") ? to : "/app");
    } catch (e) {
      console.error("[auth] login error:", e);
      return res.status(500).send(loginPage({ error: "Error interno de login.", to: "/app" }));
    }
  });

  app.post("/logout", (req, res) => {
    clearSessionCookie(res);
    return res.redirect("/login");
  });

  // menú
  app.get("/app", requireAuth, (req, res) => {
    const routes = [
      { title: "Inbox", href: "/admin/inbox", badge: "Admin UI", desc: "Bandeja de conversaciones" },
      { title: "Panel Admin", href: "/admin", badge: "Admin UI", desc: "Dashboard y herramientas" },
      { title: "Productos", href: "/productos", badge: "UI", desc: "Catálogo del tenant" },
      { title: "Horarios", href: "/horarios", badge: "UI", desc: "Configuración de horarios" },
      { title: "Comportamiento", href: "/comportamiento", badge: "UI", desc: "Behavior prompt/config" },
      { title: "Logs Conversaciones", href: "/api/logs/conversations", badge: "API", desc: "Listado de conversaciones" },
      { title: "Logs Mensajes", href: "/api/logs/messages", badge: "API", desc: "Mensajes por conversación" },
      { title: "Behavior API", href: "/api/behavior", badge: "API", desc: "Get/Set behavior" },
      { title: "Hours API", href: "/api/hours", badge: "API", desc: "Get/Set store hours" },
      { title: "Products API", href: "/api/products", badge: "API", desc: "CRUD de productos" },
    ];
    return res.status(200).send(appMenuPage({ user: req.user, routes }));
  });

  // Admin usuarios
  app.get("/admin/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      
const isSuper = String(req.user?.role || "") === "superadmin";
const filter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };
// Admin ve sólo su tenant. Superadmin ve todo.
const users = await db.collection("users").find(filter).sort({ createdAt: -1 }).toArray();
      const msg = req.query?.msg ? String(req.query.msg) : "";
      const err = req.query?.err ? String(req.query.err) : "";
      return res.status(200).send(usersAdminPage({ user: req.user, users, msg, err }));
    } catch (e) {
      console.error("[auth] users list error:", e);
      return res.status(500).send(usersAdminPage({ user: req.user, users: [], err: "Error leyendo usuarios." }));
    }
  });

  app.post("/admin/users/create", requireAuth, requireAdmin, async (req, res) => {
    try {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      const tenantId = String(req.body?.tenantId || "").trim() || "default";
      
const role = String(req.body?.role || "user").trim();
const isLocked = !!req.body?.isLocked;

const actorRole = String(req.user?.role || "");
const actorTenant = String(req.user?.tenantId || "default");

      if (!username || !password) return res.redirect("/admin/users?err=" + encodeURIComponent("Faltan datos."));
      if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
        return res.redirect("/admin/users?err=" + encodeURIComponent("Usuario inválido (3-40, letras/números ._-)."));
      }
      if (password.length < 4) return res.redirect("/admin/users?err=" + encodeURIComponent("Contraseña muy corta (mín 4)."));

      const db = await getDb();
      const exists = await db.collection("users").findOne({ username });
      if (exists) return res.redirect("/admin/users?err=" + encodeURIComponent("El usuario ya existe."));

      
// Reglas:
// - admin: sólo puede crear usuarios en su tenant y no puede crear superadmin
// - superadmin: puede elegir tenant/rol libremente
let finalTenantId = tenantId || "default";
let finalRole = ["user", "admin", "superadmin"].includes(role) ? role : "user";

if (actorRole !== "superadmin") {
  finalTenantId = actorTenant;
  if (finalRole === "superadmin") finalRole = "admin";
}

const passwordDoc = hashPassword(password);
      
await db.collection("users").insertOne({
  username,
  tenantId: finalTenantId,
  role: finalRole,
  isLocked: !!isLocked,
  password: passwordDoc,
  createdAt: new Date(),
  updatedAt: new Date(),
});

      return res.redirect("/admin/users?msg=" + encodeURIComponent("Usuario creado."));
    } catch (e) {
      console.error("[auth] users create error:", e);
      return res.redirect("/admin/users?err=" + encodeURIComponent("Error creando usuario."));
    }
  });

  app.post("/admin/users/update", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const tenantId = String(req.body?.tenantId || "").trim();
    const role = String(req.body?.role || "").trim();
    const isLocked = !!req.body?.isLocked;

    if (!ObjectId.isValid(userId)) return res.redirect("/admin/users?err=" + encodeURIComponent("userId inválido."));
    if (String(req.user?.uid) === userId) {
      return res.redirect("/admin/users?err=" + encodeURIComponent("No se permite editar tu propio rol/tenant/bloqueo."));
    }

    const db = await getDb();

    const actorRole = String(req.user?.role || "");
    const actorTenant = String(req.user?.tenantId || "default");

    const target = await db.collection("users").findOne(
      { _id: new ObjectId(userId) },
      { projection: { role: 1, tenantId: 1, username: 1 } }
    );
    if (!target) return res.redirect("/admin/users?err=" + encodeURIComponent("Usuario no encontrado."));

    // Permisos
    if (actorRole !== "superadmin") {
      if (String(target.tenantId || "") !== actorTenant) {
        return res.redirect("/admin/users?err=" + encodeURIComponent("No autorizado para ese tenant."));
      }
      if (String(target.role || "") === "superadmin") {
        return res.redirect("/admin/users?err=" + encodeURIComponent("No podés modificar un superadmin."));
      }
    }

    // Normalización + restricciones
    let finalTenantId = String(target.tenantId || "default");
    let finalRole = String(target.role || "user");

    if (actorRole === "superadmin") {
      if (tenantId) finalTenantId = tenantId;
      if (["user", "admin", "superadmin"].includes(role)) finalRole = role;
    } else {
      // admin: tenant fijo y sin superadmin
      if (["user", "admin"].includes(role)) finalRole = role;
    }

    await db.collection("users").updateOne(
      { _id: new ObjectId(userId) },
      { $set: { tenantId: finalTenantId, role: finalRole, isLocked: !!isLocked, updatedAt: new Date() } }
    );

    return res.redirect("/admin/users?msg=" + encodeURIComponent("Usuario actualizado."));
  } catch (e) {
    console.error("[auth] update user error:", e);
    return res.redirect("/admin/users?err=" + encodeURIComponent("Error actualizando usuario."));
  }
});

app.post("/admin/users/reset-password", requireAuth, requireAdmin, async (req, res) => {
    try {
      const userId = String(req.body?.userId || "").trim();
      const newPassword = String(req.body?.newPassword || "");
      if (!ObjectId.isValid(userId)) return res.redirect("/admin/users?err=" + encodeURIComponent("userId inválido."));
      if (newPassword.length < 4) return res.redirect("/admin/users?err=" + encodeURIComponent("Contraseña muy corta (mín 4)."));

      
const db = await getDb();

const actorRole = String(req.user?.role || "");
const actorTenant = String(req.user?.tenantId || "default");
const target = await db.collection("users").findOne(
  { _id: new ObjectId(userId) },
  { projection: { role: 1, tenantId: 1 } }
);

if (!target) return res.redirect("/admin/users?err=" + encodeURIComponent("Usuario no encontrado."));
if (actorRole !== "superadmin") {
  if (String(target.tenantId || "") !== actorTenant) {
    return res.redirect("/admin/users?err=" + encodeURIComponent("No autorizado para ese tenant."));
  }
  if (String(target.role || "") === "superadmin") {
    return res.redirect("/admin/users?err=" + encodeURIComponent("No podés modificar un superadmin."));
  }
}

const passwordDoc = hashPassword(newPassword);
      await db.collection("users").updateOne(
        { _id: new ObjectId(userId) },
        { $set: { password: passwordDoc, updatedAt: new Date() } }
      );

      return res.redirect("/admin/users?msg=" + encodeURIComponent("Contraseña actualizada."));
    } catch (e) {
      console.error("[auth] reset password error:", e);
      return res.redirect("/admin/users?err=" + encodeURIComponent("Error reseteando contraseña."));
    }
  });

  app.post("/admin/users/delete", requireAuth, requireAdmin, async (req, res) => {
    try {
      const userId = String(req.body?.userId || "").trim();
      if (!ObjectId.isValid(userId)) return res.redirect("/admin/users?err=" + encodeURIComponent("userId inválido."));
      // Evitar auto-borrado
      if (String(req.user?.uid) === userId) {
        return res.redirect("/admin/users?err=" + encodeURIComponent("No podés eliminar tu propio usuario."));
      }

      
const db = await getDb();

const actorRole = String(req.user?.role || "");
const actorTenant = String(req.user?.tenantId || "default");

const target = await db.collection("users").findOne(
  { _id: new ObjectId(userId) },
  { projection: { role: 1, tenantId: 1, username: 1 } }
);
if (!target) return res.redirect("/admin/users?err=" + encodeURIComponent("Usuario no encontrado."));

if (actorRole !== "superadmin") {
  if (String(target.tenantId || "") !== actorTenant) {
    return res.redirect("/admin/users?err=" + encodeURIComponent("No autorizado para ese tenant."));
  }
  if (String(target.role || "") === "superadmin") {
    return res.redirect("/admin/users?err=" + encodeURIComponent("No podés eliminar un superadmin."));
  }
}

await db.collection("users").deleteOne({ _id: new ObjectId(userId) });
      return res.redirect("/admin/users?msg=" + encodeURIComponent("Usuario eliminado."));
    } catch (e) {
      console.error("[auth] delete user error:", e);
      return res.redirect("/admin/users?err=" + encodeURIComponent("Error eliminando usuario."));
    }
  });
}

// Middleware protector por prefijo
function protectRoutes(app) {
  app.use((req, res, next) => {
    const p = req.path || "";
    // Rutas públicas
    if (
      p === "/" ||
      p === "/healthz" ||
      p === "/login" ||
      p === "/logout" ||
      p.startsWith("/static/") ||
      p.startsWith("/webhook") ||
      p.startsWith("/cache/")
    ) return next();

    // Rutas que queremos con login
    const protectedPrefixes = ["/admin", "/api"];
    const protectedExact = ["/app", "/productos", "/horarios", "/comportamiento"];

    if (protectedExact.includes(p) || protectedPrefixes.some(pref => p.startsWith(pref))) {
      return requireAuth(req, res, next);
    }
    return next();
  });
}

module.exports = {
  attachUser,
  requireAuth,
  requireAdmin,
  mountAuthRoutes,
  protectRoutes,
  resolveTenantId,
  hashPassword,
  verifyPassword,
};
