// auth_ui.js
// Login + sesión firmada (sin dependencias extras), con usuarios en MongoDB.
//
// Colección sugerida: "users"
// Doc sugerido:
// {
//   _id: ObjectId,
//   username: "admin",
//   password: "<scrypt$saltB64$hashB64>",
//   tenantId: "carico",   // o "default"
//   role: "admin",
//   active: true,
//   createdAt: Date
// }

const path = require("path");
const crypto = require("crypto");
const { getDb } = require("./db");

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "asisto_auth";
const COOKIE_SECRET = process.env.AUTH_COOKIE_SECRET || process.env.COOKIE_SECRET || "";
const COOKIE_MAX_AGE_MS = Number(process.env.AUTH_COOKIE_MAX_AGE_MS || (7 * 24 * 60 * 60 * 1000)); // 7 días

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function unbase64url(input) {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(b64, "base64");
}

function signToken(payloadObj) {
  if (!COOKIE_SECRET) throw new Error("Falta AUTH_COOKIE_SECRET en env");
  const payloadJson = JSON.stringify(payloadObj);
  const payload = base64url(payloadJson);
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64");
  const sigUrl = sig.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${payload}.${sigUrl}`;
}

function verifyToken(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64")
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    // timing safe compare
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    const json = unbase64url(payload).toString("utf-8");
    const obj = JSON.parse(json);
    if (!obj || !obj.uid || !obj.tenantId) return null;
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach(part => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  const maxAge = opts.maxAge ?? COOKIE_MAX_AGE_MS;
  parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  parts.push("Path=/");
  parts.push("HttpOnly");
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
    parts.push("SameSite=Lax");
  } else {
    parts.push("SameSite=Lax");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

// ---- Password hashing (scrypt) ----
// Formato: scrypt$<saltB64>$<hashB64>
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function verifyPassword(plain, stored) {
  try {
    const [kind, saltB64, hashB64] = String(stored || "").split("$");
    if (kind !== "scrypt" || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(String(plain), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---- Middlewares ----
function attachUser(req, _res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    const sess = verifyToken(token);
    if (sess) {
      req.user = {
        id: sess.uid,
        username: sess.u || "",
        tenantId: sess.tenantId,
        role: sess.role || "user",
      };
    }
  } catch {}
  next();
}

function requireAuth(req, res, next) {
  if (req.user && req.user.tenantId) return next();
  // API -> 401 JSON, UI -> redirect
  if ((req.path || "").startsWith("/api/")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const nextUrl = encodeURIComponent(req.originalUrl || "/app");
  return res.redirect(`/login?next=${nextUrl}`);
}

// ---- UI ----
function loginHtml({ error = "", nextUrl = "/app" } = {}) {
  const safeErr = String(error || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeNext = String(nextUrl || "/app").replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Asisto | Login</title>
  <style>
    :root{
      --bg:#0b1f33;
      --card:#0f2a44;
      --card2:#123252;
      --text:#e9f1ff;
      --muted:rgba(233,241,255,.70);
      --border:rgba(255,255,255,.10);
      --accent:#20d3a8;
      --danger:#ff5c5c;
      --shadow: 0 18px 60px rgba(0,0,0,.35);
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial;
      background: radial-gradient(1200px 600px at 20% 10%, rgba(32,211,168,.18), transparent 55%),
                  radial-gradient(1000px 600px at 80% 20%, rgba(32,211,168,.10), transparent 60%),
                  var(--bg);
      color: var(--text);
      min-height:100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:24px;
    }
    .wrap{
      width:min(980px, 100%);
      display:grid;
      grid-template-columns: 1.2fr .8fr;
      gap:18px;
      align-items:stretch;
    }
    .brand{
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
      border:1px solid var(--border);
      border-radius:22px;
      box-shadow: var(--shadow);
      padding:26px;
      position:relative;
      overflow:hidden;
    }
    .brand:before{
      content:"";
      position:absolute;
      inset:-120px -140px auto auto;
      width:340px;height:340px;
      background: radial-gradient(circle at 30% 30%, rgba(32,211,168,.35), transparent 60%);
      filter: blur(2px);
      transform: rotate(10deg);
    }
    .logo{
      display:flex;
      align-items:center;
      gap:14px;
      position:relative;
      z-index:1;
      margin-bottom:16px;
    }
    .logo img{height:44px; width:auto; display:block}
    .brand h1{
      margin:6px 0 8px;
      font-size:34px;
      letter-spacing:.2px;
      position:relative;
      z-index:1;
    }
    .brand p{
      margin:0;
      color:var(--muted);
      line-height:1.5;
      position:relative;
      z-index:1;
      max-width:54ch;
    }

    .card{
      background: linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.03));
      border:1px solid var(--border);
      border-radius:22px;
      box-shadow: var(--shadow);
      padding:22px;
    }
    .card h2{margin:0 0 12px; font-size:18px}
    label{display:block; font-size:12px; color:var(--muted); margin-top:10px}
    input{
      width:100%;
      padding:12px 12px;
      margin-top:6px;
      border-radius:14px;
      border:1px solid var(--border);
      background: rgba(0,0,0,.16);
      color:var(--text);
      outline:none;
      font-size:14px;
    }
    input:focus{border-color: rgba(32,211,168,.6)}
    button{
      width:100%;
      margin-top:14px;
      padding:12px 14px;
      border:0;
      border-radius:14px;
      background: var(--accent);
      color:#052a22;
      font-weight:800;
      cursor:pointer;
      font-size:14px;
    }
    .err{
      margin-top:10px;
      padding:10px 12px;
      border-radius:14px;
      border:1px solid rgba(255,92,92,.35);
      background: rgba(255,92,92,.10);
      color: #ffd1d1;
      font-size:13px;
    }
    .foot{
      margin-top:12px;
      font-size:12px;
      color:var(--muted);
    }

    @media (max-width: 860px){
      .wrap{grid-template-columns: 1fr; }
      .brand{order:2}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="brand">
      <div class="logo">
        <img src="/static/logo.png" alt="Asisto"/>
      </div>
      <h1>Asisto</h1>
      <p>Entrá al panel de administración para gestionar conversaciones, comportamiento, horarios y catálogo por <b>tenant</b>.</p>
    </section>

    <section class="card">
      <h2>Iniciar sesión</h2>
      <form method="POST" action="/login">
        <input type="hidden" name="next" value="${safeNext}" />
        <label>Usuario</label>
        <input name="username" autocomplete="username" required />
        <label>Contraseña</label>
        <input name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Entrar</button>
      </form>
      ${safeErr ? `<div class="err">${safeErr}</div>` : ""}
      <div class="foot">Tip: el tenant se asigna automáticamente por el usuario.</div>
    </section>
  </div>
</body>
</html>`;
}

