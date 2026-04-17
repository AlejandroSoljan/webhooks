// auth_ui.js
// Login + sesiones firmadas + menú (/app) + administración de usuarios (/admin/users)
// Requiere MongoDB (getDb) y la colección "users".
//
// Documento esperado en "users":
// { username, role: 'admin'|'user'|'superadmin', tenantId, password: { salt, hash }, createdAt, allowedPages?, defaultPage? }
//
// allowedPages:
//   - undefined / no existe el campo => acceso completo (compatibilidad)
//   - [] => sin acceso
//   - ["admin","inbox",...] => acceso restringido a esas keys

const crypto = require("crypto");
const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://www.asistobot.com.ar"; // ej: https://tudominio.com


const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "asisto_sess";
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || "dev-unsafe-secret-change-me";

// ===== Body parsers (para endpoints JSON del panel) =====
// Nota: muchos endpoints del panel (/api/wweb/*) usan JSON.
// Si el app principal no tiene express.json(), req.body llega vacío y se rompe (ej: lockId inválido).
function ensureBodyParsers(app) {
  if (app.__asistoBodyParsersMounted) return;
  app.__asistoBodyParsersMounted = true;
  try {
    app.use(express.urlencoded({ extended: true }));
  } catch {}
  try {
    app.use(express.json({ limit: "2mb" }));
  } catch {}
}

// ===== Accesos por usuario (pantallas/endpoints) =====
const ACCESS_PAGES = [
  { key: "admin", title: "Conversaciones" },
  { key: "inbox", title: "Inbox" },
  { key: "productos", title: "Productos" },
  { key: "horarios", title: "Horarios" },
  { key: "comportamiento", title: "Comportamiento" },
  { key: "leads", title: "Leads" },
  { key: "wweb", title: "Sesiones WhatsApp Web" },
  { key: "users", title: "Usuarios" },
  { key: "tenant_config", title: "Tenant Config" },
];

function normalizeAllowedPages(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const clean = arr.map((v) => String(v || "").trim()).filter(Boolean);
  const allowedKeys = new Set(ACCESS_PAGES.map((p) => p.key));
  return clean.filter((k) => allowedKeys.has(k));
}

function hasAccess(user, ...keys) {
  const role = String(user?.role || "").toLowerCase();
  if (role === "superadmin") return true;

  // compat: si el campo no existe => acceso completo
  const hasField = user && Object.prototype.hasOwnProperty.call(user, "allowedPages");
  if (!hasField) return true;

  // si existe pero no es array => compat: acceso completo
  if (!Array.isArray(user.allowedPages)) return true;

  const pages = user.allowedPages;
  if (pages.length === 0) return false;
  return keys.some((k) => pages.includes(k));
}

// Devuelve qué "keys" de acceso requiere una ruta
function requiredAccessForPath(p) {
  const path = String(p || "");
  if (path === "/app") return [];

  // Admin de usuarios
  if (path.startsWith("/admin/users")) return ["users"];
  // Tenant Config
  if (path.startsWith("/admin/tenant-config") || path.startsWith("/api/tenant-config")) return ["tenant_config"];
  // Leads (contacto)
  if (path.startsWith("/admin/leads")) return ["leads"];

  // Sesiones WhatsApp Web (whatsapp-web.js)
  if (path.startsWith("/admin/wweb") || path.startsWith("/api/wweb")) return ["wweb"];

  // UI wrapper
  if (path.startsWith("/ui/")) {
    const seg = path.split("/")[2] || "";
    if (["admin", "inbox", "productos", "horarios", "comportamiento", "tenant_config"].includes(seg)) return [seg];
  }

  // Pantallas directas
  if (path === "/admin" || path.startsWith("/admin/conversation") || path.startsWith("/admin/ticket")) return ["admin"];
  if (path.startsWith("/admin/inbox")) return ["inbox"];
   if (path.startsWith("/api/leads")) return ["leads"];
  if (path === "/productos" || path.startsWith("/api/products")) return ["productos"];
  if (path === "/horarios" || path.startsWith("/api/hours")) return ["horarios"];
  if (path === "/comportamiento" || path.startsWith("/api/behavior")) return ["comportamiento"];

  // Logs
  if (path.startsWith("/api/logs/conversations") || path.startsWith("/api/logs/pedido")) return ["admin"];
  if (path.startsWith("/api/logs/messages")) return ["inbox"];
  if (path.startsWith("/api/media")) return ["inbox"];


  // Leads / contacto desde /login
  if (path.startsWith("/api/leads")) return ["admin"];

  // Acciones admin (entrega, enviar mensaje, etc.)
  if (path.startsWith("/api/admin/")) return ["admin", "inbox"];

  return [];
}

// ===== utils cookie signing =====
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

