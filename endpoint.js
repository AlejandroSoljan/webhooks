// endpoint.js
// Servidor Express y endpoints (webhook, behavior API/UI, cache, salud) con multi-tenant
// Incluye logs de fixReply en el loop de corrección.

require("dotenv").config();
const express = require("express");
const app = express();

const crypto = require("crypto");
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;

// ⬇️ Para catálogo en Mongo
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");
const { getRuntimeByPhoneNumberId, findAnyByVerifyToken, upsertTenantChannel } = require("./tenant_runtime");
const TENANT_ID = (process.env.TENANT_ID || "").trim();


// Días de la semana para configuración de horarios
const STORE_HOURS_DAYS = [
  { key: "monday", label: "Lunes" },
  { key: "tuesday", label: "Martes" },
  { key: "wednesday", label: "Miércoles" },
  { key: "thursday", label: "Jueves" },
  { key: "friday", label: "Viernes" },
  { key: "saturday", label: "Sábado" },
  { key: "sunday", label: "Domingo" },
];
// ⬇️ Para páginas y formularios simples (admin)
const path = require("path");

// ⬇️ Auth UI (login + sesiones + admin usuarios)
const auth = require("./auth_ui");
// Servir assets estáticos locales (logo.png)
// Servir assets estáticos:
// 1) Logos del slider en /static/clientes -> <proyecto>/static/clientes
app.use("/static/clientes", express.static(path.join(__dirname, "static", "clientes")));
// 2) Mantener compatibilidad con /static/logo.png si está en la raíz del proyecto
app.use("/static", express.static(path.join(__dirname)));
// Necesario para formularios HTML (login / admin users)
app.use(express.urlencoded({ extended: true }));
// Adjunta req.user desde cookie de sesión (si existe)
app.use(auth.attachUser);
// Rutas: /login, /logout, /app, /admin/users...
auth.mountAuthRoutes(app);
// Asegura que el shell /ui quede protegido (aunque cambie protectRoutes)
app.use("/ui", auth.requireAuth);
// Protege rutas sensibles (admin/api/ui) detrás de login
auth.protectRoutes(app);


// ===================== Tenant Channels (WhatsApp/OpenAI por tenant/canal) =====================
// Permite definir por tenant (y por teléfono) los valores que antes estaban en .env:
// - phoneNumberId, whatsappToken, verifyToken, openaiApiKey
// Nota: el webhook usa esta colección para enrutar multi-teléfono.
//
// Requiere rol admin.
app.get("/api/tenant-channels", auth.requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const tenant = String(req.query.tenantId || resolveTenantId(req) || "").trim();

    const q = {};
    if (tenant) q.tenantId = tenant;

    const rows = await db.collection("tenant_channels").find(q).sort({ updatedAt: -1, createdAt: -1 }).toArray();

    // Por seguridad, si NO sos superadmin, enmascaramos secretos al listar
    const isSuper = String(req.user?.role || "").toLowerCase() === "superadmin";

    const safe = rows.map(r => ({
      _id: String(r._id),
      tenantId: r.tenantId || null,
      phoneNumberId: r.phoneNumberId || null,
      displayPhoneNumber: r.displayPhoneNumber || null,
      isDefault: !!r.isDefault,
      updatedAt: r.updatedAt || null,
      createdAt: r.createdAt || null,
      whatsappToken: isSuper ? (r.whatsappToken || null) : (r.whatsappToken ? "********" : null),
      verifyToken: isSuper ? (r.verifyToken || null) : (r.verifyToken ? "********" : null),
      openaiApiKey: isSuper ? (r.openaiApiKey || null) : (r.openaiApiKey ? "********" : null),
    }));

    res.json({ ok: true, tenant: tenant || null, items: safe });
  } catch (e) {
    console.error("GET /api/tenant-channels error:", e?.message || e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/tenant-channels", auth.requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    // Si NO es superadmin, forzamos tenantId al del usuario (no puede escribir otros tenants)
    const isSuper = String(req.user?.role || "").toLowerCase() === "superadmin";
    const tenantForced = resolveTenantId(req);

    const payload = {
      tenantId: isSuper ? (body.tenantId || tenantForced) : tenantForced,
      phoneNumberId: body.phoneNumberId,
      displayPhoneNumber: body.displayPhoneNumber,
      // isDefault puede venir como "1" / "true" / "on"
      isDefault:
        body.isDefault === "1" ||
        body.isDefault === "true" ||
        body.isDefault === "on" ||
        body.isDefault === 1 ||
        body.isDefault === true
          ? true
          : undefined,
      whatsappToken: body.whatsappToken,
      verifyToken: body.verifyToken,
      openaiApiKey: body.openaiApiKey,
    };

    const r = await upsertTenantChannel(payload, { allowSecrets: true });

    // Si se marcó default, desmarcar cualquier otro canal default del mismo tenant
    if (payload.isDefault === true) {
      const db = await getDb();
      await db.collection("tenant_channels").updateMany(
        { tenantId: String(payload.tenantId), phoneNumberId: { $ne: String(payload.phoneNumberId) } },
        { $set: { isDefault: false, updatedAt: new Date() } }
      );
    }
    res.json({ ok: true, result: r });
  } catch (e) {
    console.error("POST /api/tenant-channels error:", e?.message || e);
    res.status(400).json({ error: e?.message || "bad_request" });
  }
});


// ===================== WhatsApp Web Sessions Control (WWeb) =====================
// Admin API para controlar políticas (allow any / pinned host / blocked hosts),
// ver estado de locks y leer historial.
// Requiere sesión (login) y rol admin.
app.use("/api/wweb", auth.requireAdmin);

async function wwebCollections(db) {
  return {
    locks: db.collection("wa_locks"),
    policies: db.collection("wa_wweb_policies"),
    history: db.collection("wa_wweb_history"),
    actions: db.collection("wa_wweb_actions"),
  };
}

function wwebLockId(tenantId, numero) {
  return `${String(tenantId || "").trim()}:${String(numero || "").trim()}`;
}

function wwebHostFromReq(req) {
  // quien hace el request (admin panel)
  return String(req.headers["x-hostname"] || req.headers["x-pc-name"] || req.ip || "").trim();
}

async function wwebLog(db, entry) {
  try {
    const { history } = await wwebCollections(db);
    await history.insertOne({
      lockId: entry.lockId || null,
      tenantId: entry.tenantId || null,
      numero: entry.numero || null,
      event: String(entry.event || "event"),
      host: entry.host || null,
      by: entry.by || (req?.user?.email || req?.user?.username || "admin"), // best-effort
      detail: entry.detail || null,
      at: new Date(),
    });
  } catch {}
}

// GET /api/wweb/sessions  -> lista estado (locks + policies) para el panel
app.get("/api/wweb/sessions", async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const db = await getDb();
    const { locks, policies } = await wwebCollections(db);

    const [lockDocs, policyDocs] = await Promise.all([
      locks.find(tenantId ? { _id: new RegExp("^" + tenantId + ":") } : {}).toArray(),
      policies.find(tenantId ? { tenantId } : {}).toArray(),
    ]);

    const policyById = new Map(policyDocs.map(p => [p._id, p]));
    const sessions = lockDocs.map(l => {
      const [tid, num] = String(l._id || "").split(":");
      const pol = policyById.get(l._id) || null;
      return {
        lockId: l._id,
        tenantId: tid,
        numero: num,
        state: l.state || null,
        holderId: l.holderId || null,
        host: l.host || l.hostname || null,
        pid: l.pid || null,
        lastSeenAt: l.lastSeenAt || l.updatedAt || null,
        policy: pol ? {
          mode: pol.mode || "any",
          pinnedHost: pol.pinnedHost || null,
          blockedHosts: Array.isArray(pol.blockedHosts) ? pol.blockedHosts : [],
          updatedAt: pol.updatedAt || null,
          updatedBy: pol.updatedBy || null,
        } : { mode: "any", pinnedHost: null, blockedHosts: [] },
      };
    });

    // incluir policies sin lock (por si querés preconfigurar)
    for (const p of policyDocs) {
      if (sessions.some(s => s.lockId === p._id)) continue;
      sessions.push({
        lockId: p._id,
        tenantId: p.tenantId,
        numero: p.numero,
        state: null,
        holderId: null,
        host: null,
        pid: null,
        lastSeenAt: null,
        policy: {
          mode: p.mode || "any",
          pinnedHost: p.pinnedHost || null,
          blockedHosts: Array.isArray(p.blockedHosts) ? p.blockedHosts : [],
          updatedAt: p.updatedAt || null,
          updatedBy: p.updatedBy || null,
        },
      });
    }

    sessions.sort((a,b)=> String(a.lockId).localeCompare(String(b.lockId)));
    return res.json({ ok: true, sessions });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// POST /api/wweb/policy
// body: { tenantId?, numero, mode: "any"|"pinned", pinnedHost?, blockHost?, unblockHost? }
app.post("/api/wweb/policy", async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || resolveTenantId(req) || "").trim();
    const numero = String(req.body?.numero || "").trim();
    if (!tenantId || !numero) return res.status(400).json({ ok:false, error:"tenantId_numero_required" });

    const id = wwebLockId(tenantId, numero);
    const mode = String(req.body?.mode || "").trim().toLowerCase();
    const pinnedHost = String(req.body?.pinnedHost || "").trim();
    const blockHost = String(req.body?.blockHost || "").trim();
    const unblockHost = String(req.body?.unblockHost || "").trim();

    const db = await getDb();
    const { policies, history } = await wwebCollections(db);

    const update = { $setOnInsert: { _id: id, tenantId, numero }, $set: { updatedAt: new Date(), updatedBy: (req.user?.email || req.user?.username || "admin") } };
    if (mode === "any" || mode === "pinned") update.$set.mode = mode;
    if (mode === "pinned") update.$set.pinnedHost = pinnedHost || wwebHostFromReq(req) || null;
    if (mode === "any") update.$set.pinnedHost = null;

    if (blockHost) update.$addToSet = { ...(update.$addToSet||{}), blockedHosts: blockHost };
    if (unblockHost) update.$pull = { ...(update.$pull||{}), blockedHosts: unblockHost };

    const r = await policies.updateOne({ _id: id }, update, { upsert: true });

    await history.insertOne({
      lockId: id, tenantId, numero,
      event: "policy_update",
      host: wwebHostFromReq(req) || null,
      by: (req.user?.email || req.user?.username || "admin"),
      detail: { mode: update.$set.mode, pinnedHost: update.$set.pinnedHost, blockHost, unblockHost },
      at: new Date(),
    });

    return res.json({ ok:true, lockId: id, modified: r.modifiedCount, upserted: !!r.upsertedId });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// POST /api/wweb/release  body: { tenantId?, numero }
app.post("/api/wweb/release", async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || resolveTenantId(req) || "").trim();
    const numero = String(req.body?.numero || "").trim();
    if (!tenantId || !numero) return res.status(400).json({ ok:false, error:"tenantId_numero_required" });

    const id = wwebLockId(tenantId, numero);
    const db = await getDb();
    const { locks, actions, history } = await wwebCollections(db);

    // borrar lock para que otra PC pueda tomarlo
    await locks.deleteOne({ _id: id });

    // opcional: encolar acción para que el script (si lo implementaste) la procese
    await actions.insertOne({ lockId: id, tenantId, numero, action: "release", requestedBy: (req.user?.email || req.user?.username || "admin"), at: new Date() });

    await history.insertOne({ lockId:id, tenantId, numero, event:"release_requested", host: wwebHostFromReq(req)||null, by:(req.user?.email||req.user?.username||"admin"), detail:null, at:new Date() });
    return res.json({ ok:true, lockId:id });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// GET /api/wweb/history?tenantId=&numero=&limit=100
app.get("/api/wweb/history", async (req, res) => {
  try {
    const tenantId = String(req.query?.tenantId || "").trim();
    const numero = String(req.query?.numero || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit || 100)));

    const db = await getDb();
    const { history } = await wwebCollections(db);

    const q = {};
    if (tenantId) q.tenantId = tenantId;
    if (numero) q.numero = numero;

    const items = await history.find(q).sort({ at: -1 }).limit(limit).toArray();
    return res.json({ ok:true, items });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});


const {
  loadBehaviorTextFromMongo,
  loadBehaviorConfigFromMongo,
  invalidateBehaviorCache,
  getGPTReply, hasActiveEndedFlag, markSessionEnded, isPoliteClosingMessage,
  syncSessionConversation,
  START_FALLBACK, buildBackendSummary, coalesceResponse, recalcAndDetectMismatch,
  hydratePricesFromCatalog,
  putInCache, getFromCache, getMediaInfo, downloadMediaBuffer, transcribeAudioExternal,
  DEFAULT_TENANT_ID, setAssistantPedidoSnapshot, calcularDistanciaKm,
  geocodeAddress, getStoreCoords, pickEnvioProductByDistance,clearEndedFlag,analyzeImageExternal,
  ensureEnvioSmart,hasContext,
} = require("./logic");

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

function isValidSignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");
  if (!appSecret || !signature) return false;
  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(req.rawBody);
  const expected = "sha256=" + hmac.digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}

function resolveTenantId(req) {
  return auth.resolveTenantId(req, { defaultTenantId: DEFAULT_TENANT_ID, envTenantId: process.env.TENANT_ID });
}

// Health
// Root: en Render queremos que abra la UI (/app) en lugar de responder "OK".
// Conserva querystring si lo hubiera.
app.get("/", (req, res) => {
  const original = String(req.originalUrl || "/");
  const qs = original.includes("?") ? original.split("?").slice(1).join("?") : "";
  return res.redirect(302, "/app" + (qs ? `?${qs}` : ""));
});


app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Cache público (audio)
function sendCacheItem(res, item) {
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  return res.send(item.buffer);
}

// Backward compatible (audio)
app.get("/cache/audio/:id", (req, res) => {
  const item = getFromCache(req.params.id);
 return sendCacheItem(res, item);
});

// Nuevo: cache genérico para media (imágenes / audio / etc.)
app.get("/cache/media/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  return sendCacheItem(res, item);
});

// ===================================================================
// ===============       Catálogo de productos        ================
// ===================================================================

// ---------- LOGS: helpers ----------
const withTenant = (q = {}, tenantId) => {
  const out = { ...q };
  const tid = (tenantId || TENANT_ID || "").trim();
  if (tid) out.tenantId = tid;
  return out;
};

// Normaliza el estado para mostrarlo en /admin (ej: CANCELLED -> CANCELADA).
// Importante: si el registro ya trae un status explícito, ese status debe
// prevalecer (aunque finalized=true), porque puede ser una conversación
// finalizada por cancelación del usuario.
function adminStatusLabel(conv) {
  const raw = String(conv?.status || "").trim();
  const up = raw.toUpperCase();

  // Cancelaciones (aceptamos variantes)
  if (up === "CANCELLED" || up === "CANCELED" || up === "CANCELADA" || up === "CANCELADO") {
    return "CANCELADA";
  }

  // Si hay status persistido, lo devolvemos tal cual (en mayúsculas típicas)
  if (raw) return up;

  // Fallback si no hay status explícito
  return conv?.finalized ? "COMPLETED" : "OPEN";
}
// Parseo tolerante de filtro "entregado":
// - true  => entregadas
// - false => NO entregadas
// - null  => todas
function parseDeliveredFilter(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (["1", "true", "yes", "si", "sí", "entregado", "entregada", "delivered"].includes(v)) return true;
  if (["0", "false", "no", "pendiente", "pendientes", "noentregado", "no_entregado", "not_delivered"].includes(v)) return false;
  return null;
}