function menuHtml({ user, endpoints }) {
  const rows = (endpoints || []).map(e => {
    const badge = e.method || "";
    const href = e.path || "#";
    return `<a class="item" href="${href}">
      <div class="left">
        <div class="title">${(e.label || href).replace(/</g,"&lt;")}</div>
        <div class="sub">${href.replace(/</g,"&lt;")}</div>
      </div>
      <div class="badge">${badge}</div>
    </a>`;
  }).join("");

  const uname = String(user?.username || "usuario").replace(/</g,"&lt;");
  const tenant = String(user?.tenantId || "").replace(/</g,"&lt;");
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Asisto | Menú</title>
  <style>
    :root{
      --bg:#0b1f33;
      --panel:#0f2a44;
      --text:#e9f1ff;
      --muted:rgba(233,241,255,.72);
      --border:rgba(255,255,255,.10);
      --accent:#20d3a8;
      --shadow: 0 18px 60px rgba(0,0,0,.35);
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial;
      background: radial-gradient(1200px 600px at 20% 10%, rgba(32,211,168,.18), transparent 55%),
                  radial-gradient(1000px 600px at 80% 20%, rgba(32,211,168,.10), transparent 60%),
                  var(--bg);
      color: var(--text);
      min-height:100vh;
      padding:24px;
    }
    header{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      margin-bottom:18px;
    }
    .brand{
      display:flex; align-items:center; gap:12px;
    }
    .brand img{height:34px}
    .brand .title{font-weight:900; letter-spacing:.2px}
    .who{
      color:var(--muted);
      font-size:13px;
    }
    .btn{
      border:1px solid var(--border);
      background: rgba(0,0,0,.16);
      color: var(--text);
      padding:10px 12px;
      border-radius:14px;
      text-decoration:none;
      font-weight:700;
    }
    .wrap{
      width:min(980px, 100%);
      margin:0 auto;
    }
    .grid{
      display:grid;
      grid-template-columns: repeat(2, 1fr);
      gap:12px;
    }
    .panel{
      background: linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.03));
      border:1px solid var(--border);
      border-radius:22px;
      box-shadow: var(--shadow);
      overflow:hidden;
    }
    .panel h2{
      margin:0;
      padding:16px 16px 10px;
      font-size:16px;
    }
    .items{display:flex; flex-direction:column}
    .item{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      padding:14px 16px;
      border-top:1px solid var(--border);
      color:var(--text);
      text-decoration:none;
    }
    .item:hover{background: rgba(0,0,0,.14)}
    .title{font-weight:800}
    .sub{color:var(--muted); font-size:12px; margin-top:3px}
    .badge{
      font-size:12px;
      border:1px solid var(--border);
      padding:6px 10px;
      border-radius:999px;
      color:var(--muted);
      white-space:nowrap;
    }
    @media (max-width: 860px){
      .grid{grid-template-columns: 1fr;}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">
        <img src="/static/logo.png" alt="Asisto"/>
        <div>
          <div class="title">Asisto | Panel</div>
          <div class="who">Usuario: <b>${uname}</b> · Tenant: <b>${tenant}</b></div>
        </div>
      </div>
      <a class="btn" href="/logout">Salir</a>
    </header>

    <div class="panel">
      <h2>Accesos</h2>
      <div class="items">
        ${rows || `<div style="padding:16px;color:var(--muted)">No hay endpoints configurados.</div>`}
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function findUserByUsername(username) {
  const db = await getDb();
  const u = String(username || "").trim().toLowerCase();
  // Permitimos username o email, pero guardamos normalizado en "username"
  return db.collection("users").findOne({ username: u, active: { $ne: false } });
}

function mountAuthRoutes(app, { endpoints = [] } = {}) {
  // Servir logo desde /static/logo.png (poné logo.png en la misma carpeta del server)
  app.get("/static/logo.png", (req, res) => {
    // Ajustá el path si lo guardás en /public/logo.png, etc.
    const p = path.join(__dirname, "logo.png");
    return res.sendFile(p);
  });

  app.get("/login", (req, res) => {
    if (req.user) return res.redirect("/app");
    const nextUrl = req.query.next ? String(req.query.next) : "/app";
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(loginHtml({ nextUrl }));
  });

  app.post("/login", async (req, res) => {
    try {
      const username = String(req.body?.username || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      const nextUrl = String(req.body?.next || req.query.next || "/app");

      if (!username || !password) {
        res.status(400);
        return res.send(loginHtml({ error: "Completá usuario y contraseña.", nextUrl }));
      }

      const user = await findUserByUsername(username);
      if (!user || !user.password) {
        res.status(401);
        return res.send(loginHtml({ error: "Usuario o contraseña inválidos.", nextUrl }));
      }

      const ok = verifyPassword(password, user.password);
      if (!ok) {
        res.status(401);
        return res.send(loginHtml({ error: "Usuario o contraseña inválidos.", nextUrl }));
      }

      const payload = {
        uid: String(user._id),
        u: String(user.username || username),
        tenantId: String(user.tenantId || "default"),
        role: String(user.role || "user"),
        exp: Date.now() + COOKIE_MAX_AGE_MS,
      };

      const token = signToken(payload);
      setCookie(res, COOKIE_NAME, token, { maxAge: COOKIE_MAX_AGE_MS });

      return res.redirect(nextUrl || "/app");
    } catch (e) {
      console.error("[auth] login error:", e?.message || e);
      res.status(500);
      return res.send(loginHtml({ error: "Error interno.", nextUrl: "/app" }));
    }
  });

  app.get("/logout", (req, res) => {
    clearCookie(res, COOKIE_NAME);
    res.redirect("/login");
  });

  app.get("/app", requireAuth, (req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(menuHtml({ user: req.user, endpoints }));
  });

  // Handy endpoint
  app.get("/api/me", requireAuth, (req, res) => {
    res.json({ ok: true, user: req.user });
  });
}

module.exports = {
  mountAuthRoutes,
  attachUser,
  requireAuth,
  hashPassword,
};