// ===== session =====
function makeSessionPayload(user) {
  return {
    uid: String(user._id),
    username: String(user.username),
    role: String(user.role || "user"),
    tenantId: String(user.tenantId || "default"),
    allowedPages: Array.isArray(user.allowedPages) ? user.allowedPages : undefined,
    defaultPage: String(user?.defaultPage || "/app"),
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

    // refresca desde DB para cambios inmediatos
    const db = await getDb();
    let userDoc = null;

    const uid = String(sess.uid || "").trim();
    if (ObjectId.isValid(uid)) {
      userDoc = await db.collection("users").findOne(
        { _id: new ObjectId(uid) },
        { projection: { username: 1, role: 1, tenantId: 1, allowedPages: 1, defaultPage: 1, isLocked: 1 } }
      );
    }

    // fallback por username
    if (!userDoc && sess.username) {
      userDoc = await db.collection("users").findOne(
        { username: String(sess.username) },
        { projection: { username: 1, role: 1, tenantId: 1, allowedPages: 1, defaultPage: 1, isLocked: 1 } }
      );
    }

    if (!userDoc || userDoc.isLocked) {
      req.user = null;
      try {
        clearSessionCookie(res);
      } catch {}
      return next();
    }

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

  const pick = req.query?.tenant || req.headers?.["x-tenant-id"] || envTenantId || defaultTenantId;
  const picked = (pick || defaultTenantId).toString().trim();

  if (role === "superadmin") return picked;
  if (userTenant) return userTenant;
  return picked;
}

// ===== HTML helpers =====
function htmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function absUrl(baseUrl, path) {
  const b = String(baseUrl || "").trim();
  const p = String(path || "/").startsWith("/") ? String(path || "/") : `/${path}`;
  if (b) return b.replace(/\/+$/g, "") + p;
  return p; // fallback relativo
}

function pageShell({ title, user, body, head = "", robots = "", showSidebarToggle = false }) {
  const u = user ? `${htmlEscape(user.username)} · ${htmlEscape(user.tenantId)} · ${htmlEscape(user.role)}` : "";
  // Importante para SEO:
  // - si hay user => pantalla privada => noindex
  // - si NO hay user => por defecto index (a menos que se pase robots explícito)
  const robotsMeta =
    robots
      ? `<meta name="robots" content="${htmlEscape(robots)}"/>`
      : (user ? `<meta name="robots" content="noindex,nofollow"/>` : `<meta name="robots" content="index,follow"/>`);

  
  
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${htmlEscape(title || "Asisto")}</title>
   ${robotsMeta}
  ${head || ""}
 
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
      gap:12px;
      padding: 16px 18px;
      background: rgba(8,16,28,.20);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid rgba(255,255,255,.06);
    }
    .topbarLeft,.topbarRight{display:flex;align-items:center;gap:10px;min-width:0;}
    .topbarRight{margin-left:auto;}
    .pill{display:inline-flex; gap:10px; align-items:center; color:rgba(255,255,255,.86); font-size:13px; min-width:0}
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
.actionsWrap{
      display:flex;
      flex-wrap:wrap;
      gap:6px;
      justify-content:flex-end;
    }
    .btnDanger{border-color: rgba(240,68,56,.32); color:#b42318}
    .btnOk{border-color: rgba(14,107,102,.28); color: var(--primary)}
    .small{font-size:12px; color:#667085}

    /* ===== App layout (sidebar) ===== */
    .layout{
      width:min(1400px, 100%);
      margin: 0 auto;
      padding: 22px;
      display:flex;
      gap: 18px;
      align-items: stretch;
      transition: gap .18s ease;
    }
    .layout > .sidebar{
      flex:0 0 260px;
      transition: flex-basis .18s ease, width .18s ease, opacity .18s ease, padding .18s ease, margin .18s ease, border-color .18s ease;
    }
    body.sidebarCollapsed .layout{gap:0;}
    body.sidebarCollapsed .layout > .sidebar{
      flex-basis:0;
      width:0;
      min-width:0;
      padding:0;
      margin:0;
      border-color:transparent;
      opacity:0;
      overflow:hidden;
      pointer-events:none;
    }
    
    /* ===== Mobile drawer ===== */
    .menuBtn{
      display:none;
      border:1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.08);
      color:#fff;
      border-radius: 12px;
      padding: 8px 10px;
      font-size:18px;
      cursor:pointer;
    }
    .sidebarToggleBtn{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      border:1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.08);
      color:#fff;
      border-radius: 12px;
      padding: 8px 12px;
      font-size:13px;
      font-weight:700;
      cursor:pointer;
      white-space:nowrap;
    }
    .sidebarToggleBtn .icon{font-size:16px; line-height:1;}
    body.sidebarCollapsed .sidebarToggleBtn .when-open{display:none;}
    body:not(.sidebarCollapsed) .sidebarToggleBtn .when-closed{display:none;}

    .drawerBackdrop{
      position:fixed;
      inset:0;
      background: rgba(0,0,0,.45);
      display:none;
      z-index:2000;
    }
    .drawer{
      position:fixed;
      top:0; bottom:0; left:0;
      width: min(320px, 86vw);
      transform: translateX(-110%);
      transition: transform .18s ease;
      z-index:2001;
      padding: 14px;
    }
    /* el aside real está dentro, lo dejamos ocupar */
    .sidebar--drawer{
      width:100%;
      position:static;
      top:auto;
      height: auto;
      max-height: calc(100vh - 28px);
    }

    body.drawerOpen{ overflow:hidden; }
    body.drawerOpen .drawerBackdrop{ display:block; }
    body.drawerOpen .drawer{ transform: translateX(0); }

    @media (max-width: 980px){
      .menuBtn{ display:inline-flex; align-items:center; justify-content:center; }
      .sidebarToggleBtn{ display:none; }
      .layout{ padding: 14px; }
      /* ocultamos el sidebar “fijo” del layout en mobile */
      .layout > .sidebar{ display:none; }
      /* el drawer sí se usa */
      .drawer{ display:block; }
    }

    @media (min-width: 981px){
      /* en desktop no necesitamos drawer */
      .drawerBackdrop, .drawer{ display:none; }
    }
    .sidebar{
      width: 260px;
      border-radius: var(--radius);
      background: rgba(255,255,255,.06);
      border:1px solid rgba(255,255,255,.10);
      backdrop-filter: blur(10px);
      padding: 14px;
      position: sticky;
      top: 88px;
      height: calc(100vh - 110px);
      overflow:auto;
    }
    .sideBrand{
      display:flex;
      align-items:center;
      gap:10px;
      padding: 8px 8px 12px;
      border-bottom: 1px solid rgba(255,255,255,.10);
      margin-bottom: 12px;
    }
    .sideBrand img{width:34px;height:34px;object-fit:contain; filter: drop-shadow(0 6px 12px rgba(0,0,0,.25));}
    .sideTitle{font-weight:800; letter-spacing:.2px;}
    .sideSub{font-size:12px; color: rgba(255,255,255,.70); margin-top:2px;}
    .nav{display:flex; flex-direction:column; gap:6px; padding: 4px 0;}
    .navItem{
      display:flex;
      align-items:center;
      gap:10px;
      padding: 10px 10px;
      border-radius: 12px;
      text-decoration:none;
      color: rgba(255,255,255,.86);
      border:1px solid transparent;
    }
    .navItem:hover{background: rgba(255,255,255,.08)}
    .navItem.active{
      background: rgba(255,255,255,.12);
      border-color: rgba(255,255,255,.14);
      color:#fff;
    }
    .navDot{
      width: 10px; height: 10px; border-radius: 999px;
      background: rgba(255,255,255,.26);
      border: 1px solid rgba(255,255,255,.18);
      flex:0 0 auto;
    }
    .navItem.active .navDot{background: rgba(0,210,160,.75); border-color: rgba(0,210,160,.65);}
    .main{flex:1; min-width:0;}
    .frameWrap{
      background: rgba(255,255,255,.94);
      border: 1px solid rgba(16,24,40,.10);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow:hidden;
    }
    .frameHead{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      padding: 16px 18px;
      background: rgba(255,255,255,.88);
      border-bottom:1px solid rgba(16,24,40,.08);
      color:#0b1726;
    }
    .frameHead h2{
      margin:0;
      font-size:20px;
      line-height:1.1;
    }
    .frameHead p{
      margin:4px 0 0;
      font-size:13px;
      color:#667085;
    }
    .frameHead .badge{
      background: rgba(14,107,102,.10);
      color: var(--primary);
      border-color: rgba(14,107,102,.18);
    }
    .frame{
      width:100%;
      height: calc(100vh - 206px);
      border:0;
      background:#fff;
      display:block;
    }

    .homeShell{
      min-height: calc(100vh - 150px);
      display:flex;
      align-items:center;
      justify-content:center;
      padding: 10px 0;
    }
    .homeCard{
      width:min(860px, 100%);
      background: rgba(255,255,255,.92);
      color:#0b1726;
      border-radius: 26px;
      border:1px solid rgba(16,24,40,.10);
      box-shadow: var(--shadow);
      padding: 34px 28px;
      text-align:center;
      position:relative;
      overflow:hidden;
    }
    .homeCard::before{
      content:"";
      position:absolute;
      inset:-120px auto auto -120px;
      width:280px;
      height:280px;
      border-radius:999px;
      background: radial-gradient(circle, rgba(14,107,102,.14), transparent 68%);
      pointer-events:none;
    }
    .homeCard::after{
      content:"";
      position:absolute;
      inset:auto -120px -120px auto;
      width:260px;
      height:260px;
      border-radius:999px;
      background: radial-gradient(circle, rgba(33,140,255,.12), transparent 70%);
      pointer-events:none;
    }
    .homeLogoWrap{
      position:relative;
      z-index:1;
      display:flex;
      justify-content:center;
      margin-bottom: 18px;
    }
    .homeLogoHalo{
      width: 190px;
      height: 190px;
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(14,107,102,.12), rgba(33,140,255,.10));
      display:flex;
      align-items:center;
      justify-content:center;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.7);
    }
    .homeLogo{
      width: 116px;
      height: 116px;
      object-fit:contain;
      filter: drop-shadow(0 10px 18px rgba(0,0,0,.18));
    }
    .homeEyebrow{
      position:relative;
      z-index:1;
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(14,107,102,.08);
      color: var(--primary);
      border:1px solid rgba(14,107,102,.14);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .02em;
      margin-bottom: 12px;
    }
    .homeTitle{
      position:relative;
      z-index:1;
      margin:0;
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1.04;
      color:#0b1726;
    }
    .homeLead{
      position:relative;
      z-index:1;
      max-width: 620px;
      margin: 12px auto 0;
      color:#52606d;
      font-size: 15px;
      line-height: 1.6;
    }
    .homeHint{
      position:relative;
      z-index:1;
      margin: 20px auto 0;
      max-width: 680px;
      background: rgba(11,23,38,.04);
      border:1px solid rgba(16,24,40,.08);
      border-radius: 18px;
      padding: 16px 18px;
    }
    .homeHintTitle{
      margin:0 0 8px;
      font-size: 14px;
      font-weight: 800;
      color:#0f2741;
    }
    .homeHintText{
      margin:0;
      font-size: 14px;
      color:#52606d;
      line-height:1.55;
    }
    .homeAccess{
      position:relative;
      z-index:1;
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      justify-content:center;
      margin-top: 20px;
    }
    .homeAccess .badge{
      font-size: 12px;
      padding: 8px 12px;
      background: rgba(14,107,102,.08);
      color: var(--primary);
      border:1px solid rgba(14,107,102,.14);
    }
    .homeMeta{
      position:relative;
      z-index:1;
      margin-top: 18px;
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      justify-content:center;
    }
    .homeMetaItem{
      font-size: 12px;
      color:#667085;
      background:#fff;
      border:1px solid rgba(16,24,40,.08);
      border-radius:999px;
      padding:7px 11px;
    }

    @media (max-width: 980px){
      .homeShell{ min-height: auto; padding: 4px 0 10px; }
      .homeCard{ padding: 26px 18px; border-radius: 22px; }
      .frame{ height: calc(100vh - 240px); }
      .frameHead{
        padding: 14px 16px;
        align-items:flex-start;
        flex-direction:column;
      }
    }


      .msg.ok{border-color: rgba(70, 200, 140, .35); background: rgba(70, 200, 140, .10)}

      /* ===== /login (clean 50/50) ===== */
      .lpTop{max-width:1100px; margin:0 auto 18px; display:flex; align-items:center; justify-content:flex-end; gap:16px}
 
      .lpBrand img{width:36px; height:36px; border-radius:10px}
      .lpNav{display:flex; gap:14px; align-items:center; flex-wrap:wrap}
      .lpNav a{color:rgba(255,255,255,.85); text-decoration:none; font-size:14px}
      .lpNav a:hover{color:#fff}
      .lpCta{padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.06)}
      .lpCta:hover{background: rgba(255,255,255,.10)}

      .lpMain{
        max-width:1100px;
        margin:0 auto;
        display:grid;
        grid-template-columns: 1fr 1fr;
        gap:22px;
      align-items:stretch;
      }
      .lpLeft{
        border-radius: 18px;
        border:1px solid rgba(255,255,255,.10);
        background: rgba(255,255,255,.05);
        display:flex;
        align-items:center;
        justify-content:center;
        padding: 24px;
        overflow:hidden;
      }
      
      .lpLogo{
        width: min(420px, 70%);
        height:auto;
        object-fit:contain;
        filter: drop-shadow(0 10px 18px rgba(0,0,0,.28));
      }
      
      .lpRight{
        display:flex;
        align-items:stretch;
        justify-content:center;
        padding: 10px;
      }
      .lpRight .card{
        width: min(460px, 100%);
         height:100%;
        display:flex;
        flex-direction:column;
        justify-content:center;
      }
      

      .lpSection{max-width:1100px; margin:18px auto 0; padding:18px; border-radius:18px; border:1px solid rgba(255,255,255,.12); background: rgba(0,0,0,.10)}
      .lpSection h2{margin:0 0 10px; color:#fff; font-size:22px}
      .lpLeadSmall{margin:0 0 14px; color:rgba(255,255,255,.78)}
      .lpContact{display:block}
      .lpForm textarea{width:100%; resize:vertical}
      .lpRow{display:grid; grid-template-columns: 1fr 1fr; gap:12px}
      .lpFooter{max-width:1100px; margin:18px auto 0; padding:14px 6px; color:rgba(255,255,255,.55); font-size:12px; text-align:center}

      @media (max-width: 980px){
        .lpMain{grid-template-columns:1fr; min-height:auto}
        .lpLeft{min-height:240px}
        .lpRow{grid-template-columns:1fr}
        
      }
  
        .wa-actions-cell{position:relative; overflow:visible}
        .wa-actions-wrap{position:relative; display:inline-block}
        .wa-actions-menu{
          position:absolute;
          top:calc(100% + 6px);
          right:0;
          min-width:180px;
          z-index:2500;
          background:#fff;
          border:1px solid rgba(148,163,184,.28);
          border-radius:14px;
          box-shadow:0 18px 40px rgba(15,23,42,.18);
          padding:8px;
        }
        .wa-actions-menu.up{
          top:auto;
          bottom:calc(100% + 6px);
        }
        .wa-actions-menu[hidden]{display:none !important}
        .wa-actions-menu button{
          width:100%;
          text-align:left;
          justify-content:flex-start;
        }
        body.dark .wa-actions-menu{
          background:#111827;
          border-color:rgba(148,163,184,.22);
          box-shadow:0 18px 40px rgba(0,0,0,.35);
        }

</style>
</head>
<body>
  ${user ? `
  <div class="topbar">
    <div class="topbarLeft">
      <button type="button" class="menuBtn" id="menuBtn" aria-label="Abrir menú">☰</button>
      ${showSidebarToggle ? `<button type="button" class="sidebarToggleBtn" id="sidebarToggleBtn" aria-label="Ocultar menú lateral" title="Ocultar menú lateral"><span class="icon">☰</span><span class="when-open">Ocultar menú</span><span class="when-closed">Mostrar menú</span></button>` : ``}
      <div class="pill">
        <img src="/static/logo.png" alt="Asisto" style="width:28px;height:28px;object-fit:contain"/>
        <strong>Asisto</strong>
        <span>·</span>
        <span>${u}</span>
      </div>
    </div>
    <div class="topbarRight">
      <form method="POST" action="/logout" style="margin:0">
        <button class="btn2" type="submit">Cerrar sesión</button>
      </form>
    </div>
  </div>` : ``}
  <div class="${user ? "content" : ""}">
    ${body}
  </div>
  ${user ? `
  <script>
  (function () {
    const btn = document.getElementById("menuBtn");
    const backdrop = document.getElementById("drawerBackdrop");
    const drawer = document.getElementById("drawer");
    const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
    const SIDEBAR_STATE_KEY = "asisto.sidebarCollapsed";

    function openDrawer(){ document.body.classList.add("drawerOpen"); }
    function closeDrawer(){ document.body.classList.remove("drawerOpen"); }
    function toggleDrawer(){
      if (document.body.classList.contains("drawerOpen")) closeDrawer();
      else openDrawer();
    }

    function syncSidebarToggle(){
      if (!sidebarToggleBtn) return;
      const collapsed = document.body.classList.contains("sidebarCollapsed");
      sidebarToggleBtn.setAttribute("aria-label", collapsed ? "Mostrar menú lateral" : "Ocultar menú lateral");
      sidebarToggleBtn.setAttribute("title", collapsed ? "Mostrar menú lateral" : "Ocultar menú lateral");
      sidebarToggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }

    function applySavedSidebarState(){
      if (!sidebarToggleBtn) return;
      try {
        const saved = localStorage.getItem(SIDEBAR_STATE_KEY);
        if (saved === "1") document.body.classList.add("sidebarCollapsed");
        else document.body.classList.remove("sidebarCollapsed");
      } catch (_) {}
      syncSidebarToggle();
    }

    function toggleSidebar(){
      if (!sidebarToggleBtn) return;
      if (window.matchMedia("(max-width: 980px)").matches) {
        toggleDrawer();
        return;
      }
      document.body.classList.toggle("sidebarCollapsed");
      try {
        localStorage.setItem(SIDEBAR_STATE_KEY, document.body.classList.contains("sidebarCollapsed") ? "1" : "0");
      } catch (_) {}
      syncSidebarToggle();
    }

    applySavedSidebarState();

    if (btn && backdrop && drawer) {
      btn.addEventListener("click", toggleDrawer);
      backdrop.addEventListener("click", closeDrawer);
      drawer.addEventListener("click", (e) => { if (e.target.closest("a")) closeDrawer(); });
    }

    if (sidebarToggleBtn) {
      sidebarToggleBtn.addEventListener("click", toggleSidebar);
    }

    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    window.addEventListener("resize", syncSidebarToggle);
  })();
  </script>` : ``}

</body>
</html>`;
}

// ===== App layout (sidebar + content) =====
function getNavItemsForUser(user) {
  const isAdmin = user && (user.role === "admin" || user.role === "superadmin");
  const items = [{ key: "home", title: "Inicio", href: "/app" }];

  if (hasAccess(user, "admin")) items.push({ key: "admin", title: "Conversaciones", href: "/ui/admin" });
  if (hasAccess(user, "productos")) items.push({ key: "productos", title: "Productos", href: "/ui/productos" });
  if (hasAccess(user, "horarios")) items.push({ key: "horarios", title: "Horarios", href: "/ui/horarios" });
  if (hasAccess(user, "comportamiento")) items.push({ key: "comportamiento", title: "Comportamiento", href: "/ui/comportamiento" });

  if (isAdmin && hasAccess(user, "leads")) items.push({ key: "leads", title: "Leads", href: "/admin/leads" });
  if (isAdmin && hasAccess(user, "wweb")) items.push({ key: "wweb", title: "Sesiones WhatsApp Web", href: "/admin/wweb" });
  if (isAdmin && hasAccess(user, "users")) items.push({ key: "users", title: "Usuarios", href: "/admin/users" });
  if (isAdmin && hasAccess(user, "tenant_config")) items.push({ key: "tenant_config", title: "Tenant Config", href: "/ui/tenant_config" });

  return items;
}

function getLandingItemsForUser(user) {
  return getNavItemsForUser(user).filter((it) => it && it.href && it.title);
}

function normalizeDefaultPage(userLike, desiredHref) {
  const items = getLandingItemsForUser(userLike);
  if (!items.length) return "/app";
  const desired = String(desiredHref || "").trim();
  if (!desired) return "/app";
  const match = items.find((it) => it.href === desired);
  return match ? match.href : "/app";
}

function getDefaultPageChoices(userLike) {
  return getLandingItemsForUser(userLike).map((it) => ({
    ...it,
    title: it.key === "users" ? "Sesiones de usuarios" : it.title,
  }));
}

function getDefaultPageTitle(userLike, href) {
  const safeHref = normalizeDefaultPage(userLike, href);
  const items = getDefaultPageChoices(userLike);
  const match = items.find((it) => it.href === safeHref);
  return match ? match.title : "Inicio";
}

function defaultPageOptionsHtml(userLike, selectedHref) {
  const items = getDefaultPageChoices(userLike);
  const safeSelected = normalizeDefaultPage(userLike, selectedHref || "/app");
  return items
    .map((it) => `<option value="${htmlEscape(it.href)}" ${it.href === safeSelected ? "selected" : ""}>${htmlEscape(it.title)}</option>`)
    .join("");
}

function sidebarHtml(user, activeKey) {
  const items = getNavItemsForUser(user)
    .map((it) => {
      const active = it.key === activeKey ? "active" : "";
      return `<a class="navItem ${active}" href="${htmlEscape(it.href)}"><span class="navDot"></span><span>${htmlEscape(
        it.title
      )}</span></a>`;
    })
    .join("");

  return `
    <aside class="sidebar">
      <div class="sideBrand">
        <img src="/static/logo.png" alt="Asisto"/>
        <div>
          <div class="sideTitle">Asisto</div>
          <div class="sideSub">${htmlEscape(user.tenantId)} · ${htmlEscape(user.role)}</div>
        </div>
      </div>
      <nav class="nav">${items}</nav>
    </aside>
  `;
}

function appShell({ title, user, active, main }) {
  return pageShell({
    title,
    user,
    showSidebarToggle: true,
    body: `
    <div class="drawerBackdrop" id="drawerBackdrop"></div>
      <aside class="drawer" id="drawer">
        ${sidebarHtml(user, active).replace('class="sidebar"', 'class="sidebar sidebar--drawer"')}
      </aside>
      <div class="layout">
        ${sidebarHtml(user, active)}
        <main class="main">${main || ""}</main>
      </div>
    `,
  });
}

function loginSeoHead({ baseUrl }) {
  const canonical = absUrl(baseUrl, "/login");
  const ogImage = absUrl(baseUrl, "/static/logo.png");
  // Ajustá el texto si querés apuntar a un nicho (heladería/rotisería/super, etc.)
  const desc = "Asisto Bot, Lo hace por vos.. Asistente con Inteligencia artificial, automatiza tus conversaciones por whatsapp y tu sistema de gestión. Venado Tuerto - Santa Fe - Argentina";
  return `
  <link rel="canonical" href="${htmlEscape(canonical)}"/>
  <meta name="description" content="${htmlEscape(desc)}"/>
  <meta property="og:type" content="website"/>
 <meta property="og:title" content="Asisto — IA - Whatsapp"/>
  <meta property="og:description" content="${htmlEscape(desc)}"/>
  <meta property="og:url" content="${htmlEscape(canonical)}"/>
  <meta property="og:image" content="${htmlEscape(ogImage)}"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <script type="application/ld+json">
 {
    "@context":"https://schema.org",
    "@type":"SoftwareApplication",
    "name":"Asisto",
    "applicationCategory":"BusinessApplication",
   "operatingSystem":"Web",
    "description":"${desc.replace(/"/g, '\\"')}"
  }
  </script>
  `;
}

function loginPage({ error, msg, to, baseUrl }) {
  const err = error ? `<div class="msg err">${htmlEscape(error)}</div>` : "";
  const ok = msg ? `<div class="msg ok">${htmlEscape(msg)}</div>` : "";

  

    return pageShell({
    title: "Login · Asisto",
    user: null,
    // /login es tu página pública principal => indexable
    robots: "index,follow",
    head: loginSeoHead({ baseUrl }),
    body: `
    <div class="lp">
      <header class="lpTop">
        
      
        <nav class="lpNav">
          
        
        </nav>
      </header>

      <main class="lpMain">
        <section class="lpLeft" aria-label="Marca Asisto">
          <div class="lpLogoBox">
            <img class="lpLogo" src="/static/logo.png" alt="Asisto"/>
            
          </div>
        </section>

        <aside class="lpRight" aria-label="Ingreso">
          <div class="card">
            <h2>Iniciar sesión</h2>
            ${ok}
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
        </aside>
      </main>

       

      <section class="lpSection" id="contacto">
        <h2>Contacto</h2>
        <p class="lpLeadSmall">Contanos tu negocio y te contactaremos.</p>
        <div class="lpContact">
          <form class="lpForm" method="POST" action="/contact">
            <div class="lpRow">
              <div class="field">
                <label>Nombre</label>
                <input name="name" placeholder="Tu nombre" required/>
              </div>
              <div class="field">
                <label>Email</label>
                <input name="email" type="email" placeholder="tu@email.com" required/>
              </div>
            </div>
            <div class="lpRow">
              <div class="field">
                <label>Empresa (opcional)</label>
                <input name="company" placeholder="Tu empresa"/>
              </div>
              <div class="field">
                <label>Teléfono (opcional)</label>
                <input name="phone" placeholder="+54 ..."/>
              </div>
            </div>
            <div class="field">
              <label>Mensaje</label>
              <textarea name="message" rows="4" placeholder="Quiero automatizar pedidos por WhatsApp, tengo X sucursales, etc." required></textarea>
            </div>
            <button class="btn" type="submit">Enviar</button>
          </form>
        </div>
      </section>

      <footer class="lpFooter">
        <div>© ${new Date().getFullYear()} Asisto — lo hace por vos...</div>
      </footer>
    </div>
    `,
  });
}

function appMenuPage({ user, routes }) {
  const enabledRoutes = Array.isArray(routes) ? routes.filter((r) => r && r.href && r.href !== "/app") : [];
  const accessBadges = enabledRoutes
    .slice(0, 8)
    .map((r) => `<span class="badge">${htmlEscape(r.title)}</span>`)
    .join("");
  const extraCount = Math.max(0, enabledRoutes.length - 8);

  return appShell({
    title: "Inicio · Asisto",
    user,
    active: "home",
    main: `
    <div class="homeShell">
      <section class="homeCard">
        <div class="homeLogoWrap">
          <div class="homeLogoHalo">
            <img class="homeLogo" src="/static/logo.png" alt="Asisto"/>
          </div>
        </div>

        <div class="homeEyebrow">Panel principal</div>
        <h1 class="homeTitle">Bienvenido, ${htmlEscape(user.username)}</h1>
       

        ${accessBadges ? `
        <div class="homeAccess">
          ${accessBadges}
          ${extraCount > 0 ? `<span class="badge">+${extraCount} más</span>` : ""}
        </div>` : ""}

        <div class="homeMeta">
          <span class="homeMetaItem">Tenant: ${htmlEscape(user.tenantId)}</span>
          <span class="homeMetaItem">Rol: ${htmlEscape(user.role)}</span>
        </div>
      </section>
    </div>
    `,
  });
}

function usersAdminPage({ user, users, msg, err }) {
  const isSuper = String(user?.role || "").toLowerCase() === "superadmin";
  const myTenant = String(user?.tenantId || "default");
  const createEditablePages = ACCESS_PAGES.filter((p) => (isSuper ? true : p.key !== "users"));
  const defaultCreatePages = createEditablePages.filter((p) => p.key !== "users").map((p) => p.key);

  const roleOptionsForCreate = isSuper
    ? `<option value="user">user</option><option value="admin">admin</option><option value="superadmin">superadmin</option>`
    : `<option value="user">user</option><option value="admin">admin</option>`;

  const createTenantField = isSuper
    ? `<input name="tenantId" required placeholder="default"/>`
    : `<input name="tenantId" required value="${htmlEscape(myTenant)}" readonly/>`;

  const createAccessCheckboxes = createEditablePages
    .map((p) => `<label class="small usersPermTag">
      <input type="checkbox" name="allowedPages" value="${p.key}" ${defaultCreatePages.includes(p.key) ? "checked" : ""}/>
      <span>${htmlEscape(p.title)}</span>
    </label>`)
    .join("");

  const defaultCreateUserLike = {
    role: "user",
    tenantId: myTenant,
    allowedPages: defaultCreatePages,
    defaultPage: "/app",
  };

  const safeUsers = Array.isArray(users) ? users : [];
  const userItems = safeUsers.map((u) => {
    const id = String(u?._id || "");
    const username = String(u?.username || "");
    const tenantId = String(u?.tenantId || "");
    const role = String(u?.role || "user");
    const locked = !!u?.isLocked;
    const isSelf = String(user?.uid || "") === id;
    const hasAllowedPagesField = Object.prototype.hasOwnProperty.call(u || {}, "allowedPages");
    const currentPages = Array.isArray(u?.allowedPages)
      ? u.allowedPages
      : hasAllowedPagesField
        ? []
        : ACCESS_PAGES.map((p) => p.key);
    const accessLabel = !hasAllowedPagesField
      ? "Completo (legacy)"
      : currentPages.length
        ? currentPages.map((k) => {
            const def = ACCESS_PAGES.find((p) => p.key === k);
            return def ? (def.key === "users" ? "Sesiones de usuarios" : def.title) : k;
          }).join(", ")
        : "Sin acceso";

    const targetUserLike = {
      role,
      tenantId,
      allowedPages: currentPages,
      defaultPage: String(u?.defaultPage || "/app"),
    };

    return {
      id,
      username,
      tenantId,
      role,
      locked,
      isSelf,
      canEditTenant: isSuper,
      canEditRole: isSuper,
      canEditLock: !isSelf,
      createdAt: u?.createdAt || null,
      updatedAt: u?.updatedAt || null,
      currentPages,
      accessLabel,
      defaultPage: String(u?.defaultPage || "/app"),
      defaultPageTitle: getDefaultPageTitle(targetUserLike, String(u?.defaultPage || "/app")),
    };
  });

  const rows = userItems.map((u) => `
    <tr>
      <td>
        <div style="font-weight:700">${htmlEscape(u.username)}</div>
        <div class="small">${htmlEscape(u.id)}</div>
      </td>
      <td>${htmlEscape(u.tenantId || "-")}</td>
      <td>${htmlEscape(u.role)}</td>
      <td><div class="small" style="color:#111827">${htmlEscape(u.accessLabel)}</div></td>
      <td>${htmlEscape(u.defaultPageTitle)}</td>
      <td>${u.locked ? "Bloqueado" : "Activo"}</td>
      <td class="small">${htmlEscape(String(u.updatedAt || u.createdAt || ""))}</td>
      <td class="actions"><button class="btn2 btnOk" type="button" data-user-edit="${htmlEscape(u.id)}">Editar</button></td>
    </tr>
  `).join("");

  const message = msg ? `<div class="msg ok">${htmlEscape(msg)}</div>` : "";
  const error = err ? `<div class="msg err">${htmlEscape(err)}</div>` : "";

  return appShell({
    title: "Usuarios · Asisto",
    user,
    active: "users",
    main: `
    <style>
      .usersShell{display:flex; flex-direction:column; gap:14px;}
      .usersToolbar{display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap;}
      .usersToolbarActions{display:flex; gap:8px; flex-wrap:wrap; align-items:center;}
      .usersTableWrap{overflow:auto;}
      .usersPermGrid{display:flex; flex-wrap:wrap; gap:10px;}
      .usersPermTag{display:inline-flex;align-items:center;gap:8px;padding:8px 10px;border-radius:999px;background:#f8fafc;border:1px solid rgba(148,163,184,.28);color:#0f172a;}
      .usersPermTag input{width:auto; margin:0;}
      .usersInfoGrid{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:12px;}
      .usersFieldRow{display:flex;flex-direction:column;gap:6px;}
      .usersFieldRow label{font-size:13px;color:#475467;margin:0;}
      .usersFieldRow input,.usersFieldRow select{width:100%;}
      .usersHint{margin-top:6px;padding:10px 12px;border-radius:12px;background:#f8fafc;border:1px solid rgba(148,163,184,.2);}
      .usersModal{position:fixed; inset:0; z-index:80; display:flex; align-items:center; justify-content:center; padding:16px;}
      .usersModal[hidden]{display:none !important;}
      .usersModalBackdrop{position:absolute; inset:0; background:rgba(0,0,0,.55);}
      .usersModalCard{position:relative;width:min(820px, 96vw);max-height:calc(100vh - 32px);overflow:auto;background:#fff;color:#0b1726;border-radius:18px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.35);}
      .usersModalHeader{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:14px;}
      .usersModalTitle{margin:0; font-size:22px;}
      .usersModalFooter{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap;}
      .usersDangerZone{margin-top:14px;padding-top:14px;border-top:1px solid rgba(148,163,184,.24);display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;justify-content:space-between;}
      body.usersModalOpen{overflow:hidden;}
      @media (max-width: 820px){
        .usersInfoGrid{grid-template-columns:1fr;}
        .usersModalCard{padding:14px;}
        .usersModalFooter{flex-direction:column-reverse; align-items:stretch;}
      }
    </style>

    <div class="app appWide usersShell">
      <div class="usersToolbar">
        <div>
          <h2 style="margin:0 0 6px">Usuarios</h2>
          <div class="small">Listado de usuarios del panel. Editá cada cuenta desde un modal y creá nuevas sin salir de esta pantalla.</div>
          <div class="small">Reglas: <strong>admin</strong> gestiona sólo su tenant; <strong>superadmin</strong> puede gestionar todos.</div>
        </div>
        <div class="usersToolbarActions">
          <button class="btn2 btnOk" type="button" id="usersBtnCreate">Nuevo usuario</button>
          <a class="btn2" href="/app" style="text-decoration:none">Volver</a>
        </div>
      </div>

      ${message}
      ${error}

      <div class="card">
        <h2 style="font-size:18px; margin:0 0 12px">Listado</h2>
        <div class="usersTableWrap">
          <table>
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Tenant</th>
                <th>Rol</th>
                <th>Acceso</th>
                <th>Inicio</th>
                <th>Estado</th>
                <th>Actualizado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="8" class="small">No hay usuarios cargados.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="usersModal" id="userCreateModal" hidden>
      <div class="usersModalBackdrop" data-users-close="create"></div>
      <div class="usersModalCard" role="dialog" aria-modal="true" aria-label="Crear usuario">
        <div class="usersModalHeader">
          <div>
            <h3 class="usersModalTitle">Nuevo usuario</h3>
            <div class="small">Creá una nueva cuenta y definí qué pantallas puede abrir al iniciar sesión.</div>
          </div>
          <button class="btn2" type="button" data-users-close="create">Cerrar</button>
        </div>

        <form method="POST" action="/admin/users/create" id="userCreateForm">
          <div class="usersInfoGrid">
            <div class="usersFieldRow">
              <label>Usuario</label>
              <input name="username" required placeholder="ej: juan" />
            </div>
            <div class="usersFieldRow">
              <label>Contraseña</label>
              <input name="password" type="password" required placeholder="••••••••" />
            </div>
            <div class="usersFieldRow">
              <label>Tenant</label>
              ${createTenantField}
            </div>
            <div class="usersFieldRow">
              <label>Rol</label>
              <select name="role">${roleOptionsForCreate}</select>
            </div>
          </div>

          <div class="usersFieldRow" style="margin-top:12px">
            <label style="display:flex; align-items:center; gap:10px">
              <input type="checkbox" name="isLocked" value="1" style="width:auto" />
              <span>Crear como bloqueado</span>
            </label>
          </div>

          <div class="usersFieldRow" style="margin-top:12px">
            <label>Acceso a pantallas</label>
            <div class="usersPermGrid" data-permissions-grid="create">
              ${createAccessCheckboxes}
            </div>
          </div>

          <div class="usersFieldRow" style="margin-top:12px">
            <label>Ventana de inicio</label>
            <select name="defaultPage" data-default-page="create">${defaultPageOptionsHtml(defaultCreateUserLike, "/app")}</select>
            <div class="small">Incluye la opción <strong>Sesiones de usuarios</strong> cuando la cuenta tiene acceso a Usuarios.</div>
          </div>

          <div class="usersHint small">
            El inicio disponible depende de las pantallas marcadas arriba. Si quitás un acceso, la ventana de inicio se ajusta automáticamente.
          </div>

          <div class="usersModalFooter">
            <button class="btn2" type="button" data-users-close="create">Cancelar</button>
            <button class="btn" type="submit">Crear usuario</button>
          </div>
        </form>
      </div>
    </div>

    <div class="usersModal" id="userEditModal" hidden>
      <div class="usersModalBackdrop" data-users-close="edit"></div>
      <div class="usersModalCard" role="dialog" aria-modal="true" aria-label="Editar usuario">
        <div class="usersModalHeader">
          <div>
            <h3 class="usersModalTitle" id="userEditTitle">Editar usuario</h3>
            <div class="small" id="userEditMeta"></div>
          </div>
          <button class="btn2" type="button" data-users-close="edit">Cerrar</button>
        </div>

        <form method="POST" action="/admin/users/update" id="userEditForm">
          <input type="hidden" name="userId" value="" />
          <div class="usersInfoGrid">
            <div class="usersFieldRow">
              <label>Usuario</label>
              <input value="" data-user-edit-username readonly />
            </div>
            <div class="usersFieldRow">
              <label>Tenant</label>
              <input name="tenantId" value="" />
            </div>
            <div class="usersFieldRow">
              <label>Rol</label>
              <select name="role"></select>
            </div>
            <div class="usersFieldRow">
              <label>Ventana de inicio</label>
              <select name="defaultPage" data-default-page="edit"></select>
            </div>
          </div>

          <div class="usersFieldRow" style="margin-top:12px">
            <label style="display:flex; align-items:center; gap:10px">
              <input type="checkbox" name="isLocked" value="1" style="width:auto" />
              <span>Usuario bloqueado</span>
            </label>
          </div>

          <div class="usersFieldRow" style="margin-top:12px">
            <label>Acceso a pantallas</label>
            <div class="usersPermGrid" data-permissions-grid="edit"></div>
          </div>

          <div class="usersHint small" id="userEditHint"></div>

          <div class="usersModalFooter">
            <button class="btn2" type="button" data-users-close="edit">Cancelar</button>
            <button class="btn" type="submit" id="userEditSubmit">Guardar cambios</button>
          </div>
        </form>

        <div class="usersDangerZone">
          <form method="POST" action="/admin/users/reset-password" id="userResetForm" style="display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin:0">
            <input type="hidden" name="userId" value="" />
            <div class="usersFieldRow" style="min-width:220px">
              <label>Nueva contraseña</label>
              <input name="newPassword" placeholder="••••••••" minlength="4" required />
            </div>
            <button class="btn2 btnOk" type="submit">Resetear contraseña</button>
          </form>

          <form method="POST" action="/admin/users/delete" id="userDeleteForm" style="margin:0" onsubmit="return confirm('¿Eliminar este usuario?')">
            <input type="hidden" name="userId" value="" />
            <button class="btn2 btnDanger" type="submit" id="userDeleteBtn">Eliminar usuario</button>
          </form>
        </div>
      </div>
    </div>

    <script>
    (function(){
      const ACCESS_PAGES = [
        { key: "admin", title: "Conversaciones" },
        { key: "inbox", title: "Inbox" },
        { key: "productos", title: "Productos" },
        { key: "horarios", title: "Horarios" },
        { key: "comportamiento", title: "Comportamiento" },
        { key: "leads", title: "Leads" },
        { key: "wweb", title: "Sesiones WhatsApp Web" },
        { key: "users", title: "Sesiones de usuarios" },
        { key: "tenant_config", title: "Tenant Config" },
      ];
      const IS_SUPER = ${isSuper ? "true" : "false"};
      const USERS = ${JSON.stringify(userItems).replace(/</g, '\\u003c')};
      const ROLE_OPTIONS_SUPER = ["user", "admin", "superadmin"];
      const ROLE_OPTIONS_ADMIN = ["user", "admin"];

      const createModal = document.getElementById("userCreateModal");
      const editModal = document.getElementById("userEditModal");
      const createForm = document.getElementById("userCreateForm");
      const editForm = document.getElementById("userEditForm");
      const resetForm = document.getElementById("userResetForm");
      const deleteForm = document.getElementById("userDeleteForm");
      const createBtn = document.getElementById("usersBtnCreate");
      const editTitle = document.getElementById("userEditTitle");
      const editMeta = document.getElementById("userEditMeta");
      const editHint = document.getElementById("userEditHint");
      const editUsername = editForm.querySelector("[data-user-edit-username]");
      const editTenantInput = editForm.querySelector('input[name="tenantId"]');
      const editRoleSelect = editForm.querySelector('select[name="role"]');
      const editLockInput = editForm.querySelector('input[name="isLocked"]');
      const editDefaultPage = editForm.querySelector('[data-default-page="edit"]');
      const editPermGrid = editForm.querySelector('[data-permissions-grid="edit"]');
      const editSubmit = document.getElementById("userEditSubmit");
      const deleteBtn = document.getElementById("userDeleteBtn");

      function esc(str){
        return String(str == null ? "" : str)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }

      function openModal(which){
        const modal = which === "edit" ? editModal : createModal;
        if (!modal) return;
        modal.hidden = false;
        document.body.classList.add("usersModalOpen");
      }

      function closeModal(which){
        const modal = which === "edit" ? editModal : createModal;
        if (!modal) return;
        modal.hidden = true;
        if ((createModal && !createModal.hidden) || (editModal && !editModal.hidden)) return;
        document.body.classList.remove("usersModalOpen");
      }

      function installCloseHandlers(modalName){
        document.querySelectorAll('[data-users-close="' + modalName + '"]').forEach((el) => {
          el.addEventListener("click", () => closeModal(modalName));
        });
      }

      function getRoleOptions(){
        return IS_SUPER ? ROLE_OPTIONS_SUPER : ROLE_OPTIONS_ADMIN;
      }

      function getEditablePages(){
        return ACCESS_PAGES.filter((page) => IS_SUPER ? true : page.key !== "users");
      }

      function buildDefaultPageOptions(allowedKeys, selectedHref){
        const items = [{ key: "home", title: "Inicio", href: "/app" }];
        if (allowedKeys.includes("admin")) items.push({ key: "admin", title: "Conversaciones", href: "/ui/admin" });
        if (allowedKeys.includes("productos")) items.push({ key: "productos", title: "Productos", href: "/ui/productos" });
        if (allowedKeys.includes("horarios")) items.push({ key: "horarios", title: "Horarios", href: "/ui/horarios" });
        if (allowedKeys.includes("comportamiento")) items.push({ key: "comportamiento", title: "Comportamiento", href: "/ui/comportamiento" });
        if (allowedKeys.includes("leads")) items.push({ key: "leads", title: "Leads", href: "/admin/leads" });
        if (allowedKeys.includes("wweb")) items.push({ key: "wweb", title: "Sesiones WhatsApp Web", href: "/admin/wweb" });
        if (allowedKeys.includes("users")) items.push({ key: "users", title: "Sesiones de usuarios", href: "/admin/users" });
        if (allowedKeys.includes("tenant_config")) items.push({ key: "tenant_config", title: "Tenant Config", href: "/ui/tenant_config" });

        const desired = items.some((it) => it.href === selectedHref) ? selectedHref : "/app";
        return {
          selected: desired,
          html: items.map((it) => '<option value="' + esc(it.href) + '"' + (it.href === desired ? ' selected' : '') + '>' + esc(it.title) + '</option>').join("")
        };
      }

      function getCheckedValues(scope){
        return Array.from(scope.querySelectorAll('input[name="allowedPages"]:checked')).map((el) => String(el.value || ""));
      }

      function syncDefaultPageSelect(scope, selectedHref){
        const select = scope.querySelector('[data-default-page]');
        if (!select) return;
        const allowed = getCheckedValues(scope);
        const built = buildDefaultPageOptions(allowed, selectedHref || select.value || "/app");
        select.innerHTML = built.html;
        select.value = built.selected;
      }

      function installPermissionSync(scope){
        scope.querySelectorAll('input[name="allowedPages"]').forEach((el) => {
          el.addEventListener("change", () => syncDefaultPageSelect(scope));
        });
      }

      function buildPermissionCheckboxes(gridEl, values, disabled){
        const checkedSet = new Set(Array.isArray(values) ? values : []);
        gridEl.innerHTML = getEditablePages().map((page) => {
          const checked = checkedSet.has(page.key) ? 'checked' : '';
          const dis = disabled ? 'disabled' : '';
          return '<label class="small usersPermTag">' +
            '<input type="checkbox" name="allowedPages" value="' + esc(page.key) + '" ' + checked + ' ' + dis + '/>' +
            '<span>' + esc(page.key === "users" ? "Usuarios" : page.title) + '</span>' +
          '</label>';
        }).join("");
      }

      function setupCreateModal(){
        installPermissionSync(createForm);
        syncDefaultPageSelect(createForm, "/app");
      }

      function fillEditRoleOptions(roleValue){
        editRoleSelect.innerHTML = getRoleOptions().map((role) => '<option value="' + esc(role) + '"' + (role === roleValue ? ' selected' : '') + '>' + esc(role) + '</option>').join("");
      }

      function populateEditModal(userData){
        if (!userData) return;
        editForm.querySelector('input[name="userId"]').value = userData.id;
        resetForm.querySelector('input[name="userId"]').value = userData.id;
        deleteForm.querySelector('input[name="userId"]').value = userData.id;
        editTitle.textContent = 'Editar usuario: ' + (userData.username || '');
        editMeta.textContent = 'Tenant: ' + (userData.tenantId || '-') + ' · Rol: ' + (userData.role || '-') + (userData.updatedAt ? ' · Actualizado: ' + userData.updatedAt : '');
        editUsername.value = userData.username || '';
        editTenantInput.value = userData.tenantId || '';
        fillEditRoleOptions(userData.role || 'user');

        const selfLocked = !!userData.isSelf;
        buildPermissionCheckboxes(editPermGrid, userData.currentPages || [], selfLocked);
        installPermissionSync(editForm);
        syncDefaultPageSelect(editForm, userData.defaultPage || '/app');

        if (editLockInput) {
          editLockInput.checked = !!userData.locked;
          editLockInput.disabled = !userData.canEditLock;
        }
        editTenantInput.readOnly = !userData.canEditTenant;
        editRoleSelect.disabled = !userData.canEditRole;
        editSubmit.disabled = selfLocked;
        deleteBtn.disabled = selfLocked;
        resetForm.querySelector('input[name="newPassword"]').value = '';

        if (selfLocked) {
          editHint.innerHTML = 'No se permite cambiar tu propio rol, tenant, bloqueo ni accesos desde esta pantalla. Podés resetear tu contraseña abajo.';
        } else {
          editHint.innerHTML = 'Actualizá los accesos del usuario y elegí su ventana de inicio. Si marcás <strong>Usuarios</strong>, el selector incluirá <strong>Sesiones de usuarios</strong>.';
        }
      }

      createBtn && createBtn.addEventListener('click', () => openModal('create'));
      document.querySelectorAll('[data-user-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = String(btn.getAttribute('data-user-edit') || '');
          const userData = USERS.find((u) => String(u.id) === id);
          populateEditModal(userData || null);
          openModal('edit');
        });
      });

      installCloseHandlers('create');
      installCloseHandlers('edit');
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeModal('create');
          closeModal('edit');
        }
      });
      setupCreateModal();
    })();
    </script>
    `,
  });
}


function wwebSessionsAdminPage({ user }) {
  const isSuper = String(user?.role || "") === "superadmin";
  return appShell({
    title: "Sesiones WhatsApp Web · Asisto",
    user,
    active: "wweb",
    main: `
    <div class="app appWide">
      <div class="toolbar">
        <div>
          <h2 style="margin:0 0 6px">Sesiones WhatsApp Web</h2>
          <div class="small">Muestra las sesiones activas de <code>whatsapp-web.js</code> por tenant/número (colección <code>wa_locks</code>).</div>
          <div class="small">Acciones: <strong>Reiniciar</strong> reinicia la sesión de WhatsApp en la PC dueña. <strong>Bloquear/Habilitar</strong> pausa o permite el inicio de WhatsApp. <strong>Reset Auth</strong> fuerza pedir QR nuevamente (y si sos superadmin también limpia el backup remoto).</div>
        <div class="toolbarActions">
          <button class="btn2" type="button" onclick="window.__wwebReload && window.__wwebReload()">Actualizar</button>
          <span id="wwebStatus" class="small" style="opacity:.85"></span>
          <a class="btn2" href="/app" style="text-decoration:none">Volver</a>
        </div>
      </div>

      <div class="wwebFilters">
        <div class="wwebFilterItem wwebFilterItem--search">
          <label class="small" for="wwebSearch">Buscar sesión</label>
          <input class="inp" id="wwebSearch" type="search" placeholder="Tenant, número, host o holder"/>
        </div>
        <div class="wwebFilterItem">
          <label class="small" for="wwebStateFilter">Estado</label>
          <select class="inp" id="wwebStateFilter">
            <option value="all">Todos</option>
            <option value="active">Activas</option>
            <option value="inactive">Inactivas</option>
            <option value="starting">starting</option>
            <option value="qr">qr</option>
            <option value="authenticated">authenticated</option>
            <option value="online">online</option>
            <option value="disconnected">disconnected</option>
            <option value="offline">offline</option>
            <option value="auth_failure">auth_failure</option>
            <option value="disabled">disabled</option>
          </select>
        </div>
      </div>

      <div id="wwebMsg" class="small" style="margin-top:10px"></div>

      <div class="card" style="margin-top:14px">
        <div class="tableWrap" id="wwebTableWrap">
          <table class="table wwebTable">
            <thead>
              <tr>
                <th>Sesión</th>
                <th>Estado</th>
                <th>Dueño</th>
                <th>Tiempos</th>
                <th>Política</th>
                <th style="width:360px">Acciones</th>
              </tr>
            </thead>
            <tbody id="wwebBody">
              <tr><td colspan="9" class="small">Cargando…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <!-- Modal QR (se actualiza solo mientras está abierto) -->
      <div class="modal" id="qrModal" hidden>
       <div class="modalBackdrop" data-close="1"></div>
        <div class="modalCard" role="dialog" aria-modal="true" aria-label="QR WhatsApp">
          <div class="modalHeader">
            <div>
              <div id="qrTitle" style="font-weight:800">QR</div>
              <div id="qrSub" class="small" style="opacity:.85"></div>
            </div>
            <button id="qrClose" class="btn2" type="button">Cerrar</button>
          </div>
          <div id="qrMeta" class="small" style="margin:10px 0"></div>
          <div class="qrWrap">
            <div id="qrEmpty" class="small" style="padding:12px; opacity:.85">Esperando QR…</div>
            <img id="qrImg" alt="QR WhatsApp" />
          </div>
          <div class="small" style="margin-top:10px; opacity:.85">
            Tip: si el QR vence, este panel lo actualiza automáticamente.
          </div>
        </div>
      </div>

      <div class="modal" id="statsModal" hidden>
        <div class="modalBackdrop" data-stats-close="1"></div>
        <div class="modalCard statsModalCard" role="dialog" aria-modal="true" aria-label="Estadísticas WhatsApp">
          <div class="modalHeader">
            <div>
              <div id="statsTitle" style="font-weight:800">Estadísticas</div>
              <div id="statsSub" class="small" style="opacity:.85"></div>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
              <label class="small">Desde <input type="date" id="statsFrom"/></label>
              <label class="small">Hasta <input type="date" id="statsTo"/></label>
              <button id="statsApply" class="btn2" type="button">Ver</button>
              <button id="statsClose" class="btn2" type="button">Cerrar</button>
            </div>
          </div>
          <div id="statsMeta" class="small" style="margin:10px 0"></div>
          <div id="statsCards" class="statsCards"></div>
          <div class="card" style="margin-top:12px; padding:10px 12px">
            <div class="cellMain" style="margin-bottom:6px">Contactos del rango</div>
            <div class="tableWrap statsTableWrap">
              <table class="table statsTable">
                <thead>
                  <tr>
                    <th>Teléfono</th>
                    <th>Entrada</th>
                    <th>Salida</th>
                    <th>Total</th>
                    <th>Último mensaje</th>
                  </tr>
                </thead>
                <tbody id="statsContactsBody">
                  <tr><td colspan="5" class="small">Sin datos.</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

    </div>



    <script>
    (function(){
      var IS_SUPER = ${isSuper ? "true" : "false"};
      var body = document.getElementById('wwebBody');
      var msg = document.getElementById('wwebMsg');
      var statusEl = document.getElementById('wwebStatus');
      var tableWrap = document.getElementById('wwebTableWrap');
      var searchEl = document.getElementById('wwebSearch');
      var stateFilterEl = document.getElementById('wwebStateFilter');
      var inflight = false;
      var lastHtml = null;
      var lastLocksData = [];
      var lastNowMs = Date.now();


      // ===== Modal QR =====
      var qrModal = document.getElementById('qrModal');
      var qrTitle = document.getElementById('qrTitle');
      var qrSub = document.getElementById('qrSub');
      var qrMeta = document.getElementById('qrMeta');
      var qrImg = document.getElementById('qrImg');
      var qrEmpty = document.getElementById('qrEmpty');
      var qrClose = document.getElementById('qrClose');
      var qrLockId = null;
      var qrTimer = null;
      var lastQrSrc = null;

      function qrSetOpen(open){
        if(!qrModal) return;
        if(open){ qrModal.hidden = false; document.body.classList.add('modalOpen'); }
        else { qrModal.hidden = true; document.body.classList.remove('modalOpen'); }
      }

      function closeQr(){
       qrLockId = null;
        lastQrSrc = null;
        if(qrTimer){ try { clearInterval(qrTimer); } catch(e) {} qrTimer = null; }
        if(qrImg){ try { qrImg.removeAttribute('src'); qrImg.style.display = 'none'; } catch(e) {} }
        if(qrEmpty){ qrEmpty.style.display = 'block'; qrEmpty.textContent = 'Esperando QR…'; }
        qrSetOpen(false);
      }

      function renderQrMeta(lock){
        var parts = [];
        if(lock.state) parts.push('estado: ' + lock.state);
        if(lock.host) parts.push('host: ' + lock.host);
        if(lock.holderId) parts.push('holder: ' + lock.holderId);
        if(lock.lastSeenAt) parts.push('heartbeat: ' + fmtDate(lock.lastSeenAt));
        if(lock.lastQrAt) parts.push('qrAt: ' + lock.lastQrAt);
       return parts.join(' · ');
      }

      function fetchQrOnce(){
        if(!qrLockId) return;
        return api('/api/wweb/qr?lockId=' + encodeURIComponent(qrLockId), { method:'GET' })
          .then(function(data){
            var lock = data && data.lock ? data.lock : null;
            if(!lock) return;
            if(qrMeta) qrMeta.textContent = renderQrMeta(lock);

            var src = lock.lastQrDataUrl;
            if(src && src !== lastQrSrc){
              lastQrSrc = src;
              if(qrImg){ qrImg.src = src; qrImg.style.display = 'block'; }
              if(qrEmpty){ qrEmpty.style.display = 'none'; }
            }
            if(!src){
              if(qrImg) qrImg.style.display = 'none';
              if(qrEmpty){
                qrEmpty.style.display = 'block';
                qrEmpty.textContent = (String(lock.state||'') === 'qr')
                  ? 'Esperando QR…'
                  : 'La sesión no está en modo QR (o todavía no generó QR).';
              }
            }
          })
          .catch(function(e){
            if(qrImg) qrImg.style.display = 'none';
            if(qrEmpty){
              qrEmpty.style.display = 'block';
              qrEmpty.textContent = 'Error leyendo QR: ' + (e.message || e);
            }
          });
      }

      function openQr(lockId, tenantId, numero){
        closeAllMenus();
        qrLockId = String(lockId || '');
        lastQrSrc = null;
        if(qrTitle) qrTitle.textContent = 'QR · ' + (numero || '-');
        if(qrSub) qrSub.textContent = 'tenant: ' + (tenantId || '-') + ' · lock: ' + qrLockId;
        if(qrMeta) qrMeta.textContent = '';
        if(qrImg){ qrImg.removeAttribute('src'); qrImg.style.display = 'none'; }
        if(qrEmpty){ qrEmpty.style.display = 'block'; qrEmpty.textContent = 'Esperando QR…'; }

        qrSetOpen(true);
        fetchQrOnce();
        if(qrTimer){ try { clearInterval(qrTimer); } catch(e) {} }
        qrTimer = setInterval(fetchQrOnce, 1200);
      }

      if(qrClose) qrClose.addEventListener('click', closeQr);
      if(qrModal) qrModal.addEventListener('click', function(ev){
        var t = ev && ev.target;
        if(t && t.getAttribute && t.getAttribute('data-close')) closeQr();
      });
      document.addEventListener('keydown', function(ev){
        if(ev && ev.key === 'Escape') closeQr();
      });
 



      // ===== Modal Estadísticas =====
      var statsModal = document.getElementById('statsModal');
      var statsTitle = document.getElementById('statsTitle');
      var statsSub = document.getElementById('statsSub');
      var statsMeta = document.getElementById('statsMeta');
      var statsCards = document.getElementById('statsCards');
      var statsFrom = document.getElementById('statsFrom');
      var statsTo = document.getElementById('statsTo');
      var statsApply = document.getElementById('statsApply');
      var statsClose = document.getElementById('statsClose');
      var statsContactsBody = document.getElementById('statsContactsBody');
      var statsTenant = '';
      var statsNumero = '';

      function statsSetOpen(open){
        if(!statsModal) return;
        if(open){ statsModal.hidden = false; document.body.classList.add('modalOpen'); }
        else { statsModal.hidden = true; document.body.classList.remove('modalOpen'); }
      }
      function closeStats(){ statsSetOpen(false); }
      function toYmd(d){
        try {
          var y = d.getFullYear();
          var m = String(d.getMonth()+1).padStart(2,'0');
          var day = String(d.getDate()).padStart(2,'0');
          return y + '-' + m + '-' + day;
        } catch(e){ return ''; }
      }
      function fmtDurationMs(ms){
        var n = Number(ms);
        if(!isFinite(n) || n < 0) return '-';
        var mins = Math.floor(n/60000);
        var d = Math.floor(mins/1440);
        var h = Math.floor((mins%1440)/60);
        var m = mins%60;
        var parts = [];
        if(d) parts.push(d + 'd');
        if(h || d) parts.push(h + 'h');
        parts.push(m + 'm');
        return parts.join(' ');
      }
      function statsCard(label, value, sub){
        return '<div class="statsMiniCard">'
          + '<div class="small" style="opacity:.8; color:#475467">' + escapeHtml(label) + '</div>'
          + '<div class="cellMain" style="font-size:22px; margin-top:4px; color:#0f172a; font-weight:800">' + escapeHtml(value) + '</div>'
          + (sub ? ('<div class="small" style="margin-top:4px; color:#475467">' + escapeHtml(sub) + '</div>') : '')
          + '</div>';
      }
      function renderStats(data){
        var summary = data && data.summary ? data.summary : {};
        var overall = data && data.overall ? data.overall : {};
        var contacts = Array.isArray(data && data.contacts) ? data.contacts : [];
        statsMeta.textContent = 'Rango: ' + (data.from || '-') + ' a ' + (data.to || '-')
          + ' · Último mensaje global: ' + (overall.lastMessageAt ? fmtDate(overall.lastMessageAt) : '-');
        statsCards.innerHTML = ''
          + statsCard('Mensajes entrada', String(summary.incoming || 0))
          + statsCard('Mensajes salida', String(summary.outgoing || 0))
          + statsCard('Mensajes totales', String(summary.total || 0))
          + statsCard('Contactos', String(summary.contacts || 0))
          + statsCard('Último mensaje del rango', summary.lastAt ? fmtDate(summary.lastAt) : '-')
          + statsCard('Inactividad actual', overall.inactivityLabel || fmtDurationMs(overall.inactivityMs || 0));

        if(!contacts.length){
          statsContactsBody.innerHTML = '<tr><td colspan="5" class="small">No hay mensajes en el rango seleccionado.</td></tr>';
          return;
        }
        statsContactsBody.innerHTML = contacts.map(function(c){
          return '<tr>'
            + '<td class="mono">' + escapeHtml(c.contact || '-') + '</td>'
            + '<td>' + escapeHtml(String(c.incoming || 0)) + '</td>'
            + '<td>' + escapeHtml(String(c.outgoing || 0)) + '</td>'
            + '<td>' + escapeHtml(String(c.total || 0)) + '</td>'
            + '<td>' + escapeHtml(c.lastAt ? fmtDate(c.lastAt) : '-') + '</td>'
            + '</tr>';
        }).join('');
      }
      function loadStats(){
        if(!statsTenant || !statsNumero) return;
        statsMeta.textContent = 'Cargando…';
        statsCards.innerHTML = '';
        statsContactsBody.innerHTML = '<tr><td colspan="5" class="small">Cargando…</td></tr>';
        return api('/api/wweb/stats?tenantId=' + encodeURIComponent(statsTenant) + '&numero=' + encodeURIComponent(statsNumero)
          + '&from=' + encodeURIComponent(statsFrom.value || '') + '&to=' + encodeURIComponent(statsTo.value || ''), { method:'GET' })
          .then(renderStats)
          .catch(function(e){
            statsMeta.textContent = 'Error: ' + (e.message || e);
            statsContactsBody.innerHTML = '<tr><td colspan="5" class="small">Error cargando estadísticas.</td></tr>';
          });
      }
      function openStats(tenant, numero){
        closeAllMenus();
        statsTenant = String(tenant || '');
        statsNumero = String(numero || '');
        var today = toYmd(new Date());
        if(statsTitle) statsTitle.textContent = 'Estadísticas · ' + statsNumero;
        if(statsSub) statsSub.textContent = 'tenant: ' + statsTenant;
        if(statsFrom && !statsFrom.value) statsFrom.value = today;
        if(statsTo && !statsTo.value) statsTo.value = today;
        if(statsFrom && !statsFrom.value) statsFrom.value = today;
        if(statsTo && !statsTo.value) statsTo.value = statsFrom.value || today;
        statsSetOpen(true);
        loadStats();
      }
      if(statsApply) statsApply.addEventListener('click', loadStats);
      if(statsClose) statsClose.addEventListener('click', closeStats);
      if(statsModal) statsModal.addEventListener('click', function(ev){
        var t = ev && ev.target;
        if(t && t.getAttribute && t.getAttribute('data-stats-close')) closeStats();
      });

      function fmtDate(v){
        if(!v) return "";
        try { return new Date(v).toLocaleString(); } catch (e) { return String(v); }
      }

      function escapeHtml(s){
        return String(s == null ? "" : s)
          .replace(/&/g,"&amp;")
          .replace(/</g,"&lt;")
          .replace(/>/g,"&gt;")
          .replace(/"/g,"&quot;")
          .replace(/'/g,"&#39;");
      }

      function api(path, opts){
        opts = opts || {};
        opts.headers = Object.assign({ "Content-Type":"application/json" }, (opts.headers||{}));
        return fetch(path, opts).then(function(r){
          return r.text().then(function(t){
            var data = null;
            try { data = t ? JSON.parse(t) : null; } catch(e) {}
            if(!r.ok){
              var err = (data && (data.error || data.message)) ? (data.error || data.message) : ("HTTP " + r.status);
              throw new Error(err);
            }
            return data || {};
          });
        });
      }

      function renderRow(lock, nowMs){
        var last = lock.lastSeenAt ? new Date(lock.lastSeenAt).getTime() : 0;
        var ageSec = last ? Math.round((nowMs - last)/1000) : null;
        var active = last && (nowMs - last) <= 30000; // 30s

        var stateBadge = active
          ? '<span class="badge badgeOk">Activa</span>'
          : '<span class="badge badgeWarn">Inactiva</span>';

          var st = String(lock.state || "").trim();

        var tenantId = String(lock.tenantId || "");
        var numero = String(lock.numero || lock.number || "");
        var host = String(lock.host || lock.hostname || "");

        var pol = lock.policy || {};
        var mode = String(pol.mode || "any");
        var pinnedHost = String(pol.pinnedHost || "");
        var blockedHosts = Array.isArray(pol.blockedHosts) ? pol.blockedHosts.map(function(x){ return String(x); }) : [];
        var isBlocked = host && blockedHosts.indexOf(host) >= 0;
        var isDisabled = !!pol.disabled;

        var policyHtml = '';
        policyHtml += isDisabled
          ? '<div><span class="badge badgeWarn">Bloqueada</span></div>'
          : '<div><span class="badge badgeOk">Habilitada</span></div>';
        policyHtml += (mode === "pinned")
          ? ('<div class="small"><b>Solo:</b> ' + escapeHtml(pinnedHost || '-') + '</div>')
          : '<div class="small">Cualquiera</div>';
        if (blockedHosts.length) policyHtml += '<div class="small">Hosts bloqueados: ' + blockedHosts.length + '</div>';



        var actions = '';
        var menuId = 'm_' + String(lock._id || '').replace(/[^a-zA-Z0-9_-]/g,'') + '_' + Math.floor(Math.random()*1e6);
        var canQr = (st === 'qr') || !!lock.hasQr;

        // Dropdown + QR separado (QR queda "como está", pero más compacto)
        actions += ''
          + '<div class="menuWrap">'
          +   '<button class="btn2 btnMenu" type="button" data-action="menu" data-menu="' + escapeHtml(menuId) + '" aria-haspopup="true" aria-expanded="false" title="Acciones">Acciones <span class="caret">▾</span></button>'
          +   '<div class="menu wa-actions-menu" id="' + escapeHtml(menuId) + '" role="menu" aria-hidden="true">'
          +     '<button class="menuItem" type="button" role="menuitem" data-action="restart" data-id="' + escapeHtml(lock._id) + '">Reiniciar</button>'
          +     '<button class="menuItem" type="button" role="menuitem" data-action="toggle" data-tenant="' + escapeHtml(tenantId) + '" data-numero="' + escapeHtml(numero) + '" data-disabled="' + (isDisabled ? '1' : '0') + '">' + (isDisabled ? 'Habilitar' : 'Bloquear') + '</button>'
          +     '<div class="menuSep"></div>'
          +     '<button class="menuItem" type="button" role="menuitem" data-action="resetauth" data-id="' + escapeHtml(lock._id) + '">Reset Auth</button>'
          +     '<button class="menuItem" type="button" role="menuitem" data-action="stats" data-id="' + escapeHtml(lock._id) + '" data-tenant="' + escapeHtml(tenantId) + '" data-numero="' + escapeHtml(numero) + '">Estadísticas</button>'
          +   '</div>'
          + '</div>'
          + '<button class="btn2 btnQr" type="button" data-action="qr" data-id="' + escapeHtml(lock._id) + '" data-tenant="' + escapeHtml(tenantId) + '" data-numero="' + escapeHtml(numero) + '"' + (canQr ? '' : ' disabled') + ' title="QR">QR</button>';

        var ageHtml = (ageSec !== null) ? ('<div class="small">hace ' + ageSec + 's</div>') : '';

        var stHtml = st ? ('<div class="small" style="margin-top:4px; opacity:.9">estado: ' + escapeHtml(st) + '</div>') : '';
        var qrAgeHtml = lock.lastQrAt ? ('<div class="small" style="margin-top:4px; opacity:.85">QR: ' + escapeHtml(String(lock.lastQrAt)) + '</div>') : '';

        var versionLabel = String(lock.runtimeVersion || '').trim();
        var desiredTagLabel = String(lock.desiredTag || '').trim();
        var sessionHtml = ''
          + '<div class="cellMain">' + escapeHtml(tenantId) + '</div>'
          + '<div class="cellSub">' + escapeHtml(numero) + '</div>'
          + '<div class="cellSub"><b>Versión:</b> ' + escapeHtml(versionLabel || '-') + '</div>'
          + '<div class="cellSub"><b>TAG deseado:</b> ' + escapeHtml(desiredTagLabel || '-') + '</div>';

        var ownerHtml = ''
          + '<div class="cellMain">' + escapeHtml(host || '-') + '</div>'
          + '<div class="cellSub mono" title="' + escapeHtml(String(lock.holderId || lock.instanceId || "")) + '">'
          + escapeHtml(String(lock.holderId || lock.instanceId || "-"))
          + '</div>';

        var statsToday = lock.statsToday || { incoming:0, outgoing:0, contacts:0 };
        var timesHtml = ''
          + '<div class="cellSub"><b>Inicio:</b> ' + escapeHtml(fmtDate(lock.startedAt) || '-') + '</div>'
          + '<div class="cellSub"><b>Heartbeat:</b> ' + escapeHtml(fmtDate(lock.lastSeenAt) || '-') + '</div>'
          + '<div class="cellSub"><b>Hoy E/S:</b> ' + escapeHtml(String(statsToday.incoming || 0)) + ' / ' + escapeHtml(String(statsToday.outgoing || 0)) + '</div>'
          + '<div class="cellSub"><b>Contactos hoy:</b> ' + escapeHtml(String(statsToday.contacts || 0)) + '</div>'
          + '<div class="cellSub"><b>Últ. msg:</b> ' + escapeHtml(fmtDate(lock.lastMessageAt) || '-') + '</div>'
          + '<div class="cellSub"><b>Inactividad:</b> ' + escapeHtml(lock.inactivityLabel || '-') + '</div>';



        return ''
          + '<tr class="wwebRow">'
          + '<td>' + sessionHtml + '</td>'
          + '<td>' + stateBadge + ageHtml + stHtml + qrAgeHtml + '</td>'
          + '<td>' + ownerHtml + '</td>'
          + '<td>' + timesHtml + '</td>'
          + '<td>' + policyHtml + '</td>'
          + '<td class="wa-actions-cell"><div class="actionBar">' + actions + '</div></td>'

          + '</tr>';
      }

      function setLoading(on){
        if(!tableWrap) return;
        if(on) tableWrap.setAttribute('data-loading','1');
        else tableWrap.removeAttribute('data-loading');
      }

      function normalizedState(lock, nowMs){
        var st = String((lock && lock.state) || '').trim().toLowerCase();
        var last = lock && lock.lastSeenAt ? new Date(lock.lastSeenAt).getTime() : 0;
        var active = !!(last && (nowMs - last) <= 30000);
        if (st === 'disabled' || (lock && lock.policy && lock.policy.disabled)) return 'disabled';
        if (sfMap[st]) return sfMap[st];
        if (st) return st;
        return active ? 'active' : 'inactive';
      }

      function lockSearchText(lock){
        return [
          lock && lock.tenantId || '',
          lock && (lock.numero || lock.number || lock.phone) || '',
          lock && lock.host || '',
          lock && (lock.holderId || lock.instanceId) || '',
          lock && lock.runtimeVersion || '',
          lock && lock.desiredTag || ''
        ].join(' ').toLowerCase();
      }

      function applyFiltersAndSort(locks, nowMs){
        var items = Array.isArray(locks) ? locks.slice() : [];
        var q = searchEl ? String(searchEl.value || '').trim().toLowerCase() : '';
        var sf = stateFilterEl ? String(stateFilterEl.value || 'all').trim().toLowerCase() : 'all';

        items.sort(function(a, b){
          var ta = String(a && a.tenantId || '').toLowerCase();
          var tb = String(b && b.tenantId || '').toLowerCase();
          if (ta !== tb) return ta.localeCompare(tb, 'es', { sensitivity: 'base' });
          var na = String(a && (a.numero || a.number || a.phone) || '').toLowerCase();
          var nb = String(b && (b.numero || b.number || b.phone) || '').toLowerCase();
          return na.localeCompare(nb, 'es', { sensitivity: 'base', numeric: true });
        });

        if (q) {
          items = items.filter(function(lock){
            return lockSearchText(lock).indexOf(q) >= 0;
          });
        }

        if (sf && sf !== 'all') {
          items = items.filter(function(lock){
            var ns = normalizedState(lock, nowMs);
            if (sf === 'active') return ['active','online','authenticated','qr','starting'].indexOf(ns) >= 0;
            if (sf === 'inactive') return ['inactive','offline','disconnected','auth_failure'].indexOf(ns) >= 0;
            return ns === sf;
          });
        }

        return items;
      }

      function renderCurrentLocks(){
        var nowMs = lastNowMs || Date.now();
        var locks = applyFiltersAndSort(lastLocksData, nowMs);

        var html = '';
        if(!locks.length){
          html = '<tr><td colspan="6" class="small">No hay sesiones para los filtros seleccionados.</td></tr>';
        } else {
          html = locks.map(function(l){ return renderRow(l, nowMs); }).join('');
        }

        if(html !== lastHtml){
          var sx = tableWrap ? tableWrap.scrollLeft : 0;
          var sy = tableWrap ? tableWrap.scrollTop : 0;
          body.innerHTML = html;
          if(tableWrap){
            tableWrap.scrollLeft = sx;
            tableWrap.scrollTop = sy;
          }
          lastHtml = html;
        }
      }

      var sfMap = { ready: 'online' };

      function load(opts){
        opts = opts || {};
        var initial = !!opts.initial;

        if(document.hidden && !opts.force) return;
        if(inflight) return;
        inflight = true;

        // Solo mostramos "Cargando…" en la primera carga real (evita parpadeo)
        if(initial && body && !body.__didInitial){
          body.innerHTML = '<tr><td colspan="6" class="small">Cargando…</td></tr>';
        body.__didInitial = true;
        }

        setLoading(true);
        return api('/api/wweb/locks', { method:'GET' })
          .then(function(data){
            lastLocksData = Array.isArray(data.locks) ? data.locks : [];
            lastNowMs = data.now ? new Date(data.now).getTime() : Date.now();

            renderCurrentLocks();

            if(statusEl){
              statusEl.textContent = 'Última actualización: ' + new Date(lastNowMs).toLocaleTimeString();
            }
            if(msg) msg.textContent = '';
          })
          .catch(function(e){
            if(statusEl){
              statusEl.textContent = 'Error actualizando: ' + (e.message || e);
            }
            // Si nunca cargó nada, mostramos error en la tabla
            if(lastHtml == null){
              body.innerHTML = '<tr><td colspan="9" class="small">Error: ' + escapeHtml(e.message || e) + '</td></tr>';
              lastHtml = body.innerHTML;
            }
          })
          .finally(function(){
            inflight = false;
            setLoading(false);
          });
      }

      function doAction(lockId, action, reason){
        return api('/api/wweb/action', {
          method:'POST',
          body: JSON.stringify({ lockId: String(lockId||''), action: String(action||''), reason: reason || 'admin_panel' })
        });
      }

      function doRestart(lockId){
        closeAllMenus();
        if(!confirm('¿Reiniciar la sesión de WhatsApp en la PC dueña?')) return;
        doAction(lockId, 'restart', 'admin_restart')
          .then(function(){ msg.textContent = 'Reinicio solicitado.'; return load(); })
          .catch(function(e){ alert('Error: ' + (e.message || e)); });
      }

      function doToggle(tenantId, numero, currentlyDisabled){
        closeAllMenus();
        var nextDisabled = !currentlyDisabled;
        var label = nextDisabled ? 'bloquear' : 'habilitar';
        if(!confirm('¿' + label.toUpperCase() + ' esta sesión?' + tenantId + ' · ' + numero)) return;
        api('/api/wweb/policy', { method:'POST', body: JSON.stringify({ tenantId: tenantId, numero: numero, disabled: nextDisabled }) })
          .then(function(){ msg.textContent = nextDisabled ? 'Sesión bloqueada.' : 'Sesión habilitada.'; return load(); })
          .catch(function(e){ alert('Error: ' + (e.message || e)); });
      }

      function doResetAuth(lockId){
        closeAllMenus();
        var txt = IS_SUPER
          ? '¿Reset Auth? Esto borrará el backup remoto (si existe) y pedirá QR nuevamente.'
          : '¿Reset Auth? Pedirá QR nuevamente en la PC dueña.';
        if(!confirm(txt)) return;

        // Si es superadmin usamos el endpoint existente que además limpia GridFS.
        var p = IS_SUPER
          ? api('/api/wweb/release', { method:'POST', body: JSON.stringify({ lockId: lockId, resetAuth: true, reason: 'admin_panel' }) })
          : doAction(lockId, 'resetauth', 'admin_resetauth');

        p.then(function(){
            msg.textContent = 'Reset Auth solicitado. Esperando nuevo QR.';
            return load();
          })
          .catch(function(e){ alert('Error: ' + (e.message || e)); });
      }

      body.addEventListener('click', function(e){
        var btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
        if(!btn) return;
        var act = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');

        var tenant = btn.getAttribute('data-tenant') || "";
        var numero = btn.getAttribute('data-numero') || "";
        var host = btn.getAttribute('data-host') || "";
        var disabledFlag = btn.getAttribute('data-disabled');
        var currentlyDisabled = (disabledFlag === '1' || disabledFlag === 'true');

        // Dropdown open/close
        if(act === 'menu'){
          var menuId = btn.getAttribute('data-menu') || '';
          if(!menuId) return;
          toggleMenu(menuId, btn);
          e.preventDefault();
          return;
        }


        if(act === 'restart') return doRestart(id);
        if(act === 'toggle') return doToggle(tenant, numero, currentlyDisabled);
        if(act === 'resetauth') return doResetAuth(id);
        if(act === 'stats') return openStats(tenant, numero);
        if(act === 'qr') return openQr(id, tenant, numero);

            });


      // Menú: helpers
      function closeAllMenus(){
        document.querySelectorAll('.menu[aria-hidden="false"]').forEach(function(m){
          m.setAttribute('aria-hidden','true');
          m.style.display = 'none';
        });
        document.querySelectorAll('button[data-action="menu"][aria-expanded="true"]').forEach(function(b){
          b.setAttribute('aria-expanded','false');
        });
        document.querySelectorAll('.wa-actions-cell.menuCellOpen').forEach(function(cell){
          cell.classList.remove('menuCellOpen');
        });
        document.querySelectorAll('.wwebRow.rowMenuOpen').forEach(function(row){
          row.classList.remove('rowMenuOpen');
        });
      }
      function positionWaActionsMenu(btn){
        try{
          var wrap = btn && btn.closest ? btn.closest('.menuWrap') : null;
          if(!wrap) return;
          var menu = wrap.querySelector('.menu');
          if(!menu) return;
          menu.classList.remove('up');
          var rect = menu.getBoundingClientRect();
          var vh = window.innerHeight || document.documentElement.clientHeight || 0;
          if(rect.bottom > (vh - 12)) menu.classList.add('up');
        } catch(e){}
      }

      function toggleMenu(menuId, btn){
        var m = document.getElementById(menuId);
        if(!m) return;
        var isOpen = (m.getAttribute('aria-hidden') === 'false');
        closeAllMenus();
        if(isOpen) return;
        var cell = btn && btn.closest ? btn.closest('.wa-actions-cell') : null;
        var row = btn && btn.closest ? btn.closest('.wwebRow') : null;
        if(cell) cell.classList.add('menuCellOpen');
        if(row) row.classList.add('rowMenuOpen');
        m.setAttribute('aria-hidden','false');
        m.style.display = 'block';
        btn.setAttribute('aria-expanded','true');
        positionWaActionsMenu(btn);
      }

      window.addEventListener('resize', function(){
        document.querySelectorAll('.menu[aria-hidden="false"]').forEach(function(menu){
          var wrap = menu.closest('.menuWrap');
          var btn = wrap ? wrap.querySelector('button[data-action="menu"]') : null;
          if(btn) positionWaActionsMenu(btn);
        });
      });

document.addEventListener('click', function(e){
        // click afuera -> cerrar
        var inside = e.target && e.target.closest ? e.target.closest('.menuWrap') : null;
        if(!inside) closeAllMenus();
      });
      document.addEventListener('keydown', function(e){
        if(e.key === 'Escape') closeAllMenus();
      });

      if (searchEl) {
        searchEl.addEventListener('input', function(){
          closeAllMenus();
          renderCurrentLocks();
        });
      }
      if (stateFilterEl) {
        stateFilterEl.addEventListener('change', function(){
          closeAllMenus();
          renderCurrentLocks();
        });
      }

      window.__wwebReload = function(){ return load({ force:true }); };
      load({ initial:true });
      setInterval(function(){ if(document.hidden) return; load(); }, 8000);
      document.addEventListener('visibilitychange', function(){ if(!document.hidden) load(); });
    })();
    </script>

    <style>
      /* Ajustes específicos de /admin/wweb */
      .appWide{width:100%; max-width:1240px; margin:0 auto;}
      .toolbar{display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap}
      .toolbarActions{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
      .wwebFilters{
        display:grid;
        grid-template-columns:minmax(260px,1fr) 220px;
        gap:12px;
        align-items:end;
        margin-top:12px;
      }
      .wwebFilterItem{min-width:0}
      .wwebFilterItem label{display:block; margin-bottom:6px}

      .card{overflow:visible}
      .tableWrap{
        overflow:auto;
        max-width:100%;
        -webkit-overflow-scrolling:touch;
        padding-bottom:140px;
      }
      .tableWrap[data-loading="1"]{opacity:.75}

      .wwebTable{width:100%; table-layout:fixed; border-collapse:separate; border-spacing:0}
      .wwebTable thead th{position:sticky; top:0; background:#fff; z-index:2}
      .wwebTable tbody tr{position:relative; z-index:1}
      .wwebTable tbody tr:nth-child(even){background: rgba(16,24,40,.02)}
      .wwebTable tbody tr.rowMenuOpen{z-index:120}

      .wwebTable td, .wwebTable th{white-space:normal; word-break:break-word; vertical-align:top}
      .wwebTable th:nth-child(1){width:160px}
      .wwebTable th:nth-child(2){width:190px}
      .wwebTable th:nth-child(3){width:240px}
      .wwebTable th:nth-child(4){width:220px}
      .wwebTable th:nth-child(5){width:170px}
      .wwebTable th:nth-child(6){width:240px}

      .cellMain{font-weight:700}
      .cellSub{font-size:12px; opacity:.85; margin-top:2px}
      .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}

      .wa-actions-cell{position:relative; z-index:1}
      .wa-actions-cell.menuCellOpen{z-index:220}
      .actionBar{
        display:flex;
        gap:10px;
        align-items:center;
        justify-content:flex-start;
        flex-wrap:wrap;
      }
      .btnMenu,.btnQr{padding:8px 12px; border-radius:12px; white-space:nowrap}
      .caret{opacity:.7; margin-left:6px}

      .menuWrap{position:relative; display:inline-block; overflow:visible; z-index:260}
      .menu{
        position:absolute;
        right:0;
        top: calc(100% + 8px);
        min-width: 200px;
        background:#fff;
        border:1px solid rgba(15,23,42,.12);
        box-shadow: 0 12px 28px rgba(2,8,23,.18);
        border-radius:14px;
        padding:8px;
        display:none;
        z-index:320;
      }
      .menu.up{
        top:auto;
        bottom: calc(100% + 8px);
      }
      .menuItem{
        width:100%;
        text-align:left;
        padding:10px 12px;
        border:0;
        background:transparent;
        border-radius:10px;
        cursor:pointer;
        font-size:14px;
      }
      .menuItem:hover{background: rgba(15,23,42,.06)}
      .menuSep{height:1px; background: rgba(15,23,42,.10); margin:8px 6px}

      @media (max-width: 960px){
        .wwebFilters{grid-template-columns:1fr}
      }

      @media (max-width: 820px){
        .appWide{max-width:100%}
        .toolbar{align-items:stretch}
        .toolbarActions{width:100%}
        .toolbarActions .btn2,
        .toolbarActions a.btn2{
          flex:1 1 auto;
          justify-content:center;
        }

        .tableWrap{
          overflow:visible;
          padding-bottom:24px;
        }
        .wwebTable,
        .wwebTable thead,
        .wwebTable tbody,
        .wwebTable th,
        .wwebTable td,
        .wwebTable tr{
          display:block;
          width:100%;
        }
        .wwebTable thead{display:none}
        .wwebTable tbody{display:grid; gap:12px}
        .wwebTable tbody tr{
          border:1px solid rgba(148,163,184,.22);
          border-radius:14px;
          padding:10px 12px;
          background:#fff !important;
          box-shadow:0 8px 18px rgba(15,23,42,.06);
          z-index:1;
        }
        .wwebTable td{
          border:0;
          padding:8px 0;
        }
        .wwebTable td + td{
          border-top:1px solid rgba(148,163,184,.14);
        }
        .actionBar{justify-content:flex-start}
        .menu{
          right:auto;
          left:0;
          min-width:min(240px, 82vw);
        }
      }

      .badge{display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:700}
      .badgeOk{background:#1f7a3a1a; color:#1f7a3a; border:1px solid #1f7a3a55}
      .badgeWarn{background:#b453091a; color:#b45309; border:1px solid #b4530955}

      /* Modal QR */
      body.modalOpen{overflow:hidden}
      .modal{position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center; padding:16px}
      .modal[hidden]{display:none !important}
      .modalBackdrop{position:absolute; inset:0; background:rgba(0,0,0,.55)}
      .modalCard{position:relative; width:min(560px, 95vw); background:#fff; border-radius:16px; padding:14px 14px 16px; box-shadow:0 20px 60px rgba(0,0,0,.35)}
      .modalHeader{display:flex; justify-content:space-between; align-items:flex-start; gap:10px}
      .qrWrap{background:rgba(16,24,40,.03); border:1px solid rgba(16,24,40,.08); border-radius:12px; overflow:hidden; display:flex; align-items:center; justify-content:center; min-height:340px}
      #qrImg{max-width:100%; height:auto; display:none}
      .statsModalCard{width:min(980px,96vw); color:#0f172a}
      .statsModalCard .small,
      .statsModalCard label,
      .statsModalCard #statsMeta,
      .statsModalCard #statsSub{color:#475467}
      .statsCards{display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-top:8px}
      .statsMiniCard{background:rgba(16,24,40,.03); border:1px solid rgba(16,24,40,.08); border-radius:12px; padding:10px 12px; color:#0f172a}
      .statsMiniCard .cellMain{color:#0f172a !important; font-weight:800}
      .statsMiniCard .small{color:#475467 !important}
      .statsTableWrap{max-height:48vh; overflow:auto; padding-bottom:0}
      .statsTable{width:100%; table-layout:fixed}
      .statsTable th:nth-child(1){width:190px}
      .statsTable th:nth-child(2), .statsTable th:nth-child(3), .statsTable th:nth-child(4){width:90px}
      .statsTable th:nth-child(5){width:180px}

    </style>
    `,
  });
}
function mountAuthRoutes(app) {
  // login
  ensureBodyParsers(app);
  app.get("/login", (req, res) => {
    const to = req.query?.to || "/app";
    const msg = String(req.query?.msg || "");
    const err = String(req.query?.err || "");
    const baseUrl =
      PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`; // si usás proxy, seteá trust proxy en tu app principal
    return res.status(200).send(loginPage({ to, baseUrl, msg, error: err || "" }));
  });


  // Lead / contacto (público)
  app.post("/contact", async (req, res) => {
   try {
      const name = String(req.body?.name || "").trim();
      const email = String(req.body?.email || "").trim();
      const company = String(req.body?.company || "").trim();
      const phone = String(req.body?.phone || "").trim();
      const message = String(req.body?.message || "").trim();

      if (!name || !email || !message) {
        return res.redirect("/login?err=" + encodeURIComponent("Completá nombre, email y mensaje.") + "#contacto");
      }
      // validación liviana
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.redirect("/login?err=" + encodeURIComponent("Email inválido.") + "#contacto");
      }

      const db = await getDb();
      await db.collection("leads").insertOne({
        name, email, company, phone, message,
        createdAt: new Date(),
        ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        ua: req.headers["user-agent"] || null,
        page: "/login"
      });
      return res.redirect("/login?msg=" + encodeURIComponent("¡Gracias! Te vamos a contactar a la brevedad.") + "#contacto");
    } catch (e) {
      console.error("[contact] error:", e);
      return res.redirect("/login?err=" + encodeURIComponent("No pudimos enviar el mensaje. Probá de nuevo.") + "#contacto");
    }
  });



  // =============================
  // Leads (mensajes del formulario de contacto en /login)
  // =============================
  app.get("/api/leads", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();

      const limitRaw = parseInt(String(req.query?.limit || "50"), 10);
      const skipRaw = parseInt(String(req.query?.skip || "0"), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
      const skip = Number.isFinite(skipRaw) ? Math.max(skipRaw, 0) : 0;

      const q = String(req.query?.q || "").trim();
      const filter = {};
      if (q) {
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ name: rx }, { email: rx }, { company: rx }, { phone: rx }, { message: rx }];
      }

      const items = await db
        .collection("leads")
        .find(filter, {
          projection: { name: 1, email: 1, company: 1, phone: 1, message: 1, createdAt: 1, ip: 1, ua: 1, page: 1 },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      const total = await db.collection("leads").countDocuments(filter);

      return res.json({ ok: true, total, limit, skip, items });
    } catch (e) {
      console.error("[leads] list error:", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  app.get("/api/leads/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });

      const db = await getDb();
      const item = await db.collection("leads").findOne(
        { _id: new ObjectId(id) },
        { projection: { name: 1, email: 1, company: 1, phone: 1, message: 1, createdAt: 1, ip: 1, ua: 1, page: 1 } }
      );
     if (!item) return res.status(404).json({ ok: false, error: "not_found" });
     return res.json({ ok: true, item });
    } catch (e) {
      console.error("[leads] get error:", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // Opcional: borrar un lead (limpieza)
  app.delete("/api/leads/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: "invalid_id" });

      const db = await getDb();
      const r = await db.collection("leads").deleteOne({ _id: new ObjectId(id) });
      if (!r?.deletedCount) return res.status(404).json({ ok: false, error: "not_found" });

      return res.json({ ok: true });
    } catch (e) {
      console.error("[leads] delete error:", e);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  app.post("/login", async (req, res) => {
    try {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      const to = String(req.body?.to || req.query?.to || "/app");

      const baseUrl =
        PUBLIC_BASE_URL ||
        `${req.protocol}://${req.get("host")}`;

      if (!username || !password) {
        return res.status(400).send(loginPage({ error: "Completa usuario y contraseña.", to, baseUrl }));
      }

      const db = await getDb();
      const user = await db.collection("users").findOne({ username });
      if (!user) return res.status(401).send(loginPage({ error: "Usuario o contraseña inválidos.", to, baseUrl }));
 
      if (!verifyPassword(password, user.password)) {
           return res.status(401).send(loginPage({ error: "Usuario o contraseña inválidos.", to, baseUrl }));
    }

      if (user.isLocked) {
         return res.status(403).send(loginPage({ error: "Usuario bloqueado. Contactá al administrador.", to, baseUrl }));
     }

      const payload = makeSessionPayload(user);
      setSessionCookie(res, payload);
      const safeTo = to.startsWith("/") ? to : "/app";
      const redirectTo = (!to || safeTo === "/app")
        ? normalizeDefaultPage(user, user?.defaultPage || "/app")
        : safeTo;
      return res.redirect(redirectTo);
    } catch (e) {
      console.error("[auth] login error:", e);
           const baseUrl =
        PUBLIC_BASE_URL ||
        `${req.protocol}://${req.get("host")}`;
      return res.status(500).send(loginPage({ error: "Error interno de login.", to: "/app", baseUrl }));

    }
  });

  // SEO: robots + sitemap
  app.get("/robots.txt", (req, res) => {
    const baseUrl =
      PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;
    const sitemapUrl = absUrl(baseUrl, "/sitemap.xml");
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(
      [
        "User-agent: *",
        "Allow: /login",
        "Allow: /static/",
        "Disallow: /app",
        "Disallow: /ui/",
        "Disallow: /admin",
        "Disallow: /api/",
        `Sitemap: ${sitemapUrl}`,
        "",
      ].join("\n")
    );
  });

  app.get("/sitemap.xml", (req, res) => {
    const baseUrl =
      PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;
    const loginUrl = absUrl(baseUrl, "/login");
    res.set("Content-Type", "application/xml; charset=utf-8");
    return res.status(200).send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `  <url><loc>${loginUrl}</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
      `</urlset>\n`
    );
  });


  app.post("/logout", (req, res) => {
    clearSessionCookie(res);
    return res.redirect("/login");
  });

  // menú
  app.get("/app", requireAuth, (req, res) => {

    const role = String(req.user?.role || "");
    const isAdmin = (role === "admin" || role === "superadmin");
    const routes = [
      { title: "Inicio", href: "/app", badge: "", desc: "Panel principal" },
      { title: "Conversaciones", href: "/ui/admin", badge: "Admin UI", desc: "Panel de conversaciones" },
      { title: "Productos", href: "/ui/productos", badge: "UI", desc: "Catálogo del tenant" },
      { title: "Horarios", href: "/ui/horarios", badge: "UI", desc: "Configuración de horarios" },
      { title: "Comportamiento", href: "/ui/comportamiento", badge: "UI", desc: "Behavior prompt/config" },
      // APIs solo para admin/superadmin:
      ...(isAdmin ? [
        { title: "Leads", href: "/admin/leads", badge: "Admin", desc: "Mensajes del formulario de contacto" },
        { title: "Sesiones WhatsApp Web", href: "/admin/wweb", badge: "Admin", desc: "Control de sesiones (wwebjs)" },
        { title: "Usuarios", href: "/admin/users", badge: "Admin", desc: "Alta/baja y reseteo de contraseñas" },
        { title: "Tenant Config", href: "/ui/tenant_config", badge: "Admin", desc: "Configuración por tenant" },
        { title: "Logs Conversaciones", href: "/api/logs/conversations", badge: "API", desc: "Listado de conversaciones" },
        { title: "Logs Mensajes", href: "/api/logs/messages", badge: "API", desc: "Mensajes por conversación" },
        { title: "Behavior API", href: "/api/behavior", badge: "API", desc: "Get/Set behavior" },
        { title: "Hours API", href: "/api/hours", badge: "API", desc: "Get/Set store hours" },
        { title: "Products API", href: "/api/products", badge: "API", desc: "CRUD de productos" },
      ] : []),
    ];

    const filtered = (routes || []).filter((r) => {
      const reqKeys = requiredAccessForPath(r.href);
      return reqKeys.length === 0 || hasAccess(req.user, ...reqKeys);
    });

    return res.status(200).send(appMenuPage({ user: req.user, routes: filtered }));
  });

  // wrappers UI con menú lateral (mantienen el layout al navegar endpoints)
  app.get("/ui/:page", requireAuth, (req, res) => {
    const page = String(req.params.page || "").trim();
    if (!hasAccess(req.user, page)) {
      return res.status(403).send("403 - No autorizado");
    }

    const map = {
      admin: { title: "Conversaciones", desc: "Panel de conversaciones y seguimiento", badge: "Admin UI", src: "/admin", active: "admin" },
      inbox: { title: "Inbox", desc: "Bandeja de conversaciones estilo chat", badge: "Admin UI", src: "/admin/inbox", active: "inbox" },
      productos: { title: "Productos", desc: "Catálogo y mantenimiento del tenant", badge: "UI", src: "/productos", active: "productos" },
      horarios: { title: "Horarios", desc: "Configuración de disponibilidad", badge: "UI", src: "/horarios", active: "horarios" },
      comportamiento: { title: "Comportamiento", desc: "Prompt, reglas y configuración del asistente", badge: "UI", src: "/comportamiento", active: "comportamiento" },
      tenant_config: { title: "Tenant Config", desc: "Configuración general por tenant", badge: "Admin", src: "/admin/tenant-config?embed=1", active: "tenant_config" },
    };

    const conf = map[page];
    if (!conf) return res.status(404).send("404 - No existe esa pantalla");

    // Conservamos querystring (por ej: ?tenant=xxx o convId=...)
    const original = String(req.originalUrl || "");
    const qs = original.includes("?") ? original.split("?").slice(1).join("?") : "";
    const src = conf.src + (qs ? ((conf.src.includes("?") ? "&" : "?") + qs) : "");

    return res.status(200).send(
      appShell({
        title: conf.title + " · Asisto",
        user: req.user,
        active: conf.active,
        main: `
        <div class="frameWrap">
          <div class="frameHead">
            <div>
              <h2>${htmlEscape(conf.title)}</h2>
              <p>${htmlEscape(conf.desc || "")}</p>
            </div>
            <span class="badge">${htmlEscape(conf.badge || "Panel")}</span>
          </div>
          <iframe class="frame" src="${htmlEscape(src)}"></iframe>
        </div>
      `,
      })
    );
  });

  // Admin usuarios
  app.get("/admin/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();

            const role = String(req.user?.role || "").toLowerCase();
     const isSuper = role === "superadmin";
      const filter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };

      const users = await db
        .collection("users")
        .find(filter, { projection: { username: 1, tenantId: 1, role: 1, isLocked: 1, allowedPages: 1, defaultPage: 1, createdAt: 1, updatedAt: 1 } })
        .sort({ createdAt: -1 })
        .toArray();

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
      const defaultPage = String(req.body?.defaultPage || "/app").trim();
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
      const allowedPages = normalizeAllowedPages(req.body?.allowedPages);
      const finalDefaultPage = normalizeDefaultPage({ role: finalRole, tenantId: finalTenantId, allowedPages }, defaultPage);

      await db.collection("users").insertOne({
        username,
        tenantId: finalTenantId,
        role: finalRole,
        isLocked: !!isLocked,
        allowedPages,
        defaultPage: finalDefaultPage,
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
      const defaultPage = String(req.body?.defaultPage || "/app").trim();
      const isLocked = !!req.body?.isLocked;
      const allowedPages = normalizeAllowedPages(req.body?.allowedPages);

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

      const finalDefaultPage = normalizeDefaultPage({ role: finalRole, tenantId: finalTenantId, allowedPages }, defaultPage);

      await db.collection("users").updateOne(
        { _id: new ObjectId(userId) },
        { $set: { tenantId: finalTenantId, role: finalRole, isLocked: !!isLocked, allowedPages, defaultPage: finalDefaultPage, updatedAt: new Date() } }
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


  // ================================
  // ======== TENANT CONFIG =========
  // ================================

  function stripTenantConfigDoc(doc) {
    if (!doc || typeof doc !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(doc)) {
      if (k === "_id" || k === "createdAt" || k === "updatedAt") continue;
      out[k] = v;
    }
    return out;
  }

  function tenantConfigAdminPage({ user, initialTenantId }) {
    const role = String(user?.role || "");
    const isSuper = role === "superadmin";
    const tenantId = String(initialTenantId || user?.tenantId || "default");

    return `
      <style>
        .small{font-size:14px;color:#64748b}
        .card{background:#fff;border:1px solid rgba(148,163,184,.22);border-radius:16px;padding:16px;box-shadow:0 10px 24px rgba(15,23,42,.06)}
        .btn,.btn2{height:40px;padding:0 14px;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px}
        .btn{background:#0f3b68;color:#fff;border:1px solid #0f3b68}
        .btn:hover{filter:brightness(.98)}
        .btn2{background:#fff;color:#0f172a;border:1px solid rgba(148,163,184,.45)}
        .btnDanger{border-color:#fecaca;color:#b91c1c;background:#fff}
        .inp{width:100%;height:40px;border-radius:12px;border:1px solid rgba(148,163,184,.45);padding:0 12px;font-size:14px;box-sizing:border-box;background:#fff;color:#0f172a}
        .tbl{width:100%;border-collapse:separate;border-spacing:0}
        .tbl th,.tbl td{padding:12px 10px;border-bottom:1px solid rgba(148,163,184,.22);text-align:left;vertical-align:middle}
        .tbl thead th{font-size:13px;color:#0f172a;background:#f8fafc;position:sticky;top:0}
        .tbl tbody tr:last-child td{border-bottom:none}
        .msg{padding:10px 12px;border-radius:12px;font-size:14px}
        .msg.ok{background:#ecfdf5;color:#166534;border:1px solid #bbf7d0}
        .msg.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
        .actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
        .tc-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
        .tc-listwrap{overflow:auto;border:1px solid rgba(148,163,184,.35);border-radius:12px;margin-top:10px}
        .tc-modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;padding:20px;z-index:2000}
        .tc-modal-backdrop.open{display:flex}
        .tc-modal{width:min(960px,100%);max-height:min(88vh,900px);overflow:auto;background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(15,23,42,.32);border:1px solid rgba(148,163,184,.28)}
        .tc-modal-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid rgba(148,163,184,.22);position:sticky;top:0;background:#fff;z-index:1}
        .tc-modal-body{padding:16px 18px 18px}
        .tc-close{height:40px;border:1px solid rgba(148,163,184,.35);background:#fff;border-radius:12px;padding:0 12px;cursor:pointer;font-weight:700}
        .tc-meta{margin-top:10px;color:#64748b;font-size:12px}
        body.dark .card{background:#0f172a;border-color:rgba(148,163,184,.18)}
        body.dark .btn2, body.dark .inp, body.dark .tc-close{background:#111827;color:#e5e7eb;border-color:rgba(148,163,184,.28)}
        body.dark .tbl thead th{background:#111827;color:#e5e7eb}
        body.dark .tbl th, body.dark .tbl td{border-bottom-color:rgba(148,163,184,.16)}
        body.dark .tc-modal{background:#0f172a;border-color:rgba(148,163,184,.22)}
        body.dark .tc-modal-head{background:#0f172a;border-bottom-color:rgba(148,163,184,.18)}
      </style>

      <div class="tc-toolbar">
        <div>
          <h1 style="margin:0 0 4px">Tenant Config</h1>
          <div class="small">Editá la colección <code>tenant_config</code>. Cada documento usa <code>_id = tenantId</code>. Al hacer clic en <b>Editar</b> se abre un modal con la configuración.</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="btn2" type="button" id="tc_btnReload">Actualizar</button>
          ${isSuper ? `<button class="btn" type="button" id="tc_btnNew">Nuevo tenant</button>` : ``}
          <div class="small">${isSuper ? "Superadmin" : "Admin"} · tenant: <b>${htmlEscape(tenantId)}</b></div>
        </div>
      </div>

      <div id="tc_msg" style="margin:10px 0"></div>

      <div class="card">
        <h3 style="margin:0 0 8px">Tenants</h3>
        <div class="small">Se listan al ingresar. Usá “Editar” para abrir la configuración en un modal.</div>
        <div class="tc-listwrap">
          <table class="tbl" style="margin:0">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Empresa</th>
                <th>Número</th>
                <th>TAG deseado</th>
                <th>Updated</th>
                <th style="width:1%"></th>
              </tr>
            </thead>
            <tbody id="tc_list">
              <tr><td colspan="6" class="small">Cargando...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="tc-modal-backdrop" id="tc_modalBackdrop" aria-hidden="true">
        <div class="tc-modal" role="dialog" aria-modal="true" aria-labelledby="tc_modalTitle">
          <div class="tc-modal-head">
            <div>
              <div id="tc_modalTitle" style="font-weight:700;font-size:18px">Editar tenant</div>
              <div class="small">Modificá campos libres y guardá la configuración.</div>
            </div>
            <button class="tc-close" type="button" id="tc_btnCloseModal">Cerrar</button>
          </div>
          <div class="tc-modal-body">
            <form id="tc_form">
              <label class="small">TenantId</label>
              <input class="inp" id="tc_tenant" name="tenantId" value="${htmlEscape(tenantId)}" ${isSuper ? "" : "readonly"} placeholder="default"/>
              ${isSuper ? `
              <div id="tc_copyWrap" style="margin-top:10px">
                <label class="small">Copiar configuración desde</label>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
                  <select class="inp" id="tc_copyFrom" style="flex:1 1 280px">
                    <option value="">Seleccionar tenant…</option>
                  </select>
                  <button class="btn2" type="button" id="tc_btnCopy">Copiar</button>
                </div>
                <div class="small" style="margin-top:6px">Carga los campos del tenant seleccionado para crear uno nuevo o reutilizarlos en el actual.</div>
              </div>` : ``}

              <div class="small" style="margin-top:10px; color:#64748b">Campos</div>
              <div style="overflow:auto; border:1px solid rgba(148,163,184,.35); border-radius:12px">
                <table class="tbl" style="margin:0">
                  <thead>
                    <tr>
                      <th style="width:34%">Campo</th>
                      <th>Valor</th>
                      <th style="width:1%"></th>
                    </tr>
                  </thead>
                  <tbody id="tc_fields"></tbody>
                </table>
              </div>

              <div class="actions" style="margin-top:12px">
                <button class="btn" type="submit" id="tc_btnSave">Guardar</button>
                <button class="btn2" type="button" id="tc_btnAdd">Agregar campo</button>
                <button class="btn2" type="button" id="tc_btnAddTag">Agregar TAG versión</button>
                <button class="btn2" type="button" id="tc_btnClear">Limpiar</button>
                ${isSuper ? `<button class="btn2 btnDanger" type="button" id="tc_btnDelete">Eliminar</button>` : ``}
              </div>

              <div class="tc-meta" id="tc_meta"></div>
            </form>
          </div>
        </div>
      </div>

      <script>
      (function(){
        const isSuper = ${isSuper ? "true" : "false"};
        const msgEl = document.getElementById('tc_msg');
        const form = document.getElementById('tc_form');
        const tenantEl = document.getElementById('tc_tenant');
        const fieldsEl = document.getElementById('tc_fields');
        const listEl = document.getElementById('tc_list');
        const metaEl = document.getElementById('tc_meta');
        const btnAdd = document.getElementById('tc_btnAdd');
        const btnAddTag = document.getElementById('tc_btnAddTag');
        const btnClear = document.getElementById('tc_btnClear');
        const btnReload = document.getElementById('tc_btnReload');
        const btnNew = document.getElementById('tc_btnNew');
        const btnDelete = document.getElementById('tc_btnDelete');
        const copyFromEl = document.getElementById('tc_copyFrom');
        const btnCopy = document.getElementById('tc_btnCopy');
        const modalBackdrop = document.getElementById('tc_modalBackdrop');
        const btnCloseModal = document.getElementById('tc_btnCloseModal');
        const modalTitle = document.getElementById('tc_modalTitle');

        let currentId = null;
        let currentDocMeta = null;
        let tenantListCache = [];

        function esc(s){
          return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }
        function setMsg(type, text){
          if(!text){ msgEl.innerHTML=''; return; }
          msgEl.innerHTML = '<div class="msg '+(type==='ok'?'ok':'err')+'">'+esc(text)+'</div>';
        }

        function normalizeValueForInput(v){
          if (v === null || v === undefined) return '';
          if (typeof v === 'string') return v;
          try { return JSON.stringify(v); } catch { return String(v); }
        }

        function parseValue(raw){
          const s = String(raw ?? '').trim();
          if (s === '') return '';
          if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
          if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
          if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"') && s.endsWith('"'))) {
            try { return JSON.parse(s); } catch {}
          }
          return s;
        }

        function openModal(title){
          modalTitle.textContent = title || 'Editar tenant';
          modalBackdrop.classList.add('open');
          modalBackdrop.setAttribute('aria-hidden', 'false');
          setTimeout(() => { try { tenantEl.focus(); } catch {} }, 30);
        }
        function closeModal(){
          modalBackdrop.classList.remove('open');
          modalBackdrop.setAttribute('aria-hidden', 'true');
        }

        function addRow(key='', value=''){
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td><input class="inp" data-k value="' + esc(key) + '" placeholder="campo"/></td>' +
            '<td><input class="inp" data-v value="' + esc(value) + '" placeholder="valor"/></td>' +
            '<td><button class="btn2" type="button" data-rm>✕</button></td>';
          tr.querySelector('[data-rm]').addEventListener('click', ()=> tr.remove());
          fieldsEl.appendChild(tr);
          return tr;
        }

        function findFieldRow(fieldName){
          const want = String(fieldName || '').trim().toLowerCase();
          return Array.from(fieldsEl.querySelectorAll('tr')).find(tr => {
            const k = String(tr.querySelector('[data-k]')?.value || '').trim().toLowerCase();
            return k === want;
          }) || null;
        }

        function ensureFieldRow(fieldName, value){
          let row = findFieldRow(fieldName);
          if (!row) row = addRow(fieldName, value);
          const keyInput = row.querySelector('[data-k]');
          const valInput = row.querySelector('[data-v]');
          if (keyInput) keyInput.value = fieldName;
          if (valInput && (valInput.value === '' || String(valInput.value).trim() === '')) valInput.value = value || '';
          try { valInput && valInput.focus(); } catch {}
          return row;
        }

        function setFieldsFromDoc(doc){
          fieldsEl.innerHTML = '';
          const entries = Object.entries(doc || {});
          if (!entries.length) addRow('', '');
          for (const [k,v] of entries) addRow(k, normalizeValueForInput(v));
        }

        function renderCopyOptions(items){
          if (!copyFromEl) return;
          const currentTenant = String(tenantEl && tenantEl.value || '').trim();
          const opts = ['<option value="">Seleccionar tenant…</option>']
            .concat((Array.isArray(items) ? items : []).map(function(it){
              const id = String(it && it._id || '').trim();
              if (!id) return '';
              const disabled = (currentTenant && id === currentTenant) ? ' disabled' : '';
              const company = String(it && it.nom_emp || '').trim();
              const label = company ? (id + ' · ' + company) : id;
              return '<option value="' + esc(id) + '"' + disabled + '>' + esc(label) + '</option>';
            }).filter(Boolean));
          copyFromEl.innerHTML = opts.join('');
        }

        async function copyFromTenant(sourceTenantId){
          const sourceId = String(sourceTenantId || '').trim();
          if (!sourceId) throw new Error('Seleccioná un tenant para copiar.');
          const j = await apiGet(sourceId);
          const doc = j && j.item ? j.item : null;
          if (!doc) throw new Error('No existe configuración para el tenant origen.');
          setFieldsFromDoc(doc.data || {});
          renderMeta({ createdAt: doc.createdAt, updatedAt: doc.updatedAt });
          return doc;
        }

        function collectDoc(){
          const doc = {};
          const keys = new Set();
          const rows = Array.from(fieldsEl.querySelectorAll('tr'));
          for (const r of rows) {
            const k = String(r.querySelector('[data-k]')?.value || '').trim();
            const vRaw = r.querySelector('[data-v]')?.value;
            if (!k) continue;
            if (keys.has(k)) throw new Error('Campo duplicado: ' + k);
            keys.add(k);
            doc[k] = parseValue(vRaw);
          }
          return doc;
        }

        async function apiList(){
          const r = await fetch('/api/tenant-config', { headers: { 'Accept':'application/json' }, credentials: 'same-origin' });
          const j = await r.json().catch(()=>null);
          if(!r.ok) throw new Error((j && (j.error||j.message)) || ('HTTP '+r.status));
          return j;
        }

        async function apiGet(tenantId){
          const r = await fetch('/api/tenant-config?tenantId='+encodeURIComponent(tenantId), { headers: { 'Accept':'application/json' }, credentials: 'same-origin' });
          const j = await r.json().catch(()=>null);
          if(!r.ok) throw new Error((j && (j.error||j.message)) || ('HTTP '+r.status));
          return j;
        }

        async function apiSave(tenantId, doc){
          const body = new URLSearchParams();
          body.set('tenantId', tenantId);
          body.set('data', JSON.stringify(doc||{}));
          const r = await fetch('/api/tenant-config', {
            method: 'POST',
            headers: { 'Content-Type':'application/x-www-form-urlencoded', 'Accept':'application/json' },
            credentials: 'same-origin',
            body
          });
          const j = await r.json().catch(()=>null);
          if(!r.ok) throw new Error((j && (j.error||j.message)) || ('HTTP '+r.status));
          return j;
        }

        async function apiDelete(tenantId){
          const body = new URLSearchParams();
          body.set('tenantId', tenantId);
          const r = await fetch('/api/tenant-config', {
            method: 'DELETE',
            headers: { 'Content-Type':'application/x-www-form-urlencoded', 'Accept':'application/json' },
            credentials: 'same-origin',
            body
          });
          const j = await r.json().catch(()=>null);
          if(!r.ok) throw new Error((j && (j.error||j.message)) || ('HTTP '+r.status));
          return j;
        }

        function renderMeta(meta){
          currentDocMeta = meta || null;
          if (!meta) { metaEl.textContent = ''; return; }
          const parts = [];
          if (meta.createdAt) parts.push('createdAt: ' + meta.createdAt);
          if (meta.updatedAt) parts.push('updatedAt: ' + meta.updatedAt);
          metaEl.textContent = parts.join(' · ');
        }

        async function loadList(){
          try {
            const j = await apiList();
            const items = Array.isArray(j.items)
              ? j.items
              : (j && j.item && j.item._id
                  ? [{
                      _id: j.item._id,
                      nom_emp: (j.item.data && j.item.data.nom_emp) || '',
                      numero: (j.item.data && j.item.data.numero) || '',
                      release_tag: (j.item.data && (j.item.data.release_tag || j.item.data.version_tag || j.item.data.target_tag || '')) || '',
                      createdAt: j.item.createdAt || null,
                      updatedAt: j.item.updatedAt || null
                    }]
                  : []);
            tenantListCache = Array.isArray(items) ? items.slice() : [];
            renderCopyOptions(tenantListCache);
            if (!items.length) {
              listEl.innerHTML = '<tr><td colspan="6" class="small">No hay registros.</td></tr>';
              return;
            }
            listEl.innerHTML = items.map(it => {
              return '<tr>'+
                '<td><span class="pill">'+esc(it._id||'')+'</span></td>'+
                '<td>'+esc(it.nom_emp||'')+'</td>'+
                '<td>'+esc(it.numero||'')+'</td>'+
                '<td><span class="pill">'+esc(it.release_tag || it.version_tag || it.target_tag || '-')+'</span></td>'+
                '<td class="small">'+esc(it.updatedAt||it.createdAt||'')+'</td>'+
                '<td><button class="btn2" type="button" data-edit="'+esc(it._id||'')+'">Editar</button></td>'+
              '</tr>';
            }).join('');

            listEl.querySelectorAll('button[data-edit]').forEach(btn=>{
              btn.addEventListener('click', async ()=>{
                const tid = btn.getAttribute('data-edit');
                if(!tid) return;
                tenantEl.value = tid;
                await loadCurrent(true);
              });
            });
          } catch (e) {
            console.error('[tenant_config] list error:', e);
            listEl.innerHTML = '<tr><td colspan="6" class="small">Error: '+esc(e?.message||String(e))+'</td></tr>';
          }
        }

        async function loadCurrent(openAfterLoad){
          setMsg('', '');
          const tid = String(tenantEl.value||'').trim();
          if (!tid) {
            currentId = null;
            renderMeta(null);
            setFieldsFromDoc({});
            if (openAfterLoad) openModal('Nuevo tenant');
            return;
          }
          try {
            const j = await apiGet(tid);
            currentId = j?.item?._id || tid;
            const doc = j?.item || null;
            if (!doc) {
              renderMeta(null);
              setFieldsFromDoc({});
              renderCopyOptions(tenantListCache);
              if (openAfterLoad) openModal('Nuevo tenant');
              setMsg('err', 'No existe configuración para ese tenant. Podés crearla con Guardar.');
              return;
            }
            renderMeta({ createdAt: doc.createdAt, updatedAt: doc.updatedAt });
            setFieldsFromDoc(doc.data || {});
            renderCopyOptions(tenantListCache);
            if (openAfterLoad) openModal('Editar tenant · ' + tid);
          } catch (e) {
            console.error('[tenant_config] get error:', e);
            setMsg('err', e?.message || String(e));
            setFieldsFromDoc({});
            renderMeta(null);
            renderCopyOptions(tenantListCache);
            if (openAfterLoad) openModal('Nuevo tenant');
          }
        }

        btnAdd.addEventListener('click', ()=> addRow('', ''));
        if (btnAddTag) btnAddTag.addEventListener('click', ()=> ensureFieldRow('release_tag', 'v4.00.16'));
        if (btnCopy && copyFromEl) {
          btnCopy.addEventListener('click', async ()=> {
            try {
              setMsg('', '');
              const sourceId = String(copyFromEl.value || '').trim();
              if (!sourceId) throw new Error('Seleccioná un tenant para copiar.');
              await copyFromTenant(sourceId);
              setMsg('ok', 'Configuración copiada desde ' + sourceId + '.');
            } catch (e) {
              setMsg('err', e?.message || String(e));
            }
          });
        }
        btnClear.addEventListener('click', ()=> { setMsg('', ''); renderMeta(null); setFieldsFromDoc({}); currentId = null; renderCopyOptions(tenantListCache); });
        btnReload.addEventListener('click', async ()=> { await loadList(); });
        if (btnNew) btnNew.addEventListener('click', ()=> {
          setMsg('', '');
          renderMeta(null);
          currentId = null;
          if(isSuper) tenantEl.value = '';
          else tenantEl.value = ${JSON.stringify(tenantId)};
          setFieldsFromDoc({});
          renderCopyOptions(tenantListCache);
          openModal('Nuevo tenant');
        });

        if (btnDelete) {
          btnDelete.addEventListener('click', async ()=>{
            try {
              const tid = String(tenantEl.value||'').trim();
              if (!tid) return;
              if (!confirm('¿Eliminar la config del tenant '+tid+'?')) return;
              await apiDelete(tid);
              setMsg('ok', 'Eliminado ✅');
              currentId = null;
              renderMeta(null);
              setFieldsFromDoc({});
              closeModal();
              await loadList();
            } catch (e) {
              setMsg('err', e?.message || String(e));
            }
          });
        }

        form.addEventListener('submit', async (e)=>{
          e.preventDefault();
          setMsg('', '');
          try {
            const tid = String(tenantEl.value||'').trim();
            if (!tid) throw new Error('tenantId requerido');
            const doc = collectDoc();
            await apiSave(tid, doc);
            setMsg('ok', 'Guardado ✅');
            currentId = tid;
            closeModal();
            await loadList();
          } catch (e) {
            setMsg('err', e?.message || String(e));
          }
        });

        btnCloseModal.addEventListener('click', closeModal);
        modalBackdrop.addEventListener('click', (e)=>{
            positionWaActionsMenu(e.currentTarget); if(e.target === modalBackdrop) closeModal(); });
        document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape' && modalBackdrop.classList.contains('open')) closeModal(); });

        loadList();
      })();
      </script>
    `;
  }

  // UI
  app.get("/admin/tenant-config", requireAuth, requireAdmin, async (req, res) => {
    try {
      const role = String(req.user?.role || "");
      const isSuper = role === "superadmin";
      const initialTenantId = String(req.query?.tenantId || req.query?.tenant || "").trim() || String(req.user?.tenantId || "default");

      const embed = String(req.query?.embed || "") === "1";

      const inner = tenantConfigAdminPage({
        user: req.user,
        initialTenantId: isSuper ? initialTenantId : String(req.user?.tenantId || "default"),
      });


      if (embed) {
        // Embed liviano: evita shells anidados dentro del iframe
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Tenant Config · Asisto</title>
  <style>
    html,body{margin:0;padding:0;background:transparent;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
    .embedWrap{padding:16px}
  </style>
</head>
<body>
  <div class="embedWrap">
    ${inner}
  </div>
</body>
</html>`);
      }

      return res.status(200).send(
        appShell({
          title: "Tenant Config · Asisto",
          user: req.user,
          active: "tenant_config",
          main: inner,
        })
      );
     
    } catch (e) {
      console.error("[tenant-config] page error:", e);
      return res.status(500).send("Error");
    }
  });

  // API
  app.get("/api/tenant-config", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!hasAccess(req.user, "tenant_config")) return res.status(403).json({ ok:false, error:"forbidden" });
      const db = await getDb();
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const requested = String(req.query?.tenantId || "").trim();
      const tenantId = requested || (isSuper ? "" : String(req.user?.tenantId || "default"));
      const col = db.collection("tenant_config");

      if (tenantId) {
        const doc = await col.findOne({ _id: tenantId });
        if (!doc) return res.json({ ok:true, item: null });
        return res.json({ ok:true, item: { _id: doc._id, createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null, data: stripTenantConfigDoc(doc) } });
      }

      // listado (superadmin)
      const items = await col
        .find({}, { projection: { _id: 1, nom_emp: 1, numero: 1, release_tag: 1, version_tag: 1, target_tag: 1, createdAt: 1, updatedAt: 1 } })
        .sort({ _id: 1 })
        .limit(500)
        .toArray();
      return res.json({ ok:true, items });
    } catch (e) {
      return res.status(500).json({ ok:false, error: String(e?.message || e) });
    }
  });

  app.post("/api/tenant-config", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!hasAccess(req.user, "tenant_config")) return res.status(403).json({ ok:false, error:"forbidden" });
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const tenantIdRaw = String(req.body?.tenantId || "").trim();
      const tenantId = tenantIdRaw || (isSuper ? "" : String(req.user?.tenantId || "default"));
      if (!tenantId) return res.status(400).json({ ok:false, error:"tenantId_required" });
      if (!isSuper && tenantId !== String(req.user?.tenantId || "default")) return res.status(403).json({ ok:false, error:"forbidden_tenant" });

      let data = req.body?.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { data = {}; }
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) data = {};

      const db = await getDb();
      const col = db.collection("tenant_config");
      const now = new Date();

      const existing = await col.findOne(
        { _id: tenantId },
        { projection: { _id: 1, createdAt: 1 } }
      );

      const replacement = {
        _id: tenantId,
        ...data,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };

      await col.replaceOne(
        { _id: tenantId },
        replacement,
        { upsert: true }
      );

      return res.json({ ok:true });
    } catch (e) {
      return res.status(500).json({ ok:false, error: String(e?.message || e) });
    }
  });

  app.delete("/api/tenant-config", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!hasAccess(req.user, "tenant_config")) return res.status(403).json({ ok:false, error:"forbidden" });
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      if (!isSuper) return res.status(403).json({ ok:false, error:"superadmin_only" });
      const tenantId = String(req.body?.tenantId || req.query?.tenantId || "").trim();
      if (!tenantId) return res.status(400).json({ ok:false, error:"tenantId_required" });
      const db = await getDb();
      await db.collection("tenant_config").deleteOne({ _id: tenantId });
      return res.json({ ok:true });
    } catch (e) {
      return res.status(500).json({ ok:false, error: String(e?.message || e) });
    }
  });


  // ============================
  // ========== LEADS ===========
  // ============================

  function leadRowHtml(lead) {
    const id = String(lead?._id || "");
    const createdAt = lead?.createdAt ? new Date(lead.createdAt) : null;
    const createdLabel = createdAt ? createdAt.toISOString().replace("T", " ").slice(0, 16) : "-";

    const name = htmlEscape(String(lead?.name || ""));
    const email = htmlEscape(String(lead?.email || ""));
    const company = htmlEscape(String(lead?.company || ""));
    const phone = htmlEscape(String(lead?.phone || ""));
    const message = htmlEscape(String(lead?.message || ""));
    const ua = htmlEscape(String(lead?.ua || ""));
    const ip = htmlEscape(String(lead?.ip || ""));
    const page = htmlEscape(String(lead?.page || ""));

    const meta = [company, phone].filter(Boolean).join(" · ");

    return `
      <tr>
        <td>
          <div style="font-weight:600">${name || "-"}</div>
          <div class="small">${email || "-"}</div>
          ${meta ? `<div class="small">${meta}</div>` : ``}
        </td>
        <td style="white-space:nowrap">${createdLabel}</td>
        <td style="max-width:520px">
          <div style="white-space:pre-wrap">${message || "-"}</div>
          <div class="small" style="margin-top:8px">page: ${page || "-"} · ip: ${ip || "-"} · ua: ${ua || "-"}</div>
        </td>
        <td class="actions" style="white-space:nowrap">
          <form method="POST" action="/admin/leads/delete" style="margin:0" onsubmit="return confirm('¿Eliminar este lead?')">
            <input type="hidden" name="leadId" value="${htmlEscape(id)}"/>
            <button class="btn2 btnDanger" type="submit">Eliminar</button>
          </form>
        </td>
      </tr>
    `;
  }

  // UI: listado de leads (mensajes del formulario /login#contacto)
  app.get("/admin/leads", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();

      const q = String(req.query?.q || "").trim();
      const limit = Math.max(1, Math.min(200, parseInt(String(req.query?.limit || "50"), 10) || 50));

      const filter = q
        ? {
            $or: [
              { name: { $regex: q, $options: "i" } },
              { email: { $regex: q, $options: "i" } },
              { company: { $regex: q, $options: "i" } },
              { phone: { $regex: q, $options: "i" } },
              { message: { $regex: q, $options: "i" } },
            ],
          }
        : {};

      const leads = await db.collection("leads").find(filter).sort({ createdAt: -1 }).limit(limit).toArray();

      const rows = (leads || []).map(leadRowHtml).join("");
      const empty = `<tr><td colspan="4" class="small">No hay leads todavía.</td></tr>`;

      const msg = String(req.query?.msg || "").trim();
      const err = String(req.query?.err || "").trim();
      const message = msg ? `<div class="msg ok">${htmlEscape(msg)}</div>` : "";
      const error = err ? `<div class="msg err">${htmlEscape(err)}</div>` : "";

      return res.status(200).send(
        appShell({
          title: "Leads · Asisto",
          user: req.user,
          active: "leads",
          main: `
            <div class="app">
              <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:10px; flex-wrap:wrap">
                <div>
                  <h2 style="margin:0 0 6px">Leads</h2>
                  <div class="small">Mensajes recibidos desde el formulario de contacto en <code>/login</code> (colección <code>leads</code>).</div>
                </div>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
                  <form method="GET" action="/admin/leads" style="display:flex; gap:8px; align-items:center; margin:0">
                    <input name="q" value="${htmlEscape(q)}" placeholder="buscar..." style="width:220px"/>
                    <input name="limit" value="${htmlEscape(String(limit))}" style="width:90px" title="límite" />
                    <button class="btn2" type="submit">Buscar</button>
                    ${q ? `<a class="btn2" href="/admin/leads" style="text-decoration:none">Limpiar</a>` : ``}
                  </form>
                  <a class="btn2" href="/app" style="text-decoration:none">Volver</a>
                </div>
              </div>

              ${message}
              ${error}

              <div class="card" style="margin-top:14px">
                <h2 style="font-size:18px; margin:0 0 10px">Listado</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Contacto</th>
                      <th>Fecha</th>
                      <th>Mensaje</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rows || empty}
                  </tbody>
                </table>
              </div>
            </div>
          `,
        })
      );
    } catch (e) {
      console.error("[auth] leads ui error:", e);
      return res.status(500).send("Error cargando leads.");
    }
  });

  // UI: borrar lead
  app.post("/admin/leads/delete", requireAuth, requireAdmin, async (req, res) => {
    try {
      const leadId = String(req.body?.leadId || "").trim();
      if (!ObjectId.isValid(leadId)) return res.redirect("/admin/leads?err=" + encodeURIComponent("leadId inválido."));

      const db = await getDb();
      await db.collection("leads").deleteOne({ _id: new ObjectId(leadId) });
      return res.redirect("/admin/leads?msg=" + encodeURIComponent("Lead eliminado."));
    } catch (e) {
      console.error("[auth] leads delete error:", e);
      return res.redirect("/admin/leads?err=" + encodeURIComponent("Error eliminando lead."));
    }
  });

  // API: listar leads (JSON)
  app.get("/api/leads", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      const limit = Math.max(1, Math.min(500, parseInt(String(req.query?.limit || "100"), 10) || 100));
      const leads = await db.collection("leads").find({}).sort({ createdAt: -1 }).limit(limit).toArray();
      return res.json({ ok: true, items: leads });
    } catch (e) {
      console.error("[api] leads list error:", e);
      return res.status(500).json({ ok: false, error: "Error listando leads" });
    }
  });

  // API: obtener lead
  app.get("/api/leads/:id", requireAuth, requireAdmin, async (req, res) => {
   try {
      const id = String(req.params.id || "").trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: "id inválido" });

      const db = await getDb();
      const lead = await db.collection("leads").findOne({ _id: new ObjectId(id) });
      if (!lead) return res.status(404).json({ ok: false, error: "No encontrado" });
      return res.json({ ok: true, item: lead });
    } catch (e) {
      console.error("[api] lead get error:", e);
      return res.status(500).json({ ok: false, error: "Error obteniendo lead" });
    }
  });

  // API: borrar lead
  app.delete("/api/leads/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: "id inválido" });

      const db = await getDb();
      const r = await db.collection("leads").deleteOne({ _id: new ObjectId(id) });
      return res.json({ ok: true, deletedCount: r?.deletedCount || 0 });
    } catch (e) {
      console.error("[api] lead delete error:", e);
      return res.status(500).json({ ok: false, error: "Error eliminando lead" });
    }
  });

  // =============================
  // Admin: Sesiones WhatsApp Web (whatsapp-web.js)
  // =============================
  app.get("/admin/wweb", requireAuth, requireAdmin, async (req, res) => {
    try {
      return res.status(200).send(wwebSessionsAdminPage({ user: req.user }));
    } catch (e) {
      console.error("[wweb] page error:", e);
      return res.status(500).send("Error cargando la pantalla de sesiones.");
    }
  });

  function wwebArYmd(date = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Cordoba',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date);
      const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
      return `${map.year}-${map.month}-${map.day}`;
    } catch {
      const d = new Date(date);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
  }

  function wwebArDateRange(fromYmd, toYmd) {
    const from = String(fromYmd || '').trim();
    const to = String(toYmd || fromYmd || '').trim();
    const start = new Date(`${from}T00:00:00-03:00`);
    const endBase = new Date(`${to}T00:00:00-03:00`);
    const end = new Date(endBase.getTime() + 24*60*60*1000);
    return { start, end };
  }

  function wwebHumanizeMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '';
    const totalMinutes = Math.floor(n / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours || days) parts.push(`${hours}h`);
    parts.push(`${mins}m`);
    return parts.join(' ');
  }

  async function wwebBuildStatsMap(db, baseFilter, start, end) {
    const coll = db.collection('wa_wweb_message_log');
    const todayRows = await coll.aggregate([
      { $match: { ...baseFilter, at: { $gte: start, $lt: end } } },
      { $group: {
          _id: { tenantId: '$tenantId', numero: '$numero' },
          incoming: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, 1, 0] } },
          outgoing: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, 1, 0] } },
          contactsSet: { $addToSet: '$contact' },
          lastMessageAt: { $max: '$at' }
      } }
    ]).toArray();

    const allRows = await coll.aggregate([
      { $match: { ...baseFilter } },
      { $group: { _id: { tenantId: '$tenantId', numero: '$numero' }, lastMessageAt: { $max: '$at' } } }
    ]).toArray();

    const map = new Map();
    for (const row of (todayRows || [])) {
      const key = `${row?._id?.tenantId || ''}::${row?._id?.numero || ''}`;
      map.set(key, {
        incoming: Number(row?.incoming || 0),
        outgoing: Number(row?.outgoing || 0),
        contacts: Array.isArray(row?.contactsSet) ? row.contactsSet.filter(Boolean).length : 0,
        lastMessageAt: row?.lastMessageAt || null
      });
    }
    for (const row of (allRows || [])) {
      const key = `${row?._id?.tenantId || ''}::${row?._id?.numero || ''}`;
      const prev = map.get(key) || { incoming: 0, outgoing: 0, contacts: 0, lastMessageAt: null };
      if (!prev.lastMessageAt && row?.lastMessageAt) prev.lastMessageAt = row.lastMessageAt;
      map.set(key, prev);
    }
    return map;
  }

  // Listado de locks activos/inactivos (colección: wa_locks)
  app.get("/api/wweb/locks", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const filter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };

      const locks = await db
        .collection("wa_locks")
        .find(filter)
        .sort({ lastSeenAt: -1 })
        .limit(500)
        .toArray();

      // Políticas por sesión (tenantId+numero)
      const policies = await db
        .collection("wa_wweb_policies")
        .find(filter)
        .limit(2000)
        .toArray();

      const todayYmd = wwebArYmd(new Date());
      const { start: todayStart, end: todayEnd } = wwebArDateRange(todayYmd, todayYmd);
      const statsMap = await wwebBuildStatsMap(db, filter, todayStart, todayEnd);

      const polMap = new Map();
      for (const p of (policies || [])) {
        const tid = String(p.tenantId || "");
        const num = String(p.numero || "");
        polMap.set(tid + "::" + num, {
          mode: p.mode || "any",
          pinnedHost: p.pinnedHost || "",
          blockedHosts: Array.isArray(p.blockedHosts) ? p.blockedHosts : [],
          disabled: !!p.disabled,
          updatedAt: p.updatedAt || p.createdAt || null,
          updatedBy: p.updatedBy || null,
        });
      }

      const now = new Date();
      const out = locks.map((l) => {
        const tid = String(l.tenantId || "");
        const num = String(l.numero || l.number || l.phone || "");
        const key = tid + "::" + num;
        const policy = polMap.get(key) || { mode: "any", pinnedHost: "", blockedHosts: [], disabled: false };
        const stats = statsMap.get(key) || { incoming: 0, outgoing: 0, contacts: 0, lastMessageAt: null };
        const inactivityMs = stats.lastMessageAt ? Math.max(0, now.getTime() - new Date(stats.lastMessageAt).getTime()) : null;
        return {
          _id: String(l._id),
          tenantId: tid,
          numero: num,
          state: l.state || null,
          holderId: l.holderId || l.instanceId,
          host: l.host || l.hostname,
          startedAt: l.startedAt || l.createdAt,
          lastSeenAt: l.lastSeenAt || l.updatedAt,
          lastQrAt: l.lastQrAt || null,
          hasQr: !!l.lastQrDataUrl,
          policy,
          statsToday: {
            incoming: Number(stats.incoming || 0),
            outgoing: Number(stats.outgoing || 0),
            contacts: Number(stats.contacts || 0),
          },
          lastMessageAt: stats.lastMessageAt || null,
          inactivityMs,
          inactivityLabel: inactivityMs == null ? '' : wwebHumanizeMs(inactivityMs),
          runtimeVersion: l.runtimeVersion || l.currentVersion || '',
          desiredTag: l.desiredTag || l.targetTag || '',
          autoUpdateSource: l.autoUpdateSource || '',
        };
      }).sort((a, b) => {
        const ta = String(a?.tenantId || '').toLowerCase();
        const tb = String(b?.tenantId || '').toLowerCase();
        if (ta !== tb) return ta.localeCompare(tb, 'es', { sensitivity: 'base' });
        const na = String(a?.numero || '').toLowerCase();
        const nb = String(b?.numero || '').toLowerCase();
        return na.localeCompare(nb, 'es', { sensitivity: 'base', numeric: true });
      });

      return res.status(200).json({ now: new Date(), todayYmd, locks: out });
    } catch (e) {
      console.error("api/wweb/locks error:", e);
      return res.status(500).json({ ok: false, error: "Error leyendo locks." });
    }
  });



  // Devuelve el QR (dataUrl) más reciente para una sesión/lock
  // Se usa desde /admin/wweb para ver el QR actualizado sin bajar el listado completo.
  app.get("/api/wweb/qr", requireAuth, requireAdmin, async (req, res) => {
    try {
      const lockId = String(req.query?.lockId || "").trim();
      if (!lockId) return res.status(400).json({ ok: false, error: "lockId requerido" });

      const db = await getDb();
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const tenantFilter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };

      const lock = await db.collection("wa_locks").findOne(
        { _id: lockId, ...tenantFilter },
        { projection: { tenantId: 1, numero: 1, number: 1, phone: 1, state: 1, host: 1, hostname: 1, startedAt: 1, createdAt: 1, lastSeenAt: 1, updatedAt: 1, holderId: 1, instanceId: 1, lastQrAt: 1, lastQrDataUrl: 1 } }
      );
      if (!lock) return res.status(404).json({ ok: false, error: "Lock no encontrado (o no autorizado)." });

      // No cachear: el QR cambia
      try { res.set("Cache-Control", "no-store"); } catch {}

      return res.status(200).json({
        ok: true,
        now: new Date(),
        lock: {
          _id: String(lock._id),
          tenantId: String(lock.tenantId || ""),
          numero: String(lock.numero || lock.number || lock.phone || ""),
          state: lock.state || null,
          holderId: lock.holderId || lock.instanceId || null,
          host: lock.host || lock.hostname || null,
          startedAt: lock.startedAt || lock.createdAt || null,
          lastSeenAt: lock.lastSeenAt || lock.updatedAt || null,
          lastQrAt: lock.lastQrAt || null,
          lastQrDataUrl: lock.lastQrDataUrl || null,
        },
      });
    } catch (e) {
      console.error("api/wweb/qr error:", e);
      return res.status(500).json({ ok: false, error: "Error leyendo QR." });
    }
  });


  // Libera un lock (enviando una acción al owner).
  // Si resetAuth=true, además borra el backup remoto de LocalAuth (GridFS bucket: wa_localauth) para forzar QR.
  // IMPORTANTE: el worker usa _id string: "<tenantId>:<numero>" (no ObjectId).
  app.post("/api/wweb/release", requireAuth, requireAdmin, async (req, res) => {
    try {
      const lockId = String(req.body?.lockId || "").trim();
      const resetAuth = !!req.body?.resetAuth;
      const reason = String(req.body?.reason || "admin_panel").trim();

      if (!lockId) return res.status(400).json({ error: "lockId inválido." });

      const db = await getDb();
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const tenantFilter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };
      if (resetAuth && !isSuper) return res.status(403).json({ error: "forbidden" });

      const _id = lockId;
      const lock = await db.collection("wa_locks").findOne({ _id, ...tenantFilter });
      if (!lock) return res.status(404).json({ error: "Lock no encontrado (o no autorizado)." });

      // Marcar estado en el lock para que el panel muestre que se envió la acción.
      try {
        await db.collection("wa_locks").updateOne(
          { _id, ...tenantFilter },
          { $set: { state: resetAuth ? "reset_auth_requested" : "release_requested", lastAdminAt: new Date() } }
        );
      } catch {}
      // Encolar acción para el owner (el proceso que tenga el lock).
      const action = resetAuth ? "resetauth" : "release";
      try {
        await db.collection("wa_wweb_actions").insertOne({
          lockId: _id,
          action,
          reason,
          requestedBy: String(req.user?.email || req.user?.user || req.user?.username || ""),
          requestedAt: new Date(),
        });
      } catch (e) {
        return res.status(500).json({ error: "No se pudo encolar la acción." });
      }

      // Reset Auth: borrar el backup remoto mínimo (LocalAuth zip en GridFS wa_localauth)
      const dropped = [];
      if (resetAuth) {
        const tenantId = String(lock.tenantId || "");
        const numero = String(lock.numero || lock.number || lock.phone || "");
        const clientId = `asisto_${tenantId}_${numero}`;
        const filename = `LocalAuth-${clientId}.zip`;

        // GridFS native (bucketName: wa_localauth)
        // Collections: wa_localauth.files / wa_localauth.chunks
        try {
          const filesColl = db.collection("wa_localauth.files");
          const chunksColl = db.collection("wa_localauth.chunks");
          const files = await filesColl.find({ filename }).toArray();
          for (const f of files) {
            try { await chunksColl.deleteMany({ files_id: f._id }); } catch {}
            try { await filesColl.deleteOne({ _id: f._id }); } catch {}
          }
          if (files?.length) dropped.push(`wa_localauth:${filename}`);
        } catch (e) {
          // no es fatal: la acción igual se envió
        }
      }

      return res.status(200).json({ ok: true, enqueued: true, action, resetAuth, dropped });
    } catch (e) {
      console.error("[wweb] release error:", e);
      return res.status(500).json({ error: "Error liberando sesión." });
    }
  });


  // Configuración de política de sesión (permitir cualquiera / fijar host / bloquear hosts)
  app.post("/api/wweb/policy", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const tenantFilter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };

      const tenantId = String(req.body?.tenantId || (tenantFilter.tenantId || "")).trim();
      const numero = String(req.body?.numero || "").trim();
      if (!tenantId || !numero) return res.status(400).json({ error: "tenantId y numero requeridos" });
      if (!isSuper && tenantId !== tenantFilter.tenantId) return res.status(403).json({ error: "forbidden" });

      const mode = String(req.body?.mode || "").trim(); // 'any' | 'pinned'
      const pinnedHost = String(req.body?.pinnedHost || "").trim();
      const blockHost = String(req.body?.blockHost || "").trim();
      const unblockHost = String(req.body?.unblockHost || "").trim();
      const disabledRaw = req.body?.disabled;
      const disabled = (disabledRaw === true || disabledRaw === false)
        ? !!disabledRaw
        : (String(disabledRaw || "").trim()
          ? (String(disabledRaw).trim().toLowerCase() === "true" || String(disabledRaw).trim() === "1")
          : null);

      const now = new Date();
      const update = { $setOnInsert: { createdAt: now }, $set: { updatedAt: now, updatedBy: String(req.user?.email || req.user?.user || req.user?.username || "") } };

      if (mode === "any") {
        update.$set.mode = "any";
        update.$set.pinnedHost = "";
      } else if (mode === "pinned") {
        update.$set.mode = "pinned";
        update.$set.pinnedHost = pinnedHost || "";
      }

      if (blockHost) update.$addToSet = { blockedHosts: blockHost };
      if (unblockHost) update.$pull = { blockedHosts: unblockHost };
      if (disabled !== null) update.$set.disabled = !!disabled;

      await db.collection("wa_wweb_policies").updateOne({ tenantId, numero }, update, { upsert: true });

      // Historial
      await db.collection("wa_wweb_history").insertOne({
        tenantId, numero,
        event: "policy_update",
        mode: mode || null,
        pinnedHost: (mode === "pinned") ? (pinnedHost || null) : null,
        blockHost: blockHost || null,
        unblockHost: unblockHost || null,
        disabled: (disabled !== null) ? !!disabled : null,
        by: String(req.user?.email || req.user?.user || req.user?.username || ""),
        at: now,
      });

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("api/wweb/policy error:", e);
      return res.status(500).json({ ok: false, error: "Error guardando política." });
    }
  });

  // Estadísticas de mensajes por sesión y rango de fechas
  app.get("/api/wweb/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const tenantId = String(req.query?.tenantId || (!isSuper ? (req.user?.tenantId || "default") : "")).trim();
      const numero = String(req.query?.numero || "").trim();
      if (!tenantId || !numero) return res.status(400).json({ ok:false, error: "tenantId y numero requeridos" });
      if (!isSuper && tenantId !== String(req.user?.tenantId || "default")) return res.status(403).json({ ok:false, error: "forbidden" });

      const from = String(req.query?.from || wwebArYmd(new Date())).trim();
      const to = String(req.query?.to || from).trim();
      const { start, end } = wwebArDateRange(from, to);
      const coll = db.collection("wa_wweb_message_log");
      const baseMatch = { tenantId, numero };
      const rangeMatch = { ...baseMatch, at: { $gte: start, $lt: end } };

      const [summaryRows, contactRows, overallLast] = await Promise.all([
        coll.aggregate([
          { $match: rangeMatch },
          { $group: {
              _id: null,
              incoming: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, 1, 0] } },
              outgoing: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, 1, 0] } },
              total: { $sum: 1 },
              contactsSet: { $addToSet: '$contact' },
              firstAt: { $min: '$at' },
              lastAt: { $max: '$at' }
          } }
        ]).toArray(),
        coll.aggregate([
          { $match: rangeMatch },
          { $group: {
              _id: '$contact',
              incoming: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, 1, 0] } },
              outgoing: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, 1, 0] } },
              total: { $sum: 1 },
              firstAt: { $min: '$at' },
              lastAt: { $max: '$at' }
          } },
          { $sort: { total: -1, lastAt: -1 } },
          { $limit: 1000 }
        ]).toArray(),
        coll.find(baseMatch).sort({ at: -1 }).limit(1).toArray(),
      ]);

      const summary = summaryRows[0] || { incoming: 0, outgoing: 0, total: 0, contactsSet: [], firstAt: null, lastAt: null };
      const lastOverall = overallLast[0] || null;
      const inactivityMs = lastOverall?.at ? Math.max(0, Date.now() - new Date(lastOverall.at).getTime()) : null;

      return res.status(200).json({
        ok: true,
        tenantId,
        numero,
        from,
        to,
        range: { start, end },
        summary: {
          incoming: Number(summary.incoming || 0),
          outgoing: Number(summary.outgoing || 0),
          total: Number(summary.total || 0),
          contacts: Array.isArray(summary.contactsSet) ? summary.contactsSet.filter(Boolean).length : 0,
          firstAt: summary.firstAt || null,
          lastAt: summary.lastAt || null,
        },
        overall: {
          lastMessageAt: lastOverall?.at || null,
          inactivityMs,
          inactivityLabel: inactivityMs == null ? '' : wwebHumanizeMs(inactivityMs),
        },
        contacts: (contactRows || []).map((r) => ({
          contact: String(r._id || ''),
          incoming: Number(r.incoming || 0),
          outgoing: Number(r.outgoing || 0),
          total: Number(r.total || 0),
          firstAt: r.firstAt || null,
          lastAt: r.lastAt || null,
        })),
      });
    } catch (e) {
      console.error("api/wweb/stats error:", e);
      return res.status(500).json({ ok:false, error: "Error leyendo estadísticas." });
    }
  });

  // Historial de eventos (admin actions)
  app.get("/api/wweb/history", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
       const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const tenantFilter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };

      const tenantId = String(req.query?.tenantId || "").trim();
      const numero = String(req.query?.numero || "").trim();
      if (!tenantId || !numero) return res.status(400).json({ error: "tenantId y numero requeridos" });
      if (!isSuper && tenantId !== tenantFilter.tenantId) return res.status(403).json({ error: "forbidden" });

      const items = await db.collection("wa_wweb_history")
        .find({ tenantId, numero })
        .sort({ at: -1 })
        .limit(100)
        .toArray();

      const out = (items || []).map((x) => ({
        at: x.at || x.createdAt || null,
        event: x.event || "",
        host: x.host || "",
        by: x.by || "",
      }));

      return res.status(200).json(out);
    } catch (e) {
      console.error("api/wweb/history error:", e);
      return res.status(500).json({ ok: false, error: "Error leyendo historial." });
    }
  });

  // Encola una acción para que el script de whatsapp-web.js la tome (si lo tenés polling)
  app.post("/api/wweb/action", requireAuth, requireAdmin, async (req, res) => {
    try {
      const lockId = String(req.body?.lockId || "").trim();
      const action = String(req.body?.action || "").trim().toLowerCase(); // 'restart' | 'resetauth' | 'release'
      const reason = String(req.body?.reason || "").trim();
      if (!lockId) return res.status(400).json({ error: "lockId requerido." });
      if (!action) return res.status(400).json({ error: "action requerida." });

      const db = await getDb();
      const role = String(req.user?.role || "").toLowerCase();
      const isSuper = role === "superadmin";
      const tenantFilter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };

      const lock = await db.collection("wa_locks").findOne({ _id: lockId, ...tenantFilter });
      if (!lock) return res.status(404).json({ error: "Lock no encontrado (o no autorizado)." });

      const now = new Date();
      await db.collection("wa_wweb_actions").insertOne({
        lockId: String(lockId),
        action,
        reason,
        requestedBy: String(req.user?.email || req.user?.user || req.user?.username || ""),
        requestedAt: now,
      });

      await db.collection("wa_wweb_history").insertOne({
        tenantId: lock.tenantId,
        numero: lock.numero || lock.number || lock.phone,
        event: "action_" + action,
        host: lock.host || lock.hostname || "",
        by: String(req.user?.email || req.user?.user || req.user?.username || ""),
        at: now,
      });

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("api/wweb/action error:", e);
      return res.status(500).json({ ok: false, error: "Error creando acción." });
    }
  });

}