// ===== Orden "próximos a entregar" (AR -03:00) =====
function _toMs(v) {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

// Convierte fechaEntrega (YYYY-MM-DD) + horaEntrega (HH:MM) a ms.
// Si falta hora, usamos 23:59 para que quede "más tarde" dentro del mismo día.
function pedidoEntregaMs(fechaEntrega, horaEntrega) {
  const f = String(fechaEntrega || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  const h = /^\d{2}:\d{2}$/.test(String(horaEntrega || "").trim())
    ? String(horaEntrega).trim()
   : "23:59";
  // Argentina (Córdoba): -03:00
  const iso = `${f}T${h}:00-03:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function compareConvsForEntrega(a, b) {
  const aHasPedido = a?.fechaEntrega && a.fechaEntrega !== "-";
  const bHasPedido = b?.fechaEntrega && b.fechaEntrega !== "-";

  const aPending = aHasPedido && a?.delivered !== true;
  const bPending = bHasPedido && b?.delivered !== true;

  // 1) Pendientes arriba
  if (aPending !== bPending) return aPending ? -1 : 1;

  const aPedidoMs = aHasPedido ? pedidoEntregaMs(a.fechaEntrega, a.horaEntrega) : null;
  const bPedidoMs = bHasPedido ? pedidoEntregaMs(b.fechaEntrega, b.horaEntrega) : null;

  // 2) Si ambos pendientes: más próximos primero
  if (aPending && bPending) {
    if (aPedidoMs !== null && bPedidoMs !== null && aPedidoMs !== bPedidoMs) return aPedidoMs - bPedidoMs;
    if (aPedidoMs !== null && bPedidoMs === null) return -1;
    if (aPedidoMs === null && bPedidoMs !== null) return 1;
    return _toMs(b.lastAt) - _toMs(a.lastAt);
  }

  // 3) No pendientes: primero los que tienen pedido
  if (aHasPedido !== bHasPedido) return aHasPedido ? -1 : 1;

  // 4) Entregadas / resto: por fecha/hora del pedido (más reciente primero)
  if (aHasPedido && bHasPedido) {
    const am = aPedidoMs ?? 0, bm = bPedidoMs ?? 0;
    if (am !== bm) return bm - am;
  }

  // 5) Fallback por actividad reciente
  return _toMs(b.lastAt) - _toMs(a.lastAt);
}


async function saveLog(entry) {
  try {
    const db = await getDb();
    const doc = {
      tenantId: (entry?.tenantId || TENANT_ID || DEFAULT_TENANT_ID || null),
      waId: entry.waId || null,
      role: entry.role,             // 'user' | 'assistant' | 'system'
      content: entry.content ?? "",
      payload: entry.payload ?? null, // cualquier JSON extra (Pedido/estado/trace)
    createdAt: new Date()
    };
    await db.collection("logs").insertOne(doc);
  } catch (e) {
    console.error("[logs] saveLog error:", e);
  }
}

 
// ================== Persistencia de conversaciones y mensajes ==================
// ================== Persistencia de conversaciones y mensajes ==================
async function upsertConversation(waId, init = {}, tenantId) {
  const db = await getDb();
  const now = new Date();
  const tenant = String(tenantId || TENANT_ID || DEFAULT_TENANT_ID || "default");

   // 👉 Solo conversaciones abiertas: si la última está finalizada/cancelada, se creará un registro nuevo
  const filter = { waId: String(waId), tenantId: tenant, finalized: { $ne: true }, status: { $nin: ["COMPLETED", "CANCELLED"] } };
  const update = {
    $setOnInsert: { createdAt: now, openedAt: now, status: "OPEN", manualOpen: false },
   
    $set: { updatedAt: now, ...init },
  };
  // Para driver moderno
  const opts = { upsert: true, returnDocument: "after" };
  // Si tu driver es 4.x antiguo, usar en su lugar: { upsert:true, returnOriginal:false }

  const res = await db.collection("conversations").findOneAndUpdate(filter, update, opts);
  if (res && res.value) return res.value;
  // (Quitar fallback insertOne para evitar duplicados en condiciones de carrera)
  return await db.collection("conversations").findOne(filter);
}
// ------- helper para cerrar conversación (finalizar/cancelar) -------
async function closeConversation(convId, status = "COMPLETED", extra = {}) {
  try {
    const db = await getDb();
    const now = new Date();
    await db.collection("conversations").updateOne(
      { _id: new ObjectId(String(convId)) },
      { $set: { finalized: true, status, closedAt: now, updatedAt: now, ...extra } }
    );
  } catch (e) {
    console.error("closeConversation error:", e?.message || e);
  }
}

// ------- helper para validar que el pedido esté completo antes de cerrar -------
function isPedidoCompleto(p) {
  try {
    if (!p) return false;
    const itemsOk   = Array.isArray(p.items) && p.items.length > 0;
    const entregaOk = p.Entrega === 'retiro' || p.Entrega === 'domicilio';
    const dirOk     = p.Entrega !== 'domicilio'
      || (p.Domicilio && p.Domicilio.direccion && String(p.Domicilio.direccion).trim());
    const fechaOk   = /^\d{4}-\d{2}-\d{2}$/.test(p.Fecha || "");
    const horaOk    = /^\d{2}:\d{2}$/.test(p.Hora  || "");
    return itemsOk && entregaOk && dirOk && fechaOk && horaOk;
  } catch {
    return false;
  }
}

// ------- helper: validación de fecha/hora del pedido contra horarios configurados -------
function _hhmmToMinutes(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function _weekdayKeyFromISODate(isoDate) {
  try {
    const val = String(isoDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return null;
    // Usamos el mediodía para evitar problemas de timezone
    const d = new Date(`${val}T12:00:00`);
    const idx = d.getDay(); // 0=Domingo ... 6=Sábado
    const map = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    return map[idx] || null;
  } catch {
    return null;
  }
}

/**
 * Valida que Pedido.Fecha / Pedido.Hora caigan dentro de los horarios configurados.
 * @param {Object} pedido   Pedido con { Fecha: 'YYYY-MM-DD', Hora: 'HH:MM', ... }
 * @param {Object} hoursCfg Objeto { monday:[{from,to}], tuesday:[...], ... }
 * @returns {{ok:boolean, reason:string|null, msg:string}}
 */
function validatePedidoSchedule(pedido, hoursCfg) {
  const result = { ok: true, reason: null, msg: "" };
  try {
    if (!pedido || !hoursCfg) return result;

    const fecha = String(pedido.Fecha || "").trim();
    const hora  = String(pedido.Hora  || "").trim();

    // Si el formato no es el esperado, no forzamos nada (lo valida la lógica actual)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return result;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return result;

    const dayKey = _weekdayKeyFromISODate(fecha);
    if (!dayKey) return result;

    const ranges = Array.isArray(hoursCfg[dayKey]) ? hoursCfg[dayKey] : [];

    // Día sin horarios configurados => consideramos cerrado
    if (!ranges.length) {
      const dayLabel =
        (STORE_HOURS_DAYS.find(d => d.key === dayKey)?.label) || "ese día";

      // Armamos una línea con todos los horarios configurados para informar bien
      const parts = [];
      for (const d of STORE_HOURS_DAYS) {
        const rs = Array.isArray(hoursCfg[d.key]) ? hoursCfg[d.key] : [];
        if (!rs.length) continue;
        const slots = rs.map(r => `${r.from} a ${r.to}`).join(" y ");
        parts.push(`${d.label}: ${slots}`);
      }
      const allLabel = parts.length ? parts.join(" | ") : "";

      result.ok = false;
      result.reason = "day_closed";
      result.msg = allLabel
        ? `Para ${dayLabel} no tenemos horarios disponibles para recibir pedidos.\n\nNuestros horarios configurados son:\n${allLabel}.\n\n¿Querés elegir otro día y horario dentro de esas franjas?`
        : `Para ${dayLabel} no tenemos horarios disponibles para recibir pedidos. ¿Querés elegir otro día en el que estemos abiertos?`;
      return result;
    }

    const minutes = _hhmmToMinutes(hora);
    if (minutes == null) return result;

    const inside = ranges.some(r => {
      const fromM = _hhmmToMinutes(r.from);
      const toM   = _hhmmToMinutes(r.to);
      if (fromM == null || toM == null) return false;
      return minutes >= fromM && minutes <= toM;
    });

    if (!inside) {
      const dayLabel =
        (STORE_HOURS_DAYS.find(d => d.key === dayKey)?.label) || "ese día";
      const slots = ranges.map(r => `${r.from} a ${r.to}`).join(" y ");

      result.ok = false;
      result.reason = "time_outside_ranges";
      result.msg =
        `En ${dayLabel} no tomamos pedidos para las ${hora}. ` +
        `Para ese día nuestro horario de atención es: ${slots}.\n\n` +
        `¿Querés elegir otro horario dentro de esa franja?`;
      return result;
    }

    return result;
  } catch {
    // Ante cualquier error no rompemos el flujo ni sobreescribimos el mensaje
    return result;
  }
}


async function saveMessageDoc({ conversationId, waId, role, content, type = "text", meta = {}, tenantId }) {
  console.log("[messages] entering saveMessageDoc", { conversationId: String(conversationId || ""), role, type, hasMeta: !!meta });
  if (!conversationId) {
    throw new Error("conversationId_missing");
  }
  try {
    const db = await getDb();
    const now = new Date();
    const convObjectId =
      (conversationId && typeof conversationId === "object" && conversationId._bsontype === "ObjectID")
        ? conversationId
        : new ObjectId(String(conversationId));

    const roleStr = String(role);
    const typeStr = String(type || "text");

    // 🔹 Helper: actualizar resumen de Pedido en `conversations` usando el JSON del assistant
    async function persistPedidoResumenFromAssistantJson() {
      if (roleStr !== "assistant") return;
      try {
        const s = String(content || "").trim();
        if (!s.startsWith("{")) return;
        const j = JSON.parse(s);
        if (!j || !j.Pedido || !Array.isArray(j.Pedido.items)) return;
        const pedido = j.Pedido || {};
 
        // Estado del flujo (IN_PROGRESS | COMPLETED | CANCELLED | PENDIENTE)
        const estadoStr = String(j.estado || "").trim().toUpperCase();
        const isFinalEstado = (estadoStr === "COMPLETED" || estadoStr === "CANCELLED");


        // 🧾 Nombre y apellido directo desde el Pedido (toma prioridad sobre heurísticas de texto)
        const nombreFromPedido = String(
          pedido.nombre_apellido || pedido.nombre || ""
        ).trim();

       // 🛠️ Normalizar/Inferir entrega:
       const entregaRaw = String(pedido.Entrega || "").trim().toLowerCase();
        const envioItem = (pedido.items || []).find(i =>
          /env[ií]o/i.test(String(i?.descripcion || ""))
        );

        // ¿Hay dirección en el JSON?
        const hasAddress =
          pedido?.Domicilio &&
          typeof pedido.Domicilio === "object" &&
          Object.values(pedido.Domicilio).some(v => String(v || "").trim() !== "");

        // Si Entrega no es 'domicilio'/'retiro' pero hay dirección o envío → forzar 'domicilio'
        let entrega = (entregaRaw === "domicilio" || entregaRaw === "retiro")
          ? entregaRaw
          : ((hasAddress || !!envioItem) ? "domicilio" : (entregaRaw || ""));

        // Dirección amigable:
        // - Si Domicilio es string → usarlo directo
        // - Si es objeto → usar .direccion / .calle
        // - Si no hay dirección pero sí ítem de envío → usar descripción del envío
        let direccion = "";
        if (typeof pedido.Domicilio === "string") {
          direccion = pedido.Domicilio.trim();
        } else if (pedido.Domicilio && typeof pedido.Domicilio === "object") {
          direccion = String(
            pedido.Domicilio.direccion ||
            pedido.Domicilio.calle ||
            ""
          ).trim();
        }
        if (!direccion && envioItem) {
          direccion = String(envioItem.descripcion || "").trim();
        }

        // Etiqueta de entrega para la tabla: solo "Envío" o "Retiro"
        let entregaLabel;
        if (entrega === "domicilio") {
          entregaLabel = "Envío";
        } else if (entrega === "retiro") {
          entregaLabel = "Retiro";
        } else {
          entregaLabel = "-";
        }

        // Fecha/Hora sólo si vienen en campos normales
        const fechaEntrega = /^\d{4}-\d{2}-\d{2}$/.test(String(pedido.Fecha || "")) ? pedido.Fecha : null;
        const horaEntrega  = /^\d{2}:\d{2}$/.test(String(pedido.Hora  || "")) ? pedido.Hora  : null;

        await db.collection("conversations").updateOne(
          { _id: convObjectId },
          {
            $set: {
              updatedAt: now,
              lastAssistantTs: now,
              pedidoEntrega: entrega || null,
              pedidoEntregaLabel: entregaLabel || null,
              ...(direccion ? { pedidoDireccion: direccion } : {}),
              ...(fechaEntrega ? { pedidoFecha: fechaEntrega } : {}),
              ...(horaEntrega  ? { pedidoHora:  horaEntrega  } : {}),
              ...(nombreFromPedido ? { contactName: nombreFromPedido } : {}),
              ...(estadoStr ? { pedidoEstado: estadoStr } : {}),
              ...(isFinalEstado ? { finalized: true, status: estadoStr, closedAt: now } : {})
    
            }
          }
        );
      } catch (e) {
        console.warn("[messages] no se pudo persistir resumen de Pedido en conversations:", e?.message);
      }
    }

    // 🚫 Si es el mensaje JSON del assistant, NO lo guardamos en `messages`,
    //     solo actualizamos el resumen del Pedido en `conversations` y salimos.
    if (roleStr === "assistant" && typeStr === "json") {
      await persistPedidoResumenFromAssistantJson();
      return;
    }

    const doc = {
      tenantId: (tenantId ?? TENANT_ID ?? null),
      conversationId: convObjectId,
      waId: String(waId || ""),
      role: String(role),
      content: String(content ?? ""),
      type: typeStr,
      meta: { ...meta },
      ts: now,
      createdAt: now
    };
    const ins = await db.collection("messages").insertOne(doc);
    console.log("[messages] inserted:", ins?.insertedId?.toString?.());
    // 🟢 Actualizar conversación: nombre/apellido (desde texto)
    // 1) Intento de extracción de NOMBRE desde cualquier mensaje (user/assistant)
    try {
      const text = String(content || "").trim();
      let nameHit = "";
      // a nombre de <Nombre>
      let m = text.match(/\ba nombre de\s+([a-záéíóúñü][a-záéíóúñü\s.'-]{2,})/i);
      if (m && m[1]) nameHit = m[1].trim();
      // Nombre: <Nombre>
      if (!nameHit) { m = text.match(/\bNombre\s*:\s*([a-záéíóúñü][a-záéíóúñü\s.'-]{2,})/i); if (m && m[1]) nameHit = m[1].trim(); }
      // Gracias, <Nombre>
      if (!nameHit) { m = text.match(/\bgracias[,:\s]+([a-záéíóúñü][a-záéíóúñü\s.'-]{2,})/i); if (m && m[1]) nameHit = m[1].trim(); }
      if (nameHit) {
        await db.collection("conversations").updateOne(
          { _id: convObjectId },
          { $set: { updatedAt: now, contactName: nameHit } }
        );
      }
    } catch (e) {
      console.warn("[messages] nombre no detectado:", e?.message);
    }

    
  } catch (e) {
    console.error("[messages] save error:", e?.stack || e?.message || e);
    throw e;
  }
}




// === Helpers para resumen de Pedido (fecha/hora/entrega/envío) ===
async function _getLastPedidoSummary(db, convId, tenantId) {
 try {
    const filter = withTenant({ conversationId: new ObjectId(String(convId)), role: "assistant" }, tenantId);
    const cursor = db.collection("messages")
      .find(filter)
      .sort({ ts: -1, createdAt: -1 })
      .limit(200);
    let pedido = null;
    for await (const m of cursor) {
      const s = String(m.content || "").trim();
      try {
        const j = JSON.parse(s);
        if (j && j.Pedido && Array.isArray(j.Pedido.items)) { pedido = j.Pedido; break; }
      } catch {}
    }
    if (!pedido) return { entregaLabel: "-", fechaEntrega: "-", horaEntrega: "-", direccion: "-" };

    // Entrega/Envío
    const entregaRaw = String(pedido.Entrega || "").trim().toLowerCase();
    const envio = (pedido.items || []).find(i => /env[ií]o/i.test(String(i?.descripcion || "")));

    let entregaLabel = "-";
    if (entregaRaw === "domicilio") {
      entregaLabel = "Envío";
    } else if (entregaRaw === "retiro") {
      entregaLabel = "Retiro";
    }

    // Dirección (string u objeto)
    let direccion = "";
    if (typeof pedido.Domicilio === "string") {
      direccion = pedido.Domicilio.trim();
    } else if (pedido.Domicilio && typeof pedido.Domicilio === "object") {
      direccion = String(
        pedido.Domicilio.direccion ||
        pedido.Domicilio.calle ||
        ""
      ).trim();
    }
    if (!direccion && envio) {
      direccion = String(envio.descripcion || "").trim();
    }

    // Día/Hora
    const fechaEntrega = /^\d{4}-\d{2}-\d{2}$/.test(String(pedido.Fecha || "")) ? pedido.Fecha : "-";
    const horaEntrega  = /^\d{2}:\d{2}$/.test(String(pedido.Hora  || "")) ? pedido.Hora  : "-";
    return { entregaLabel, fechaEntrega, horaEntrega, direccion: direccion || "-" };
  } catch {
    return { entregaLabel: "-", fechaEntrega: "-", horaEntrega: "-", direccion: "-" };
  }
}

// Listado de conversaciones reales (colección `conversations`)
// deliveredFilter:
//   - true  => solo entregadas
//   - false => solo NO entregadas (incluye docs sin el campo)
//   - null  => todas
async function listConversations(limit = 50, tenantId, deliveredFilter = null) {
  const db = await getDb();
  const q = withTenant({}, tenantId);

  // Filtro entregadas/no entregadas
  if (deliveredFilter === true) {
    q.delivered = true;
  } else if (deliveredFilter === false) {
    // incluye docs legacy sin el campo
    q.delivered = { $ne: true };
  }


  // 1) Traer conversaciones
  const rows = await db.collection("conversations")
    .find(q)
    .sort({ updatedAt: -1, closedAt: -1, openedAt: -1 })
    .limit(limit)
    .toArray();

  // 2) Traer órdenes asociadas para obtener distancia_km
  const convIds = rows.map(c => c._id).filter(Boolean);
  const ordersByConvId = new Map();

  if (convIds.length) {
    const cursor = db.collection("orders")
      .find({ conversationId: { $in: convIds } })
      .sort({ createdAt: -1 });

    for await (const ord of cursor) {
      const key = String(ord.conversationId);
      // Nos quedamos con la más reciente por conversación
      if (!ordersByConvId.has(key)) {
        ordersByConvId.set(key, ord);
      }
    }
  }

  // 3) Enriquecer con resumen de Pedido (fecha/hora/entrega/envío + distancia)
  const out = [];
  for (const c of rows) {
    const base = {
      _id: String(c._id),
      waId: c.waId,
      contactName: c.contactName || "-",
      status: adminStatusLabel(c),
      manualOpen: !!c.manualOpen,
      delivered: !!c.delivered,
      deliveredAt: c.deliveredAt || null,
      lastAt: c.lastUserTs || c.lastAssistantTs || c.updatedAt || c.closedAt || c.openedAt
    };

    const ord = ordersByConvId.get(String(c._id));
    const distanceKm =
      ord && ord.distancia_km !== undefined && ord.distancia_km !== null
        ? ord.distancia_km
        : null;

    // Preferir campos persistidos en conversations; si faltan, fallback a escanear mensajes
    if (c.pedidoEntregaLabel || c.pedidoFecha || c.pedidoHora || c.pedidoEntrega) {
      const extra = {
        entregaLabel:
          c.pedidoEntregaLabel
          || (c.pedidoEntrega === "domicilio"
                ? "Envío"
                : c.pedidoEntrega === "retiro"
                  ? "Retiro"
                  : "-"),
        fechaEntrega: c.pedidoFecha || "-",
        horaEntrega: c.pedidoHora || "-",
        direccion: c.pedidoDireccion || "-",
        ...(distanceKm !== null ? { distanceKm } : {})
      };
      out.push({ ...base, ...extra });
    } else {
      const extra = await _getLastPedidoSummary(db, c._id, tenantId);
      out.push({
        ...base,
        ...extra,
        ...(distanceKm !== null ? { distanceKm } : {})
      });
    }
  }
 
  // Orden final: pendientes arriba y más próximos a entregar
  out.sort(compareConvsForEntrega);
  return out;
}

// Mensajes por conversación
// Mensajes por conversación (colección `messages`)
async function getConversationMessagesByConvId(convId, limit = 500, tenantId) {
  const db = await getDb();
  const filter = withTenant({ conversationId: new ObjectId(String(convId)) }, tenantId);
  return db.collection("messages")
    .find(filter).sort({ ts: 1, createdAt: 1 }).limit(limit).toArray();
}
async function getConversationMessagesByWaId(waId, limit = 500, tenantId) {
  const db = await getDb();
  const conv = await db.collection("conversations").findOne(
    withTenant({ waId }, tenantId),
    { sort: { updatedAt: -1, openedAt: -1 } }
  );
  if (!conv) return [];
  return getConversationMessagesByConvId(conv._id, limit, tenantId);
}

// ---------- API de logs ----------
// Conversaciones (lista)
app.get("/api/logs/conversations", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "50", 10), 500));
    const deliveredFilter = parseDeliveredFilter(req.query.delivered);
    const rows = await listConversations(limit, resolveTenantId(req), deliveredFilter);
  
    res.json(rows);
  } catch (e) {
    console.error("GET /api/logs/conversations error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// Mensajes de una conversación
app.get("/api/logs/messages", async (req, res) => {
  try {
    const { convId, waId } = req.query;
    if (!convId && !waId) return res.status(400).json({ error: "convId or waId is required" });
    const t = resolveTenantId(req);
    const rows = convId
      ? await getConversationMessagesByConvId(convId, 500, t)
      : await getConversationMessagesByWaId(waId, 500, t);
    res.json(rows.map(m => ({
      _id: String(m._id),
      role: m.role,                     // "user" | "assistant" | "system"
      content: m.content,
      type: m.type,
      createdAt: m.ts || m.createdAt
    })));
  } catch (e) {
    console.error("GET /api/logs/messages error:", e);
    res.status(500).json({ error: "internal" });
  }
});


// ---------- Meta de conversación para admin (incluye manualOpen) ----------
app.get("/api/admin/conversation-meta", async (req, res) => {
  try {
    const { convId, waId } = req.query;
    if (!convId && !waId) {
      return res.status(400).json({ error: "convId_or_waId_required" });
    }
    const tenant = resolveTenantId(req);
    const db = await getDb();

    let conv = null;
    if (convId) {
      conv = await db.collection("conversations").findOne(
        withTenant({ _id: new ObjectId(String(convId)) }, tenant)
      );
    } else {
      conv = await db.collection("conversations").findOne(
        withTenant({ waId: String(waId) }, tenant),
        { sort: { updatedAt: -1, openedAt: -1 } }
      );
    }

    if (!conv) {
      return res.status(404).json({ error: "conv_not_found" });
    }

    res.json({
      ok: true,
      convId: String(conv._id),
      waId: conv.waId,
      contactName: conv.contactName || "",
      status: adminStatusLabel(conv),
      manualOpen: !!conv.manualOpen,
      delivered: !!conv.delivered,
      deliveredAt: conv.deliveredAt || null,
       // Canal/telefono del negocio por el que entró la conversación
       phoneNumberId: conv.phoneNumberId || null,
       displayPhoneNumber: conv.displayPhoneNumber || null,
    });
  } catch (e) {
    console.error("GET /api/admin/conversation-meta error:", e);
    res.status(500).json({ error: "internal" });
  }
});


// ---------- Página /admin/inbox (UI estilo WhatsApp Web) ----------
app.get("/admin/inbox", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const conversations = await listConversations(200, tenant);
    const urlConvId = String(req.query.convId || "");

    const initialConvs = JSON.stringify(conversations || []);

    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Admin | Inbox</title>
  <style>
    :root{
      --bg:#0b141a;
      --panel:#111b21;
      --panel-2:#202c33;
      --text:#e9edef;
      --muted:#aebac1;
      --accent:#00a884;
      --bubble-me:#005c4b;
      --bubble-them:#202c33;
      --border:rgba(255,255,255,.08);
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial;
      background:var(--bg);
      color:var(--text);
      height:100vh;
      overflow:hidden;
    }
    .app{
      display:flex;
      height:100vh;
      width:100vw;
    }

    /* ===== Left: Sidebar ===== */
    .sidebar{
      width:360px;
      min-width:280px;
      background:var(--panel);
      border-right:1px solid var(--border);
      display:flex;
      flex-direction:column;
    }
    .side-header{
      padding:14px 12px;
      background:var(--panel-2);
      display:flex;
      gap:8px;
      align-items:center;
      border-bottom:1px solid var(--border);
    }
    .side-header h1{
      font-size:16px;
      margin:0 8px 0 0;
      font-weight:600;
    }
    .search{
      padding:10px 12px;
      border-bottom:1px solid var(--border);
    }
    .search input{
      width:100%;
      padding:10px 12px;
      border-radius:8px;
      border:1px solid var(--border);
      background:#0f1a20;
      color:var(--text);
      outline:none;
      font-size:13px;
    }
    .conv-list{
      overflow:auto;
      flex:1;
    }
    .conv-item{
      padding:12px 12px;
      border-bottom:1px solid var(--border);
      cursor:pointer;
      display:flex;
      gap:10px;
      align-items:flex-start;
    }
    .conv-item:hover{background:#0f1a20}
    .conv-item.active{background:#0d2420}
    .avatar{
      width:38px;height:38px;border-radius:50%;
      background:#2a3942;
      display:flex;align-items:center;justify-content:center;
      font-weight:700;font-size:14px;color:#d1d7db;
      flex:0 0 38px;
    }
    .conv-meta{
      flex:1;
      min-width:0;
    }
    .conv-row{
      display:flex;justify-content:space-between;gap:8px;
      align-items:center;
    }
    .conv-name{
      font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .conv-wa{
      font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .conv-status{
      font-size:10px;color:var(--muted);
      border:1px solid var(--border);
      padding:2px 6px;border-radius:999px;
    }
     .conv-delivered{
      font-size:12px;
      color:var(--accent);
      margin-left:6px;
      font-weight:800;
      line-height:1;
    }
    .conv-last{
      font-size:11px;color:var(--muted);
    }

    /* ===== Right: Chat ===== */
    .chat{
      flex:1;
      display:flex;
      flex-direction:column;
      background:linear-gradient(180deg, #0b141a 0%, #0b141a 100%);
    }
    .chat-header{
      background:var(--panel-2);
      padding:10px 14px;
      border-bottom:1px solid var(--border);
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
    }
    .chat-title{
      display:flex;align-items:center;gap:10px;min-width:0;
    }
    .chat-title .name{
      font-size:15px;font-weight:600;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .chat-title .sub{
      font-size:11px;color:var(--muted);
    }
    .chat-actions{
      display:flex;align-items:center;gap:10px;
      font-size:12px;
      display:flex;
      align-items:center;
      gap:8px;
      font-size:11px;
      flex-wrap:wrap;
      justify-content:flex-end;
    }
    .toggle{
      display:flex;align-items:center;gap:6px;
      padding:3px 6px;border:1px solid var(--border);border-radius:8px;
      background:#0f1a20;
    }
    .toggle input{transform:translateY(1px)}
    .chat-body{
      flex:1;
      overflow:auto;
      padding:18px 16px 8px 16px;
    }
    .empty{
      color:var(--muted);
      font-size:13px;
      padding:20px;
    }
    .msg{
      max-width:70%;
      padding:8px 10px;
      border-radius:10px;
      margin:6px 0;
      font-size:13.5px;
      line-height:1.3;
      word-wrap:break-word;
      white-space:pre-wrap;
    }
    .msg.them{
      background:var(--bubble-them);
      border-top-left-radius:4px;
      align-self:flex-start;
    }
    .msg.me{
      background:var(--bubble-me);
      border-top-right-radius:4px;
      align-self:flex-end;
    }
    .msg-meta{
      font-size:10px;color:rgba(255,255,255,.55);
      margin-top:4px; text-align:right;
    }
    .msg-row{
      display:flex;flex-direction:column;
    }

    .chat-footer{
      border-top:1px solid var(--border);
      background:var(--panel);
      padding:10px;
    }
    .send-form{
      display:flex;gap:8px;
    }
    .send-form input{
      flex:1;
      padding:12px 12px;
      border-radius:10px;
      border:1px solid var(--border);
      background:#0f1a20;
      color:var(--text);
      outline:none;
      font-size:13px;
    }
    .send-form button{
      padding:0 14px;
      border-radius:10px;
      border:1px solid var(--border);
      background:var(--accent);
      color:white;
      cursor:pointer;
      font-weight:600;
    }
    .send-form button:disabled{
      opacity:.5; cursor:not-allowed;
    }

    .pill{
      font-size:10px;
      padding:2px 6px;border-radius:999px;
      border:1px solid var(--border);
      color:var(--muted);
    }

    @media (max-width: 720px){
  body{ margin: 12px; }
  header{ flex-wrap: wrap; }

  /* Ocultamos encabezados y colgroup */
  .adminTable colgroup,
  .adminTable thead{
    display:none;
  }

  /* Tabla → lista de cards */
  .adminTable,
  .adminTable tbody,
  .adminTable tr,
  .adminTable td{
    display:block;
    width:100%;
  }

  .adminTable{
    border:0;
  }

  .adminTable tr{
    border:1px solid #ddd;
    border-radius:12px;
    padding:10px 12px;
    margin:10px 0;
    background:#fff;
  }

  /* Cada “fila” (td) con etiqueta a la izquierda */
  .adminTable td{
    border:none;
    padding:6px 0;
    overflow:visible;          /* evita “celdas” altísimas por ellipsis */
    text-overflow:unset;
    display:flex;
    gap:10px;
    justify-content:space-between;
    align-items:flex-start;
  }

  .adminTable td::before{
    content: attr(data-label);
    font-weight:700;
    color:#475467;
    min-width:42%;
    max-width:42%;
  }

  /* Acciones: que ocupen toda la línea y permitan wrap */
  .adminTable td[data-label="Acciones"]{
    display:block;
    padding-top:10px;
  }
  .adminTable td[data-label="Acciones"]::before{
    display:none;
  }
  .adminTable td[data-label="Acciones"] .actions{
    flex-wrap:wrap;
    white-space:normal;
    gap:8px;
  }
}

  </style>
</head>
<body>
  <div class="app">
    <!-- SIDEBAR -->
    <aside class="sidebar">
      <div class="side-header">
        <h1>Inbox</h1>
        <button id="refreshBtn" class="pill" title="Actualizar">↻ Actualizar</button>
      </div>
      <div class="search">
        <input id="searchInput" placeholder="Buscar contacto o número..." />
      </div>
      <div id="convList" class="conv-list"></div>
    </aside>

    <!-- CHAT -->
    <main class="chat">
      <div class="chat-header">
        <div class="chat-title">
          <div class="avatar" id="chatAvatar">?</div>
          <div>
            <div class="name" id="chatName">Seleccioná un chat</div>
            <div class="sub" id="chatSub"></div>
          </div>
        </div>

        <div class="chat-actions">
          <span id="chatStatus" class="pill"></span>
          <label class="toggle">
            <input type="checkbox" id="manualToggle" />
            <span>Modo humano</span>
          </label>
          <label class="toggle">
            <input type="checkbox" id="deliveredToggle" />
            <span>Entregado</span>
          </label>
        </div>
      </div>

      <div id="chatBody" class="chat-body">
        <div class="empty">No hay conversación seleccionada.</div>
      </div>

      <div class="chat-footer">
        <form id="sendForm" class="send-form">
          <input id="msgInput" placeholder="Escribí un mensaje..." autocomplete="off" />
          <button id="sendBtn" type="submit" disabled>Enviar</button>
        </form>
      </div>
    </main>
  </div>

<script>
  // Datos iniciales pre-render
  window.__INITIAL_CONVS__ = ${initialConvs};

  const qs = new URLSearchParams(location.search);
  const TENANT = qs.get("tenant") || "";
  const PRESELECT = ${JSON.stringify(urlConvId || "")};

  let conversations = Array.isArray(window.__INITIAL_CONVS__) ? window.__INITIAL_CONVS__ : [];
  let activeConvId = "";

  const convListEl = document.getElementById("convList");
  const searchInput = document.getElementById("searchInput");
  const refreshBtn = document.getElementById("refreshBtn");

  const chatAvatar = document.getElementById("chatAvatar");
  const chatName = document.getElementById("chatName");
  const chatSub = document.getElementById("chatSub");
  const chatStatus = document.getElementById("chatStatus");
  const deliveredToggle = document.getElementById("deliveredToggle");

  const chatBody = document.getElementById("chatBody");
  const sendForm = document.getElementById("sendForm");
  const msgInput = document.getElementById("msgInput");
  const sendBtn = document.getElementById("sendBtn");

  function api(url){
    try{
      const u = new URL(url, location.origin);
      if (TENANT) u.searchParams.set("tenant", TENANT);
      return u.toString();
    }catch{
      // fallback simple
      if (!TENANT) return url;
      return url.includes("?") ? (url + "&tenant=" + encodeURIComponent(TENANT)) : (url + "?tenant=" + encodeURIComponent(TENANT));
    }
  }

  function initials(nameOrWa){
    const s = String(nameOrWa || "").trim();
    if (!s) return "?";
    const parts = s.split(/\\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0,2).toUpperCase();
  }

  function fmtTime(d){
    try{
      const dt = new Date(d);
      if (Number.isNaN(dt.getTime())) return "";
      return dt.toLocaleString("es-AR", { hour:"2-digit", minute:"2-digit", day:"2-digit", month:"2-digit" });
    }catch{ return ""; }
  }

  function renderList(){
    const f = String(searchInput.value || "").toLowerCase().trim();
    const rows = conversations.filter(c => {
      const name = String(c.contactName || "").toLowerCase();
      const wa = String(c.waId || "").toLowerCase();
      return !f || name.includes(f) || wa.includes(f);
    });

    convListEl.innerHTML = rows.map(c => {
      const id = c._id;
      const name = c.contactName && c.contactName !== "-" ? c.contactName : (c.waId || "Sin nombre");
      const last = c.lastAt ? fmtTime(c.lastAt) : "";
      const status = c.status || "OPEN";
      const deliveredMark = c.delivered ? '<span class="conv-delivered" title="Entregado">✓</span>' : '';
      const cls = id === activeConvId ? "conv-item active" : "conv-item";
      return \`
        <div class="\${cls}" data-id="\${id}">
          <div class="avatar">\${initials(name)}</div>
          <div class="conv-meta">
            <div class="conv-row">
              <div class="conv-name">\${name}</div>
               <span class="conv-status">${status}</span>${deliveredMark}
            </div>
            <div class="conv-row">
              <div class="conv-wa">\${c.waId || ""}</div>
              <span class="pill">\${manual}</span>
            </div>
            <div class="conv-last">\${last}</div>
          </div>
        </div>
      \`;
    }).join("");

    // bind clicks
    convListEl.querySelectorAll(".conv-item").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-id");
        if (id) selectConversation(id);
      });
    });

    if (!rows.length){
      convListEl.innerHTML = '<div class="empty">Sin resultados.</div>';
    }
  }

  async function refreshConversations(){
    const r = await fetch(api("/api/logs/conversations?limit=200"));
    conversations = await r.json();
    renderList();
  }

  function setUrlConv(id){
    const u = new URL(location.href);
    if (id) u.searchParams.set("convId", id);
    else u.searchParams.delete("convId");
    if (TENANT) u.searchParams.set("tenant", TENANT);
    history.replaceState(null, "", u.toString());
  }

  async function loadMeta(convId){
    const r = await fetch(api("/api/admin/conversation-meta?convId=" + encodeURIComponent(convId)));
    if (!r.ok) throw new Error("meta_error");
    return r.json();
  }

  async function loadMessages(convId){
    const r = await fetch(api("/api/logs/messages?convId=" + encodeURIComponent(convId)));
    if (!r.ok) throw new Error("messages_error");
    return r.json();
  }

  function renderMessages(msgs){
    if (!Array.isArray(msgs) || !msgs.length){
      chatBody.innerHTML = '<div class="empty">Sin mensajes todavía.</div>';
      return;
    }
    chatBody.innerHTML = "";
    const frag = document.createDocumentFragment();

    msgs.forEach(m => {
      const row = document.createElement("div");
      row.className = "msg-row";
      row.style.alignItems = (m.role === "user") ? "flex-start" : "flex-end";

      const bubble = document.createElement("div");
      bubble.className = "msg " + ((m.role === "user") ? "them" : "me");
      bubble.textContent = String(m.content || "");

      const meta = document.createElement("div");
      meta.className = "msg-meta";
      meta.textContent = m.createdAt ? fmtTime(m.createdAt) : "";

      bubble.appendChild(meta);
      row.appendChild(bubble);
      frag.appendChild(row);
    });

    chatBody.appendChild(frag);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  async function selectConversation(convId){
    activeConvId = convId;
    setUrlConv(convId);
    renderList();

    sendBtn.disabled = !convId;

    chatBody.innerHTML = '<div class="empty">Cargando...</div>';

    try{
      const meta = await loadMeta(convId);
      const name = meta.contactName || meta.waId || "Chat";
      chatAvatar.textContent = initials(name);
      chatName.textContent = name;
       const ch = (meta.displayPhoneNumber || meta.phoneNumberId || "");
       chatSub.textContent = meta.waId
         ? ("WhatsApp: " + meta.waId + (ch ? (" · Canal: " + ch) : ""))
         : "";
      chatStatus.textContent = meta.status || "";
      if (deliveredToggle) deliveredToggle.checked = !!meta.delivered;

      const msgs = await loadMessages(convId);
      renderMessages(msgs);
    }catch(e){
      chatBody.innerHTML = '<div class="empty">No se pudo cargar la conversación.</div>';
    }
  }

  // Toggle humano/bot
  manualToggle.addEventListener("change", async () => {
    if (!activeConvId) return;
    try{
      await fetch(api("/api/admin/conversation-manual"), {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ convId: activeConvId, manualOpen: manualToggle.checked })
      });
      // refrescamos lista para que refleje pill HUMANO/BOT
      await refreshConversations();
    }catch{}
  });


  // Toggle entregado/no entregado
  if (deliveredToggle) {
    deliveredToggle.addEventListener("change", async () => {
      if (!activeConvId) return;
      try{
        await fetch(api("/api/admin/conversation-delivered"), {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ convId: activeConvId, delivered: deliveredToggle.checked })
        });
        // refrescamos lista para que se refleje el check
        await refreshConversations();
      }catch{}
    });
  }



  // Enviar mensaje manual
  sendForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeConvId) return;
    const text = String(msgInput.value || "").trim();
    if (!text) return;

    sendBtn.disabled = true;

    try{
      await fetch(api("/api/admin/send-message"), {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ convId: activeConvId, text })
      });
      msgInput.value = "";
      const msgs = await loadMessages(activeConvId);
      renderMessages(msgs);
      await refreshConversations();
    }catch(e){}
    finally{
      sendBtn.disabled = false;
      msgInput.focus();
    }
  });

  // Buscador
  searchInput.addEventListener("input", renderList);

  // Refresh
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.textContent = "↻ ...";
    try{ await refreshConversations(); }
    finally{ refreshBtn.textContent = "↻ Actualizar"; }
  });

  // Init
  renderList();
  if (PRESELECT) {
    selectConversation(PRESELECT);
  } else if (conversations[0] && conversations[0]._id) {
    selectConversation(conversations[0]._id);
  }
</script>
</body>
</html>`;

    res.send(html);
  } catch (e) {
    console.error("GET /admin/inbox error:", e);
    res.status(500).send("Error interno");
  }
});



