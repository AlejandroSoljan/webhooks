// auth_ui.js
// Login + sesiones firmadas + menú (/app) + administración de usuarios (/admin/users)
// Requiere MongoDB (getDb) y la colección "users".
//
// Documento esperado en "users":
// { username, role: 'admin'|'user'|'superadmin', tenantId, password: { salt, hash }, createdAt, allowedPages? }
//
// allowedPages:
//   - undefined / no existe el campo => acceso completo (compatibilidad)
//   - [] => sin acceso
//   - ["admin","inbox",...] => acceso restringido a esas keys

const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://www.asistobot.com.ar"; // ej: https://tudominio.com


const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "asisto_sess";
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || "dev-unsafe-secret-change-me";

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
];

function normalizeAllowedPages(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const clean = arr.map((v) => String(v || "").trim()).filter(Boolean);
  const allowedKeys = new Set(ACCESS_PAGES.map((p) => p.key));
  return clean.filter((k) => allowedKeys.has(k));
}

function hasAccess(user, ...keys) {
  const role = String(user?.role || "");
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
  // Leads (contacto)
  if (path.startsWith("/admin/leads")) return ["leads"];

  // Sesiones WhatsApp Web (whatsapp-web.js)
  if (path.startsWith("/admin/wweb") || path.startsWith("/api/wweb")) return ["wweb"];

  // UI wrapper
  if (path.startsWith("/ui/")) {
    const seg = path.split("/")[2] || "";
    if (["admin", "inbox", "productos", "horarios", "comportamiento"].includes(seg)) return [seg];
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
        { projection: { username: 1, role: 1, tenantId: 1, allowedPages: 1, isLocked: 1 } }
      );
    }

    // fallback por username
    if (!userDoc && sess.username) {
      userDoc = await db.collection("users").findOne(
        { username: String(sess.username) },
        { projection: { username: 1, role: 1, tenantId: 1, allowedPages: 1, isLocked: 1 } }
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

function pageShell({ title, user, body, head = "", robots = "" }) {
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
      background: rgba(255,255,255,.92);
      border: 1px solid rgba(16,24,40,.10);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow:hidden;
    }
    .frame{
      width:100%;
      height: calc(100vh - 140px);
      border:0;
      background:#fff;
      display:block;
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
      /* ===== Slider clientes ===== */
      .lpSliderWrap{max-width:1100px; margin:18px auto 0; padding:16px; border-radius:18px; border:1px solid rgba(255,255,255,.12); background: rgba(0,0,0,.10)}
      .lpSliderTitle{
  margin: 0 0 10px;
  color: #fff;
  font-size: 22px;
  font-weight: 700;
}
      .lpSlider{overflow:hidden; border-radius:14px}
      .lpSliderTrack{display:flex; gap:14px; align-items:center; width:max-content; animation: lpScroll 22s linear infinite}
      .clientBadge{opacity:.95}
      .lpSliderHint{margin-top:10px; color:rgba(255,255,255,.65); font-size:12px}
      @keyframes lpScroll{from{transform:translateX(0)} to{transform:translateX(-50%)}}
.clientBadge{
  height: 58px;                 /* antes 44px */
  display:flex;
  align-items:center;
  justify-content:center;
  padding: 10px 16px;           /* antes 6px 12px */
  border-radius: 14px;
  border:1px solid rgba(255,255,255,0.16);
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.90);
  font-size: 13px;
  white-space: nowrap;
}

.clientLogoImg{
  height: 38px;                 /* antes 26px */
  width: auto;
  max-width: 220px;             /* antes 170px */
  object-fit: contain;
  filter: drop-shadow(0 6px 10px rgba(0,0,0,.18));
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
  </style>
</head>
<body>
  ${user ? `
  <div class="topbar">
  <button type="button" class="menuBtn" id="menuBtn" aria-label="Abrir menú">☰</button>
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
  ${user ? `
  <script>
  (function () {
    const btn = document.getElementById("menuBtn");
    const backdrop = document.getElementById("drawerBackdrop");
   const drawer = document.getElementById("drawer");

    function openDrawer(){ document.body.classList.add("drawerOpen"); }
    function closeDrawer(){ document.body.classList.remove("drawerOpen"); }
    function toggleDrawer(){
      if (document.body.classList.contains("drawerOpen")) closeDrawer();
      else openDrawer();
    }

    if (!btn || !backdrop || !drawer) return;

    btn.addEventListener("click", toggleDrawer);
    backdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    drawer.addEventListener("click", (e) => { if (e.target.closest("a")) closeDrawer(); });
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
  if (hasAccess(user, "inbox")) items.push({ key: "inbox", title: "Inbox", href: "/ui/inbox" });
  if (hasAccess(user, "productos")) items.push({ key: "productos", title: "Productos", href: "/ui/productos" });
  if (hasAccess(user, "horarios")) items.push({ key: "horarios", title: "Horarios", href: "/ui/horarios" });
  if (hasAccess(user, "comportamiento")) items.push({ key: "comportamiento", title: "Comportamiento", href: "/ui/comportamiento" });

  if (isAdmin && hasAccess(user, "leads")) items.push({ key: "leads", title: "Leads", href: "/admin/leads" });
  if (isAdmin && hasAccess(user, "wweb")) items.push({ key: "wweb", title: "Sesiones WhatsApp Web", href: "/admin/wweb" });
  if (isAdmin && hasAccess(user, "users")) items.push({ key: "users", title: "Usuarios", href: "/admin/users" });

  return items;
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

   // Logos reales (reemplazá name/src por los tuyos)
  const clientLogo = ({ name, src }) => {
    // fallback si no hay logo real
    if (!src) {
      return `<div class="clientBadge" title="${htmlEscape(name)}">${htmlEscape(name)}</div>`;
    }
    return `
      <div class="clientBadge" title="${htmlEscape(name)}" aria-label="${htmlEscape(name)}">
        <img class="clientLogoImg" src="${htmlEscape(src)}" alt="${htmlEscape(name)}" loading="lazy"/>
      </div>
    `;
  };
  const logos = [
    { name: "Chiarotto", src: "/static/clientes/chiarotto.png" },  // <- corregí pngg -> png
    { name: "Fleming",   src: "/static/clientes/fleming.png" },
    { name: "TecnoVet",  src: "/static/clientes/tecnovet.png" },
    { name: "Caryco",    src: "/static/clientes/carico.png" },    // ojo: que el nombre del archivo exista
     { name: "Provemix",    src: "/static/clientes/provemix.png" },    // ojo: que el nombre del archivo exista
  ];

  const sliderHtml = logos.concat(logos).map(clientLogo).join("");


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

       <section class="lpSliderWrap" id="clientes" aria-label="Clientes">
        <div class="lpSliderTitle">Empresas que confían en Asisto</div>
        <div class="lpSlider">
          <div class="lpSliderTrack">
            ${sliderHtml}
          </div>
        </div>
        
      </section>

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
  const tiles = (routes || [])
    .map(
      (r) => `
    <a class="tile" href="${htmlEscape(r.href)}">
      <div>
        <h3>${htmlEscape(r.title)}</h3>
        <p>${htmlEscape(r.desc || "")}</p>
      </div>
      <span class="badge">${htmlEscape(r.badge || "")}</span>
    </a>
  `
    )
    .join("");

 const adminTiles =
    user && (user.role === "admin" || user.role === "superadmin")
      ? [
          hasAccess(user, "leads")
            ? `<a class="tile" href="/admin/leads">
                <div><h3>Leads</h3><p>Mensajes recibidos desde el formulario de contacto</p></div>
                <span class="badge">Admin</span>
              </a>`
            : "",
          hasAccess(user, "users")
            ? `<a class="tile" href="/admin/users">
                <div><h3>Usuarios</h3><p>Alta/baja y reseteo de contraseñas</p></div>
                <span class="badge">Admin</span>
              </a>`
            : "",
        ].join("")
      : "";

  return appShell({
    title: "Inicio · Asisto",
    user,
    active: "home",
    main: `
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
  const defaultCreatePages = ACCESS_PAGES.filter((p) => p.key !== "users").map((p) => p.key);
  const createAccessCheckboxes = ACCESS_PAGES.filter((p) => p.key !== "users")
    .map(
      (p) => `<label class="small" style="display:inline-flex;align-items:center;gap:6px">
      <input type="checkbox" name="allowedPages" value="${p.key}" ${defaultCreatePages.includes(p.key) ? "checked" : ""}/>
      ${htmlEscape(p.title)}
    </label>`
    )
    .join("");

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

  const rows = (users || [])
    .map((u) => {
      const id = String(u._id);
      const username = String(u.username || "");
      const tenantId = String(u.tenantId || "");
      const role = String(u.role || "user");
      const locked = !!u.isLocked;
      const isSelf = String(user?.uid) === id;

      const canEditTenant = isSuper;
      const canEditRole = isSuper;
      const canEditLock = !isSelf;

      // ===== Accesos (label + checkboxes) =====
      const hasAllowedPagesField = Object.prototype.hasOwnProperty.call(u, "allowedPages");
      const currentPages = Array.isArray(u.allowedPages)
        ? u.allowedPages
        : hasAllowedPagesField
          ? []
          : ACCESS_PAGES.map((p) => p.key); // legacy => completo

      const accessLabel = !hasAllowedPagesField
        ? "Completo (legacy)"
        : currentPages.length
          ? currentPages.join(", ")
          : "Sin acceso";

      const editablePages = ACCESS_PAGES.filter((p) => (isSuper ? true : p.key !== "users"));
      const accessCheckboxes = editablePages
        .map((p) => {
          const checked = currentPages.includes(p.key) ? "checked" : "";
          return `<label class="small" style="display:inline-flex;align-items:center;gap:6px">
            <input type="checkbox" name="allowedPages" value="${p.key}" ${checked}/>
            ${htmlEscape(p.title)}
          </label>`;
        })
        .join("");

      const roleSelect = (() => {
        const opts = isSuper ? ["user", "admin", "superadmin"] : ["user", "admin"];
        const options = opts.map((r) => `<option value="${r}" ${r === role ? "selected" : ""}>${r}</option>`).join("");
        const disabled = !canEditRole ? "disabled" : "";
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
        <td><div class="small" style="color:#111827">${htmlEscape(accessLabel)}</div></td>
        <td>${locked ? "Bloqueado" : "Activo"}</td>
        <td class="actions">
          <form method="POST" action="/admin/users/update" style="margin:0 0 8px 0">
            <input type="hidden" name="userId" value="${htmlEscape(id)}"/>
            ${tenantInput}
            ${roleSelect}
            ${lockToggle}
            <div style="margin:8px 0 10px; display:flex; flex-wrap:wrap; gap:10px">
              ${accessCheckboxes}
            </div>
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
      </tr>`;
    })
    .join("");

  return appShell({
    title: "Usuarios · Asisto",
    user,
    active: "users",
    main: `
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
              <input name="username" required placeholder="ej: juan"/>
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
              <select name="role">${roleOptionsForCreate}</select>
            </div>
          </div>

          <div class="field">
            <label style="display:flex; align-items:center; gap:10px">
              <input type="checkbox" name="isLocked" value="1" style="width:auto"/>
              Crear como “bloqueado” (no podrá iniciar sesión)
            </label>
          </div>

          <div class="field">
            <label>Acceso a pantallas</label>
            <div style="display:flex; flex-wrap:wrap; gap:10px">
              ${createAccessCheckboxes}
            </div>
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
              <th>Acceso</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="6" class="small">No hay usuarios cargados.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
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
    <div class="app">
      <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:10px; flex-wrap:wrap">
        <div>
          <h2 style="margin:0 0 6px">Sesiones WhatsApp Web</h2>
          <div class="small">Muestra las sesiones activas de <code>whatsapp-web.js</code> por tenant/número (colección <code>wa_locks</code>).</div>
          <div class="small">Acciones: <strong>Liberar</strong> borra el lock (la PC actual se desconecta en el próximo heartbeat). <strong>Reset Auth</strong> además borra la sesión guardada (requiere nuevo QR).</div>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap">
          <button class="btn2" type="button" onclick="window.__wwebReload && window.__wwebReload()">Actualizar</button>
          <a class="btn2" href="/app" style="text-decoration:none">Volver</a>
        </div>
      </div>

      <div id="wwebMsg" class="small" style="margin-top:10px"></div>

      <div class="card" style="margin-top:14px">
        <div style="overflow:auto">
          <table class="table" style="min-width:980px">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Número</th>
                <th>Estado</th>
                <th>Holder</th>
                <th>Host</th>
                <th>Inicio</th>
                <th>Último heartbeat</th>
                <th>Política</th>
                <th style="width:240px">Acciones</th>
              </tr>
            </thead>
            <tbody id="wwebBody">
              <tr><td colspan="9" class="small">Cargando…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <script>
    (function(){
      var IS_SUPER = ${isSuper ? "true" : "false"};
      var body = document.getElementById('wwebBody');
      var msg = document.getElementById('wwebMsg');

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

        var tenantId = String(lock.tenantId || "");
        var numero = String(lock.numero || lock.number || "");
        var host = String(lock.host || lock.hostname || "");

        var pol = lock.policy || {};
        var mode = String(pol.mode || "any");
        var pinnedHost = String(pol.pinnedHost || "");
        var blockedHosts = Array.isArray(pol.blockedHosts) ? pol.blockedHosts.map(function(x){ return String(x); }) : [];
        var isBlocked = host && blockedHosts.indexOf(host) >= 0;

        var policyHtml = (mode === "pinned")
          ? ('<div><b>Solo:</b> ' + escapeHtml(pinnedHost || '-') + '</div>')
          : '<div>Cualquiera</div>';
        if (blockedHosts.length) policyHtml += '<div class="small">Bloqueadas: ' + blockedHosts.length + '</div>';

        var actions = '';
        actions += '<button class="btn2" type="button" data-action="history" data-tenant="' + escapeHtml(tenantId) + '" data-numero="' + escapeHtml(numero) + '">Historial</button>';

        // Modo: fijar o permitir cualquiera
        if (mode !== "pinned" || pinnedHost !== host) {
          actions += '<button class="btn2" type="button" data-action="pin" data-tenant="' + escapeHtml(tenantId) + '" data-numero="' + escapeHtml(numero) + '" data-host="' + escapeHtml(host) + '">Fijar a esta PC</button>';
        } else {
          actions += '<button class="btn2" type="button" data-action="any" data-tenant="' + escapeHtml(tenantId) + '" data-numero="' + escapeHtml(numero) + '">Permitir cualquiera</button>';
        }

        // Bloqueo por host
        if (host) {
          actions += isBlocked
            ? '<button class="btn2" type="button" data-action="unblock" data-tenant="' + escapeHtml(tenantId) + '" data-numero="' + escapeHtml(numero) + '" data-host="' + escapeHtml(host) + '">Desbloquear PC</button>'
            : '<button class="btn2" type="button" data-action="block" data-tenant="' + escapeHtml(tenantId) + '" data-numero="' + escapeHtml(numero) + '" data-host="' + escapeHtml(host) + '">Bloquear PC</button>';
        }

        // Ver QR (si hay)
        if (lock.qrDataUrl) {
          actions += '<button class="btn2" type="button" data-action="qr" data-qr="' + escapeHtml(lock.qrDataUrl) + '" data-tenant="' + escapeHtml(tenantId) + '" data-numero="' + escapeHtml(numero) + '">Ver QR</button>';
        }

        // Acciones sobre el lock
        actions += '<button class="btn2 btnDanger" type="button" data-action="release" data-id="' + escapeHtml(lock._id) + '">Liberar</button>';
        actions += (IS_SUPER ? '<button class="btn2" type="button" data-action="reset" data-id="' + escapeHtml(lock._id) + '">Reset Auth</button>' : '');

        var ageHtml = (ageSec !== null) ? ('<div class="small">hace ' + ageSec + 's</div>') : '';

        return ''
          + '<tr>'
          + '<td>' + escapeHtml(tenantId) + '</td>'
          + '<td>' + escapeHtml(numero) + '</td>'
          + '<td>' + stateBadge + ageHtml + '</td>'
          + '<td>' + escapeHtml(lock.holderId || lock.instanceId || "") + '</td>'
          + '<td>' + escapeHtml(host) + '</td>'
          + '<td>' + escapeHtml(fmtDate(lock.startedAt)) + '</td>'
          + '<td>' + escapeHtml(fmtDate(lock.lastSeenAt)) + '</td>'
          + '<td>' + policyHtml + '</td>'
          + '<td><div class="actionsWrap">' + actions + '</div></td>'
          + '</tr>';
      }

      function load(){
        msg.textContent = "";
        body.innerHTML = '<tr><td colspan="9" class="small">Cargando…</td></tr>';
        return api('/api/wweb/locks', { method:'GET' })
          .then(function(data){
            var locks = Array.isArray(data.locks) ? data.locks : [];
            var nowMs = data.now ? new Date(data.now).getTime() : Date.now();

            if(!locks.length){
              body.innerHTML = '<tr><td colspan="9" class="small">No hay sesiones registradas.</td></tr>';
              return;
            }
            body.innerHTML = locks.map(function(l){ return renderRow(l, nowMs); }).join('');
          })
          .catch(function(e){
            body.innerHTML = '<tr><td colspan="9" class="small">Error: ' + escapeHtml(e.message || e) + '</td></tr>';
          });
      }

      function doRelease(id, resetAuth){
        var txt = resetAuth
          ? '¿Resetear autenticación? Esto borrará la sesión guardada y pedirá QR de nuevo.'
          : '¿Liberar lock? (la PC actual se desconectará en el próximo heartbeat)';
        if(!confirm(txt)) return;

        api('/api/wweb/release', { method:'POST', body: JSON.stringify({ lockId: id, resetAuth: !!resetAuth }) })
          .then(function(){
            msg.textContent = resetAuth ? 'Sesión reseteada.' : 'Lock liberado.';
            return load();
          })
          .catch(function(e){
            alert('Error: ' + (e.message || e));
          });
      }

      body.addEventListener('click', function(e){
        var btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
        if(!btn) return;
        var act = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');

        var tenant = btn.getAttribute('data-tenant') || "";
        var numero = btn.getAttribute('data-numero') || "";
        var host = btn.getAttribute('data-host') || "";

        if(act === 'release') return doRelease(id, false);
        if(act === 'reset') return doRelease(id, true);
        if(act === 'qr'){
          var dataUrl = btn.getAttribute('data-qr') || '';
          if(!dataUrl){ return alert('QR no disponible (todavía).'); }

          var overlay = document.createElement('div');
          overlay.className = 'qrOverlay';
          overlay.innerHTML = ''
            + '<div class="qrModal">'
            + '  <div class="qrHead">'
            + '    <div class="qrTitle">QR ' + escapeHtml(tenant) + ' / ' + escapeHtml(numero) + '</div>'
            + '    <button class="btn2" type="button" data-qx="1">Cerrar</button>'
            + '  </div>'
            + '  <div class="qrBody">'
            + '    <img class="qrImg" src="' + escapeHtml(dataUrl) + '" alt="QR" />'
            + '    <div class="small">Escaneá con WhatsApp → Dispositivos vinculados</div>'
            + '  </div>'
            + '</div>';

          overlay.addEventListener('click', function(ev){
            var t = ev.target;
            if(t === overlay || (t && t.getAttribute && t.getAttribute('data-qx') === '1')){
              try { document.body.removeChild(overlay); } catch(_){ }
            }
          });
          document.body.appendChild(overlay);
          return;
        }

        if(act === 'pin'){
          if(!confirm('¿Configurar para que esta sesión SOLO inicie en esta PC? PC: ' + host)) return;
          return api('/api/wweb/policy', { method:'POST', body: JSON.stringify({ tenantId: tenant, numero: numero, mode: 'pinned', pinnedHost: host }) })
            .then(function(){ load(); })
            .catch(function(e){ alert('Error: ' + (e.message || e)); });
        }
        if(act === 'any'){
          if(!confirm('¿Permitir que inicie en CUALQUIER PC?')) return;
          return api('/api/wweb/policy', { method:'POST', body: JSON.stringify({ tenantId: tenant, numero: numero, mode: 'any' }) })
            .then(function(){ load(); })
            .catch(function(e){ alert('Error: ' + (e.message || e)); });
        }
        if(act === 'block'){
          if(!confirm('¿Bloquear esta PC para esta sesión? PC: ' + host)) return;
          return api('/api/wweb/policy', { method:'POST', body: JSON.stringify({ tenantId: tenant, numero: numero, blockHost: host }) })
            .then(function(){ load(); })
            .catch(function(e){ alert('Error: ' + (e.message || e)); });
        }
        if(act === 'unblock'){
          if(!confirm('¿Desbloquear esta PC? PC: ' + host)) return;
          return api('/api/wweb/policy', { method:'POST', body: JSON.stringify({ tenantId: tenant, numero: numero, unblockHost: host }) })
            .then(function(){ load(); })
            .catch(function(e){ alert('Error: ' + (e.message || e)); });
        }
        if(act === 'history'){
          return api('/api/wweb/history?tenantId=' + encodeURIComponent(tenant) + '&numero=' + encodeURIComponent(numero))
            .then(function(items){
              if(!items || !items.length) return alert('Sin historial.');
              var lines = items.map(function(it){
                var t = it.at ? new Date(it.at).toLocaleString() : '';
                return t + ' | ' + (it.event || '') + ' | ' + (it.host || '') + ' | ' + (it.by || '');
              });
              
            })
            .catch(function(e){ alert('Error: ' + (e.message || e)); });
        }
      });

      window.__wwebReload = load;
      load();
      setInterval(load, 8000);
    })();
    </script>

    <style>
      .badge{display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:700}
      .badgeOk{background:#1f7a3a1a; color:#1f7a3a; border:1px solid #1f7a3a55}
      .badgeWarn{background:#b453091a; color:#b45309; border:1px solid #b4530955}
      .table td, .table th{white-space:nowrap}
    </style>
    `,
  });
}
function mountAuthRoutes(app) {
  // login
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
      return res.redirect(to.startsWith("/") ? to : "/app");
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
      { title: "Inbox", href: "/ui/inbox", badge: "Admin UI", desc: "Bandeja de conversaciones" },
      { title: "Conversaciones", href: "/ui/admin", badge: "Admin UI", desc: "Panel de conversaciones" },
      { title: "Productos", href: "/ui/productos", badge: "UI", desc: "Catálogo del tenant" },
      { title: "Horarios", href: "/ui/horarios", badge: "UI", desc: "Configuración de horarios" },
      { title: "Comportamiento", href: "/ui/comportamiento", badge: "UI", desc: "Behavior prompt/config" },
      // APIs solo para admin/superadmin:
      ...(isAdmin ? [
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
      admin: { title: "Conversaciones", src: "/admin", active: "admin" },
      inbox: { title: "Inbox", src: "/admin/inbox", active: "inbox" },
      productos: { title: "Productos", src: "/productos", active: "productos" },
      horarios: { title: "Horarios", src: "/horarios", active: "horarios" },
      comportamiento: { title: "Comportamiento", src: "/comportamiento", active: "comportamiento" },
    };

    const conf = map[page];
    if (!conf) return res.status(404).send("404 - No existe esa pantalla");

    // Conservamos querystring (por ej: ?tenant=xxx o convId=...)
    const original = String(req.originalUrl || "");
    const qs = original.includes("?") ? original.split("?").slice(1).join("?") : "";
    const src = conf.src + (qs ? "?" + qs : "");

    return res.status(200).send(
      appShell({
        title: conf.title + " · Asisto",
        user: req.user,
        active: conf.active,
        main: `
        <div class="frameWrap">
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

      const isSuper = String(req.user?.role || "") === "superadmin";
      const filter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };

      const users = await db
        .collection("users")
        .find(filter, { projection: { username: 1, tenantId: 1, role: 1, isLocked: 1, allowedPages: 1, createdAt: 1 } })
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

      await db.collection("users").insertOne({
        username,
        tenantId: finalTenantId,
        role: finalRole,
        isLocked: !!isLocked,
        allowedPages,
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

      await db.collection("users").updateOne(
        { _id: new ObjectId(userId) },
        { $set: { tenantId: finalTenantId, role: finalRole, isLocked: !!isLocked, allowedPages, updatedAt: new Date() } }
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

  // Listado de locks activos/inactivos (colección: wa_locks)
  app.get("/api/wweb/locks", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      const isSuper = String(req.user?.role || "") === "superadmin";
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

      const polMap = new Map();
      for (const p of (policies || [])) {
        const tid = String(p.tenantId || "");
        const num = String(p.numero || "");
        polMap.set(tid + "::" + num, {
          mode: p.mode || "any",
          pinnedHost: p.pinnedHost || "",
          blockedHosts: Array.isArray(p.blockedHosts) ? p.blockedHosts : [],
          updatedAt: p.updatedAt || p.createdAt || null,
          updatedBy: p.updatedBy || null,
        });
      }

      const out = locks.map((l) => {
        const tid = String(l.tenantId || "");
        const num = String(l.numero || l.number || l.phone || "");
        const policy = polMap.get(tid + "::" + num) || { mode: "any", pinnedHost: "", blockedHosts: [] };
        return {
          _id: String(l._id),
          tenantId: tid,
          numero: num,
          holderId: l.holderId || l.instanceId,
          host: l.host || l.hostname,
          startedAt: l.startedAt || l.createdAt,
          lastSeenAt: l.lastSeenAt || l.updatedAt,
          policy,
          qrDataUrl: l.qrDataUrl || null,
          qrAt: l.qrAt || null,
        };
      });

      return res.status(200).json({ now: new Date(), locks: out });
    } catch (e) {
      console.error("api/wweb/locks error:", e);
      return res.status(500).json({ ok: false, error: "Error leyendo locks." });
    }
  });

  // Libera un lock. Si resetAuth=true, además borra la sesión persistida de wwebjs-mongo (requiere QR de nuevo).
  app.post("/api/wweb/release", requireAuth, requireAdmin, async (req, res) => {
    try {
      const lockId = String(req.body?.lockId || "").trim();
      const resetAuth = !!req.body?.resetAuth;

      if (!ObjectId.isValid(lockId)) return res.status(400).json({ error: "lockId inválido." });

      const db = await getDb();
      const isSuper = String(req.user?.role || "") === "superadmin";
      const tenantFilter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };
      if (resetAuth && !isSuper) return res.status(403).json({ error: "forbidden" });

      const _id = new ObjectId(lockId);
      const lock = await db.collection("wa_locks").findOne({ _id, ...tenantFilter });
      if (!lock) return res.status(404).json({ error: "Lock no encontrado (o no autorizado)." });

      const del = await db.collection("wa_locks").deleteOne({ _id, ...tenantFilter });

      const dropped = [];
      if (resetAuth) {
        // wwebjs-mongo usa GridFS bucket "whatsapp-<sessionName>" => collections: whatsapp-<sessionName>.files/.chunks
        const tenantId = String(lock.tenantId || "");
        const numero = String(lock.numero || lock.number || lock.phone || "");
        const sessionName = String(lock.sessionName || lock.session || lock.clientId || ("asisto_" + tenantId + "_" + numero));
        const bucket = `whatsapp-${sessionName}`;

        for (const coll of [`${bucket}.files`, `${bucket}.chunks`]) {
          try {
            await db.collection(coll).drop();
            dropped.push(coll);
          } catch (e) {
            // si no existe, drop falla: ignoramos
          }
        }
      }

      return res.status(200).json({ ok: true, deletedCount: del?.deletedCount || 0, resetAuth, dropped });
    } catch (e) {
      console.error("[wweb] release error:", e);
      return res.status(500).json({ error: "Error liberando sesión." });
    }
  });

  // Configuración de política de sesión (permitir cualquiera / fijar host / bloquear hosts)
  app.post("/api/wweb/policy", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      const isSuper = String(req.user?.role || "") === "superadmin";
      const tenantFilter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };

      const tenantId = String(req.body?.tenantId || (tenantFilter.tenantId || "")).trim();
      const numero = String(req.body?.numero || "").trim();
      if (!tenantId || !numero) return res.status(400).json({ error: "tenantId y numero requeridos" });
      if (!isSuper && tenantId !== tenantFilter.tenantId) return res.status(403).json({ error: "forbidden" });

      const mode = String(req.body?.mode || "").trim(); // 'any' | 'pinned'
      const pinnedHost = String(req.body?.pinnedHost || "").trim();
      const blockHost = String(req.body?.blockHost || "").trim();
      const unblockHost = String(req.body?.unblockHost || "").trim();

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

      await db.collection("wa_wweb_policies").updateOne({ tenantId, numero }, update, { upsert: true });

      // Historial
      await db.collection("wa_wweb_history").insertOne({
        tenantId, numero,
        event: "policy_update",
        mode: mode || null,
        pinnedHost: (mode === "pinned") ? (pinnedHost || null) : null,
        blockHost: blockHost || null,
        unblockHost: unblockHost || null,
        by: String(req.user?.email || req.user?.user || req.user?.username || ""),
        at: now,
      });

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("api/wweb/policy error:", e);
      return res.status(500).json({ ok: false, error: "Error guardando política." });
    }
  });

  // Historial de eventos (admin actions)
  app.get("/api/wweb/history", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      const isSuper = String(req.user?.role || "") === "superadmin";
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
      const action = String(req.body?.action || "").trim(); // e.g. 'restart' | 'logout' | 'release'
      const reason = String(req.body?.reason || "").trim();
      if (!ObjectId.isValid(lockId)) return res.status(400).json({ error: "lockId inválido." });
      if (!action) return res.status(400).json({ error: "action requerida." });

      const db = await getDb();
      const isSuper = String(req.user?.role || "") === "superadmin";
      const tenantFilter = isSuper ? {} : { tenantId: String(req.user?.tenantId || "default") };

      const _id = new ObjectId(lockId);
      const lock = await db.collection("wa_locks").findOne({ _id, ...tenantFilter });
      if (!lock) return res.status(404).json({ error: "Lock no encontrado (o no autorizado)." });

      const now = new Date();
      await db.collection("wa_actions").insertOne({
        tenantId: lock.tenantId,
        numero: lock.numero || lock.number || lock.phone,
        lockId: String(_id),
        action,
        reason,
        requestedBy: String(req.user?.email || req.user?.user || req.user?.username || ""),
        createdAt: now,
        status: "PENDING",
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
      p.startsWith("/cache/")
    ) return next();

// =============================
// LEGACY DUPLICATES (renamed)
// (evita que pisen las versiones SEO + drawer)
// =============================
function appShellLegacy() { /* legacy */ }
function loginPageLegacy() { /* legacy */ }
function mountAuthRoutesLegacy() { /* legacy */ }
function protectRoutesLegacy() { /* legacy */ }
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