// Middleware protector por prefijo + permisos
function protectRoutes(app) {
  app.use((req, res, next) => {
    const p = req.path || "";

    // públicas
    if (
      p === "/" ||
      p === "/healthz" ||
      p === "/robots.txt" ||
      p === "/sitemap.xml" ||
      p === "/login" ||
      p === "/contact" ||
      p === "/logout" ||
      p.startsWith("/static/") ||
      p.startsWith("/webhook") ||
      p.startsWith("/cache/") ||
      p.startsWith("/api/ext/wweb/")
    ) return next();

// =============================
// LEGACY DUPLICATES (renamed)
// (evita que pisen las versiones SEO + drawer)
// =============================

    // requiere login
    const protectedPrefixes = ["/admin", "/api", "/ui"];
    const protectedExact = ["/app", "/productos", "/horarios", "/comportamiento"];

    if (protectedExact.includes(p) || protectedPrefixes.some((pref) => p.startsWith(pref))) {
      return requireAuth(req, res, () => {
         // defensa extra: aunque alguien tenga sesión, no queremos indexar pantallas privadas
        try { res.set("X-Robots-Tag", "noindex, nofollow"); } catch {}
        const required = requiredAccessForPath(p);
        if (required.length && !hasAccess(req.user, ...required)) {
          if (p.startsWith("/api")) return res.status(403).json({ error: "forbidden" });
          return res.status(403).send("403 - No autorizado");
        }
        return next();
      });
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