// ---------- Marcar conversación como entregada / no entregada ----------
app.post("/api/admin/conversation-delivered", async (req, res) => {
  try {
    const { convId, waId, delivered } = req.body || {};
    if (!convId && !waId) {
      return res.status(400).json({ error: "convId_or_waId_required" });
    }
    const tenant = resolveTenantId(req);
    const db = await getDb();

    let filter;
    if (convId) {
      filter = withTenant({ _id: new ObjectId(String(convId)) }, tenant);
    } else {
      filter = withTenant({ waId: String(waId) }, tenant);
    }

    const now = new Date();
   const flag = !!delivered;
    const update = flag
      ? { $set: { delivered: true, deliveredAt: now, updatedAt: now } }
      : { $set: { delivered: false, updatedAt: now }, $unset: { deliveredAt: "" } };

    const result = await db.collection("conversations").findOneAndUpdate(
      filter,
      update,
      { returnDocument: "after" }
    );

    const conv = result.value;
   if (!conv) {
      return res.status(404).json({ error: "conv_not_found" });
    }

    res.json({
      ok: true,
      convId: String(conv._id),
      delivered: !!conv.delivered,
      deliveredAt: conv.deliveredAt || null,
    });
  } catch (e) {
    console.error("POST /api/admin/conversation-delivered error:", e);
    res.status(500).json({ error: "internal" });
  }
});


// ---------- Marcar conversación como manual (humano) / automática (bot) ----------
app.post("/api/admin/conversation-manual", async (req, res) => {
  try {
    const { convId, waId, manualOpen } = req.body || {};
    if (!convId && !waId) {
      return res.status(400).json({ error: "convId_or_waId_required" });
    }
    const tenant = resolveTenantId(req);
    const db = await getDb();

    let filter;
    if (convId) {
      filter = withTenant({ _id: new ObjectId(String(convId)) }, tenant);
    } else {
      filter = withTenant({ waId: String(waId) }, tenant);
    }

    const now = new Date();
    const result = await db.collection("conversations").findOneAndUpdate(
      filter,
      { $set: { manualOpen: !!manualOpen, updatedAt: now } },
      { returnDocument: "after" }
    );

    const conv = result.value;
    if (!conv) {
      return res.status(404).json({ error: "conv_not_found" });
    }

    res.json({
      ok: true,
      convId: String(conv._id),
      manualOpen: !!conv.manualOpen,
    });
  } catch (e) {
    console.error("POST /api/admin/conversation-manual error:", e);
    res.status(500).json({ error: "internal" });
  }
});


// ---------- Enviar mensaje manual al cliente desde /admin ----------
app.post("/api/admin/send-message", async (req, res) => {
  try {
    const { convId, waId, text } = req.body || {};
    const body = String(text || "").trim();
    if (!body) {
      return res.status(400).json({ error: "text_required" });
    }

    const tenant = resolveTenantId(req);
    const db = await getDb();

    let conv = null;
    if (convId) {
      conv = await db.collection("conversations").findOne(
        withTenant({ _id: new ObjectId(String(convId)) }, tenant)
      );
    } else if (waId) {
      conv = await db.collection("conversations").findOne(
        withTenant({ waId: String(waId) }, tenant),
        { sort: { updatedAt: -1, openedAt: -1 } }
      );
    }

    if (!conv) {
      return res.status(404).json({ error: "conv_not_found" });
    }

    const to = conv.waId;

     // Enviar por WhatsApp (multi-phone): usar el mismo canal (phoneNumberId) de la conversación
    const convPhoneNumberId = conv.phoneNumberId || null;
    let rt = null;
    try {
      if (convPhoneNumberId) {
        rt = await getRuntimeByPhoneNumberId(convPhoneNumberId);
      }
    } catch {}

    const waOpts = {
      whatsappToken: rt?.whatsappToken || null,
      phoneNumberId: rt?.phoneNumberId || convPhoneNumberId || null,
    };

    // Enviar por WhatsApp (si waOpts no tiene token/phoneNumberId, logic.js cae a .env => retrocompatible)
    await require("./logic").sendWhatsAppMessage(to, body, waOpts);

    const now = new Date();

    // Guardar en colección messages como "assistant" pero marcado como humano
    await saveMessageDoc({
      tenantId: tenant,
      conversationId: conv._id,
      waId: to,
      role: "assistant",
      content: body,
      type: "text",
      meta: { from: "admin" },
    });

    // Actualizar timestamps de la conversación
    await db.collection("conversations").updateOne(
      { _id: conv._id },
      { $set: { lastAssistantTs: now, updatedAt: now } }
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/admin/send-message error:", e);
    res.status(500).json({ error: "internal" });
  }
});




// Pedido de una conversación (detalle JSON)
app.get("/api/logs/pedido", async (req, res) => {
  try {
    const { convId } = req.query;
    if (!convId) {
      return res.status(400).json({ error: "convId required" });
    }

    const db = await getDb();
    const tenantId = resolveTenantId(req);
    const convObjectId = new ObjectId(String(convId));

    // Datos básicos de la conversación
    let waId = "";
    let contactName = "";
    let fecha = new Date().toLocaleString("es-AR");
    try {
      const conv = await db.collection("conversations").findOne(
        withTenant({ _id: convObjectId }, tenantId)
      );
      if (conv) {
        waId = conv.waId || "";
        contactName = conv.contactName || "";
        fecha = conv.lastAt
          ? new Date(conv.lastAt).toLocaleString("es-AR")
          : fecha;
      }
    } catch (e) {
      console.warn("[pedido] no se pudo leer conversation:", e?.message);
    }

    // 1) Intentar leer el pedido desde orders
    let pedido = null;
    try {
      const order = await db.collection("orders").findOne(
        withTenant({ conversationId: convObjectId }, tenantId),
        { sort: { createdAt: -1 } }
      );
      if (order && order.pedido) {
        pedido = order.pedido;
      }
    } catch (e) {
      console.warn("[pedido] no se pudo leer order:", e?.message);
    }

    // 2) Fallback: si no hay pedido en orders, buscar JSON en mensajes
    if (!pedido) {
      const msgs = await getConversationMessagesByConvId(convId, 1000, tenantId);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "assistant") continue;
        const s = String(m.content || "").trim();
        try {
          const j = JSON.parse(s);
          if (j && j.Pedido && Array.isArray(j.Pedido.items)) {
            pedido = j.Pedido;
            break;
          }
        } catch {
          // no era JSON, seguimos
        }
      }
    }

    if (!pedido) {
      return res.status(404).json({ error: "pedido_not_found" });
    }

    const items = (pedido.items || []).map((it) => ({
      descripcion: String(it.descripcion || "").trim(),
      cantidad: Number(it.cantidad || 0),
      importe_unitario: Number(it.importe_unitario || 0),
      total: Number(it.total || 0),
    }));

    let total = Number(pedido.total_pedido || 0);
    if (!total && items.length) {
      total = items.reduce(
        (sum, it) => sum + (Number(it.total) || 0),
        0
      );
    }

    let entregaLabel = "-";
    const entregaRaw = String(pedido.Entrega || "").trim().toLowerCase();
    if (entregaRaw === "domicilio") entregaLabel = "Envío";
    else if (entregaRaw === "retiro") entregaLabel = "Retiro";

    let direccion = "-";
    if (pedido.Entrega === "domicilio") {
      if (typeof pedido.Domicilio === "string") {
        direccion = pedido.Domicilio.trim() || "-";
      } else if (pedido.Domicilio && typeof pedido.Domicilio === "object") {
        direccion =
          String(
            pedido.Domicilio.direccion ||
              pedido.Domicilio.calle ||
              ""
          ).trim() || "-";
      }
    }

    res.json({
      ok: true,
      convId,
      waId,
      contactName,
      fecha,
      entrega: entregaLabel,
      direccion,
      fechaEntrega: pedido.Fecha || null,
      horaEntrega: pedido.Hora || null,
      items,
      total,
    });
  } catch (e) {
    console.error("GET /api/logs/pedido error:", e);
    res.status(500).json({ error: "internal" });
  }
});


// ---------- Página /admin (HTML liviano) ----------
app.get("/admin", async (req, res) => {
  try {
    const conversations = await listConversations(200, resolveTenantId(req));
    const urlConvId = String(req.query.convId || "");
   
    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Admin | Conversaciones</title>
  <style>
    body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin:20px;}
     header{display:flex; align-items:center; gap:12px; margin-bottom:16px;}
     input,button,select{font-size:12px; padding:5px 6px;}
     table{border-collapse:collapse; width:100%; table-layout:fixed}
     th,td{border:1px solid #ddd; padding:6px; vertical-align:top; font-size:12px; word-break:break-word}

     th{background:#f5f5f5; text-align:left}
     .row{display:flex; gap:16px; align-items:center; flex-wrap:wrap}
     .muted{color:#666}
     .btn{padding:6px 10px; border:1px solid #333; background:#fff; border-radius:4px; cursor:pointer}
    /* ===== Modal simple ===== */
    .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;z-index:1000}
    .modal{background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);width:min(900px,95vw);max-height:85vh;display:flex;flex-direction:column}
    .modal header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #eee}
    .modal header h3{margin:0;font-size:16px}
    .modal .body{padding:10px 12px;overflow:auto}
    .chip{display:inline-flex;align-items:center;gap:6px}
    .iconbtn{border:none;background:transparent;cursor:pointer;font-size:18px}
    .msg{border:1px solid #eee;border-radius:8px;padding:8px;margin-bottom:8px}
    .role-user{background:#f0fafc}
    .role-assistant{background:#f8f6ff}
    small{color:#666}
    pre{white-space:pre-wrap;margin:4px 0 0}

    /* ===== Manual chat UI ===== */
    .badge{padding:4px 8px;border-radius:999px;font-size:12px}
    .badge-bot{background:#e3f7e3;color:#145214}
    .badge-manual{background:#ffe4e1;color:#8b0000}
    .modal-meta-row{display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap}
    #modalChatBox{margin-top:12px;border-top:1px solid #eee;padding-top:10px;display:flex;flex-direction:column;gap:6px}
    #modalReplyText{width:100%;min-height:70px;font-family:inherit;font-size:14px;padding:6px 8px}
    .chat-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}
     table{border-collapse:collapse; width:100%; margin-top:12px; table-layout:fixed}
    th,td{border:1px solid #ddd; padding:6px; vertical-align:top; font-size:12px; word-break:break-word}

    th{background:#f7f7f7; text-align:left}
    .btn{padding:6px 10px; border:1px solid #333; background:#fff; border-radius:6px; cursor:pointer}
    .actions{
      display:flex;
      gap:6px;
      flex-wrap:nowrap;          /* una sola fila */
      white-space:nowrap;
      align-items:center;
    }
    .actions .btn{
      padding:4px 6px;
      font-size:11px;
      line-height:1.1;
      white-space:nowrap;
    }

@media (max-width: 720px){
  body{ margin: 12px; }
  header{ flex-wrap: wrap; }

  /* Ocultamos encabezados y colgroup */
  .adminTable colgroup,
  .adminTable thead{
    display:none;
  }

  /* Tabla → lista de cards */
  .adminTable,
  .adminTable tbody,
  .adminTable tr,
  .adminTable td{
    display:block;
    width:100%;
  }

  .adminTable{
    border:0;
  }

  .adminTable tr{
    border:1px solid #ddd;
    border-radius:12px;
    padding:10px 12px;
    margin:10px 0;
    background:#fff;
  }

  /* Cada “fila” (td) con etiqueta a la izquierda */
  .adminTable td{
    border:none;
    padding:6px 0;
    overflow:visible;
    text-overflow:unset;
    display:flex;
    gap:10px;
    justify-content:space-between;
    align-items:flex-start;
  }

  .adminTable td::before{
    content: attr(data-label);
    font-weight:700;
    color:#475467;
    min-width:42%;
    max-width:42%;
  }

  /* Acciones: que ocupen toda la línea y permitan wrap */
  .adminTable td[data-label="Acciones"]{
    display:block;
    padding-top:10px;
  }
  .adminTable td[data-label="Acciones"]::before{
    display:none;
  }
  .adminTable td[data-label="Acciones"] .actions{
    flex-wrap:wrap;
    white-space:normal;
    gap:8px;
  }
}


    /* Ajuste de anchos (sin scroll horizontal) */
    .adminTable{table-layout:fixed}
    .adminTable th{white-space:nowrap}
    .adminTable td{overflow:hidden; text-overflow:ellipsis}
    .adminTable col.c-entrega{width:88px}    /* más chico */
    .adminTable col.c-hora{width:66px}       /* más chico */
    .adminTable col.c-ent{width:44px}        /* más chico */
    .adminTable col.c-estado{width:140px}    /* un poquito más grande */
    .adminTable col.c-acciones{width:240px}  /* asegura que entren los botones */
    .delivered-row{opacity:.85}
    .delivChk{cursor:pointer}


    /* ===== Estado (badge) ===== */
    .status-badge{
      display:inline-block;
      padding:2px 8px;
      border-radius:999px;
      font-size:12px;
      font-weight:700;
      letter-spacing:.2px;
      border:1px solid transparent;
      line-height:1.4;
      white-space:nowrap;
    }
    .st-open{background:#eef2ff;color:#1e3a8a;border-color:#c7d2fe;}
    .st-progress{background:#fff7ed;color:#9a3412;border-color:#fed7aa;}
    .st-completed{background:#ecfdf5;color:#065f46;border-color:#a7f3d0;}
    .st-cancelled{background:#fef2f2;color:#991b1b;border-color:#fecaca;}


      /* ===== Modal de ticket ===== */
      .ticket-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.45);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .ticket-modal {
        background: #fff;
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.25);
        width: 90mm;           /* ancho parecido a ticket de 80mm */
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        overflow: auto;
        gap: 8px;
      }

     .ticket-modal iframe {
       border: none;
        width: 100%;
        flex: 1;
      }

      .ticket-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 6px;
      }




  </style>
</head>
<body>
  <header>
    <h2>Panel de conversaciones</h2>
  </header>

    <div class="row" style="gap:8px">
     <label>Buscar por waId:&nbsp;<input id="waIdI" placeholder="5493..."/></label>
     <button class="btn" id="btnBuscar">Buscar</button>
     <button class="btn" id="btnReload">Recargar tabla</button>
     <label>Filtro:&nbsp;
       <select id="delivFilter">
         <option value="all" selected>Todas</option>
         <option value="pending">No entregadas</option>
         <option value="delivered">Entregadas</option>
       </select>
     </label>
   </div>
   <p></p>
   <table id="tbl" class="adminTable">
     <colgroup>
       <col class="c-actividad"/>
       <col class="c-telefono"/>
       <col class="c-nombre"/>
       <col class="c-entrega"/>
       <col class="c-direccion"/>
       <col class="c-dist"/>
       <col class="c-dia"/>
       <col class="c-hora"/>
       <col class="c-estado"/>
       <col class="c-ent"/>
       <col class="c-acciones"/>
     </colgroup>
     <thead>
       <tr>
         <th>Actividad</th>
         <th>Teléfono</th>
         <th>Nombre</th>
         <th>Entrega</th>
         <th>Dirección</th>
          <th>Distancia (km)</th>
          <th>Día</th>
         <th>Hora</th>
         <th>Estado</th>
         <th>Ent.</th>
         <th>Acciones</th>
       </tr>
     </thead>
     <tbody></tbody>
   </table>
    <!-- Modal -->
   <div id="modalRoot" class="modal-backdrop" role="dialog" aria-modal="true" aria-hidden="true">
     <div class="modal" role="document">
       <header>
         <h3>Detalle de conversación</h3>
         <div class="chip">
           <button class="iconbtn" title="Imprimir" id="modalPrintBtn">🖨️</button>
           <button class="iconbtn" title="Cerrar" id="modalCloseBtn">✖</button>
         </div>
       </header>
       <div class="body" id="modalBody">
         <div class="modal-meta-row">
           <span id="modalManualBadge" class="badge badge-bot">Estado: ...</span>
           <button class="btn" id="modalToggleManualBtn">Tomar chat (pausar bot)</button>
         </div>
         <div id="modalMsgs">
           <p class="muted">Cargando…</p>
         </div>
         <div id="modalChatBox">
           <textarea id="modalReplyText" placeholder="Escribí un mensaje para el cliente… (Ctrl/⌘+Enter para enviar)"></textarea>
           <div class="chat-actions">
             <button class="btn" id="modalSendBtn">Enviar</button>
             <span class="muted" style="font-size:12px">El bot solo se pausa si el chat está en modo manual.</span>
           </div>
         </div>
       </div>
     </div>
   </div>

    <!-- Modal Detalle de Pedido -->
    <div id="pedidoModalBackdrop" class="modal-backdrop" role="dialog" aria-modal="true" aria-hidden="true">
      <div class="modal" role="document">
        <header>
          <h3>Detalle de pedido</h3>
          <div class="chip">
            <button class="iconbtn" title="Cerrar" id="pedidoModalCloseBtn">✖</button>
          </div>
        </header>
        <div class="body" id="pedidoModalBody">
          <p class="muted">Cargando…</p>
        </div>
      </div>
    </div>


   <!-- Modal para mostrar el ticket -->
    <div id="ticketModalBackdrop" class="ticket-modal-backdrop">
      <div class="ticket-modal">
        <iframe id="ticketFrame" title="Ticket"></iframe>
        <div class="ticket-modal-actions">
          <button onclick="closeTicketModal()">Cerrar</button>
          <button onclick="printTicket()">Imprimir</button>
        </div>
      </div>
    </div>

  <script>
  // =========================
  // Helpers DOM
  // =========================
  const modalRoot = document.getElementById('modalRoot');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const modalPrintBtn = document.getElementById('modalPrintBtn');

  const pedidoModalBackdrop = document.getElementById('pedidoModalBackdrop');
  const pedidoModalBody = document.getElementById('pedidoModalBody');
  const pedidoModalCloseBtn = document.getElementById('pedidoModalCloseBtn');

  const modalMsgs = () => document.getElementById('modalMsgs');
  const modalManualBadge = () => document.getElementById('modalManualBadge');
  const modalToggleManualBtn = () => document.getElementById('modalToggleManualBtn');
  const modalReplyText = () => document.getElementById('modalReplyText');
  const modalSendBtn = () => document.getElementById('modalSendBtn');

  // =========================
  // Estado global del modal
  // =========================
  let currentConvId = null;
  let modalManualOpen = false;

  // Auto-refresh modal
  let modalPollTimer = null;
  let lastMsgsFingerprint = "";

  // =========================
  // Utilidades UI
  // =========================
  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }


  // Normaliza cualquier estado a un set canónico para poder colorear.
  function normalizeStatus(raw){
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return 'OPEN';
    if (['CANCELLED','CANCELED','CANCELADA','CANCELADO'].includes(s)) return 'CANCELLED';
    if (['COMPLETED','COMPLETADA','FINALIZADA','FINALIZADO'].includes(s)) return 'COMPLETED';
    if (['OPEN','ABIERTA','ABIERTO'].includes(s)) return 'OPEN';
    if (['IN_PROGRESS','EN CURSO','PROCESANDO'].includes(s)) return 'IN_PROGRESS';
    return s;
  }

  function statusLabelEs(raw){
    const st = normalizeStatus(raw);
    if (st === 'CANCELLED') return 'CANCELADA';
    if (st === 'COMPLETED') return 'COMPLETADA';
    if (st === 'IN_PROGRESS') return 'EN CURSO';
    if (st === 'OPEN') return 'ABIERTA';
    return String(raw || st || '').trim();
  }

  function statusClass(raw){
    const st = normalizeStatus(raw);
    if (st === 'CANCELLED') return 'st-cancelled';
    if (st === 'COMPLETED') return 'st-completed';
    if (st === 'IN_PROGRESS') return 'st-progress';
    return 'st-open';
  }

  function renderStatusBadge(raw){
    const label = statusLabelEs(raw);
    const cls = statusClass(raw);
    return '<span class="status-badge ' + cls + '">' + escHtml(label) + '</span>';
  }
 



  function formatMoney(n) {
    const num = Number(n || 0);
    if (!Number.isFinite(num)) return '-';
    return num.toLocaleString('es-AR', { minimumFractionDigits: 0 });
  }

  function fmt(d){
    try { return new Date(d).toLocaleString(); }
    catch { return '-'; }
  }

  // =========================
  // Render mensajes modal
  // =========================
  function renderMessages(list){
    const target = modalMsgs();
    if (!target) return;

    if(!Array.isArray(list) || !list.length){
      target.innerHTML = '<p class="muted">Sin mensajes para mostrar</p>';
      return;
    }

    target.innerHTML = list.map(m => (
      '<div class="msg role-'+escHtml(m.role)+'">'+
        '<small>['+new Date(m.createdAt).toLocaleString()+'] '+escHtml(m.role)+'</small>'+
        '<pre>'+escHtml(m.content||'')+'</pre>'+
      '</div>'
    )).join('');
  }

  // =========================
  // Estado manual UI
  // =========================
  function updateModalManualUI(){
    const badge = modalManualBadge();
    const btn = modalToggleManualBtn();
    if (!badge || !btn) return;

    if (modalManualOpen) {
      badge.textContent = 'Modo MANUAL: bot pausado';
      badge.classList.remove('badge-bot');
      badge.classList.add('badge-manual');
      btn.textContent = 'Liberar al bot';
    } else {
      badge.textContent = 'Modo BOT automático';
      badge.classList.remove('badge-manual');
      badge.classList.add('badge-bot');
      btn.textContent = 'Tomar chat (pausar bot)';
    }
  }

  async function verifyDelivered(convId){
    try{
      const r = await fetch('/api/admin/conversation-meta?convId=' + encodeURIComponent(convId));
      if(!r.ok) return null;
      const j = await r.json();
      return !!j.delivered;
    }catch{
      return null;
    }
  }

  async function loadModalMeta(){
    if (!currentConvId) return;
    try {
      const r = await fetch('/api/admin/conversation-meta?convId=' + encodeURIComponent(currentConvId));
      if (!r.ok) return;
      const j = await r.json().catch(()=>null);
      modalManualOpen = !!(j && j.manualOpen);
      updateModalManualUI();
    } catch (e) {
      console.warn("loadModalMeta error", e);
    }
  }

  // ✅ Toggle tolerante (evita “error fantasma”)
  async function toggleModalManual(){
    if (!currentConvId) return;

    let j = null;
    let r = null;

    try {
      r = await fetch('/api/admin/conversation-manual', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ convId: currentConvId, manualOpen: !modalManualOpen })
      });

      j = await r.json().catch(()=>null);

      // Si el backend devolvió manualOpen booleano, es suficiente
      if (j && typeof j.manualOpen === "boolean") {
        modalManualOpen = !!j.manualOpen;
        updateModalManualUI();
        return;
      }

      if (!r.ok || !j?.ok) {
        alert('No se pudo cambiar el estado manual.');
        return;
      }

      modalManualOpen = !!j.manualOpen;
      updateModalManualUI();

    } catch (e) {
      console.error("toggleModalManual error", e);
      alert('No se pudo cambiar el estado manual.');
    }
  }

  // =========================
  // Enviar mensaje manual
  // =========================
  async function sendModalMessage(){
    if (!currentConvId) return;

    const ta = modalReplyText();
    const text = String(ta?.value || '').trim();
    if (!text) return;

    try {
      const r = await fetch('/api/admin/send-message', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ convId: currentConvId, text })
      });

      const j = await r.json().catch(()=>null);
      if (!r.ok || !j?.ok) {
        alert('Error al enviar el mensaje.');
        return;
      }

      if (ta) ta.value = '';

      // refrescar mensajes inmediato
      await refreshModalMessages(true);

    } catch (e) {
      console.error("sendModalMessage error", e);
      alert('Error al enviar el mensaje.');
    }
  }

  // =========================
  // Polling del modal (auto refresh)
  // =========================
  async function refreshModalMessages(forceScroll){
    if (!currentConvId) return;

    const target = modalMsgs();
    const wasNearBottom = target
      ? (target.scrollHeight - target.scrollTop - target.clientHeight) < 120
      : true;

    const r = await fetch('/api/logs/messages?convId=' + encodeURIComponent(currentConvId));
    if (!r.ok) return;

    const data = await r.json().catch(()=>[]);
    if (!Array.isArray(data)) return;

    const last = data[data.length - 1];
     const fp =
      String(data.length) + ':' +
      String((last && (last._id || last.createdAt)) || '');

    if (fp !== lastMsgsFingerprint) {
      lastMsgsFingerprint = fp;
      renderMessages(data);

      const target2 = modalMsgs();
      if (target2 && (forceScroll || wasNearBottom)) {
        target2.scrollTop = target2.scrollHeight;
      }
    }
  }

  function startModalPolling(){
    stopModalPolling();
    modalPollTimer = setInterval(async () => {
      try {
        await refreshModalMessages(false);
        await loadModalMeta();
      } catch (e) {
        console.warn("modal polling error", e);
      }
    }, 3000);
  }

  function stopModalPolling(){
    if (modalPollTimer) {
      clearInterval(modalPollTimer);
      modalPollTimer = null;
    }
  }

  // =========================
  // Modal open/close
  // =========================
  function closeModal(){
    stopModalPolling();
    currentConvId = null;
    lastMsgsFingerprint = "";
    modalRoot.style.display='none';
    modalRoot.setAttribute('aria-hidden','true');
  }

  modalCloseBtn.addEventListener('click', closeModal);
  modalRoot.addEventListener('click', (e)=>{ if(e.target===modalRoot) closeModal(); });

  async function openDetailModal(convId){
    try{
      currentConvId = convId;
      lastMsgsFingerprint = "";

      modalRoot.style.display = 'flex';
      modalRoot.setAttribute('aria-hidden','false');

      const msgsEl = modalMsgs();
      if (msgsEl) msgsEl.innerHTML = '<p class="muted">Cargando…</p>';

      await loadModalMeta();

      await refreshModalMessages(true);

      // imprimir desde el modal
      if (modalPrintBtn) {
        modalPrintBtn.onclick = () => openTicketModal(convId);
      }

      // ✅ empezar auto-actualización
      startModalPolling();

    } catch (e) {
      console.error('openDetailModal error:', e);
      const msgsEl = modalMsgs();
      if (msgsEl) msgsEl.innerHTML = '<p class="muted">Error al cargar.</p>';
    }
  }

  // =========================
  // Modal Pedido
  // =========================
  function closePedidoModal() {
    pedidoModalBackdrop.style.display = 'none';
    pedidoModalBackdrop.setAttribute('aria-hidden', 'true');
  }

  pedidoModalCloseBtn.addEventListener('click', closePedidoModal);
  pedidoModalBackdrop.addEventListener('click', (e)=>{ if(e.target===pedidoModalBackdrop) closePedidoModal(); });

  function renderPedidoDetail(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    let html = '';

    html += '<p>';
    html += '<strong>Nombre:</strong> ' + escHtml(data.contactName || '-') + '<br/>';
    html += '<strong>Teléfono:</strong> ' + escHtml(data.waId || '-') + '<br/>';
    if (data.fechaEntrega || data.horaEntrega) {
      html += '<strong>Entrega para:</strong> ' +
        escHtml(data.fechaEntrega || '') + ' ' +
        escHtml(data.horaEntrega || '') + '<br/>';
    }
    html += '<strong>Modalidad:</strong> ' + escHtml(data.entrega || '-') + '<br/>';
    html += '<strong>Dirección:</strong> ' + escHtml(data.direccion || '-') + '<br/>';
    html += '</p>';

    if (!items.length) {
      html += '<p class="muted">No se encontraron ítems en este pedido.</p>';
      pedidoModalBody.innerHTML = html;
      return;
    }

    html += '<table style="width:100%;border-collapse:collapse;margin-top:8px">';
    html += '<thead><tr>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">Cant.</th>' +
      '<th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">Producto</th>' +
      '<th style="text-align:right;border-bottom:1px solid #ddd;padding:4px">Unit.</th>' +
      '<th style="text-align:right;border-bottom:1px solid #ddd;padding:4px">Total</th>' +
      '</tr></thead><tbody>';

    items.forEach(it => {
      html += '<tr>';
      html += '<td style="padding:4px;border-bottom:1px solid #eee">' + escHtml(it.cantidad != null ? it.cantidad : '') + '</td>';
      html += '<td style="padding:4px;border-bottom:1px solid #eee">' + escHtml(it.descripcion || '') + '</td>';
      html += '<td style="padding:4px;border-bottom:1px solid #eee;text-align:right">' +
        (it.importe_unitario ? ('$ ' + formatMoney(it.importe_unitario)) : '-') +
        '</td>';
      html += '<td style="padding:4px;border-bottom:1px solid #eee;text-align:right">$ ' +
        formatMoney(it.total) +
        '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';
    html += '<p style="margin-top:8px;text-align:right"><strong>Total:</strong> $ ' + formatMoney(data.total) + '</p>';

    pedidoModalBody.innerHTML = html;
  }

  async function openPedidoModal(convId) {
    try {
      pedidoModalBody.innerHTML = '<p class="muted">Cargando…</p>';
      pedidoModalBackdrop.style.display = 'flex';
      pedidoModalBackdrop.setAttribute('aria-hidden', 'false');

      const r = await fetch('/api/logs/pedido?convId=' + encodeURIComponent(convId));
      if (!r.ok) {
        pedidoModalBody.innerHTML = '<p class="muted">No se encontró un pedido para esta conversación.</p>';
        return;
      }
      const data = await r.json();
      if (!data || !data.ok) {
        pedidoModalBody.innerHTML = '<p class="muted">No se encontró un pedido para esta conversación.</p>';
        return;
      }
      renderPedidoDetail(data);
    } catch (e) {
      console.error('Detalle pedido modal error:', e);
      pedidoModalBody.innerHTML = '<p class="muted">Error al cargar el pedido.</p>';
    }
  }

  // =========================
  // Ticket modal (iframe)
  // =========================
  function openTicketModal(conversationId) {
    const backdrop = document.getElementById('ticketModalBackdrop');
    const frame = document.getElementById('ticketFrame');
    if (frame) frame.src = '/admin/ticket/' + conversationId;
    if (backdrop) backdrop.style.display = 'flex';
  }

  function closeTicketModal() {
    const backdrop = document.getElementById('ticketModalBackdrop');
    const frame = document.getElementById('ticketFrame');
    if (frame) frame.src = 'about:blank';
    if (backdrop) backdrop.style.display = 'none';
  }

  function printTicket() {
    const frame = document.getElementById('ticketFrame');
    if (frame && frame.contentWindow) {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }
  }

  // Exponer para botones inline del HTML
  window.openTicketModal = openTicketModal;
  window.closeTicketModal = closeTicketModal;
  window.printTicket = printTicket;

  // =========================
  // Tabla conversaciones (ÚNICA versión)
  // =========================
  async function loadTable(){
    try{
      const f = (document.getElementById('delivFilter')?.value || 'all');
      let url = '/api/logs/conversations?limit=200';
      if (f === 'delivered') url += '&delivered=true';
      else if (f === 'pending') url += '&delivered=false';

      const r = await fetch(url);
      const data = await r.json().catch(()=>[]);
      const tb = document.querySelector('#tbl tbody');
      if (!tb) return;

      tb.innerHTML = '';

      for(const c of data){
        const tr = document.createElement('tr');
        if (c.delivered) tr.classList.add('delivered-row');
        tr.innerHTML =
  '<td data-label="Actividad">' + fmt(c.lastAt) + '</td>' +
  '<td data-label="Teléfono">' + escHtml(c.waId || '-') + '</td>' +
  '<td data-label="Nombre">' + escHtml(c.contactName || '-') + '</td>' +
  '<td data-label="Entrega">' + escHtml(c.entregaLabel || '-') + '</td>' +
  '<td data-label="Dirección">' + escHtml(c.direccion || '-') + '</td>' +
  '<td data-label="Distancia (km)">' +
    ((c.distanceKm !== undefined && c.distanceKm !== null) ? escHtml(c.distanceKm) : '-') +
  '</td>' +
  '<td data-label="Día">' + escHtml(c.fechaEntrega || '-') + '</td>' +
  '<td data-label="Hora">' + escHtml(c.horaEntrega || '-') + '</td>' +
  '<td data-label="Estado">' + renderStatusBadge(c.status) + '</td>' +
  '<td data-label="Ent." style="text-align:center">' +
    '<input class="delivChk" type="checkbox" data-id="' + escHtml(c._id) + '" ' +
    (c.delivered ? 'checked' : '') + ' title="Entregado" />' +
  '</td>' +
  '<td data-label="Acciones">' +
    '<div class="actions">' +
      '<button class="btn" data-conv="' + escHtml(c._id) + '">Detalle</button>' +
      '<button class="btn" data-pedido="' + escHtml(c._id) + '">Pedido</button>' +
      '<button class="btn" data-print="' + escHtml(c._id) + '">🖨️ Imprimir</button>' +
    '</div>' +
  '</td>';

        tb.appendChild(tr);
      }

      // Bind botones
      tb.querySelectorAll('button[data-conv]').forEach(b=>{
        b.addEventListener('click',()=>openDetailModal(b.getAttribute('data-conv')));
      });
      tb.querySelectorAll('button[data-pedido]').forEach(b=>{
        b.addEventListener('click',()=>openPedidoModal(b.getAttribute('data-pedido')));
      });
      tb.querySelectorAll('button[data-print]').forEach(b=>{
        b.addEventListener('click',()=>openTicketModal(b.getAttribute('data-print')));
      });
      // Bind entregado
      tb.querySelectorAll('input.delivChk').forEach(chk=>{
        chk.addEventListener('change', async()=>{
          const convId = chk.getAttribute('data-id');
          if (!convId) return;
          const flag = chk.checked;
          chk.disabled = true;
          try{
            const rr = await fetch('/api/admin/conversation-delivered', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ convId, delivered: flag })
            });
            let ok = rr.ok;

            // Si el server/proxy devolvió un status raro pero alcanzó a guardar,
            // verificamos el estado real antes de mostrar error.
            if (!ok) {
              const actual = await verifyDelivered(convId);
              ok = (actual === flag);
            }

            if (!ok) throw new Error('not_updated');

            const tr = chk.closest('tr');
            if (tr) {
              if (flag) tr.classList.add('delivered-row');
              else tr.classList.remove('delivered-row');
            }


          }catch(e){
            // revertir UI
            chk.checked = !flag;
            alert('No se pudo actualizar el estado de entrega');
          }finally{
            chk.disabled = false;
          }
        });
      });

      if(!data.length){
        const tr = document.createElement('tr');
       tr.innerHTML = '<td colspan="11" style="text-align:center;color:#666">Sin conversaciones</td>';
       tb.appendChild(tr);
      }

    }catch(e){
      console.error('loadTable error', e);
    }
  }

  // =========================
  // Buscar
  // =========================
  function openDetailByWaId(wa){
    window.open('/admin/conversation?waId='+encodeURIComponent(wa),'_blank');
  }

  // =========================
  // Bind general
  // =========================
  document.getElementById('delivFilter')?.addEventListener('change', loadTable);

  document.getElementById('btnBuscar')?.addEventListener('click', ()=>{
    const v=(document.getElementById('waIdI')?.value||'').trim();
    if(!v){ alert('Ingresá un waId'); return; }
    openDetailByWaId(v);
  });

  // Bind modal manual/chat
  document.addEventListener('DOMContentLoaded', () => {
    const tBtn = modalToggleManualBtn();
    const sBtn = modalSendBtn();
    const ta = modalReplyText();

    if (tBtn) tBtn.addEventListener('click', toggleModalManual);
    if (sBtn) sBtn.addEventListener('click', sendModalMessage);

    if (ta) {
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          sendModalMessage();
        }
      });
    }
  });

  // Carga inicial + refresco tabla
  loadTable();
  setInterval(loadTable, 20000);


  </script>
</body>
</html>`;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("GET /admin error:", e);
    res.status(500).send("Error interno");
  }
});


 // ---------- Ventana de detalle de conversación ----------
 app.get("/admin/conversation", async (req, res) => {
   try {
     const { convId, waId } = req.query;
     if (!convId && !waId) return res.status(400).send("convId o waId requerido");
     const qs = convId ? ("convId="+encodeURIComponent(convId)) : ("waId="+encodeURIComponent(waId));

     const convIdJs = convId ? String(convId).replace(/\\/g, "\\\\").replace(/'/g, "\\'") : "";
     const waIdJs = waId ? String(waId).replace(/\\/g, "\\\\").replace(/'/g, "\\'") : "";

     res.setHeader("content-type","text/html; charset=utf-8");
     res.end(`<!doctype html><html lang="es"><head>
       <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
       <title>Detalle de conversación</title>
       <style>
         body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin:20px;}
         .msg{border:1px solid #ddd;border-radius:8px;padding:10px;margin-bottom:10px}
         .role-user{background:#f0fafc}
         .role-assistant{background:#f8f6ff}
         small{color:#666}
         pre{white-space:pre-wrap}
         .toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
         .btn{padding:6px 10px; border:1px solid #333; background:#fff; border-radius:4px; cursor:pointer}
         .badge{padding:4px 8px;border-radius:999px;font-size:12px}
         .badge-bot{background:#e3f7e3;color:#145214}
         .badge-manual{background:#ffe4e1;color:#8b0000}
         #chatBox{margin-top:16px;border-top:1px solid #ddd;padding-top:10px;display:flex;flex-direction:column;gap:6px}
         #replyText{width:100%;min-height:70px;font-family:inherit;font-size:14px;padding:6px 8px}
         .chat-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}
         .muted{color:#666;font-size:12px}
       </style></head><body>
       <div class="toolbar">
         <button class="btn" onclick="window.print()">Imprimir</button>
         <button class="btn" onclick="location.reload()">Recargar</button>
         <span id="manualBadge" class="badge badge-bot">Cargando estado…</span>
         <span id="channelInfo" class="muted" style="margin-left:8px"></span>
         <button class="btn" id="toggleManualBtn">Tomar chat (pausar bot)</button>
       </div>
       <div id="root"></div>
       <div id="chatBox">
         <textarea id="replyText" placeholder="Escribí un mensaje para el cliente… (Ctrl/⌘+Enter para enviar)"></textarea>
         <div class="chat-actions">
           <button class="btn" id="sendBtn">Enviar</button>
           <span class="muted">El bot solo se pausa si el chat está en modo manual.</span>
         </div>
       </div>
       <script>
         const CONV_ID = '${convIdJs}';
         const WA_ID = '${waIdJs}';
         const QS = '${qs}';
         let meta = null;
         let manualOpen = false;

         async function loadMessages(){
           const r = await fetch('/api/logs/messages?' + QS);
          const data = await r.json();
           const root = document.getElementById('root');
           root.innerHTML='';
           for (const m of data){
             const d=document.createElement('div');
             d.className='msg role-'+m.role;
             const when = new Date(m.createdAt).toLocaleString();
             d.innerHTML='<small>['+when+'] '+m.role+'</small><pre>'+(m.content||'')+'</pre>';
             root.appendChild(d);
           }
           if(!data.length){ root.innerHTML='<p class="muted">Sin mensajes para mostrar</p>'; }
           root.scrollTop = root.scrollHeight || 0;
         }

         function updateManualUI(){
           const badge = document.getElementById('manualBadge');
           const btn = document.getElementById('toggleManualBtn');
           if (!badge || !btn) return;
           if (manualOpen) {
             badge.textContent = 'Modo MANUAL: bot pausado';
             badge.classList.remove('badge-bot');
             badge.classList.add('badge-manual');
             btn.textContent = 'Liberar al bot';
           } else {
             badge.textContent = 'Modo BOT automático';
             badge.classList.remove('badge-manual');
             badge.classList.add('badge-bot');
             btn.textContent = 'Tomar chat (pausar bot)';
           }
         }

         async function loadMeta(){
           const url = new URL('/api/admin/conversation-meta', window.location.origin);
           if (CONV_ID) url.searchParams.set('convId', CONV_ID);
           else if (WA_ID) url.searchParams.set('waId', WA_ID);
           const r = await fetch(url.toString());
           if (!r.ok) return;
           meta = await r.json();
           manualOpen = !!(meta && meta.manualOpen);
           updateManualUI();
           const ch = (meta && (meta.displayPhoneNumber || meta.phoneNumberId))
             ? (meta.displayPhoneNumber || meta.phoneNumberId)
             : "";
           const chEl = document.getElementById('channelInfo');
           if (chEl) chEl.textContent = ch ? ('Canal: ' + ch) : '';
         }

         async function toggleManual(){
           if (!meta && !CONV_ID && !WA_ID) return;
           const payload = { manualOpen: !manualOpen };
           if (meta && meta.convId) payload.convId = meta.convId;
           else if (CONV_ID) payload.convId = CONV_ID;
           else if (WA_ID) payload.waId = WA_ID;

           const r = await fetch('/api/admin/conversation-manual', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify(payload)
           });
           const j = await r.json().catch(()=>({}));
           if (!r.ok || !j.ok) {
             alert('No se pudo cambiar el estado manual.');
             return;
           }
           manualOpen = !!j.manualOpen;
           updateManualUI();
         }

         async function sendMessage(){
           const ta = document.getElementById('replyText');
           const text = (ta.value || '').trim();
           if (!text) return;
           const payload = { text };
           if (meta && meta.convId) payload.convId = meta.convId;
           else if (CONV_ID) payload.convId = CONV_ID;
           else if (WA_ID) payload.waId = WA_ID;

           const r = await fetch('/api/admin/send-message', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify(payload)
           });
           const j = await r.json().catch(()=>({}));
           if (!r.ok || !j.ok) {
             alert('Error al enviar el mensaje.');
             return;
           }
           ta.value = '';
           await loadMessages();
         }

         document.getElementById('toggleManualBtn').addEventListener('click', toggleManual);
         document.getElementById('sendBtn').addEventListener('click', sendMessage);
         document.getElementById('replyText').addEventListener('keydown', function(e){
           if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
             e.preventDefault();
             sendMessage();
           }
         });

         loadMessages();
         loadMeta();
       </script>
     </body></html>`);
   } catch (e) {
     console.error("GET /admin/conversation error:", e);
     res.status(500).send("Error interno");
   }
 });

// ---------- Ventana separada de mensajes ----------
app.get("/admin/messages/:convId", async (req, res) => {
  try {
    const convId = String(req.params.convId || "").trim();
    if (!convId) return res.status(400).send("convId requerido");
    const msgs = await getConversationMessagesByConvId(convId, 1000);
    const html = `<!doctype html><html><head><meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <title>Mensajes</title>
      <style>
        body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial; margin:16px}
        .msg{border:1px solid #ddd; border-radius:8px; padding:10px; margin-bottom:10px}
        .role-user{background:#f0fafc}.role-assistant{background:#f8f6ff}
        small{color:#666} pre{white-space:pre-wrap; margin:4px 0 0}
      </style></head><body>
      <h3>Mensajes</h3>
      ${msgs.map(m => `
        <div class="msg role-${m.role}">
          <small>[${new Date(m.ts || m.createdAt).toLocaleString()}] ${m.role}</small>
          <pre>${(m.content || "").replace(/</g,"&lt;")}</pre>
        </div>`).join("") || "<em>Sin mensajes</em>"}
      </body></html>`;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("GET /admin/messages error:", e);
    res.status(500).send("Error interno");
 }
});







// ---------- Ticket imprimible (80mm) ----------
app.get("/admin/ticket/:convId", async (req, res) => {
  try {
    const convId = String(req.params.convId || "").trim();
    if (!convId) return res.status(400).send("convId requerido");
    const db = await getDb();
    const convObjectId = new ObjectId(convId);

    // Traemos la conversación para nombre / teléfono
    let pedido = null;
    let nombre = "";
    let waId = "";

    try {
      const conv = await db
        .collection("conversations")
        .findOne(withTenant({ _id: convObjectId }));
      waId = conv?.waId || "";
      nombre = conv?.contactName || "";
    } catch (e) {
      console.error("GET /admin/ticket conv error:", e?.message || e);
    }

    // 1) Intentar leer el pedido desde la colección orders (modo actual)
    try {
      const order = await db
        .collection("orders")
        .findOne(
          withTenant({ conversationId: convObjectId }),
          { sort: { createdAt: -1 } }
        );
      if (order && order.pedido) {
        pedido = order.pedido;
      }
    } catch (e) {
      console.error("GET /admin/ticket orders error:", e?.message || e);
    }

    // 2) Si por algún motivo no encontramos en orders,
    //    caemos al método viejo: buscar el JSON en los mensajes.
    if (!pedido) {
      const msgs = await getConversationMessagesByConvId(convId, 1000);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "assistant") continue;
        const s = String(m.content || "").trim();
        try {
          const j = JSON.parse(s);
          if (j && j.Pedido && Array.isArray(j.Pedido.items)) {
            pedido = j.Pedido;
            break;
          }
        } catch {}
      }
    }

    const items = (pedido?.items || []).map((it) => ({
      desc: String(it.descripcion || "").trim(),
      qty: Number(it.cantidad || 0),
    }));

    const total = Number(pedido?.total_pedido || 0);
    const fecha = new Date().toLocaleString();

    // ===== Modalidad de entrega y dirección =====
    const entregaRaw = String(pedido?.Entrega || "").trim();
    let modalidadText = "-";
    let direccionText = "-";

    if (entregaRaw) {
      // Soportar valores nuevos ("domicilio"/"retiro") y viejos ("Envío (Moreno 2862)")
      if (/domicilio|env[ií]o|delivery/i.test(entregaRaw)) {
        modalidadText = "Envío";
      } else if (/retiro|retir/i.test(entregaRaw)) {
        modalidadText = "Retiro";
      } else {
        // fallback: mostramos lo que vino
        modalidadText = entregaRaw;
      }
    }

    // Dirección: primero miramos Pedido.Domicilio
    if (pedido?.Domicilio) {
      const dom = pedido.Domicilio;
      if (typeof dom === "string") {
        direccionText = dom;
      } else if (typeof dom === "object") {
        direccionText = String(
          dom.direccion || dom.calle || ""
        ).trim();
        if (!direccionText) {
          // último recurso: stringify para no perder info
          direccionText = JSON.stringify(dom);
        }
      }
    } else if (entregaRaw) {
      // Soportar formato viejo: "Envío (Moreno 2862)"
      const m = entregaRaw.match(/\((.+)\)/);
      if (m) direccionText = m[1].trim();
    }
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>Ticket</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  @media print { .no-print{display:none} body{margin:0} }
  body{font-family: ui-monospace, Menlo, Consolas, monospace; width: 80mm; margin:0; padding:8px}
  h3{margin:0 0 8px 0; font-size:14px; text-align:center}
  .line{display:flex; justify-content:space-between; font-size:12px; margin:2px 0}
  .sep{border-top:1px dashed #000; margin:6px 0}
  .foot{font-size:11px; text-align:center; margin-top:8px}
  .btn{padding:6px 10px; border:1px solid #333; border-radius:6px; background:#fff; cursor:pointer}
  .warn{font-size:11px; margin-top:6px}
  </style></head>
<body>
  <h3>Comanda Cliente</h3>
    <div class="line"><span>Fecha</span><span>${fecha}</span></div>
   <div class="line"><span>Teléfono</span><span>${waId || "-"}</span></div>
   <div class="line"><span>Nombre</span><span>${(nombre||"-")}</span></div>
   <div class="line"><span>Entrega</span><span>${modalidadText}</span></div>
   <div class="line"><span>Dirección</span><span>${direccionText}</span></div>
   <div class="sep"></div>
  ${items.length ? items.map(i => `<div class="line"><span>${i.qty} x ${i.desc}</span><span></span></div>`).join("") : "<div class='line'><em>Sin ítems detectados</em></div>"}
  <div class="sep"></div>
  <div class="line"><strong>Total</strong><strong>$ ${total.toLocaleString("es-AR")}</strong></div>
  ${(items.some(x => /milanesa/i.test(x.desc)) ? `<div class="warn">* Las milanesas se pesan al entregar; el precio se informa al momento de la entrega.</div>` : ``)}
  <div class="foot">¡Gracias por tu compra!</div>
</body></html>`;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("GET /admin/ticket error:", e);
    res.status(500).send("Error interno");
  }
});




// GET /api/products  → lista (activos por defecto; ?all=true para todos)
app.get("/api/products", async (req, res) => {
  try {
    const db = await getDb();
    const tenant = resolveTenantId(req);
    const q = req.query.all === "true" ? {} : { active: { $ne: false } };
    if (tenant) q.tenantId = tenant; else if (TENANT_ID) q.tenantId = TENANT_ID;
    const items = await db.collection("products")
      .find(q).sort({ createdAt: -1, descripcion: 1 }).toArray();
    res.json(items.map(it => ({ ...it, _id: String(it._id) })));
  } catch (e) {
    console.error("GET /api/products error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/products  → crear
app.post("/api/products", async (req, res) => {
  try {
    const db = await getDb();
    let { descripcion, importe, cantidad, observacion, active } = req.body || {};
    descripcion = String(descripcion || "").trim();
    observacion = String(observacion || "").trim();
    if (typeof active !== "boolean") active = !!active;
    let imp = null;
    if (typeof importe === "number") imp = importe;
    else if (typeof importe === "string") {
      const n = Number(importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      imp = Number.isFinite(n) ? n : null;
    }
    // cantidad (stock/limite) opcional
    // - si viene vacío, no se guarda
    // - si viene numérico, se guarda como entero
    let qty = null;
    if (typeof cantidad === "number") {
      qty = Number.isFinite(cantidad) ? Math.trunc(cantidad) : null;
    } else if (typeof cantidad === "string") {
      const t = cantidad.trim();
      if (t) {
       // Solo entero (permitimos que el usuario cargue "10" o "10,0")
        const n = parseInt(t.replace(/[^\d-]/g, ""), 10);
        qty = Number.isFinite(n) ? n : null;
      }
    }

    if (!descripcion) return res.status(400).json({ error: "descripcion requerida" });
    const now = new Date();
    const tenant = resolveTenantId(req);
    const doc = { tenantId: (tenant || TENANT_ID || DEFAULT_TENANT_ID || null), descripcion, observacion, active, createdAt: now, updatedAt: now };
     if (qty !== null) doc.cantidad = qty;
    if (imp !== null) doc.importe = imp;
    const ins = await db.collection("products").insertOne(doc);
    res.json({ ok: true, _id: String(ins.insertedId) });
  } catch (e) {
    console.error("POST /api/products error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// PUT /api/products/:id  → actualizar
app.put("/api/products/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const upd = {};
    ["descripcion","observacion","active","importe","cantidad"].forEach(k => {
      if (req.body[k] !== undefined) upd[k] = req.body[k];
    });
    if (upd.importe !== undefined && typeof upd.importe === "string") {
      const n = Number(upd.importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      upd.importe = Number.isFinite(n) ? n : undefined;
    }
    // cantidad: permitir "" para limpiar (null)
    if (upd.cantidad !== undefined) {
      if (typeof upd.cantidad === "string") {
        const t = upd.cantidad.trim();
        if (!t) {
          upd.cantidad = null;
        } else {
          const n = parseInt(t.replace(/[^\d-]/g, ""), 10);
          upd.cantidad = Number.isFinite(n) ? n : null;
        }
      } else if (typeof upd.cantidad === "number") {
        upd.cantidad = Number.isFinite(upd.cantidad) ? Math.trunc(upd.cantidad) : null;
      } else {
        upd.cantidad = null;
      }
    }
    if (Object.keys(upd).length === 0) return res.status(400).json({ error: "no_fields" });
    upd.updatedAt = new Date();
    const tenant = resolveTenantId(req);
    const filter = { _id: new ObjectId(String(id)) };
    if (tenant) filter.tenantId = tenant; else if (TENANT_ID) filter.tenantId = TENANT_ID;
    const result = await db.collection("products").updateOne(filter, { $set: upd });
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /api/products/:id error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// DELETE /api/products/:id  → eliminar
app.delete("/api/products/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const tenant = resolveTenantId(req);
    const filter = { _id: new ObjectId(String(id)) };
    if (tenant) filter.tenantId = tenant; else if (TENANT_ID) filter.tenantId = TENANT_ID;
    const result = await db.collection("products").deleteOne(filter);
    if (!result.deletedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/products/:id error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/products/:id/inactivate  → inactivar
app.post("/api/products/:id/inactivate", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const tenant = resolveTenantId(req);
    const filter = { _id: new ObjectId(String(id)) };
    if (tenant) filter.tenantId = tenant; else if (TENANT_ID) filter.tenantId = TENANT_ID;
    const result = await db.collection("products").updateOne(filter, { $set: { active: false, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/products/:id/inactivate error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/products/:id/reactivate  → reactivar
app.post("/api/products/:id/reactivate", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const tenant = resolveTenantId(req);
    const filter = { _id: new ObjectId(String(id)) };
    if (tenant) filter.tenantId = tenant; else if (TENANT_ID) filter.tenantId = TENANT_ID;
    const result = await db.collection("products").updateOne(filter, { $set: { active: true, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/products/:id/reactivate error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// GET /productos  → UI HTML simple para administrar
app.get("/productos", async (req, res) => {
  try {
    const db = await getDb();
    const verTodos = req.query.all === "true";
    const tenant = resolveTenantId(req);
    const filtro = verTodos ? {} : { active: { $ne: false } };
    if (tenant) filtro.tenantId = tenant; else if (TENANT_ID) filtro.tenantId = TENANT_ID;
    const productos = await db.collection("products").find(filtro).sort({ createdAt: -1 }).toArray();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" /><title>Productos</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:1100px}
        table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
        th{background:#f5f5f5;text-align:left}input,textarea{width:100%;box-sizing:border-box}
        textarea{min-height:56px}.row{display:flex;gap:8px;align-items:center}.btn{padding:6px 10px;border:1px solid #333;background:#fff;border-radius:4px;cursor:pointer}
      </style></head><body>
      <h1>Productos</h1>
      <div class="row"><a class="btn" href="/productos${verTodos ? "" : "?all=true"}">${verTodos ? "Ver solo activos" : "Ver todos"}</a> <button id="btnAdd" class="btn">Agregar</button> <button id="btnReload" class="btn">Recargar</button></div>
      <p></p>
      <table id="tbl"><thead><tr><th>Descripción</th><th>Importe</th><th>Cantidad</th><th>Obs.</th><th>Activo</th><th>Acciones</th></tr></thead>
      <tbody>${productos.map(p => `<tr data-id="${p._id}">
        <td><input class="descripcion" type="text" value="${(p.descripcion||'').replace(/\"/g,'&quot;')}" /></td>
        <td><input class="importe" type="number" step="0.01" value="${p.importe ?? ''}" /></td>
        <td><input class="cantidad" type="number" step="1" value="${p.cantidad ?? ''}" /></td>
        <td><textarea class="observacion">${(p.observacion||'').replace(/</g,'&lt;')}</textarea></td>
        <td><input class="active" type="checkbox" ${p.active!==false?'checked':''} /></td>
        <td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">${p.active!==false?'Inactivar':'Reactivar'}</button></td>
      </tr>`).join('')}</tbody></table>
      <template id="row-tpl"><tr data-id="">
        <td><input class="descripcion" type="text" /></td>
        <td><input class="importe" type="number" step="0.01" /></td>
        <td><input class="cantidad" type="number" step="1" /></td>
        <td><textarea class="observacion"></textarea></td>
        <td><input class="active" type="checkbox" checked /></td>
        <td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">Inactivar</button></td>
      </tr></template>
      <script>
        function q(s,c){return (c||document).querySelector(s)}function all(s,c){return Array.from((c||document).querySelectorAll(s))}
        async function j(url,opts){const r=await fetch(url,opts||{});if(!r.ok)throw new Error('HTTP '+r.status);const ct=r.headers.get('content-type')||'';return ct.includes('application/json')?r.json():r.text()}
        async function reload(){const url=new URL(location.href);const allFlag=url.searchParams.get('all')==='true';const data=await j('/api/products'+(allFlag?'?all=true':''));const tb=q('#tbl tbody');tb.innerHTML='';for(const it of data){const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);tr.dataset.id=it._id||'';q('.descripcion',tr).value=it.descripcion||'';q('.importe',tr).value=typeof it.importe==='number'?it.importe:(it.importe||'');q('.cantidad',tr).value=typeof it.cantidad==='number'?it.cantidad:(it.cantidad||'');q('.observacion',tr).value=it.observacion||'';q('.active',tr).checked=it.active!==false;q('.toggle',tr).textContent=(it.active!==false)?'Inactivar':'Reactivar';bindRow(tr);tb.appendChild(tr);}if(!data.length){const r=document.createElement('tr');r.innerHTML='<td colspan="6" style="text-align:center;color:#666">Sin productos para mostrar</td>';tb.appendChild(r);}}
        async function saveRow(tr){const id=tr.dataset.id;const payload={descripcion:q('.descripcion',tr).value.trim(),importe:q('.importe',tr).value.trim(),cantidad:q('.cantidad',tr).value.trim(),observacion:q('.observacion',tr).value.trim(),active:q('.active',tr).checked};if(!payload.descripcion){alert('Descripción requerida');return;}if(id){await j('/api/products/'+encodeURIComponent(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}else{await j('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}await reload();}
  async function deleteRow(tr){const id=tr.dataset.id;if(!id){tr.remove();return;}if(!confirm('¿Eliminar definitivamente?'))return;await j('/api/products/'+encodeURIComponent(id),{method:'DELETE'});await reload();}
        async function toggleRow(tr){const id=tr.dataset.id;if(!id){alert('Primero guardá el nuevo producto.');return;}const active=q('.active',tr).checked;const path=active?('/api/products/'+encodeURIComponent(id)+'/inactivate'):('/api/products/'+encodeURIComponent(id)+'/reactivate');await j(path,{method:'POST'});await reload();}
        function bindRow(tr){q('.save',tr).addEventListener('click',()=>saveRow(tr));q('.del',tr).addEventListener('click',()=>deleteRow(tr));q('.toggle',tr).addEventListener('click',()=>toggleRow(tr));}
        document.getElementById('btnReload').addEventListener('click',reload);
        document.getElementById('btnAdd').addEventListener('click',()=>{const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);q('#tbl tbody').prepend(tr);bindRow(tr);});
        all('#tbl tbody tr').forEach(bindRow);
      </script></body></html>`);
  } catch (e) {
    console.error("/productos error:", e);
    res.status(500).send("internal");
  }
});


 
// ================== Horarios de atención (UI L-V) ==================
// Página simple para cargar horarios de lunes a viernes (hasta 2 franjas por día)
app.get("/horarios", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const db = await getDb();
    const _id = `store_hours:${tenant}`;
    const doc = (await db.collection("settings").findOne({ _id })) || {};
    const hours = doc.hours || {};
    const hoursJson = JSON.stringify(hours).replace(/</g, "\\u003c");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" />
      <title>Horarios de atención (${tenant})</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:960px}
        table{border-collapse:collapse;width:100%}
        th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}
        th{background:#f5f5f5}
        input[type=time]{width:100%;box-sizing:border-box;padding:4px}
        input[type=checkbox]{transform:scale(1.1)}
        .row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
        .btn{padding:6px 10px;border-radius:4px;border:1px solid #333;background:#fff;cursor:pointer}
        .btn:active{transform:scale(.97)}
        .hint{color:#555;font-size:13px}
      </style></head><body>
      <h1>Horarios de atención</h1>
      <p class="hint">Configurá las franjas horarias disponibles de <strong>lunes a domingo</strong>. Cada día puede tener hasta dos rangos horarios.</p>
      <div class="row">
        <label>Tenant:&nbsp;<input id="tenant" type="text" value="${tenant.replace(/"/g,'&quot;')}" /></label>
        <button id="btnReload" class="btn">Recargar</button>
        <button id="btnSave" class="btn">Guardar</button>
      </div>
      <table>
        <thead><tr>
          <th>Día</th>
          <th>Habilitado</th>
          <th>Desde 1</th>
          <th>Hasta 1</th>
          <th>Desde 2</th>
          <th>Hasta 2</th>
        </tr></thead>
        <tbody>
          ${STORE_HOURS_DAYS.map(d => `
          <tr data-day="${d.key}">
            <td>${d.label}</td>
            <td style="text-align:center"><input type="checkbox" class="enabled" /></td>
            <td><input type="time" class="from1" /></td>
            <td><input type="time" class="to1" /></td>
            <td><input type="time" class="from2" /></td>
            <td><input type="time" class="to2" /></td>
          </tr>`).join("")}
        </tbody>
      </table>
      <p class="hint">Dejá un día deshabilitado o sin horarios para que no se pueda seleccionar. Los horarios se guardan en el backend y se usarán para validar nuevos pedidos.</p>
      <script>
        const DAYS = ${JSON.stringify(STORE_HOURS_DAYS).replace(/</g,"\\u003c")};

        function setForm(data){
          DAYS.forEach(d => {
            const row = document.querySelector('tr[data-day="'+d.key+'"]');
            if (!row) return;
            const ranges = Array.isArray(data[d.key]) ? data[d.key] : [];
            const r1 = ranges[0] || {};
            const r2 = ranges[1] || {};
            row.querySelector('.enabled').checked = ranges.length > 0;
            row.querySelector('.from1').value = r1.from || "";
            row.querySelector('.to1').value   = r1.to   || "";
            row.querySelector('.from2').value = r2.from || "";
            row.querySelector('.to2').value   = r2.to   || "";
          });
        }

        function collectForm(){
          const out = {};
          DAYS.forEach(d => {
            const row = document.querySelector('tr[data-day="'+d.key+'"]');
            if (!row) return;
            const enabled = row.querySelector('.enabled').checked;
            const f1 = row.querySelector('.from1').value;
            const t1 = row.querySelector('.to1').value;
            const f2 = row.querySelector('.from2').value;
            const t2 = row.querySelector('.to2').value;
            if (!enabled) return;
            const ranges = [];
            if (f1 && t1) ranges.push({ from:f1, to:t1 });
            if (f2 && t2) ranges.push({ from:f2, to:t2 });
            if (ranges.length) out[d.key] = ranges;
          });
          return out;
        }

        async function reloadHours(){
          const t = document.getElementById('tenant').value || '';
          const r = await fetch('/api/hours?tenant=' + encodeURIComponent(t));
          if (!r.ok) { alert('Error recargando horarios'); return; }
          const j = await r.json();
          setForm(j.hours || {});
        }

        async function saveHours(){
          const t = document.getElementById('tenant').value || '';
          const hours = collectForm();
          const r = await fetch('/api/hours', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ tenantId:t, hours })
          });
          if (!r.ok) { alert('Error al guardar'); return; }
          const j = await r.json();
          setForm(j.hours || {});
          alert('Horarios guardados ✅');
        }

        document.getElementById('btnReload').addEventListener('click', reloadHours);
        document.getElementById('btnSave').addEventListener('click', saveHours);
        // Inicializar con lo que vino del servidor
        setForm(${hoursJson});
      </script></body></html>`);
  } catch (e) {
    console.error("/horarios error:", e);
    res.status(500).send("internal");
  }
});



// Behavior UI
app.get("/comportamiento", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const cfg = await loadBehaviorConfigFromMongo(tenant);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" />
      <title>Comportamiento del Bot (${tenant})</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:960px}
      textarea{width:100%;min-height:360px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}
      .row{display:flex;gap:8px;align-items:center}.hint{color:#666;font-size:12px}.tag{padding:2px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px}
      input[type=text]{padding:6px 8px}</style></head><body>
      <h1>Comportamiento del Bot</h1>
      <div class="row">
        <label>Tenant:&nbsp;<input id="tenant" type="text" value="${tenant}" /></label>
        <button id="btnReload">Recargar</button>
        <button id="btnSave">Guardar</button>
      </div>
      <div class="row" style="margin-top:8px">
        <label>Modo de historial:&nbsp;
          <select id="historyMode">
            <option value="standard">standard (completo)</option>
            <option value="minimal">minimal (solo user + assistant Pedido)</option>
          </select>
        </label>
      </div>
      <p></p><textarea id="txt" placeholder="Escribí aquí el comportamiento para este tenant..."></textarea>
      <script>
        async function load(){
          const t = document.getElementById('tenant').value || '';
          const r=await fetch('/api/behavior?tenant='+encodeURIComponent(t));
          const j=await r.json();
          document.getElementById('txt').value=j.text||'';
          document.getElementById('historyMode').value = (j.history_mode || 'standard');
        }
        async function save(){
          const t=document.getElementById('tenant').value||'';
          const v=document.getElementById('txt').value||'';
          const m=document.getElementById('historyMode').value||'standard';
          const r=await fetch('/api/behavior?tenant='+encodeURIComponent(t),{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({text:v,tenantId:t,history_mode:m})
          });
          alert(r.ok?'Guardado ✅':'Error al guardar');
        }
        document.getElementById('btnSave').addEventListener('click',save);
        document.getElementById('btnReload').addEventListener('click',load);
        document.addEventListener('DOMContentLoaded', () => {
          document.getElementById('historyMode').value='${(cfg.history_mode || 'standard').replace(/"/g,'&quot;')}';
        });
        load();
      </script></body></html>`);
  } catch (e) { console.error("/comportamiento error:", e); res.status(500).send("internal"); }
});


// ===================================================================
// ===============          Canales (WA/OpenAI)        ===============
// ===================================================================
// UI simple (sin sidebar) para administrar tenant_channels.
// Se usa dentro de /ui/canales (appShell) para evitar duplicar el menú.
app.get("/canales", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Canales (${tenant})</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:1100px}
    h1{margin:0 0 8px}
    .muted{color:#666;font-size:13px}
    .row{display:flex;gap:14px;flex-wrap:wrap}
    .card{border:1px solid #ddd;border-radius:10px;padding:14px;flex:1;min-width:320px}
    label{display:block;font-size:12px;color:#333;margin:10px 0 6px}
    input{width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:8px}
    button{padding:10px 14px;border:0;border-radius:8px;background:#0f766e;color:#fff;font-weight:600;cursor:pointer}
    button.secondary{background:#e5e7eb;color:#111827}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{border-bottom:1px solid #eee;padding:10px;text-align:left;font-size:13px;vertical-align:top}
    th{font-size:12px;color:#374151}
    .pill{display:inline-block;padding:2px 8px;border:1px solid #cbd5e1;border-radius:999px;font-size:12px;color:#0f172a;background:#f8fafc}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .msg{margin:10px 0;padding:10px 12px;border-radius:8px}
    .msg.ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46}
    .msg.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
    code{background:#f3f4f6;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <h1>Canales (WhatsApp/OpenAI)</h1>
  <div class="muted">Configurá por <b>tenantId</b> y <b>phoneNumberId</b> el token de WhatsApp, verify token y API key de OpenAI (colección <code>tenant_channels</code>). Podés marcar un canal como <b>Default</b> por tenant.</div>

  <div id="msg"></div>

  <div class="row" style="margin-top:14px">
    <div class="card">
      <h3 style="margin:0 0 8px">Crear / actualizar</h3>
      <form id="f">
        <label>TenantId</label>
        <input name="tenantId" value="${String(tenant||'').replace(/"/g,'&quot;')}" placeholder="default"/>

        <label>Phone Number ID (Meta)</label>
        <input name="phoneNumberId" placeholder="1234567890" required/>

        <label>Display phone (opcional)</label>
        <input name="displayPhoneNumber" placeholder="+54 9 ..."/>

        <label>WhatsApp Token</label>
        <input name="whatsappToken" placeholder="EAAG..." />

        <label>Verify Token</label>
        <input name="verifyToken" placeholder="mi-token-verificacion" />

        <label>OpenAI API Key</label>
        <input name="openaiApiKey" placeholder="sk-..." />

        <label style="display:flex;gap:10px;align-items:center;margin-top:12px">
          <input type="checkbox" name="isDefault" value="1" style="width:auto"/>
          <span>Canal default (por tenant)</span>
        </label>
       <div class="actions" style="margin-top:12px">
          <button type="submit">Guardar</button>
          <button type="button" class="secondary" id="btnClear">Limpiar</button>
          <button type="button" class="secondary" id="btnReload">Actualizar</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h3 style="margin:0 0 8px">Canales cargados</h3>
      <div class="muted">Tip: hacé click en “Editar” para cargar los campos.</div>
      <div style="overflow:auto">
        <table>
          <thead>
            <tr>
              <th>Tenant</th>
              <th>PhoneNumberId</th>
              <th>Display</th>
              <th>Default</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="tbody">
            <tr><td colspan="6" class="muted">Cargando...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

<script>
(function(){
  const msgEl = document.getElementById('msg');
  const form = document.getElementById('f');
  const tbody = document.getElementById('tbody');
  const btnClear = document.getElementById('btnClear');
  const btnReload = document.getElementById('btnReload');

  function esc(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function setMsg(type, text){
    if(!text){ msgEl.innerHTML=''; return; }
    msgEl.innerHTML = '<div class="msg '+(type==='ok'?'ok':'err')+'">'+esc(text)+'</div>';
  }

  async function load(){
    setMsg('', '');
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Cargando...</td></tr>';
    const tenantId = (form.tenantId.value||'').trim();
    const qs = tenantId ? ('?tenantId='+encodeURIComponent(tenantId)) : '';
    const r = await fetch('/api/tenant-channels'+qs, { headers: { 'Accept':'application/json' }});
    if(!r.ok){
      tbody.innerHTML = '<tr><td colspan="5">No se pudo cargar.</td></tr>';
      return;
    }
    const j = await r.json();
    const items = Array.isArray(j.items) ? j.items : [];
    if(!items.length){
      tbody.innerHTML = '<tr><td colspan="6" class="muted">No hay canales cargados.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(it => {
      return '<tr>'+
        '<td><span class="pill">'+esc(it.tenantId||'')+'</span></td>'+
        '<td>'+esc(it.phoneNumberId||'')+'</td>'+
        '<td>'+esc(it.displayPhoneNumber||'')+'</td>'+
        '<td>'+def+'</td>'+
        '<td class="muted">'+esc(it.updatedAt||it.createdAt||'')+'</td>'+
        '<td class="actions">'+
          '<button type="button" class="secondary" data-edit="'+esc(it._id)+'">Editar</button>'+
          '<button type="button" class="secondary" data-make-default="1" data-tenant="'+esc(it.tenantId||'')+'" data-phone="'+esc(it.phoneNumberId||'')+'">Hacer default</button>'+
        '</td>'+
      '</tr>';
    }).join('');

    // wire edit buttons
    tbody.querySelectorAll('button[data-edit]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-edit');
        const it = items.find(x => String(x._id)===String(id));
        if(!it) return;
        form.tenantId.value = it.tenantId || '';
        form.phoneNumberId.value = it.phoneNumberId || '';
        form.displayPhoneNumber.value = it.displayPhoneNumber || '';
        // secretos pueden venir enmascarados si no sos superadmin; igual dejamos el valor actual por si querés reescribir
        form.whatsappToken.value = (it.whatsappToken && it.whatsappToken !== '********') ? it.whatsappToken : '';
        form.verifyToken.value = (it.verifyToken && it.verifyToken !== '********') ? it.verifyToken : '';
        form.openaiApiKey.value = (it.openaiApiKey && it.openaiApiKey !== '********') ? it.openaiApiKey : '';
          const cb = form.querySelector('input[name="isDefault"]');
          if (cb) cb.checked = !!it.isDefault;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

      // wire make-default buttons (no toca tokens, solo marca isDefault)
      tbody.querySelectorAll('button[data-make-default]').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const t = btn.getAttribute('data-tenant') || '';
          const p = btn.getAttribute('data-phone') || '';
          if(!t || !p) return;
          setMsg('', '');
          const data = new URLSearchParams();
          data.set('tenantId', t);
          data.set('phoneNumberId', p);
          data.set('isDefault', '1');
          const r = await fetch('/api/tenant-channels', {
            method: 'POST',
            headers: { 'Content-Type':'application/x-www-form-urlencoded' },
            body: data
          });
          const j = await r.json().catch(()=>null);
          if(!r.ok){
            setMsg('err', (j && j.error) ? j.error : 'Error seteando default.');
            return;
          }
          setMsg('ok', 'Default actualizado ✅');
          await load();
        });
      });
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    setMsg('', '');
    const data = new URLSearchParams(new FormData(form));
    const r = await fetch('/api/tenant-channels', {
      method: 'POST',
      headers: { 'Content-Type':'application/x-www-form-urlencoded' },
      body: data
    });
    const j = await r.json().catch(()=>null);
    if(!r.ok){
      setMsg('err', (j && j.error) ? j.error : 'Error guardando.');
      return;
    }
    setMsg('ok', 'Guardado OK.');
    await load();
  });

  btnClear.addEventListener('click', ()=>{
    const keepTenant = form.tenantId.value;
    form.reset();
    form.tenantId.value = keepTenant;
    setMsg('', '');
  });

  btnReload.addEventListener('click', load);

  load();
})();
</script>
</body>
</html>`);
  } catch (e) {
    console.error("GET /canales error:", e?.message || e);
    res.status(500).send("Error");
  }
});

app.get("/api/behavior", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const cfg = await loadBehaviorConfigFromMongo(tenant);
    res.json({ source: "mongo", tenant, text: cfg.text, history_mode: cfg.history_mode });
  } catch {
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/behavior", async (req, res) => {
  try {
    const tenant = (req.body?.tenantId || resolveTenantId(req)).toString().trim();
    const text = String(req.body?.text || "").trim();
    const history_mode = String(req.body?.history_mode || "").trim() || "standard";
    const db = await require("./db").getDb();
    const _id = `behavior:${tenant}`;
    await db.collection("settings").updateOne(
      { _id },
      { $set: { text, history_mode, tenantId: tenant, updatedAt: new Date() } },
      { upsert: true }
    );
    invalidateBehaviorCache(tenant);
    res.json({ ok: true, tenant, history_mode });
  } catch (e) {
    console.error("POST /api/behavior error:", e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/behavior/refresh-cache", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    invalidateBehaviorCache(tenant);
    res.json({ ok: true, tenant, cache: "invalidated" });
  } catch (e) { console.error("refresh-cache error:", e); res.status(500).json({ error: "internal" }); }
});

// ===================================================================
// ===============      Horarios de atención (L-V)     ================
// ===================================================================
// Permite guardar y leer los horarios disponibles de lunes a viernes.
// Cada día puede tener hasta dos franjas horarias [{ from, to }, ...]
// Formato de hora: "HH:MM" (24h).

function normalizeHoursPayload(raw) {
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday","saturday","sunday"];
  const out = {};
  const isHHMM = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "").trim());

  for (const d of days) {
    const ranges = Array.isArray(raw?.[d]) ? raw[d] : [];
    const normRanges = [];

    for (const r of ranges) {
      if (!r) continue;
      // Soportar tanto { from, to } como { desde, hasta }
      const from = String(r.from ?? r.desde ?? "").trim();
      const to   = String(r.to   ?? r.hasta ?? "").trim();

      // Validar formato y que from < to
      if (!isHHMM(from) || !isHHMM(to)) continue;
      if (from >= to) continue;

      normRanges.push({ from, to });
      // Máximo 2 franjas por día
      if (normRanges.length >= 2) break;
    }

    if (normRanges.length) {
      out[d] = normRanges;
    }
  }

  return out;
}

// GET /api/hours  → devuelve horarios configurados para el tenant actual
app.get("/api/hours", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const db = await getDb();
    const _id = `store_hours:${tenant}`;
    const doc = (await db.collection("settings").findOne({ _id })) || {};

    res.json({
      ok: true,
      tenant,
      hours: doc.hours || {},
      updatedAt: doc.updatedAt || null,
    });
  } catch (e) {
    console.error("GET /api/hours error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/hours  → guarda horarios (sobrescribe los existentes para ese tenant)
app.post("/api/hours", async (req, res) => {
  try {
    const tenant = (req.body?.tenantId || resolveTenantId(req)).toString().trim();
    const hours = normalizeHoursPayload(req.body?.hours || req.body || {});

    const db = await getDb();
    const _id = `store_hours:${tenant}`;
    await db.collection("settings").updateOne(
      { _id },
      { $set: { hours, tenantId: tenant, updatedAt: new Date() } },
      { upsert: true }
    );

    res.json({ ok: true, tenant, hours });
  } catch (e) {
    console.error("POST /api/hours error:", e);
    res.status(500).json({ error: "internal" });
  }
});






// Webhook Verify (GET)
// Retrocompatible: acepta VERIFY_TOKEN de .env como siempre,
// y además acepta cualquier verifyToken guardado en tenant_channels.
app.get("/webhook", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] || "").trim();
  const challenge = req.query["hub.challenge"];

  if (!mode || mode !== "subscribe" || !token) return res.sendStatus(403);

  // 1) modo legacy (solo .env)
  if (token && token === String(VERIFY_TOKEN || "").trim()) {
    return res.status(200).send(challenge);
  }

  // 2) modo multi-tenant (DB)
  try {
    const rt = await findAnyByVerifyToken(token);
    if (rt) return res.status(200).send(challenge);
  } catch (e) {
    console.error("[webhook] verify db error:", e?.message || e);
  }

  return res.sendStatus(403);
});

// Webhook Entrante (POST)
app.post("/webhook", async (req, res) => {
  try {
    if (process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) {
      if (process.env.NODE_ENV === "production") return res.sendStatus(403);
      console.warn("⚠️ Webhook: firma inválida (ignorada en dev).");
    }
// ✅ PARSEO CORRECTO DEL PAYLOAD WHATSAPP

    const change = req.body?.entry?.[0]?.changes?.[0];
    const value  = change?.value;
const phoneNumberIdInbound =
  value?.metadata?.phone_number_id ||
  value?.metadata?.phoneNumberId ||
  value?.metadata?.phone_number ||
  null;

// Runtime por canal (WhatsApp/OpenAI) desde Mongo.
// Si no existe, cae a .env (100% retrocompatible).
let runtime = null;
try { runtime = await getRuntimeByPhoneNumberId(phoneNumberIdInbound); } catch {}
const tenant = String(runtime?.tenantId || DEFAULT_TENANT_ID || TENANT_ID || "default").trim();

const waOpts = {
  whatsappToken: runtime?.whatsappToken || null,
  phoneNumberId: runtime?.phoneNumberId || phoneNumberIdInbound || null,
};
const aiOpts = { openaiApiKey: runtime?.openaiApiKey || null };

    const msg    = value?.messages?.[0];   // mensaje entrante (texto/audio/etc.)
    const status = value?.statuses?.[0];   // (se ignora para persistencia)
    if (!msg) {
      console.warn("[webhook] evento sin messages; se ignora");
      return res.sendStatus(200);
    }
    const from = msg.from;
    let text   = (msg.text?.body || "").trim();
    const msgType = msg.type;

    // Normalización del texto según tipo de mensaje
    if (msg.type === "text" && msg.text?.body) {
      text = msg.text.body;
    } else if (msg.type === "audio" && msg.audio?.id) {
      try {
        const info = await getMediaInfo(msg.audio.id, waOpts);
        const buf = await downloadMediaBuffer(info.url, waOpts);
        const id = putInCache(buf, info.mime_type || "audio/ogg");
        const publicAudioUrl = `${req.protocol}://${req.get("host")}/cache/audio/${id}`;
        const tr = await transcribeAudioExternal({ publicAudioUrl, buffer: buf, mime: info.mime_type, ...aiOpts });
        text = String(tr?.text || "").trim() || "(audio sin texto)";
      } catch (e) {
        console.error("Audio/transcripción:", e.message);
        text = "(no se pudo transcribir el audio)";
      }
     } else if (msg.type === "image" && msg.image?.id) {
      try {
        const info = await getMediaInfo(msg.image.id, waOpts);
        const buf = await downloadMediaBuffer(info.url, waOpts);
        const id = putInCache(buf, info.mime_type || "image/jpeg");
        const publicImageUrl = `${req.protocol}://${req.get("host")}/cache/media/${id}`;

        const img = await analyzeImageExternal({
          publicImageUrl,
          mime: info.mime_type,
          purpose: "payment-proof",
          ...aiOpts
        });

        // Texto que alimenta al modelo conversacional
        text = img?.userText || "[imagen recibida]";

        // enriquecemos meta para admin/debug
        msg.__media = { cacheId: id, publicUrl: publicImageUrl, mime: info.mime_type, analysis: img?.json || null };
      } catch (e) {
        console.error("Imagen/análisis:", e?.message || e);
        text = "[imagen recibida]";
      }
    }

        // Asegurar conversación y guardar mensaje de usuario
    let conv = null;
     try {
       // Guardamos el canal/telefono por el que entró el mensaje para poder verlo en Admin UI
       conv = await upsertConversation(from, {
         phoneNumberId: waOpts?.phoneNumberId || null,
         displayPhoneNumber: runtime?.displayPhoneNumber || null,
       }, tenant);
     } catch (e) { console.error("upsertConversation:", e?.message); }
     // Guardamos phoneNumberId para poder responder/operar por el mismo canal luego (admin, etc.)
 
    const convId = conv?._id;

   
console.log("[convId] "+ convId);

    // ✅ Si se creó una conversación nueva, reseteamos historial del LLM
    // para que un nuevo pedido no arrastre contexto del pedido anterior.
    if (convId) syncSessionConversation(tenant, from, convId);

       if (convId) {
      console.log("[messages] about to save USER message", { convId, from, type: msg.type, textPreview: String(text).slice(0,80) });
      try {
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "user",
          content: text,
          type: msg.type || "text",
           meta: { raw: msg, media: msg.__media || null }
        });
      } catch (e) { console.error("saveMessage(user):", e?.message); }
    }

    // 🧑‍💻 Si la conversación está en modo manual, no respondemos automáticamente
    if (conv && conv.manualOpen) {
      console.log("[webhook] conversación en modo manualOpen=true; se omite respuesta automática.");
      return res.sendStatus(200);
   }


    // Si el mensaje NO es solo un cierre de cortesía, limpiamos el flag de sesión terminada
    if (!isPoliteClosingMessage(text)) {
      clearEndedFlag(tenant, from);
    }

    if (hasActiveEndedFlag(tenant, from)) {
      if (isPoliteClosingMessage(text)) {
        await require("./logic").sendWhatsAppMessage(
          from,
          "¡Gracias! 😊 Cuando quieras hacemos otro pedido.",
          waOpts
        );
        return res.sendStatus(200);
      }
    }

        // ⚡ Fast-path: si el usuario confirma explícitamente, cerramos sin llamar al modelo
    // ⚡ Fast-path: aceptar también “sí/si” como confirmación explícita,
    // además de las variantes de “confirmar”.
    const userConfirms =
      /\bconfirm(ar|o|a|ame|alo|ado)\b/i.test(text) ||
      /\b(s[ií])\b/.test(text);
    if (userConfirms) {
      // Tomamos último snapshot si existe
      let snapshot = null;
      try { snapshot = JSON.parse(require("./logic").__proto__ ? "{}" : "{}"); } catch {}
      // En minimal guardamos snapshot siempre; si no lo tenés a mano, seguimos y dejamos que el modelo lo complete
    }
    const gptReply = await getGPTReply(tenant, from, text, aiOpts);
    // También dispara si el usuario pide "total" o está en fase de confirmar
   const wantsDetail = /\b(detalle|detall|resumen|desglose|total|confirm(a|o|ar))\b/i
      .test(String(text || ""));


    let responseText = "Perdón, hubo un error. ¿Podés repetir?";
    let estado = null;
    let pedido = null;

    try {
      const parsed = JSON.parse(gptReply);
      estado = parsed.estado;
      pedido = parsed.Pedido || { items: [] };
      // 💰 Hidratar precios desde catálogo ANTES de recalcular (evita “Pollo entero @ 0”)
      try { pedido = await hydratePricesFromCatalog(pedido, tenant || null); } catch {}
      // 🚚 Asegurar ítem Envío con geocoding/distancia (awaitable, sin race)
      try { pedido = await ensureEnvioSmart(pedido, tenant || null); } catch {}

      // 🧽 Normalización defensiva: si el modelo puso la HORA en `Entrega`, corrige campos.
      if (pedido && typeof pedido.Entrega === "string" && /^\d{1,2}:\d{2}$/.test(pedido.Entrega)) {
        const hhmm = pedido.Entrega.length === 4 ? ("0" + pedido.Entrega) : pedido.Entrega;
        pedido.Hora = pedido.Hora || hhmm;
        // Si `Entrega` no es "domicilio" ni "retiro", dejalo vacío para que no bloquee isPedidoCompleto
        if (!/^(domicilio|retiro)$/i.test(pedido.Entrega)) pedido.Entrega = "";
      }

      const { pedidoCorr, mismatch, hasItems } = recalcAndDetectMismatch(pedido);
      pedido = pedidoCorr;

      //if (mismatch && hasItems) {
      //  let fixedOk = false;
      //  let parsedFixLast = null;

       // ✅ Si el modelo devuelve {"error":"..."} lo tratamos como MENSAJE AL USUARIO (no fatal):
      if (typeof parsed?.error === "string" && parsed.error.trim()) {
        responseText = parsed.error.trim();
      } else if (mismatch && hasItems) {
        let fixedOk = false;
        let parsedFixLast = null;

        const itemsForModel = (pedido.items || [])
          .map(i => `- ${i.cantidad} x ${i.descripcion} @ ${i.importe_unitario}`)
          .join("\n");

        const baseCorrection = [
          "[CORRECCION_DE_IMPORTES]",
          "Detectamos que los importes de tu JSON no coinciden con la suma de ítems según el catálogo.",
          "Usá EXACTAMENTE estos ítems interpretados por backend (cantidad y precio unitario):",
          itemsForModel,
          `Total esperado por backend (total_pedido): ${pedido.total_pedido}`,
          "Reglas OBLIGATORIAS:",
          "- Recalculá todo DESDE CERO usando esos precios (no arrastres totales previos).",
          "- Si Pedido.Entrega = 'domicilio', DEBES incluir el ítem de Envío correspondiente.",
          "",
          "SOBRE EL CAMPO response:",
          "- NO digas que estás recalculando ni hables de backend ni de importes.",
          "- Usá en `response` el MISMO tipo de mensaje que venías usando para seguir la conversación.",
          "- Si antes estabas pidiendo fecha y hora, seguí pidiendo fecha y hora.",
          "- Si ya tenés fecha/hora, seguí con el siguiente dato faltante (por ejemplo, nombre del cliente).",
          "",
          "Devolvé UN ÚNICO objeto JSON con: response, estado (IN_PROGRESS|COMPLETED|CANCELLED),",
          "y Pedido { Entrega, Domicilio, items[ {id, descripcion, cantidad, importe_unitario, total} ], total_pedido }.",
          "No incluyas texto fuera del JSON."
        ].join("\n");

        for (let attempt = 1; attempt <= (Number(process.env.CALC_FIX_MAX_RETRIES || 3)); attempt++) {
          const fixReply = await getGPTReply(tenant, from, `${baseCorrection}\n[INTENTO:${attempt}/${process.env.CALC_FIX_MAX_RETRIES || 3}]`, aiOpts);
          console.log(`[fix][${attempt}] assistant.content =>\n${fixReply}`);
          try {
            const parsedFix = JSON.parse(fixReply);
            parsedFixLast = parsedFix;
            estado = parsedFix.estado || estado;

            let pedidoFix = parsedFix.Pedido || { items: [] };
             // 💰 Rehidratar también en el ciclo de fix
            try { pedidoFix = await hydratePricesFromCatalog(pedidoFix, tenant || null); } catch {}
         
            const { pedidoCorr: pedidoFixCorr, mismatch: mismatchFix, hasItems: hasItemsFix } = recalcAndDetectMismatch(pedidoFix);
            pedido = pedidoFixCorr;

            if (!mismatchFix && hasItemsFix) { fixedOk = true; break; }
          } catch (e2) {
            console.error("Error parse fixReply JSON:", e2.message);
          }
        }

        responseText =
          parsedFixLast && typeof parsedFixLast.response === "string"
            ? coalesceResponse(parsedFixLast.response, pedido)
            // Solo mostrar resumen si el usuario pidió detalle/total/confirmar
            : (wantsDetail ? buildBackendSummary(pedido, { showEnvio: wantsDetail }) : "");
      } else {
        responseText = coalesceResponse(parsed.response, pedido);
      }
    } catch (e) {
      console.error("Error al parsear/corregir JSON:", e.message);
    }

    // ✅ Validar día y horario del pedido contra los horarios configurados del local
    try {
      // Normalizar campos de fecha/hora desde el JSON del modelo.
      // El asistente devuelve fecha_pedido / hora_pedido, pero la validación
      // trabaja con Pedido.Fecha / Pedido.Hora.
      if (pedido && typeof pedido === "object") {
        if (!pedido.Fecha &&
            typeof pedido.fecha_pedido === "string" &&
            pedido.fecha_pedido.trim()) {
          pedido.Fecha = pedido.fecha_pedido.trim();
        }
        if (!pedido.Hora &&
            typeof pedido.hora_pedido === "string" &&
            pedido.hora_pedido.trim()) {
          pedido.Hora = pedido.hora_pedido.trim();
        }
      }

      if (pedido && typeof pedido === "object" && pedido.Fecha && pedido.Hora) {
        const db = await getDb();
        const hoursDocId = `store_hours:${tenant}`;
        const docHours = await db.collection("settings").findOne({ _id: hoursDocId });
        const hoursCfg = docHours?.hours || null;

        if (hoursCfg) {
          const schedCheck = validatePedidoSchedule(pedido, hoursCfg);
          if (!schedCheck.ok) {
            // Si la fecha/hora no es válida, sobreescribimos la respuesta textual
            // para que el usuario elija un nuevo horario dentro de las franjas.
            responseText = schedCheck.msg;
            // Si ya estaba en COMPLETED, lo bajamos a IN_PROGRESS para que siga el flujo
            if (estado === "COMPLETED") {
              estado = "IN_PROGRESS";
            }
          }
        }
      }
    } catch (e) {
      console.error("[hours] Error al validar fecha/hora de Pedido:", e?.message || e);
    }
     /*// Guardar respuesta del asistente:
     // 1) el TEXTO que se envía al cliente
     // 2) un SNAPSHOT JSON con el Pedido ya corregido, para que /admin pueda leerlo
     if (convId) {
       try {
         console.log("[messages] about to save ASSISTANT message", { convId: String(convId), from, len: String(responseText||"").length });
         await saveMessageDoc({
           tenantId: tenant,
           conversationId: convId,
           waId: from,
           role: "assistant",
           content: String(responseText || ""),
           type: "text",
          meta: { model: "gpt" }
         });
       } catch (e) {
         console.error("saveMessage(assistant text):", e?.message);
       }
 
       // Preparar el snapshot JSON a persistir (usa el pedido ya armado en este handler)
       try {
         const snap = {
           response: typeof responseText === "string" ? responseText : "",
           estado: typeof estado === "string" ? estado : "IN_PROGRESS",
           Pedido: pedido && typeof pedido === "object"
             ? pedido
             : { Entrega: "", Domicilio: {}, items: [], total_pedido: 0 }
         };
         const assistantSnapshot = JSON.stringify(snap);
         await saveMessageDoc({
           tenantId: tenant,
           conversationId: convId,
           waId: from,
           role: "assistant",
           content: assistantSnapshot,
           type: "json",
           meta: { model: "gpt", kind: "pedido-snapshot" }
         });
       } catch (e) {
         console.error("saveMessage(assistant json):", e?.message);
       }
     }
*/
    try {
      let finalBody = String(responseText ?? "").trim();

      // 🛡️ Si el modelo solo respondió algo muy corto tipo
      // "tu pedido queda así" sin detallar productos/total,
      // generamos un resumen completo desde backend.
      if (
        finalBody &&
        /queda\s+as[ií]/i.test(finalBody) &&
        finalBody.length < 80 &&
        pedido &&
        Array.isArray(pedido.items) &&
        pedido.items.length > 0
      ) {
        // Usamos el resumen estándar del backend (sin ítem de envío)
        responseText = buildBackendSummary(pedido);
        finalBody = String(responseText || "").trim();
      }

      if (!finalBody) {
        // No forzar resumen a menos que lo pidan explícitamente
        if (wantsDetail && pedido && Array.isArray(pedido.items) && pedido.items.length > 0) {
          responseText = buildBackendSummary(pedido, { showEnvio: wantsDetail });
        } else {
          // Texto neutro si ya hay contexto; saludo solo si no lo hay
          responseText = coalesceResponse("", pedido);
        }
      }
    } catch {}


    /*// 🚚 Visibilidad de "Envío": sólo en total/resumen/confirmación
    // (o cuando wantsDetail=true). En resúmenes parciales lo ocultamos.
    try {
      const text = String(responseText || "");
      const showsTotals = /\btotal\s*:?\s*\d/i.test(text);
      const isConfirmation = /¿\s*confirm/i.test(text) || /\u00BF\s*confirm/i.test(text) || /¿Confirmas\?/i.test(text);
      const explicitResumen = /resumen del pedido/i.test(text);
      const allowShipping = wantsDetail || showsTotals || isConfirmation || explicitResumen;
      if (!allowShipping) {
        // Remover líneas que muestren "Envío ..." (con o sin viñetas)
        responseText = text
          .split(/\r?\n/)
          .filter(line =>
            !/^\s*[-•*]\s*Env[ií]o\b/i.test(line) &&  // • Envío ...
            !/^\s*Env[ií]o\b/i.test(line)            // Envío ...
          )
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }
    } catch {}*/


    // 🔎 Leyenda de milanesas: mostrarla SOLO en resumen/total/confirmar.
    // Si el modelo generó un resumen aunque el usuario no haya pedido "total/resumen",
    // lo detectamos por el contenido del responseText.
    try {
      const hasMilanesas = (pedido?.items || []).some(i =>
        String(i?.descripcion || "").toLowerCase().includes("milanesa")
      );
      // ¿El texto "parece" un resumen?
      const looksLikeSummary = wantsDetail || /\b(resumen del pedido|total\s*:|\btotal\b|¿\s*confirm|¿confirmas|\u00BF\s*confirm)/i.test(String(responseText || ""));

      if (!hasMilanesas) {
        // Limpia cualquier rastro de la leyenda si no hay milanesas
        responseText = String(responseText || "")
          .replace(/\*?\s*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega\.\s*\*?/i, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      } else {
        if (looksLikeSummary) {
          // Asegurar que la leyenda esté presente en resúmenes/totales/confirmaciones
          const hasLegend = /\bse pesan al entregar\b/i.test(String(responseText || ""));
          if (!hasLegend) {
            responseText = `${String(responseText || "").trim()}\n\n*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega.*`;
          }
        } else {
          // No es resumen → quitar la leyenda si el modelo la hubiera puesto
          responseText = String(responseText || "")
            .replace(/\*?\s*Las milanesas se pesan al entregar; el precio se informa al momento de la entrega\.\s*\*?/i, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }
      }
    } catch {}

    /*await require("./logic").sendWhatsAppMessage(from, responseText);
    // persistir respuesta del asistente
    if (convId) {
      try {
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "assistant",
          content: responseText,
          type: "text"
        });
      } catch (e) { console.error("saveMessage(assistant):", e?.message); }
    }*/

    //await require("./logic").sendWhatsAppMessage(from, responseText);
    // ⚠️ No persistimos aquí para evitar duplicados.
    // El guardado del mensaje del asistente (texto) y del snapshot JSON
    // se realiza más abajo en un único bloque.
    // 1) Enviar EXACTAMENTE el texto final (post-fallback/normalizaciones)
    //await require("./logic").sendWhatsAppMessage(from, responseText);
        // 1) Enviar EXACTAMENTE el texto final (post-fallback/normalizaciones)
    //    ⚠️ Garantía: nunca mandar vacío a WhatsApp


    // ==============================
    // ✅ Validación de dirección exacta (Google Maps)
    // Si el geocoding NO es exacto, pedimos al cliente que reescriba la dirección.
    // Importante: limpiamos `Pedido.Domicilio.direccion` para que NO cierre la conversación.
    // ==============================
    try {
      if (pedido?.Entrega?.toLowerCase() === "domicilio" && pedido?.Domicilio) {
        const dom = (typeof pedido.Domicilio === "string")
          ? { direccion: pedido.Domicilio }
          : (pedido.Domicilio || {});
        pedido.Domicilio = dom;

        const addrParts = [
          dom.direccion,
          [dom.calle, dom.numero].filter(Boolean).join(" "),
          dom.barrio,
          dom.ciudad || dom.localidad,
          dom.provincia,
          dom.cp
        ].filter(Boolean);
        const address = addrParts.join(", ").trim();
        if (address) {
          const DEF_CITY = process.env.DEFAULT_CITY || "Venado Tuerto";
          const DEF_PROVINCE = process.env.DEFAULT_PROVINCE || "Santa Fe";
          const DEF_COUNTRY = process.env.DEFAULT_COUNTRY || "Argentina";
          const addressFinal = /,/.test(address)
            ? address
            : [address, DEF_CITY, DEF_PROVINCE, DEF_COUNTRY].filter(Boolean).join(", ");

          const geo = await geocodeAddress(addressFinal);
          const exact = Boolean(geo && geo.exact);

          if (!exact) {
            // Evitar cierre por pedido "completo" y evitar envío/distance incorrectos
            estado = "IN_PROGRESS";
            pedido.distancia_km = null;
            if (pedido.Domicilio && typeof pedido.Domicilio === "object") {
              delete pedido.Domicilio.lat;
              delete pedido.Domicilio.lon;
              pedido.Domicilio.direccion = "";
            }
            // Quitar item de envío si ya fue agregado por ensureEnvioSmart
            if (Array.isArray(pedido.items)) {
              pedido.items = pedido.items.filter(i => !/env[ií]o/i.test(String(i?.descripcion || "")));
            }
            // Recalcular total
            try {
              const { pedidoCorr } = recalcAndDetectMismatch(pedido);
              pedido = pedidoCorr;
            } catch {}

            responseText = "📍 No pude ubicar *exactamente* esa dirección en Google Maps.\n\nPor favor escribila nuevamente con *calle y número*, y si podés agregá *barrio/localidad*.\nEj: *Moreno 247, Venado Tuerto*";
          }
        }
      }
    } catch (e) {
      console.warn("[geo] Validación de dirección exacta falló:", e?.message || e);
    }





    const responseTextSafe = String(responseText || "").trim()
      || (wantsDetail && pedido && Array.isArray(pedido.items) && pedido.items.length
          ? buildBackendSummary(pedido, { showEnvio: wantsDetail })
          : "Perfecto, sigo acá. ¿Querés confirmar o cambiar algo?");
    await require("./logic").sendWhatsAppMessage(from, responseTextSafe, waOpts);
    
    
    
    // 2) Guardar ahora el mismo texto y el snapshot JSON (mismo estado/pedido finales)




    if (convId) {
      try {
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "assistant",
          content: String(responseTextSafe || ""),
          type: "text",
          meta: { model: "gpt" }
        });
      } catch (e) {
        console.error("saveMessage(assistant text final):", e?.message);
      }
      try {
        const snap = {
          response: typeof responseTextSafe === "string" ? responseTextSafe : "",
          estado: typeof estado === "string" ? estado : "IN_PROGRESS",
          Pedido: (pedido && typeof pedido === "object")
            ? pedido
            : { Entrega: "", Domicilio: {}, items: [], total_pedido: 0 }
        };
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "assistant",
          content: JSON.stringify(snap),
          type: "json",
          meta: { model: "gpt", kind: "pedido-snapshot" }
        });
      } catch (e) {
        console.error("saveMessage(assistant json final):", e?.message);
      }
    }




    try {
     // 🔹 Distancia + geocoding + Envío dinámico
      let distKm = null;
      if (pedido?.Entrega?.toLowerCase() === "domicilio" && pedido?.Domicilio) {
        const store = getStoreCoords();
        if (store) {
          let { lat, lon } = pedido.Domicilio;

          // Geocodificamos si faltan coords
          if (!(typeof lat === "number" && typeof lon === "number")) {
            const addrParts = [
              pedido.Domicilio.direccion,
              [pedido.Domicilio.calle, pedido.Domicilio.numero].filter(Boolean).join(" "),
              pedido.Domicilio.barrio,
              pedido.Domicilio.ciudad || pedido.Domicilio.localidad,
              pedido.Domicilio.provincia,
              pedido.Domicilio.cp
            ].filter(Boolean);
            const address = addrParts.join(", ").trim();
            if (address) {
              // ➕ Si el usuario solo escribió "Moreno 2862", agregamos localidad por defecto
              const DEF_CITY = process.env.DEFAULT_CITY || "Venado Tuerto";
              const DEF_PROVINCE = process.env.DEFAULT_PROVINCE || "Santa Fe";
              const DEF_COUNTRY = process.env.DEFAULT_COUNTRY || "Argentina";
              const addressFinal = /,/.test(address) ? address : [address, DEF_CITY, DEF_PROVINCE, DEF_COUNTRY].filter(Boolean).join(", ");
              console.log(`[geo] Direccion compilada='${addressFinal}'`);
             
              const geo = await geocodeAddress(addressFinal);
              if (geo && geo.exact) {
                lat = geo.lat; lon = geo.lon;
                pedido.Domicilio.lat = lat;
                pedido.Domicilio.lon = lon;
                console.log(`[geo] OK lat=${lat}, lon=${lon}`);
              } else {
                
                const reason = geo ? `inexacto (partial=${geo.partial_match}, type=${geo.location_type})` : "sin resultado";
                console.warn(`[geo] Geocoding ${reason}. No uso coords para distancia/envío.`);
 
              }
            }
          }

          // Si ya tenemos coords → calcular distancia
          if (typeof lat === "number" && typeof lon === "number") {
            distKm = calcularDistanciaKm(store.lat, store.lon, lat, lon);
            pedido.distancia_km = distKm;
            console.log(`📍 Distancia calculada al domicilio: ${distKm} km`);

            // Buscar producto de Envío según km
            const db = await getDb();
            const envioProd = await pickEnvioProductByDistance(db, tenant || null, distKm);
            if (envioProd && typeof envioProd.importe === "number") {
                 console.log(`[envio] Seleccionado por distancia: '${envioProd.descripcion}' @ ${envioProd.importe}`);
            
              const idx = (pedido.items || []).findIndex(i =>
                String(i.descripcion || "").toLowerCase().includes("envio")
              );
              if (idx >= 0) {
                 const cantidad = Number(pedido.items[idx].cantidad || 1);
                const prevImporte = Number(pedido.items[idx].importe_unitario || 0);
                const prevDesc = String(pedido.items[idx].descripcion || "");

                // ✅ Actualizar TODO: id, descripción, unitario y total
                pedido.items[idx].id = envioProd._id || pedido.items[idx].id || 0;
                pedido.items[idx].descripcion = envioProd.descripcion;
                pedido.items[idx].importe_unitario = Number(envioProd.importe);
                pedido.items[idx].total = cantidad * Number(envioProd.importe);

                const changed = (prevImporte !== Number(envioProd.importe)) || (prevDesc !== envioProd.descripcion);
                if (changed) console.log(`[envio] Ajustado item existente: '${prevDesc}' @ ${prevImporte} -> '${envioProd.descripcion}' @ ${envioProd.importe}`);
                } else {
                // 🆕 No existía el item Envío: lo insertamos ahora
                (pedido.items ||= []).push({
                  id: envioProd._id || 0,
                  descripcion: envioProd.descripcion,
                  cantidad: 1,
                  importe_unitario: Number(envioProd.importe),
                  total: Number(envioProd.importe),
                });
                console.log(`[envio] Insertado item envío: '${envioProd.descripcion}' @ ${envioProd.importe}`);
            
              }
              // Recalcular total localmente
              let totalCalc = 0;
              (pedido.items || []).forEach(it => {
                const cant = Number(String(it.cantidad).replace(/[^\d.-]/g,'')) || 0;
                const unit = Number(String(it.importe_unitario).replace(/[^\d.-]/g,'')) || 0;
                it.total = cant * unit;
                totalCalc += it.total;
              });
              pedido.total_pedido = totalCalc;

              // 🔔 (opcional pero útil): si hubo cambio de envío, avisar al cliente con total correcto
            /*  try {
                const totalStr = (Number(pedido.total_pedido)||0).toLocaleString("es-AR");
                await require("./logic").sendWhatsAppMessage(
                  from,
                  `Actualicé el envío según tu dirección (${distKm} km): ${envioProd.descripcion}. Total: $${totalStr}.`
                );
              } catch (e) {
                console.warn("[envio] No se pudo notificar ajuste de envío:", e?.message);
              }*/

            }
          }
        }
      }
   // 🔹 Mantener snapshot del asistente
setAssistantPedidoSnapshot(tenant, from, pedido, estado);

   // 🔹 Mantener snapshot del asistente
	setAssistantPedidoSnapshot(tenant, from, pedido, estado);

	// 🔎 Heurística: si el usuario pidió cancelar, forzamos CANCELLED para el cierre
	// (esto evita que el /admin muestre COMPLETED cuando el modelo respondió mal el estado)
	const _tNorm = String(text || "")
	  .toLowerCase()
	  .normalize("NFD")
	  .replace(/[\u0300-\u036f]/g, "");
	const userWantsCancelRaw =
	  /\b(cancel|anul)(ar|o|a|e|en|ado|ada)?\b/.test(_tNorm) ||
	  /\bdar de baja\b/.test(_tNorm);
	const userCancelNeg =
	  /\bno\s+(quiero\s+)?cancel/.test(_tNorm) ||
	  /\bno\s+(quiero\s+)?anul/.test(_tNorm);
	const userCancelled = !!(userWantsCancelRaw && !userCancelNeg);

	// ¿Cerramos como COMPLETED aunque el modelo no lo haya puesto?
	const userConfirmsFast =
	  /\bconfirm(ar|o|a)\b/i.test(String(text || "")) ||
	  /^s(i|í)\b.*confirm/i.test(String(text || ""));
	const willComplete = !!(estado === "COMPLETED" || (userConfirmsFast && isPedidoCompleto(pedido)));

// 🔹 Persistir pedido definitivo en MongoDB (upsert por conversationId) cuando está COMPLETED
if (willComplete && pedido && convId) {
  try {
    const db = await getDb();
    const nowOrder = new Date();
    const convObjectId = new ObjectId(String(convId));
    const filter = { conversationId: convObjectId, ...(tenant ? { tenantId: tenant } : {}) };

    await db.collection("orders").updateOne(
      filter,
      {
        $set: {
          tenantId: (tenant || null),
          from,
          conversationId: convObjectId,
          pedido,
          estado: "COMPLETED",
          status: "COMPLETED",
          distancia_km: typeof pedido?.distancia_km === "number" ? pedido.distancia_km : (distKm ?? null),
          updatedAt: nowOrder,
        },
        $setOnInsert: { createdAt: nowOrder }
      },
      { upsert: true }
    );
  } catch (e) {
    console.error("[orders] error upsert COMPLETED:", e?.message || e);
  }
}
    } catch {}
    try {
	      // Cerramos si:
	      // 1) el usuario canceló explícitamente, o
	      // 2) el flujo terminó (COMPLETED) o
	      // 3) el usuario confirmó explícitamente y el pedido está completo.
	      const closeStatus =
	        (userCancelled || estado === "CANCELLED")
	          ? "CANCELLED"
	          : (willComplete ? "COMPLETED" : null);

	      if (closeStatus) {
	        await closeConversation(convId, closeStatus);
          
	        // 🔄 Mantener estado del pedido en orders (si existe) / crear si no existe
	        try {
	          const db = await getDb();
	          const nowOrder = new Date();
	          const convObjectId = new ObjectId(String(convId));
	          await db.collection("orders").updateOne(
	            { conversationId: convObjectId, ...(tenant ? { tenantId: tenant } : {}) },
	            {
	              $set: {
	                tenantId: (tenant || null),
	                from,
	                conversationId: convObjectId,
	                ...(pedido ? { pedido } : {}),
	                estado: closeStatus,
	                status: closeStatus,
	                updatedAt: nowOrder,
	              },
	              $setOnInsert: { createdAt: nowOrder }
	            },
	            { upsert: true }
	          );
	        } catch (e) {
	          console.error("[orders] error upsert closeStatus:", e?.message || e);
	        }

	        // 🧹 limpiar sesión en memoria para que el próximo msg empiece conversación nueva
	        markSessionEnded(tenant, from);
	      }
    } catch {}

    res.sendStatus(200);
  } catch (e) {
    console.error("POST /webhook error:", e?.message || e);
    res.sendStatus(500);
  }
});

/*const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

*/

// --- reemplazar desde aquí ---
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  });

  // Cierre prolijo en deployment (Render/Heroku envían SIGTERM)
  process.on('SIGTERM', () => {
    console.log('SIGTERM recibido. Cerrando server...');
    server.close(() => process.exit(0));
  });
}

// Exportar la app para que otros módulos (tests/otros entrypoints) puedan importarla sin abrir un puerto.
module.exports = app;
// --- reemplazar hasta aquí ---
