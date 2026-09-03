// Asisto | Version: 5.00.018 | Fecha: 2026-09-03
// endpoint.js
// Servidor Express y endpoints (webhook, behavior API/UI, cache, salud) con multi-tenant
// Incluye logs de fixReply en el loop de corrección.

require("dotenv").config();
const express = require("express");
const app = express();

const crypto = require("crypto");
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;
const WWEB_API_KEY = String(process.env.WWEB_API_KEY || "").trim();
const DOMAIN_STATUS_API_KEY = String(
  process.env.DOMAIN_STATUS_API_KEY ||
  process.env.ASISTO_DOMAIN_STATUS_API_KEY ||
  ""
).trim();


// ⬇️ Para catálogo en Mongo
const { ObjectId } = require("mongodb");
const { getDb, closeDb } = require("./db");
const {
  getRuntimeByPhoneNumberId,
  getRuntimeByInstagramAccountId,
  getRuntimeByTenantId,
  getRuntimeByWwebPhone,
  getRuntimeByWwebPhoneAny,
  findAnyByVerifyToken,
  upsertTenantChannel,
  normalizeWhatsappTransport,
  normalizeWwebBotLogicMode,
  clearTenantRuntimeCache,
} = require("./tenant_runtime");
const TENANT_ID = (process.env.TENANT_ID || "").trim();
// ================== Debounce de textos (por tenant+canal+waId+convId) ==================
const pendingTextBatches = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));


// ================== Coordinación de corridas por conversación ==================
// Evita respuestas duplicadas cuando entran múltiples webhooks muy juntos
// para el mismo tenant/canal/conversación.
// - Serializa el procesamiento por conversación.
// - Permite descartar resultados viejos si una corrida más nueva ya tomó prioridad.
const processingRunState = new Map();

function buildProcessingRunKey(tenantId, phoneNumberId, convId, waId) {
  return convId
    ? `${String(tenantId || "").trim()}:${String(phoneNumberId || "env").trim()}:${String(convId)}`
    : `${String(tenantId || "").trim()}:${String(phoneNumberId || "env").trim()}:${String(waId || "").trim()}`;
}

async function withConversationRunLock(runKey, job) {
  const key = String(runKey || "").trim();
  if (!key) return job({ runSeq: 0, isStale: () => false });

  let state = processingRunState.get(key);
  if (!state) {
    state = { seq: 0, tail: Promise.resolve() };
    processingRunState.set(key, state);
  }

  const mySeq = ++state.seq;
  const prevTail = state.tail;
  let release = null;
  const myTail = new Promise((resolve) => { release = resolve; });
  state.tail = myTail;

  await prevTail.catch(() => {});

  const isStale = () => {
    const current = processingRunState.get(key);
    return !current || current.seq !== mySeq;
  };

  try {
    return await job({ runSeq: mySeq, isStale });
  } finally {
    try { if (typeof release === "function") release(); } catch {}
    const current = processingRunState.get(key);
    if (current && current.seq === mySeq && current.tail === myTail) {
      processingRunState.delete(key);
    }
  }
}

function clampInt(v, min, max) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

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
const { mountWebAccessRoutes } = require("./web_access_stats");
const { mountTokenControlRoutes } = require("./token_control_stats");
const { mountFleterosViajesPanel } = require("./fleteros_viajes_panel");
const { mountOrderConfigPanel } = require("./order_config_panel");
const { mountWwebPhoneAccess } = require("./wweb_phone_access");
const { mountClientPhoneAccess, isClientPhoneAllowed } = require("./client_phone_access");
const { mountConversationFollowupPanel } = require("./conversation_followup_panel");
const { mountBotTestPanel } = require("./bot_test_panel");
const { mountQrProductWeb } = require("./qr_product_web");
const { mountDemoCatalogApi } = require("./demo_catalog_api");
const {
  mountHelpTool,
  loadHelpConfig,
  saveHelpConfig,
  loadHelpDomainConfig,
  loadHelpDomainEnabled,
  saveHelpDomainEnabled,
  publicHelpConfig,
} = require("./help_tool");
const {
  loadOrderConfig,
  orderFeatureEnabled,
  orderRequiredEnabled,
  orderMessage,
  orderPostCompletionReuseMinutes,
  orderPoliteFollowupReply,
} = require("./order_config");
// Servir assets estáticos locales (logo.png)
// Servir assets estáticos:
// 1) Logos del slider en /static/clientes -> <proyecto>/static/clientes
app.use("/static/clientes", express.static(path.join(__dirname, "static", "clientes")));
// 2) Assets generales ubicados físicamente en <proyecto>/static
//    Ej.: /static/novedades-inicio.jpg -> <proyecto>/static/novedades-inicio.jpg
app.use("/static", express.static(path.join(__dirname, "static")));
// 3) Compatibilidad con assets legacy ubicados en la raíz del proyecto
//    Ej.: /static/logo.png -> <proyecto>/logo.png
app.use("/static", express.static(path.join(__dirname)));
// Favicon global para todas las páginas, incluidas las plantillas independientes.
app.get("/favicon.ico", (_req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "static", "favicon-asisto.png")));
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
mountWebAccessRoutes(app, auth);
mountTokenControlRoutes(app, auth);
mountFleterosViajesPanel(app, { auth });
mountOrderConfigPanel(app, { auth }); 
mountWwebPhoneAccess(app);
mountClientPhoneAccess(app, { auth });
mountConversationFollowupPanel(app, { auth });
mountBotTestPanel(app, { auth });
mountQrProductWeb(app);
mountDemoCatalogApi(app);
mountHelpTool(app);
// ===================== Índices seguimiento ventanas API Mensajes =====================
let apiMessageWindowIndexesReady = false;
async function ensureApiMessageWindowIndexes() {
  if (apiMessageWindowIndexesReady) return;
  try {
    const db = await getDb();
    const coll = db.collection('wa_api_message_windows');
    await Promise.all([
      coll.createIndex(
        { tenantId: 1, numeroFrom: 1, contact: 1, windowEndsAt: -1 },
        { name: 'tenant_from_contact_windowEnd' }
      ),
      coll.createIndex(
        { tenantId: 1, windowStartedAt: -1 },
        { name: 'tenant_windowStart' }
      )
    ]);
    apiMessageWindowIndexesReady = true;
  } catch (e) {
    console.warn('[api-message-windows] no se pudo crear/verificar índices:', e?.message || e);
  }
}
setTimeout(() => ensureApiMessageWindowIndexes().catch(() => {}), 20 * 1000);



// ===================== Retención de wa_wweb_message_log =====================
// Configuración por dominio en tenant_config:
//   wweb_message_log_retention_days = N
// - N > 0: conserva N días y elimina registros anteriores.
// - 0 / ausente: no elimina nada (compatibilidad con el comportamiento histórico).
// El cleanup se ejecuta centralmente en el servidor para no duplicarlo en cada PC/worker WWeb.
const WWEB_MESSAGE_LOG_CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000; // 6 horas
const WWEB_MESSAGE_LOG_CLEANUP_START_DELAY_MS = 30 * 1000;     // 30 segundos
const WWEB_MESSAGE_LOG_CLEANUP_BATCH_SIZE = 5000;
const WWEB_MESSAGE_LOG_CLEANUP_MAX_BATCHES_PER_TENANT = 50;
let wwebMessageLogCleanupRunning = false;
let wwebMessageLogCleanupIndexReady = false;

function wwebMessageLogRetentionDays(doc) {
  const raw =
    doc?.wweb_message_log_retention_days ??
    doc?.wwebMessageLogRetentionDays ??
    doc?.message_log_retention_days ??
    0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.min(3650, Math.floor(n)));
}

async function cleanupWwebMessageLog(reason = "interval") {
  if (wwebMessageLogCleanupRunning) return;
  wwebMessageLogCleanupRunning = true;
  try {
    const db = await getDb();
    const logs = db.collection("wa_wweb_message_log");

    if (!wwebMessageLogCleanupIndexReady) {
      try {
        await logs.createIndex(
          { tenantId: 1, at: 1 },
          { name: "tenantId_1_at_1_cleanup" }
        );
        wwebMessageLogCleanupIndexReady = true;
      } catch (e) {
        console.warn("[wweb-log-cleanup] no se pudo crear/verificar índice:", e?.message || e);
      }
    }

    const configs = await db.collection("tenant_config").find(
      {
        $or: [
          { wweb_message_log_retention_days: { $exists: true } },
          { wwebMessageLogRetentionDays: { $exists: true } },
          { message_log_retention_days: { $exists: true } }
        ]
      },
      {
        projection: {
          _id: 1,
          tenantId: 1,
          tenantid: 1,
          wweb_message_log_retention_days: 1,
          wwebMessageLogRetentionDays: 1,
          message_log_retention_days: 1
        }
      }
    ).toArray();

    let tenantsProcessed = 0;
    let deletedTotal = 0;

    for (const cfg of configs) {
      const retentionDays = wwebMessageLogRetentionDays(cfg);
      if (retentionDays <= 0) continue;

      const tenantId = String(cfg?.tenantId || cfg?.tenantid || cfg?._id || "").trim();
      if (!tenantId) continue;

      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      let deletedTenant = 0;
      let batches = 0;

      while (batches < WWEB_MESSAGE_LOG_CLEANUP_MAX_BATCHES_PER_TENANT) {
        const oldRows = await logs.find(
         { tenantId, at: { $lt: cutoff } },
          { projection: { _id: 1 } }
        ).sort({ at: 1 }).limit(WWEB_MESSAGE_LOG_CLEANUP_BATCH_SIZE).toArray();

        if (!oldRows.length) break;

        const ids = oldRows.map((r) => r?._id).filter(Boolean);
        if (!ids.length) break;

        const result = await logs.deleteMany({ _id: { $in: ids } });
        const deleted = Number(result?.deletedCount || 0);
        deletedTenant += deleted;
        batches += 1;

        if (oldRows.length < WWEB_MESSAGE_LOG_CLEANUP_BATCH_SIZE || deleted <= 0) break;
      }

      tenantsProcessed += 1;
      deletedTotal += deletedTenant;

      if (deletedTenant > 0 || reason === "startup") {
        console.log(
          `[wweb-log-cleanup] tenant=${tenantId} retentionDays=${retentionDays} deleted=${deletedTenant} cutoff=${cutoff.toISOString()} batches=${batches} reason=${reason}`
        );
      }
    }

    if (deletedTotal > 0) {
      console.log(`[wweb-log-cleanup] total deleted=${deletedTotal} tenants=${tenantsProcessed} reason=${reason}`);
    }
  } catch (e) {
    console.error("[wweb-log-cleanup] error:", e?.message || e);
  } finally {
    wwebMessageLogCleanupRunning = false;
  }
}

function startWwebMessageLogCleanup() {
  const first = setTimeout(() => {
    cleanupWwebMessageLog("startup").catch(() => {});
  }, WWEB_MESSAGE_LOG_CLEANUP_START_DELAY_MS);
  if (typeof first.unref === "function") first.unref();

  const timer = setInterval(() => {
    cleanupWwebMessageLog("interval").catch(() => {});
  }, WWEB_MESSAGE_LOG_CLEANUP_EVERY_MS);
  if (typeof timer.unref === "function") timer.unref();
}

startWwebMessageLogCleanup();
 

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
      channelType: r.channelType || "whatsapp",
      phoneNumberId: r.phoneNumberId || null,
      displayPhoneNumber: r.displayPhoneNumber || null,
      instagramAccountId: r.instagramAccountId || null,
      instagramPageId: r.instagramPageId || null,
      isDefault: !!r.isDefault,
      whatsappTransport: normalizeWhatsappTransport(r.whatsappTransport ?? r.whatsapp_transport ?? r.transport ?? "api"),
      wwebBotLogicMode: normalizeWwebBotLogicMode(r.wwebBotLogicMode ?? r.wweb_bot_logic_mode ?? r.botLogicMode ?? r.bot_logic_mode ?? "api"),
      messageDebounceMs: r.messageDebounceMs ?? 0,
      updatedAt: r.updatedAt || null,
      createdAt: r.createdAt || null,
      whatsappToken: isSuper ? (r.whatsappToken || null) : (r.whatsappToken ? "********" : null),
      instagramAccessToken: isSuper ? (r.instagramAccessToken || null) : (r.instagramAccessToken ? "********" : null),
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
      _id: body._id || body.id || body.channelId,
      tenantId: isSuper ? (body.tenantId || tenantForced) : tenantForced,
      channelType: body.channelType || "whatsapp",
      phoneNumberId: body.phoneNumberId,
      displayPhoneNumber: body.displayPhoneNumber,
      instagramAccountId: body.instagramAccountId,
      instagramPageId: body.instagramPageId,
      whatsappTransport: body.whatsappTransport ?? body.whatsapp_transport ?? body.transport,
      wwebBotLogicMode: body.wwebBotLogicMode ?? body.wweb_bot_logic_mode ?? body.botLogicMode ?? body.bot_logic_mode,
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
      instagramAccessToken: body.instagramAccessToken,
      verifyToken: body.verifyToken,
      openaiApiKey: body.openaiApiKey,
      messageDebounceMs: clampInt(req.body?.messageDebounceMs ?? 0, 0, 5000),
    };

    const r = await upsertTenantChannel(payload, { allowSecrets: true });

    // Si se marcó default, dejar UN solo default por dominio.
    // Importante: se usa el _id real del canal actualizado/creado, no el teléfono,
    // porque un mismo dominio puede tener API Meta y WhatsApp Web con números/IDs repetidos.
    if (payload.isDefault === true) {
      const db = await getDb();
      const currentId = String(r?._id || r?.id || payload._id || "").trim();
      const notCurrent = ObjectId.isValid(currentId)
        ? { _id: { $ne: new ObjectId(currentId) } }
        : {};
      await db.collection("tenant_channels").updateMany(
        { tenantId: String(payload.tenantId), ...notCurrent },
        { $set: { isDefault: false, updatedAt: new Date() } }
      );
    }
    res.json({ ok: true, result: r });
  } catch (e) {
    console.error("POST /api/tenant-channels error:", e?.message || e);
    res.status(400).json({ error: e?.message || "bad_request" });
  }
});

app.delete("/api/tenant-channels/:id", auth.requireAdmin, async (req, res) => {
  try {
    const id = String(req.params?.id || "").trim();
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "channel_id_invalid" });

    const db = await getDb();
    const _id = new ObjectId(id);
    const doc = await db.collection("tenant_channels").findOne({ _id });
    if (!doc) return res.status(404).json({ error: "channel_not_found" });

    const isSuper = String(req.user?.role || "").toLowerCase() === "superadmin";
    const tenantForced = String(resolveTenantId(req) || "").trim();
    if (!isSuper && String(doc.tenantId || "").trim() !== tenantForced) {
      return res.status(403).json({ error: "forbidden" });
    }

   await db.collection("tenant_channels").deleteOne({ _id });
    clearTenantRuntimeCache();
    return res.json({ ok: true, deletedId: id });
  } catch (e) {
    console.error("DELETE /api/tenant-channels/:id error:", e?.message || e);
    return res.status(500).json({ error: "internal" });
  }
});


// ===================== WhatsApp Web Sessions Control (WWeb) =====================
// Admin API para controlar políticas (allow any / pinned host / blocked hosts),
// ver estado de locks y leer historial.
// Requiere sesión (login) y rol admin.
app.use("/api/wweb", auth.requireWwebAccess);


function wwebReadApiKeyFromReq(req) {
  const authz = String(req.headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(authz)) {
    return authz.replace(/^Bearer\s+/i, "").trim();
  }
  return String(
    req.headers["x-api-key"] ||
    req.query?.apiKey ||
    ""
  ).trim();
}

function requireWwebExternalAccess(req, res, next) {
  try {
    const role = String(req.user?.role || "").toLowerCase();
    if (role === "admin" || role === "superadmin") return next();

    const provided = wwebReadApiKeyFromReq(req);
    if (!WWEB_API_KEY || !provided || provided !== WWEB_API_KEY) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
}

// ===================== API externa simple de sesiones por dominio =====================
function requireDomainStatusAccess(req, res, next) {
  try {
    const expected = DOMAIN_STATUS_API_KEY || WWEB_API_KEY;
    const provided = wwebReadApiKeyFromReq(req);
    if (!expected || !provided) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
}

function domainStatusBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return !!fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "si", "sí", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return !!fallback;
}

function domainStatusConfig(doc) {
  if (!doc || typeof doc !== "object") return {};
  const nested = doc.configuracion && typeof doc.configuracion === "object"
    ? doc.configuracion
    : {};
  return { ...doc, ...nested };
}

function domainStatusVersion(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const m = raw.match(/\d+(?:\.\d+){1,3}/);
  return m ? m[0] : raw;
}

function domainStatusServices(conf, channel, helpGlobalEnabled = false) {
  const out = [];

  const habilitarBot = domainStatusBool(
    conf.habilitar_bot ??
    conf.habilitarBot ??
    conf.bot_habilitado ??
    conf.botHabilitado ??
    conf.enable_bot ??
    conf.enableBot,
    true
  );

  const habilitarApiMensajes = domainStatusBool(
    conf.habilitar_consulta_mensajes ??
    conf.habilitarConsultaMensajes ??
    conf.consulta_api_mensajes_habilitado ??
    conf.consultaApiMensajesHabilitado ??
    conf.consulta_api_mensajes_enabled ??
    conf.consultaApiMensajesEnabled ??
    conf.envio_mensajes_habilitado ??
    conf.envioMensajesHabilitado,
    false
  );

  const logicMode = normalizeWwebBotLogicMode(
    channel?.wwebBotLogicMode ??
    channel?.wweb_bot_logic_mode ??
    channel?.botLogicMode ??
    channel?.bot_logic_mode ??
    conf.wweb_bot_logic_mode ??
    conf.wwebBotLogicMode ??
    conf.bot_logic_mode ??
    conf.botLogicMode ??
    "api"
  );

  if (habilitarApiMensajes || (habilitarBot && logicMode === "api")) {
    out.push("Api mensajes");
  }
  if (habilitarBot && logicMode === "chatgpt") {
    out.push("Pedidos ChatGPT");
  }

  const ayudaDominioEnabled = domainStatusBool(
    conf.help_enabled ?? conf.ayuda_enabled ?? conf.ayudaManagerEnabled,
    false
  );
  if (helpGlobalEnabled && ayudaDominioEnabled) {
    out.push("Ayuda Manager");
  }


  // Servicios futuros opcionales configurados directamente en tenant_config.
  const extra = conf.services ?? conf.servicios ?? conf.servicios_habilitados ?? conf.serviciosHabilitados;
  if (Array.isArray(extra)) {
    for (const item of extra) {
      const nombre = typeof item === "string"
        ? item
        : String(item?.name ?? item?.nombre ?? item?.code ?? item?.codigo ?? "").trim();
      const enabled = typeof item === "object" && item !== null
        ? domainStatusBool(item.enabled ?? item.habilitado, true)
        : true;
      if (nombre && enabled && !out.includes(nombre)) out.push(nombre);
    }
  }

  return out;
}

function domainStatusDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function domainStatusFindChannel(channels, numero) {
  const phone = domainStatusDigits(numero);
  return (channels || []).find((row) => {
    if (String(row?.channelType || "whatsapp").toLowerCase() !== "whatsapp") return false;
    const a = domainStatusDigits(row?.displayPhoneNumber);
    const b = domainStatusDigits(row?.phoneNumberId);
    return (a && a === phone) || (b && b === phone);
  }) || null;
}

function domainStatusEstado(lock, policy) {
  const last = lock?.lastSeenAt || lock?.updatedAt;
  const lastMs = last ? new Date(last).getTime() : 0;
  const active = !!(lastMs && (Date.now() - lastMs) <= 30000);

  if (!active) return "inactive";
  if (policy?.disabled === true) return "disabled";
  if (
    policy?.paused ||
    policy?.pausado ||
    policy?.blocked ||
    policy?.bloqueado ||
    policy?.messagesBlocked ||
    policy?.mensajes_bloqueados
  ) return "paused";

  return String(lock?.state || "active").trim().toLowerCase();
}



// ===================== WWeb Agent Control API =====================
// Las PC con LocalAuth usan esta API HTTPS en lugar de abrir un MongoClient
// propio. De esta forma Web, Telegram y todos los agentes comparten el único
// pool de db.js dentro de Render.
const WWEB_AGENT_ALLOWED_COLLECTIONS = new Set([
  'tenant_config',
  'tenant_channels',
  'settings',
  'wa_lid_phone_map',
  'wa_locks',
  'wa_wweb_policies',
  'wa_wweb_history',
  'wa_wweb_actions',
  'wa_wweb_message_log',
  'wa_api_mensajes_confirmaciones',
  'wa_api_message_windows',
]);
const WWEB_AGENT_ALLOWED_OPERATIONS = new Set([
  'findOne', 'find', 'insertOne', 'updateOne', 'updateMany',
  'deleteMany', 'findOneAndUpdate'
]);
const WWEB_AGENT_TYPE_KEY = '__asistoType';
const wwebAgentJson = express.json({ limit: process.env.WWEB_AGENT_JSON_LIMIT || '20mb' });

function wwebAgentDecode(value, keyName = '') {
  if (Array.isArray(value)) return value.map((item) => wwebAgentDecode(item));
  if (value && typeof value === 'object') {
    if (value[WWEB_AGENT_TYPE_KEY] === 'date') return new Date(value.value);
    if (value[WWEB_AGENT_TYPE_KEY] === 'regexp') return new RegExp(value.source || '', value.flags || '');
    if (value[WWEB_AGENT_TYPE_KEY] === 'buffer') return Buffer.from(String(value.value || ''), 'base64');
    if (value[WWEB_AGENT_TYPE_KEY] === 'objectId') {
      const raw = String(value.value || '');
      return ObjectId.isValid(raw) ? new ObjectId(raw) : raw;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      let decoded = wwebAgentDecode(item, key);
      // Los _id generados por Mongo llegan a la PC como string y vuelven en
      // updateOne. Convertimos solamente el campo _id para no tocar teléfonos.
      if (key === '_id' && typeof decoded === 'string' && ObjectId.isValid(decoded)) {
        decoded = new ObjectId(decoded);
      }
      out[key] = decoded;
    }
    return out;
  }
  return value;
}

function wwebAgentEncode(value) {
  if (value instanceof Date) return { [WWEB_AGENT_TYPE_KEY]: 'date', value: value.toISOString() };
  if (value instanceof RegExp) return { [WWEB_AGENT_TYPE_KEY]: 'regexp', source: value.source, flags: value.flags };
  if (Buffer.isBuffer(value)) return { [WWEB_AGENT_TYPE_KEY]: 'buffer', value: value.toString('base64') };
  if (value && value._bsontype === 'ObjectId' && typeof value.toHexString === 'function') {
    return { [WWEB_AGENT_TYPE_KEY]: 'objectId', value: value.toHexString() };
  }
  if (Array.isArray(value)) return value.map(wwebAgentEncode);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = wwebAgentEncode(item);
    return out;
  }
  return value;
}

function wwebAgentAnd(query, scope) {
  const q = query && typeof query === 'object' ? query : {};
  return { $and: [q, scope] };
}

function wwebAgentScopeQuery(collection, query, tenantId, numero) {
  const tenant = String(tenantId || '').trim().toUpperCase();
  const phone = String(numero || '').replace(/\D/g, '');
  const lockId = `${tenant}:${phone}`;
  const q = query && typeof query === 'object' ? query : {};

  if (collection === 'tenant_config') {
    return { $or: [{ _id: tenant }, { tenantId: tenant }, { tenantid: tenant }] };
  }
  if (collection === 'tenant_channels') {
    return wwebAgentAnd(q, { tenantId: tenant });
  }
  if (collection === 'settings') {
    return wwebAgentAnd(q, {
      _id: { $in: [`client_phone_access:${tenant}`, `store_hours:${tenant}`] }
    });
  }
  if (collection === 'wa_locks' || collection === 'wa_wweb_policies') {
    return { _id: lockId };
  }
  if (collection === 'wa_wweb_actions') {
    return wwebAgentAnd(q, { lockId });
  }
  if (collection === 'wa_wweb_history') {
    return wwebAgentAnd(q, { lockId });
  }
  if (collection === 'wa_wweb_message_log') {
    return wwebAgentAnd(q, { tenantId: tenant, numero: phone });
  }
  if (collection === 'wa_lid_phone_map') {
    return wwebAgentAnd(q, {
      $or: [
        { tenantId: tenant },
        { tenantid: tenant },
        { tenantId: { $exists: false }, tenantid: { $exists: false } }
      ]
    });
  }
  if (collection === 'wa_api_mensajes_confirmaciones') {
    return wwebAgentAnd(q, { tenantId: tenant, numeroFrom: phone });
  }
  if (collection === 'wa_api_message_windows') {
    return wwebAgentAnd(q, { tenantId: tenant, numeroFrom: phone });
  }
  return q;
}

function wwebAgentScopeDocument(collection, document, tenantId, numero) {
  const tenant = String(tenantId || '').trim().toUpperCase();
  const phone = String(numero || '').replace(/\D/g, '');
  const lockId = `${tenant}:${phone}`;
  const doc = { ...(document || {}) };

  if (collection === 'tenant_channels' || collection === 'wa_lid_phone_map' ||
      collection === 'wa_wweb_message_log' || collection === 'wa_api_mensajes_confirmaciones' ||
      collection === 'wa_api_message_windows') {
    doc.tenantId = tenant;
  }
  if (collection === 'wa_wweb_message_log') doc.numero = phone;
  if (collection === 'wa_api_mensajes_confirmaciones') doc.numeroFrom = phone;
  if (collection === 'wa_api_message_windows') doc.numeroFrom = phone;
  if (collection === 'wa_wweb_history') {
    doc.lockId = lockId;
    doc.tenantId = tenant;
    doc.numero = phone;
  }
  if (collection === 'wa_wweb_actions') doc.lockId = lockId;
  if (collection === 'wa_locks' || collection === 'wa_wweb_policies') {
    doc._id = lockId;
    doc.tenantId = tenant;
    doc.tenantid = tenant;
    doc.numero = phone;
  }
  return doc;
}

function wwebAgentScopeUpdate(collection, update, tenantId, numero) {
  const tenant = String(tenantId || '').trim().toUpperCase();
  const phone = String(numero || '').replace(/\D/g, '');
  const lockId = `${tenant}:${phone}`;
  const out = { ...(update || {}) };
  const ensureSet = () => { out.$set = { ...(out.$set || {}) }; return out.$set; };

  // MongoDB no permite modificar _id. Algunos wrappers/modelos pueden devolver
  // documentos completos y reenviarlo dentro de cualquier operador. El _id de
  // locks/políticas se obtiene exclusivamente del filtro canónico del upsert.
  for (const [operator, payload] of Object.entries(out)) {
    if (!operator.startsWith('$') || !payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    for (const key of Object.keys(payload)) {
      if (key === '_id' || key.startsWith('_id.')) delete payload[key];
    }
    if (operator === '$rename') {
      for (const [key, target] of Object.entries(payload)) {
        const targetPath = String(target || '');
        if (key === '_id' || key.startsWith('_id.') || targetPath === '_id' || targetPath.startsWith('_id.')) delete payload[key];
      }
    }
  }
  delete out._id;

  if (collection === 'wa_locks' || collection === 'wa_wweb_policies') {
    // $set también se aplica cuando updateOne hace upsert, por lo que tenantId,
    // tenantid y numero no deben repetirse en $setOnInsert. MongoDB rechaza una
    // actualización cuando la misma ruta aparece en ambos operadores.
    Object.assign(ensureSet(), { tenantId: tenant, tenantid: tenant, numero: phone });

    // Limpieza defensiva por si el agente envía alguno de estos campos dentro de
    // $setOnInsert. Evita el error "Updating the path ... would create a conflict".
    if (out.$setOnInsert) {
      delete out.$setOnInsert.tenantId;
      delete out.$setOnInsert.tenantid;
      delete out.$setOnInsert.numero;
      if (!Object.keys(out.$setOnInsert).length) delete out.$setOnInsert;
    }
  }
  if (collection === 'wa_wweb_message_log') Object.assign(ensureSet(), { tenantId: tenant, numero: phone });
  if (collection === 'wa_api_mensajes_confirmaciones') Object.assign(ensureSet(), { tenantId: tenant, numeroFrom: phone });
  if (collection === 'wa_api_message_windows') Object.assign(ensureSet(), { tenantId: tenant, numeroFrom: phone });
  return out;
}

async function requireWwebAgentAccess(req, res, next) {
  try {
    const provided = wwebReadApiKeyFromReq(req);
    if (!provided) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (WWEB_API_KEY && provided === WWEB_API_KEY) return next();

    const tenantId = String(req.body?.tenantId || req.headers['x-asisto-tenant'] || '').trim().toUpperCase();
    if (!tenantId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const db = await getDb();
    const doc = await db.collection('tenant_config').findOne({
      $or: [{ _id: tenantId }, { tenantId }, { tenantid: tenantId }]
    });
    const nested = doc && doc.configuracion && typeof doc.configuracion === 'object' ? doc.configuracion : {};
    const expected = String(
      nested.control_api_token || nested.controlApiToken || nested.status_token || nested.statusToken ||
      doc?.control_api_token || doc?.controlApiToken || doc?.status_token || doc?.statusToken || ''
    ).trim();

    if (!expected) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
}

function wwebAgentSafeOptions(operation, raw) {
  const options = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (options.projection && typeof options.projection === 'object') out.projection = options.projection;
  if (options.sort && typeof options.sort === 'object') out.sort = options.sort;
  if (operation === 'updateOne' || operation === 'updateMany' || operation === 'findOneAndUpdate') {
    out.upsert = options.upsert === true;
  }
  if (operation === 'findOneAndUpdate') {
    out.returnDocument = options.returnDocument === 'before' ? 'before' : 'after';
  }
  return out;
}

app.post('/api/ext/wweb/agent/ping', wwebAgentJson, requireWwebAgentAccess, async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || req.headers['x-asisto-tenant'] || '').trim().toUpperCase();
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_required' });
    await getDb();
    return res.json({ ok: true, tenantId, now: new Date() });
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'db_unavailable', detail: String(e?.message || e) });
  }
});

app.post('/api/ext/wweb/agent/db', wwebAgentJson, requireWwebAgentAccess, async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || req.headers['x-asisto-tenant'] || '').trim().toUpperCase();
    const numero = String(req.body?.numero || req.headers['x-asisto-numero'] || '').replace(/\D/g, '');
    const collectionName = String(req.body?.collection || '').trim();
    const operation = String(req.body?.operation || '').trim();
    const args = wwebAgentDecode(req.body?.args || {});

    if (!tenantId || (!numero && collectionName !== 'tenant_config')) {
      return res.status(400).json({ ok: false, error: 'tenant_numero_required' });
    }
    if (!WWEB_AGENT_ALLOWED_COLLECTIONS.has(collectionName)) {
      return res.status(403).json({ ok: false, error: 'collection_not_allowed' });
    }
    if (!WWEB_AGENT_ALLOWED_OPERATIONS.has(operation)) {
      return res.status(403).json({ ok: false, error: 'operation_not_allowed' });
    }

    // Las PC ya no deben borrar ni administrar RemoteAuth. Todos los agentes
    // migrados usan LocalAuth.
    if (operation === 'deleteMany' && collectionName !== 'wa_api_mensajes_confirmaciones') {
      return res.status(403).json({ ok: false, error: 'delete_not_allowed' });
    }

    const db = await getDb();
    const collection = db.collection(collectionName);
    const query = wwebAgentScopeQuery(collectionName, args.query || {}, tenantId, numero);
    const options = wwebAgentSafeOptions(operation, args.options || {});
    let result;

    if (operation === 'findOne') {
      result = await collection.findOne(query, options);
    } else if (operation === 'find') {
      let cursor = collection.find(query, options);
      if (args.sort && typeof args.sort === 'object') cursor = cursor.sort(args.sort);
      const limit = Math.max(0, Math.min(500, Number(args.limit) || 0));
      if (limit) cursor = cursor.limit(limit);
      result = await cursor.toArray();
    } else if (operation === 'insertOne') {
      const document = wwebAgentScopeDocument(collectionName, args.document || {}, tenantId, numero);
      const write = await collection.insertOne(document, options);
      result = { acknowledged: write.acknowledged, insertedId: write.insertedId, document: { ...document, _id: write.insertedId || document._id } };
    } else if (operation === 'updateOne') {
      const update = wwebAgentScopeUpdate(collectionName, args.update || {}, tenantId, numero);
      result = await collection.updateOne(query, update, options);
    } else if (operation === 'updateMany') {
      const update = wwebAgentScopeUpdate(collectionName, args.update || {}, tenantId, numero);
      result = await collection.updateMany(query, update, options);
    } else if (operation === 'deleteMany') {
      result = await collection.deleteMany(query, options);
    } else if (operation === 'findOneAndUpdate') {
      const update = wwebAgentScopeUpdate(collectionName, args.update || {}, tenantId, numero);
      result = await collection.findOneAndUpdate(query, update, options);
    }

    return res.json(wwebAgentEncode({ ok: true, result }));
  } catch (e) {
    console.error('POST /api/ext/wweb/agent/db error:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'agent_db_error', detail: String(e?.message || e) });
  }
});
 
function wwebOperatorPhoneVariants(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return [];
  const out = new Set([digits]);
  if (digits.startsWith("549")) out.add("54" + digits.slice(3));
  else if (digits.startsWith("54")) out.add("549" + digits.slice(2));
  return Array.from(out).filter(Boolean);
}

// Mensajes enviados manualmente desde el mismo WhatsApp/telefono vinculado.
// Se usa solamente para sincronizar la conversación del bot ChatGPT/Pedidos.
// Un mensaje ya generado desde Asisto/panel se ignora por dedupe; un mensaje
// realmente escrito desde el teléfono se guarda como assistant humano y puede
// avanzar PENDIENTE IMPORTE -> PENDIENTE COMPROBANTE igual que el panel.
app.post('/api/ext/wweb/agent/operator-message', wwebAgentJson, requireWwebAgentAccess, async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || req.headers['x-asisto-tenant'] || '').trim().toUpperCase();
    const ownPhone = String(
      req.body?.Tel_Destino || req.body?.tel_destino || req.body?.numero || req.headers['x-asisto-numero'] || ''
    ).replace(/\D/g, '');
    const customerPhone = String(
      req.body?.Tel_Origen || req.body?.tel_origen || req.body?.to || req.body?.waId || ''
    ).replace(/\D/g, '');
    const text = String(req.body?.Mensaje ?? req.body?.mensaje ?? req.body?.text ?? '').trim();
    const messageId = String(req.body?.MessageId || req.body?.messageId || req.body?.id || '').trim();
    const source = String(req.body?.source || 'wweb_phone_operator').trim() || 'wweb_phone_operator';

    if (!tenantId || !ownPhone || !customerPhone || !text) {
      return res.status(400).json({ ok: false, error: 'tenant_numero_customer_text_required' });
    }

    // Sólo corresponde a números configurados como WhatsApp Web + ChatGPT.
    // El flujo API tradicional y otros transportes no se tocan.
    let runtime = null;
    try { runtime = await getRuntimeByWwebPhone(tenantId, ownPhone); } catch {}
    if (!runtime || normalizeWhatsappTransport(runtime.whatsappTransport || 'api') !== 'wweb') {
      return res.status(409).json({ ok: false, error: 'wweb_channel_not_found' });
    }
    if (normalizeWwebBotLogicMode(runtime.wwebBotLogicMode || 'api') !== 'chatgpt') {
      return res.json({ ok: true, ignored: true, reason: 'logic_mode_not_chatgpt' });
    }

    const db = await getDb();
    const waVariants = wwebOperatorPhoneVariants(customerPhone);
    let conv = await db.collection('conversations').findOne(
      {
        tenantId,
        waId: { $in: waVariants },
        finalized: { $ne: true },
        status: { $nin: ['COMPLETED', 'CANCELLED'] }
      },
      { sort: { updatedAt: -1, openedAt: -1, createdAt: -1 } }
    );

    // Compatibilidad con conversaciones viejas donde finalized/status pueden no
    // estar completos, priorizando siempre una pendiente de transferencia.
    if (!conv) {
      conv = await db.collection('conversations').findOne(
        {
          tenantId,
          waId: { $in: waVariants },
          transferFlowStatus: { $in: ['PENDIENTE_IMPORTE_TRANSFERENCIA', 'PENDIENTE_COMPROBANTE_TRANSFERENCIA'] }
        },
        { sort: { updatedAt: -1, openedAt: -1, createdAt: -1 } }
      );
    }

    if (!conv) {
      return res.json({ ok: true, ignored: true, reason: 'conversation_not_found' });
    }

    const convId = conv._id;
    const now = new Date();

    // Si el mensaje salió desde el panel o desde el bot, el servidor ya lo guardó
    // antes de que WhatsApp dispare message_create. Evitamos duplicarlo. El filtro
    // excluye mensajes ya identificados como escritos desde el teléfono.
    const recentCutoff = new Date(Date.now() - 90 * 1000);
    const alreadyRecorded = await db.collection('messages').findOne({
      tenantId,
      conversationId: convId,
      role: 'assistant',
      content: text,
      'meta.from': { $ne: 'wweb_phone_operator' },
     $or: [
        { ts: { $gte: recentCutoff } },
        { createdAt: { $gte: recentCutoff } }
      ]
    }, { projection: { _id: 1, meta: 1 } });

    if (alreadyRecorded) {
      return res.json({
        ok: true,
        ignored: true,
        reason: 'already_recorded_by_asisto',
        convId: String(convId),
        transferAdvanced: false
      });
    }

    await saveMessageDoc({
      tenantId,
      conversationId: convId,
      waId: String(conv.waId || customerPhone),
      role: 'assistant',
      content: text,
      type: 'text',
      meta: {
        from: 'wweb_phone_operator',
        source,
        qrPhone: ownPhone,
        raw: messageId ? { id: messageId } : {}
      }
    });

    const convUpdate = {
      $set: {
        lastAssistantTs: now,
        updatedAt: now,
        lastOperatorMessageAt: now,
        lastOperatorMessageSource: 'wweb_phone_operator'
      }
    };

    let transferAdvanced = false;
    if (
      normalizeTransferFlowStatus(conv?.transferFlowStatus || '') === 'PENDIENTE_IMPORTE_TRANSFERENCIA' &&
      manualTextLooksLikeAmountNotice(text)
    ) {
      convUpdate.$set.transferFlowStatus = 'PENDIENTE_COMPROBANTE_TRANSFERENCIA';
      convUpdate.$set.status = 'PENDIENTE';
      convUpdate.$set.pedidoEstado = 'PENDIENTE';
      transferAdvanced = true;
    }

    await db.collection('conversations').updateOne(
      { _id: convId, tenantId },
      convUpdate
    );

    console.log('[WWEB_OPERATOR] mensaje manual sincronizado', {
      tenantId,
      ownPhone,
      customerPhone,
      convId: String(convId),
      transferAdvanced,
      transferFlowStatusBefore: conv?.transferFlowStatus || null,
      transferFlowStatusAfter: transferAdvanced ? 'PENDIENTE_COMPROBANTE_TRANSFERENCIA' : (conv?.transferFlowStatus || null)
    });

    return res.json({
      ok: true,
      recorded: true,
      convId: String(convId),
      transferAdvanced,
      transferFlowStatus: transferAdvanced
        ? 'PENDIENTE_COMPROBANTE_TRANSFERENCIA'
        : (conv?.transferFlowStatus || null)
    });
  } catch (e) {
    console.error('POST /api/ext/wweb/agent/operator-message error:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'operator_message_error', detail: String(e?.message || e) });
  }
});



function wwebResolveLockIdFromReq(req) {
  const explicit = String(req.query?.lockId || req.params?.lockId || "").trim();
  if (explicit) return explicit;

  const tenantId = String(req.query?.tenantId || req.params?.tenantId || "").trim();
  const numero = String(req.query?.numero || req.params?.numero || "").trim();
  if (!tenantId || !numero) return "";

  return wwebLockId(tenantId, numero);
}

function wwebParseLockId(lockId) {
  const raw = String(lockId || "").trim();
  const idx = raw.indexOf(":");
  if (idx === -1) return { tenantId: "", numero: raw };
  return {
    tenantId: raw.slice(0, idx).trim(),
    numero: raw.slice(idx + 1).trim()
  };
}

function wwebBuildPublicLock(lockDoc, policyDoc = null) {
  const lockId = String(lockDoc?._id || policyDoc?._id || "").trim();
  const parsed = wwebParseLockId(lockId);
  const tenantId = String(lockDoc?.tenantId || policyDoc?.tenantId || parsed.tenantId || "").trim();
  const numero = String(lockDoc?.numero || lockDoc?.number || lockDoc?.phone || policyDoc?.numero || parsed.numero || "").trim();

  return {
    lockId,
    tenantId,
    numero,
    state: lockDoc?.state || null,
    holderId: lockDoc?.holderId || lockDoc?.instanceId || null,
    host: lockDoc?.host || lockDoc?.hostname || null,
    pid: lockDoc?.pid || null,
    startedAt: lockDoc?.startedAt || lockDoc?.createdAt || null,
    lastSeenAt: lockDoc?.lastSeenAt || lockDoc?.updatedAt || null,
    lastQrAt: lockDoc?.lastQrAt || null,
    hasQr: !!lockDoc?.lastQrDataUrl,
    runtimeVersion: lockDoc?.runtimeVersion || lockDoc?.currentVersion || "",
    desiredTag: lockDoc?.desiredTag || lockDoc?.targetTag || "",
    autoUpdateSource: lockDoc?.autoUpdateSource || "",
    policy: policyDoc ? {
      mode: policyDoc.mode || "any",
      pinnedHost: policyDoc.pinnedHost || null,
      blockedHosts: Array.isArray(policyDoc.blockedHosts) ? policyDoc.blockedHosts : [],
      disabled: !!policyDoc.disabled,
      updatedAt: policyDoc.updatedAt || policyDoc.createdAt || null,
      updatedBy: policyDoc.updatedBy || null,
    } : {
      mode: "any",
      pinnedHost: null,
      blockedHosts: [],
      disabled: false,
      updatedAt: null,
      updatedBy: null,
    }
  };
}

function wwebDecodeDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  const m = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(raw);
  if (!m) return null;

  const mime = String(m[1] || "application/octet-stream").trim() || "application/octet-stream";
  const isBase64 = !!m[2];
  const payload = m[3] || "";

try {
    const buffer = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { mime, buffer };
  } catch {
    return null;
  }
}

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

function digitsOnlyForWweb(value) {
  return String(value || "").replace(/\D/g, "");
}

function getWwebNumeroForConversation(conv, runtime) {
  const candidates = [
    runtime?.displayPhoneNumber,
    conv?.displayPhoneNumber,
    runtime?.phoneNumberId,
    conv?.phoneNumberId,
  ];
  for (const c of candidates) {
    const s = String(c || "").trim();
    if (!s) continue;
    const m = /^wweb:[^:]+:(.+)$/i.exec(s);
    const d = digitsOnlyForWweb(m ? m[1] : s);
    if (d) return d;
  }
  return "";
}

function isWwebConversation(conv, runtime) {
  if (String(conv?.channelType || "whatsapp").trim().toLowerCase() !== "whatsapp") return false;
  const transport = normalizeWhatsappTransport(runtime?.whatsappTransport || conv?.whatsappTransport || "api");
  if (transport === "wweb") return true;
  return /^wweb:/i.test(String(conv?.phoneNumberId || ""));
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

// GET /api/ext/wweb/status
app.get("/api/ext/wweb/status", requireWwebExternalAccess, async (req, res) => {
  try {
    const db = await getDb();
    const { locks, policies } = await wwebCollections(db);
    const lockId = wwebResolveLockIdFromReq(req);
    const tenantId = String(req.query?.tenantId || "").trim();

    if (lockId) {
      const [lockDoc, policyDoc] = await Promise.all([
        locks.findOne({ _id: lockId }),
        policies.findOne({ _id: lockId })
      ]);

      return res.json({
        ok: true,
        item: wwebBuildPublicLock(lockDoc || { _id: lockId }, policyDoc || null)
      });
    }

    const lockFilter = tenantId ? { tenantId } : {};
    const policyFilter = tenantId ? { tenantId } : {};

    const [lockDocs, policyDocs] = await Promise.all([
      locks.find(lockFilter).sort({ lastSeenAt: -1, updatedAt: -1 }).limit(500).toArray(),
      policies.find(policyFilter).limit(2000).toArray()
    ]);

    const policyById = new Map((policyDocs || []).map((p) => [String(p._id), p]));
    const items = (lockDocs || []).map((lockDoc) =>
      wwebBuildPublicLock(lockDoc, policyById.get(String(lockDoc._id)) || null)
    );

    for (const p of (policyDocs || [])) {
      const id = String(p._id || "");
      if (!id) continue;
      if (items.some((x) => String(x.lockId) === id)) continue;
      items.push(wwebBuildPublicLock({ _id: id, tenantId: p.tenantId, numero: p.numero }, p));
    }

    items.sort((a, b) => String(a.lockId || "").localeCompare(String(b.lockId || "")));
    return res.json({ ok: true, items });
  } catch (e) {
    console.error("GET /api/ext/wweb/status error:", e);
    return res.status(500).json({ ok: false, error: "internal" });
  }
});


// GET /api/ext/domain-status?dominio=SDG
app.get("/api/ext/domain-status", requireDomainStatusAccess, async (req, res) => {
  try {
    const tenantId = String(req.query?.dominio || "").trim().toUpperCase();
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "dominio_required" });
    }

    const db = await getDb();
    const tenantRegex = new RegExp(
      "^" + tenantId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":",
      "i"
    );

    const [tenantDoc, locks, policies, channels, helpCfg] = await Promise.all([
      db.collection("tenant_config").findOne({
        $or: [{ _id: tenantId }, { tenantId }, { tenantid: tenantId }]
      }),
      db.collection("wa_locks").find({
        $or: [
          { tenantId },
          { tenantid: tenantId },
          { _id: tenantRegex }
        ]
      }).sort({ lastSeenAt: -1 }).limit(500).toArray(),
      db.collection("wa_wweb_policies").find({
        $or: [
          { tenantId },
          { tenantid: tenantId },
          { _id: tenantRegex }
        ]
      }).limit(1000).toArray(),
      db.collection("tenant_channels").find({ tenantId }).limit(500).toArray(),
      loadHelpConfig("MANAGER").catch(() => ({ enabled: false }))
    ]);

    if (!tenantDoc && !locks.length) {
      return res.status(404).json({
        ok: false,
        error: "tenant_not_found"
      });
    }

    const conf = domainStatusConfig(tenantDoc);
    const helpStatus = publicHelpConfig(helpCfg || {});
    // La habilitación es por dominio. Acá sólo verificamos que el servicio
    // global tenga fuente y clave configuradas.
    const helpServiceEnabled = helpStatus.api_key_configured === true && !!helpStatus.source_url;
    const policyById = new Map(
      policies.map((p) => [String(p._id || ""), p])
    );
    const sessions = locks.map((lock) => {
      const lockId = String(lock._id || "");
      const numero = domainStatusDigits(
        lock.numero ||
        lock.number ||
        lock.phone ||
        (lockId.includes(":") ? lockId.split(":").slice(1).join(":") : "")
      );

      const channel = domainStatusFindChannel(channels, numero);
      const policy = policyById.get(lockId) || null;

      return {
        numero,
        estado: domainStatusEstado(lock, policy),
        version: domainStatusVersion(lock.runtimeVersion || lock.currentVersion),
        servicios: domainStatusServices(conf, channel, helpServiceEnabled),
        pc: String(lock.host || lock.hostname || "").trim() || null
      };
    }).sort((a, b) =>
      String(a.numero).localeCompare(String(b.numero), "es", { numeric: true })
    );

    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      tenantId,
      sessions
    });
 } catch (e) {
    console.error("GET /api/ext/domain-status error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal" });
  }
});


// GET /api/ext/wweb/qr
app.get("/api/ext/wweb/qr", requireWwebExternalAccess, async (req, res) => {
  try {
    const lockId = wwebResolveLockIdFromReq(req);
    if (!lockId) {
      return res.status(400).json({ ok: false, error: "lockId_or_tenant_numero_required" });
    }

    const db = await getDb();
    const lock = await db.collection("wa_locks").findOne(
      { _id: lockId },
      {
        projection: {
          _id: 1,
          tenantId: 1,
          numero: 1,
          number: 1,
          phone: 1,
          state: 1,
          holderId: 1,
          instanceId: 1,
          host: 1,
          hostname: 1,
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
          autoUpdateSource: 1,
        }
      }
    );

    if (!lock) {
      return res.status(404).json({ ok: false, error: "lock_not_found" });
    }

    try { res.set("Cache-Control", "no-store"); } catch {}

    return res.status(200).json({
      ok: true,
      item: {
        ...wwebBuildPublicLock(lock),
        lastQrDataUrl: lock.lastQrDataUrl || null
      }
    });
  } catch (e) {
    console.error("GET /api/ext/wweb/qr error:", e);
    return res.status(500).json({ ok: false, error: "internal" });
  }
});

// GET /api/ext/wweb/qr-image
// JSON por defecto. Binario solo con ?raw=1
app.get("/api/ext/wweb/qr-image", requireWwebExternalAccess, async (req, res) => {
  try {
    const lockId = wwebResolveLockIdFromReq(req);
    if (!lockId) {
      return res.status(400).json({ ok: false, error: "lockId_or_tenant_numero_required" });
    }

    const db = await getDb();
    const lock = await db.collection("wa_locks").findOne(
      { _id: lockId },
      {
        projection: {
          _id: 1,
          tenantId: 1,
          numero: 1,
          number: 1,
          phone: 1,
          state: 1,
          lastQrAt: 1,
          lastQrDataUrl: 1,
          lastSeenAt: 1,
          updatedAt: 1,
        }
      }
    );

    if (!lock) {
      return res.status(404).json({ ok: false, error: "lock_not_found" });
    }

    const qrDataUrl = String(lock.lastQrDataUrl || "").trim();
    const wantRaw = String(req.query?.raw || "").trim() === "1";

    if (!qrDataUrl) {
      return res.status(404).json({
        ok: false,
        error: "qr_not_available",
        item: {
          lockId: String(lock._id),
          tenantId: String(lock.tenantId || ""),
          numero: String(lock.numero || lock.number || lock.phone || ""),
          state: lock.state || null,
          lastQrAt: lock.lastQrAt || null,
          lastSeenAt: lock.lastSeenAt || lock.updatedAt || null,
          hasQr: false
        }
      });
    }

    if (!wantRaw) {
      return res.status(200).json({
        ok: true,
        item: {
          lockId: String(lock._id),
          tenantId: String(lock.tenantId || ""),
          numero: String(lock.numero || lock.number || lock.phone || ""),
          state: lock.state || null,
          lastQrAt: lock.lastQrAt || null,
          lastSeenAt: lock.lastSeenAt || lock.updatedAt || null,
          hasQr: true,
          imageDataUrl: qrDataUrl
        }
      });
    }

    const decoded = wwebDecodeDataUrl(qrDataUrl);
    if (!decoded || !decoded.buffer || !decoded.buffer.length) {
      return res.status(500).json({ ok: false, error: "qr_decode_failed" });
    }

    try { res.set("Cache-Control", "no-store"); } catch {}
    res.setHeader("Content-Type", decoded.mime || "image/png");
    return res.status(200).send(decoded.buffer);
  } catch (e) {
    console.error("GET /api/ext/wweb/qr-image error:", e);
    return res.status(500).json({ ok: false, error: "internal" });
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
  normalizeBotMode,
  getGPTReply, hasActiveEndedFlag, markSessionEnded, isPoliteClosingMessage,
  syncSessionConversation,
  START_FALLBACK, buildBackendSummary, coalesceResponse, recalcAndDetectMismatch,
  hydratePricesFromCatalog,
  putInCache, getFromCache, getMediaInfo, downloadMediaBuffer, transcribeAudioExternal,
  DEFAULT_TENANT_ID, setAssistantPedidoSnapshot, replaceLastAssistantHistory, calcularDistanciaKm,
  geocodeAddress, reverseGeocode, getStoreCoords, pickEnvioProductByDistance,clearEndedFlag,analyzeImageExternal,
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
// ===================== SEO (landing pública) =====================
// Evitamos que "/" redirija a /app (privado). Si los crawlers caen en login,
// suelen mostrar "no se puede mostrar la descripción". Esta landing es indexable
// y define description + og:image (logo) para snippets.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://www.asistobot.com.ar").trim();
function absUrl(p = "/") {
  const base = String(PUBLIC_BASE_URL || "").replace(/\/+$/g, "");
  const path = String(p || "/").startsWith("/") ? String(p || "/") : `/${p}`;
  return base ? (base + path) : path;
}

app.get("/", (req, res) => {
  const qs = req.originalUrl && req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  return res.redirect(302, "/login" + qs);
});

// ===================== Novedades públicas =====================
app.get("/novedades", (_req, res) => {
  const canonical = absUrl("/novedades");

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  return res.status(200).send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <title>Novedades · Asisto</title>

  <meta
    name="description"
    content="Novedades, actualizaciones y nuevas funciones de Asisto."
  >

  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${canonical}">

  <meta property="og:type" content="website">
  <meta property="og:title" content="Novedades · Asisto">
  <meta
    property="og:description"
    content="Conocé las novedades, actualizaciones y nuevas funciones de Asisto."
  >
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${absUrl("/static/novedades-inicio.jpg")}">

  <style>
    *{box-sizing:border-box}


    :root{
      --brand:#02c38f;
      --brand-hover:#04976f;
      --dot:rgba(255,255,255,.35);
    }

    html,
    body{
      width:100%;
      min-height:100%;
      margin:0;
    }

    body{
      font-family:
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Roboto,
        Arial,
        sans-serif;

      color:#fff;
      background-color:#071d35;
      background-image:
        linear-gradient(
          90deg,
          rgba(5,24,45,.18) 0%,
          rgba(5,24,45,.08) 48%,
          rgba(5,24,45,.20) 100%
        ),
        url("/static/wa-session-bg.png");

      background-size:cover;
      background-position:left center;
      background-repeat:no-repeat;
      background-attachment:fixed;
    }

    .page{
      
      min-height:100vh;
      width:100%;
      display:flex;
      flex-direction:column;
      justify-content:center;
      padding:22px 24px 16px;
    }

    .carousel-container{
      width:min(1480px, 94vw);
      margin:0 auto;
    }

    .carousel-frame{
      width:100%;
      aspect-ratio:16 / 9;
      position:relative;
      overflow:hidden;
      border-radius:22px;
      background:rgba(3,17,34,.68);
      border:1px solid rgba(255,255,255,.12);
      box-shadow:0 28px 80px rgba(0,0,0,.34);
      backdrop-filter:blur(8px);
      -webkit-backdrop-filter:blur(8px);
    }

    .slide-content{
      width:100%;
      height:100%;
    }

    .slide-content img,
    .slide-content iframe{
      width:100%;
      height:100%;
      display:block;
      border:0;
    }

    .slide-content img{
      object-fit:contain;
      background:#071d35;
    }

    .counter{
      position:absolute;
      top:16px;
      right:16px;
      z-index:4;
      padding:7px 12px;
      border-radius:999px;
      background:rgba(2,12,25,.58);
      border:1px solid rgba(255,255,255,.12);
      color:#fff;
      font-size:13px;
      font-weight:700;
      backdrop-filter:blur(8px);
    }

    .nav{
      position:absolute;
      inset:0;
      z-index:3;
     display:flex;
      align-items:center;
      justify-content:space-between;
      padding:14px;
      pointer-events:none;
    }

    .nav-btn{
      pointer-events:auto;
      width:46px;
      height:46px;
      display:grid;
      place-items:center;
      border:1px solid rgba(255,255,255,.18);
      border-radius:50%;
      background:rgba(2,195,143,.88);
      color:#fff;
      font-size:22px;
      line-height:1;
      cursor:pointer;
      box-shadow:0 8px 24px rgba(0,0,0,.28);
      transition:background .18s ease, transform .18s ease;
    }

    .nav-btn:hover{
      background:var(--brand-hover);
      transform:scale(1.05);
    }

    .nav-btn:focus-visible,
    .dot:focus-visible{
      outline:3px solid rgba(255,255,255,.9);
      outline-offset:3px;
    }

    .dots{
      display:flex;
      justify-content:center;
      align-items:center;
      gap:9px;
      margin-top:14px;
      min-height:22px;
      flex-wrap:wrap;
    }

    .dot{
      appearance:none;
      border:0;
      padding:0;
      width:9px;
      height:9px;
      border-radius:999px;
      background:var(--dot);
      cursor:pointer;
      transition:width .18s ease, background .18s ease;
    }

    .dot.active{
      width:26px;
      background:var(--brand);
    }

    .footer{
      width:min(1480px, 94vw);
      margin:8px auto 0;
      text-align:right;
      color:rgba(255,255,255,.48);
      font-size:12px;
    }

    @media(max-width:800px){
      body{
      background-attachment:scroll;
        background-position:left center;
     
      }

      .page{
        min-height:100vh;
        padding:10px 8px 12px;
      }

      .carousel-container{
        width:100%;
      }

      .carousel-frame{
        border-radius:14px;
      }

      .nav{
        padding:8px;
      }

      .nav-btn{
        width:40px;
        height:40px;
        font-size:19px;
      }

      .counter{
        top:9px;
        right:9px;
        font-size:12px;
        padding:5px 9px;
      }

      .dots{
        margin-top:10px;
      }

      .footer{
        width:100%;
        margin-top:4px;
        padding-right:4px;
        text-align:center;
      }
    }
  </style>
</head>

<body>
  <div class="page">



    <main class="carousel-container">
      <div class="carousel-frame" id="carouselFrame">
        <div id="slideContent" class="slide-content"></div>
        <div class="counter" id="counter"></div>

        <div class="nav">
          <button type="button" class="nav-btn" id="prevBtn" aria-label="Anterior">&#10094;</button>
          <button type="button" class="nav-btn" id="nextBtn" aria-label="Siguiente">&#10095;</button>
        </div>

      </div>

      <div class="dots" id="dots" aria-label="Navegación del carrusel"></div>
    </main>

    <footer class="footer">
      © ${new Date().getFullYear()} Asisto · lo hace por vos...
    </footer>

  </div>


  <script>
    const DEFAULT_SLIDES = [
      "/static/novedades-inicio.jpg",
      "/static/novedades-envio-ws.jpg",
      "/static/novedades-contacto.jpg"
    ];

    const AUTOPLAY_MS = 6000;

    function getSlidesFromQuery(){
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("imgs");

      if (!raw) return DEFAULT_SLIDES.slice();

      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {}

      const arr = decoded
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);

      return arr.length ? arr : DEFAULT_SLIDES.slice();
    }

    function getVimeoId(value){
      const slide = String(value || "").trim();

      if (/^(vimeo|video):/i.test(slide)) {
        return slide.split(":").slice(1).join(":").trim();
      }

      const match = slide.match(/vimeo\\.com\\/(?:video\\/)?([0-9]+)/i);
      return match ? match[1] : null;
    }

    function normalizeSlide(value){
      const vimeoId = getVimeoId(value);

      if (vimeoId) {
        return { type:"vimeo", id:vimeoId };
      }

      return { type:"image", src:value };
    }

    const slides = getSlidesFromQuery().map(normalizeSlide);
    const slideContent = document.getElementById("slideContent");
    const carouselFrame = document.getElementById("carouselFrame");
    const counter = document.getElementById("counter");
    const dotsContainer = document.getElementById("dots");
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");

    let index = 0;
    let autoInterval = null;
    let startX = 0;

    function stopAuto(){
      if (autoInterval) {
        clearInterval(autoInterval);
        autoInterval = null;
      }
    }

    function startAuto(){
      stopAuto();

      if (slides.length <= 1) return;
      if (slides[index]?.type === "vimeo") return;

      autoInterval = setInterval(() => {
        index = (index + 1) % slides.length;
        render();
      }, AUTOPLAY_MS);
    }

    function buildDots(){
      dotsContainer.innerHTML = "";

      slides.forEach((_, i) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "dot";
        dot.setAttribute("aria-label", "Ir a la novedad " + (i + 1));
        dot.addEventListener("click", () => {
          index = i;
          render();
        });
        dotsContainer.appendChild(dot);
      });
    }

    function render(){
      const slide = slides[index];
      slideContent.innerHTML = "";

      if (slide.type === "vimeo") {
        const iframe = document.createElement("iframe");
        iframe.src =
          "https://player.vimeo.com/video/" +
          encodeURIComponent(slide.id) +
         "?texttrack=es&title=0&byline=0&portrait=0";
        iframe.allow = "autoplay; fullscreen; picture-in-picture";
        iframe.allowFullscreen = true;
        iframe.title = "Video " + (index + 1);
        slideContent.appendChild(iframe);
      } else {
        const img = document.createElement("img");
        img.src = slide.src;
        img.alt = "Novedad Asisto " + (index + 1);
        slideContent.appendChild(img);
      }

      counter.textContent = (index + 1) + " / " + slides.length;

     [...dotsContainer.children].forEach((dot, i) => {
        dot.classList.toggle("active", i === index);
        dot.setAttribute("aria-current", i === index ? "true" : "false");
      });

      const showNav = slides.length > 1;
      prevBtn.style.display = showNav ? "" : "none";
      nextBtn.style.display = showNav ? "" : "none";
      dotsContainer.style.display = showNav ? "flex" : "none";
      counter.style.display = showNav ? "" : "none";

      startAuto();
    }

    function next(){
      index = (index + 1) % slides.length;
      render();
    }

    function prev(){
      index = (index - 1 + slides.length) % slides.length;
     render();
    }

    nextBtn.addEventListener("click", next);
    prevBtn.addEventListener("click", prev);

    document.addEventListener("keydown", (event) => {
      if (slides.length <= 1) return;
     if (event.key === "ArrowRight") next();
      if (event.key === "ArrowLeft") prev();
    });

    carouselFrame.addEventListener("mouseenter", stopAuto);
    carouselFrame.addEventListener("mouseleave", startAuto);

    carouselFrame.addEventListener("touchstart", (event) => {
      if (!event.touches?.length) return;
      startX = event.touches[0].clientX;
    }, { passive:true });

    carouselFrame.addEventListener("touchend", (event) => {
      if (slides.length <= 1 || !event.changedTouches?.length) return;

      const diff = event.changedTouches[0].clientX - startX;
      if (Math.abs(diff) <= 50) return;

      if (diff < 0) next();
      else prev();
    }, { passive:true });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopAuto();
      else startAuto();
    });

    buildDots();
    render();
  </script> 
</body>
</html>`);
});


// robots + sitemap para ayudar a indexación/snippet
app.get("/robots.txt", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(200).send([
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${absUrl("/sitemap.xml")}`,
    ""
  ].join("\n"));
});

app.get("/sitemap.xml", (_req, res) => {
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  const urls = [
    { loc: absUrl("/"), priority: "1.0" },
    { loc: absUrl("/novedades"), priority: "0.8" },
    { loc: absUrl("/login"), priority: "0.3" }
  ];
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${u.loc}</loc><priority>${u.priority}</priority></url>`).join("\n") +
    `\n</urlset>\n`;
  return res.status(200).send(body);
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
  const pedidoEstado = String(conv?.pedidoEstado || "").trim().toUpperCase();
   // Si la conversación ya quedó finalizada, eso manda por sobre cualquier subestado de transferencia
  if (up === "COMPLETED") return "COMPLETED";


  // Cancelaciones (aceptamos variantes)
  if (up === "CANCELLED" || up === "CANCELED" || up === "CANCELADA" || up === "CANCELADO") {
    return "CANCELADA";
  }

  const flow = String(conv?.transferFlowStatus || "").trim().toUpperCase();
  if (flow === "PENDIENTE_IMPORTE_TRANSFERENCIA") return "PENDIENTE IMPORTE";
  if (flow === "PENDIENTE_COMPROBANTE_TRANSFERENCIA") return "PENDIENTE COMPROBANTE";
  
  // Si hay status persistido, lo devolvemos tal cual (en mayúsculas típicas)
  if (raw) return up;

  // Si no hay status formal pero sí estado de pedido persistido, usarlo.
  if (pedidoEstado === "PENDIENTE") return "PENDIENTE";
 

  // Fallback si no hay status explícito
  return conv?.finalized ? "COMPLETED" : "OPEN";
}

function isExplicitUserConfirmation(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const norm = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/\bconfirm(ar|o|a|ame|alo|ado)\b/.test(norm)) return true;
  if (/^(s[i1]+|sip+|sep+|ok(?:ey)?|dale|listo|de una|perfecto|joya|mandale|obvio)\b/.test(norm) && norm.split(/\s+/).length <= 3) return true;
  if (["👍", "👌", "✅", "✔️", "☑️"].includes(raw)) return true;
  return false;
}

function normalizeTransferFlowStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function manualTextLooksLikeAmountNotice(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const norm = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const hasAmount = /\$\s*\d/.test(raw) || /(?:^|[^\d])\d{4,}(?:[.,]\d{2})?(?=$|[^\d])/.test(raw);
  const hasPaymentWords = /\b(total|importe|monto|transfer(?:encia)?|alias|cbu|cvu|comprobante)\b/.test(norm);

  return hasAmount || hasPaymentWords;
}

function isInboundTransferReceiptMedia(msg) {
  const t = String(msg?.type || "").trim().toLowerCase();
  return t === "image" || t === "document";
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
function findOneAndUpdateDoc(result) {
  if (!result) return null;
  if (result.value) return result.value;
  if (result._id) return result;
  return null;
}

function recentCompletedWindowCutoff(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() - Math.min(1440, Math.trunc(n)) * 60 * 1000);
}

function conversationIsRecentlyCompleted(conv, minutes) {
  const cutoff = recentCompletedWindowCutoff(minutes);
  if (!conv || !cutoff) return false;
  const status = String(conv.status || conv.pedidoEstado || "").trim().toUpperCase();
  if (status !== "COMPLETED") return false;
  const closedMs = Date.parse(conv.closedAt || conv.updatedAt || "");
  return Number.isFinite(closedMs) && closedMs >= cutoff.getTime();
}

async function upsertConversation(waId, init = {}, tenantId, options = {}) {
  const db = await getDb();
  const now = new Date();
  const tenant = String(tenantId || TENANT_ID || DEFAULT_TENANT_ID || "default");
  const reuseCompletedWithinMinutes = Math.max(0, Math.min(1440, Number(options.reuseCompletedWithinMinutes || 0)));

   // 👉 Primero reutilizamos conversaciones abiertas.
  const filter = { waId: String(waId), tenantId: tenant, finalized: { $ne: true }, status: { $nin: ["COMPLETED", "CANCELLED"] } };
  const update = {
    $setOnInsert: { createdAt: now, openedAt: now, status: "OPEN", manualOpen: false },
   
    $set: { updatedAt: now, ...init },
  };


  const openRes = await db.collection("conversations").findOneAndUpdate(
    filter,
    { $set: { updatedAt: now, ...init } },
    { upsert: false, returnDocument: "after", sort: { updatedAt: -1, openedAt: -1, createdAt: -1 } }
  );
  const openDoc = findOneAndUpdateDoc(openRes);
  if (openDoc) return openDoc;

  // ✅ Opcional por dominio: después de confirmar, seguir usando la MISMA conversación
  // durante una ventana de cortesía. Evita que un "gracias" o mensaje posterior
  // abra automáticamente otra conversación/pedido.
  const cutoff = recentCompletedWindowCutoff(reuseCompletedWithinMinutes);
  if (cutoff) {
    const recentCompletedFilter = {
      waId: String(waId),
      tenantId: tenant,
      finalized: true,
      status: "COMPLETED",
      $or: [
        { closedAt: { $gte: cutoff } },
        { closedAt: { $exists: false }, updatedAt: { $gte: cutoff } },
      ],
    };
    const recentRes = await db.collection("conversations").findOneAndUpdate(
      recentCompletedFilter,
      { $set: { updatedAt: now, postCompletionReusedAt: now, ...init } },
      { upsert: false, returnDocument: "after", sort: { closedAt: -1, updatedAt: -1 } }
    );
    const recentDoc = findOneAndUpdateDoc(recentRes);
    if (recentDoc) {
      console.log("[conv] reutilizando conversación COMPLETED dentro de ventana post-confirmación", {
        convId: String(recentDoc._id || ""),
        waId: String(waId || ""),
        tenant,
        reuseCompletedWithinMinutes,
      });
      return recentDoc;
    }
  }

  // Si no hay abierta ni una COMPLETED reutilizable, crear una nueva como antes.
  const opts = { upsert: true, returnDocument: "after" };

  const res = await db.collection("conversations").findOneAndUpdate(filter, update, opts);
  const doc = findOneAndUpdateDoc(res);
  if (doc) return doc;
  return await db.collection("conversations").findOne(filter);
}
// ------- helper para cerrar conversación (finalizar/cancelar) -------
async function closeConversation(convId, status = "COMPLETED", extra = {}) {
  try {
    const db = await getDb();
    const now = new Date();
    const update = {
      $set: {
        finalized: true,
        status,
        pedidoEstado: status,
        closedAt: now,
        updatedAt: now,
        ...extra
      }
    };

    if (/^(COMPLETED|CANCELLED)$/i.test(String(status || "").trim())) {
      update.$unset = { transferFlowStatus: "" };
    }

    await db.collection("conversations").updateOne(
      { _id: new ObjectId(String(convId)) },
      update
    );
  } catch (e) {
    console.error("closeConversation error:", e?.message || e);
  }
}

// ------- helper para validar que el pedido esté completo antes de cerrar -------
function isPedidoCompleto(p) {
  try {
    if (!p) return false;
    const pedido = normalizePedidoDateTimeFields(cloneJsonSafe(p) || {});
    const itemsOk   = Array.isArray(pedido.items) && pedido.items.length > 0;
    const entregaOk = pedido.Entrega === 'retiro' || pedido.Entrega === 'domicilio';
    const dirOk     = pedido.Entrega !== 'domicilio'
      || (pedido.Domicilio && pedido.Domicilio.direccion && String(pedido.Domicilio.direccion).trim());
    const fechaOk   = /^\d{4}-\d{2}-\d{2}$/.test(String(pedido.Fecha || ""));
    const horaOk    = /^\d{2}:\d{2}$/.test(String(pedido.Hora || ""));
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

    const p = normalizePedidoDateTimeFields(cloneJsonSafe(pedido) || {});
    const fecha = String(p.Fecha || "").trim();
    const hora  = String(p.Hora || "").trim();

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
              ...(estadoStr === "PENDIENTE" ? { status: "PENDIENTE" } : {}),
              lastPedidoSnapshot: {
                estado: estadoStr || null,
                Pedido: pedido
              },
              lastPedidoSnapshotAt: now,
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

    // Dedupe: WhatsApp puede reintentar el webhook y enviar el mismo mensaje más de una vez.
    // Si viene un id de WhatsApp (meta.raw.id), evitamos insertar duplicados en la misma conversación.
    const effectiveTenantId = (tenantId ?? TENANT_ID ?? null);
    const waMsgId = (meta && meta.raw && meta.raw.id) ? String(meta.raw.id) : "";
    if (waMsgId) {
      const dup = await db.collection("messages").findOne(
        withTenant({ conversationId: convObjectId, "meta.raw.id": waMsgId }, effectiveTenantId),
        { projection: { _id: 1 } }
      );
      if (dup) {
        console.log("[messages] duplicate wa msg ignored:", waMsgId);
        return;
      }
    }


    const doc = {
      tenantId: effectiveTenantId,
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

 
function cloneJsonSafe(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

function isFilledValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function normalizeDomicilioObj(v) {
  if (typeof v === "string") return { direccion: v };
  if (v && typeof v === "object") return cloneJsonSafe(v) || {};
  return {};
}

function normalizePedidoDateTimeFields(pedido) {
  const p = (pedido && typeof pedido === "object") ? pedido : {};

  const fechaNew = typeof p.fecha_pedido === "string" ? p.fecha_pedido.trim() : "";
  const fechaOld = typeof p.Fecha === "string" ? p.Fecha.trim() : "";
  const horaNew = typeof p.hora_pedido === "string" ? p.hora_pedido.trim() : "";
  const horaOld = typeof p.Hora === "string" ? p.Hora.trim() : "";

  if (fechaNew) p.Fecha = fechaNew;
  else if (fechaOld) p.fecha_pedido = fechaOld;

  if (horaNew) p.Hora = horaNew;
  else if (horaOld) p.hora_pedido = horaOld;

  return p;
}

function mergePedidoState(prevPedido, nextPedido) {
  const prev = (prevPedido && typeof prevPedido === "object") ? cloneJsonSafe(prevPedido) : {};
  const next = (nextPedido && typeof nextPedido === "object") ? cloneJsonSafe(nextPedido) : {};

  const merged = { ...prev, ...next };
  for (const key of ["nombre_apellido", "Entrega", "Pago", "fecha_pedido", "hora_pedido", "Fecha", "Hora", "distancia_km"]) {
    merged[key] = isFilledValue(next[key]) ? next[key] : prev[key];
  }

  const prevDom = normalizeDomicilioObj(prev.Domicilio);
  const nextDom = normalizeDomicilioObj(next.Domicilio);
  const dom = {};
  for (const key of new Set([...Object.keys(prevDom), ...Object.keys(nextDom)])) {
    dom[key] = isFilledValue(nextDom[key]) ? nextDom[key] : prevDom[key];
  }
  merged.Domicilio = dom;

  if (Array.isArray(next.items) && next.items.length > 0) merged.items = cloneJsonSafe(next.items);
  else if (Array.isArray(prev.items)) merged.items = cloneJsonSafe(prev.items);
  else merged.items = [];

  if (isFilledValue(next.total_pedido)) merged.total_pedido = next.total_pedido;
  else if (isFilledValue(prev.total_pedido)) merged.total_pedido = prev.total_pedido;
  else merged.total_pedido = 0;

  return normalizePedidoDateTimeFields(merged);
}


function pedidoItemsArray(pedido) {
  return Array.isArray(pedido?.items) ? pedido.items : [];
}

function lowerText(value) {
  return String(value || "").trim().toLowerCase();
}

function pedidoEntregaValue(pedido) {
  return lowerText(pedido?.Entrega || "");
}

function pedidoIsDomicilio(pedido) {
  return pedidoEntregaValue(pedido) === "domicilio";
}

function pedidoHasAddress(pedido) {
  const dom = normalizeDomicilioObj(pedido?.Domicilio);
  if (String(dom.direccion || "").trim()) return true;
  if ([dom.calle, dom.numero].filter(Boolean).join(" ").trim()) return true;
  if (String(dom.address || "").trim()) return true;
  const hasCoords = Number.isFinite(Number(dom.lat)) && Number.isFinite(Number(dom.lon));
  return hasCoords;
}

function pedidoHasPago(pedido) {
  return !!String(pedido?.Pago || "").trim();
}

function pedidoHasHora(pedido) {
  const p = normalizePedidoDateTimeFields(cloneJsonSafe(pedido) || {});
  return /^\d{2}:\d{2}$/.test(String(p.hora_pedido || p.Hora || "").trim());
}

function pedidoHasNombreCompleto(pedido) {
  const name = String(pedido?.nombre_apellido || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!name) return false;

  // aceptar un nombre simple tipo "Werli" o nombre + apellido.
  // rechazar basura demasiado corta o numérica.
 if (name.length < 2) return false;
  if (/^\d+$/.test(name)) return false;
  if (!/[a-záéíóúñü]/i.test(name)) return false;

  return /^[a-záéíóúñü][a-záéíóúñü.'-]*(?:\s+[a-záéíóúñü][a-záéíóúñü.'-]*)*$/i.test(name);

}

function pedidoHasAnyItems(pedido) {
  return pedidoItemsArray(pedido).some(it => String(it?.descripcion || "").trim());
}

function pedidoHasChickenMainItem(pedido) {
  return pedidoItemsArray(pedido).some((it) => {
    const id = String(it?.id ?? "").trim();
    const desc = lowerText(it?.descripcion || "");
    return id === "55" || id === "42" || desc === "pollo entero" || desc === "medio pollo";
  });
}

function pedidoHasResolvedMilanesaType(pedido) {
  return pedidoItemsArray(pedido).some((it) => {
    const desc = lowerText(it?.descripcion || "");
    return desc === "milanesas de carne" || desc === "milanesas de pollo";
  });
}

function pedidoHasMilanesas(pedido) {
  return pedidoItemsArray(pedido).some((it) =>
    /milanesa/i.test(String(it?.descripcion || ""))
  );
}


function foldIntentText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textMentionsMilanesaIntent(text) {
  const s = foldIntentText(text);
  return /\bmila\b|\bmilanesa\b|\bnapo\b|\bnapolitana\b/.test(s);
}

function nextMissingMilanesaQuestionFromText(text, pedido) {
  const s = foldIntentText(text);
  if (!s) return "";
  if (!textMentionsMilanesaIntent(s)) return "";
  if (pedidoHasMilanesas(pedido)) return "";

  const mentionsPollo = /\bde pollo\b|\bpollo\b/.test(s);
  const mentionsCarne = /\bde carne\b|\bcarne\b/.test(s);
  const mentionsPechuga = /\bpechuga\b/.test(s);
  const mentionsMuslo = /\bmuslo\b/.test(s);
  const mentionsNapo = /\bnapo\b|\bnapolitana\b/.test(s);
  const mentionsComun = /\bcomun\b/.test(s);

if (!mentionsPollo && !mentionsCarne) {
    return "¿La milanesa la querés de carne o de pollo? 😊";
  }
  if (mentionsPollo && !mentionsPechuga && !mentionsMuslo) {
    return "¿La milanesa de pollo la querés de pechuga o de muslo? 😊";
  }
  if (!mentionsNapo && !mentionsComun) {
    return "¿La querés común o napolitana? 😊";
  }

  return "";
}

function stripEnvioItemsFromPedido(pedido) {
  if (!pedido || typeof pedido !== "object") return pedido;
  if (Array.isArray(pedido.items)) {
    pedido.items = pedido.items.filter((it) => !/env[ií]o/i.test(String(it?.descripcion || "")));
  }
  return pedido;
}

function asksChickenCondimentQuestion(text) {
  const s = lowerText(text);
  return /lim[oó]n,?\s*chimichurri\s*o\s*solo/.test(s)
    || /lo quer[eé]s con lim[oó]n/.test(s)
    || /quer[eé]s.*chimichurri.*solo/.test(s);
}

function asksMilanesaTypeQuestion(text) {
  const s = lowerText(text);
  return /milanesas?.*de carne o de pollo/.test(s)
    || /milanesas?.*carne.*pollo/.test(s)
    || /la milanesa la quer[eé]s de carne o de pollo/.test(s);
}

function asksPaymentQuestion(text) {
  return /efectivo o por transferencia/i.test(String(text || ""));
}

function isExplicitUserCancellation(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const norm = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const wantsCancelRaw =
    /\b(cancel|anul)(ar|o|a|e|en|ado|ada|alo|ala)?\b/.test(norm) ||
    /\bdar de baja\b/.test(norm) ||
    /\bsuspende\b/.test(norm);

  const cancelNeg =
    /\bno\s+(quiero\s+)?cancel/.test(norm) ||
    /\bno\s+(quiero\s+)?anul/.test(norm);

  return !!(wantsCancelRaw && !cancelNeg);
}

function looksLikeSummaryOrConfirmation(text) {
  const s = String(text || "");
  return /¿\s*confirm[aá]s?\??/i.test(s)
    || /resumen de tu pedido/i.test(s)
    || /hora de entrega:/i.test(s)
    || /modalidad:/i.test(s)
    || /\*productos:\*/i.test(s);
}

function assistantWasAskingForOrderConfirmation(text) {
  const s = String(text || "");
  return looksLikeSummaryOrConfirmation(s)
    || /¿\s*confirm(amos|as|ás)\s+el\s+pedido\??/i.test(s)
    || /quer[eé]s\s+confirmar/i.test(s)
    || /pedido\s+qued[oó]\s+confirmado/i.test(s);
}

async function loadLastAssistantTextMessage(tenantId, conversationId) {
  try {
    if (!conversationId) return "";
    const db = await getDb();
    const convObjectId = new ObjectId(String(conversationId));
    const doc = await db.collection("messages").findOne(
      withTenant({ conversationId: convObjectId, role: "assistant", type: "text" }, tenantId),
      { sort: { ts: -1, createdAt: -1, _id: -1 }, projection: { content: 1 } }
    );
    return String(doc?.content || "").trim();
  } catch (e) {
    console.warn("[messages] loadLastAssistantTextMessage error:", e?.message || e);
    return "";
  }
}

function isExplicitUserConfirmation(text, opts = {}) {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const norm = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

   const lastAssistantText = String(opts?.lastAssistantText || "").trim();
  const expectingOrderConfirmation =
    !!opts?.expectingOrderConfirmation ||
    assistantWasAskingForOrderConfirmation(lastAssistantText);

  // confirmaciones realmente explícitas: valen siempre
  if (/\bconfirm(ar|o|a|ame|alo|ado)\b/.test(norm)) return true;
    if (/^(s[i1]+|s[i1]+s[i1]+|sip+|sep+)\b.*\bconfirm/.test(norm)) return true;

  // afirmaciones débiles: solo valen si el mensaje anterior del asistente
  // estaba realmente pidiendo confirmar el pedido
  const weakAffirmative =
    (/^(s[i1]+|s[i1]+s[i1]+|sip+|sep+|ok(?:ey)?|dale|listo|de una|perfecto|joya|mandale|obvio)\b/.test(norm))
    && norm.split(/\s+/).length <= 3;

  if (weakAffirmative) return expectingOrderConfirmation;

  if (["👍", "👌", "✅", "✔️", "☑️"].includes(raw)) {
    return expectingOrderConfirmation;
  }

  return false;
}


function nextRequiredQuestionFromPedido(pedido, orderConfig = null) {
  const p = normalizePedidoDateTimeFields(cloneJsonSafe(pedido) || {});
  if (orderRequiredEnabled(orderConfig, "items") && !pedidoHasAnyItems(p)) return orderMessage(orderConfig, "missingItems");
  if (orderRequiredEnabled(orderConfig, "entrega") && !pedidoEntregaValue(p)) return orderMessage(orderConfig, "missingEntrega");
  if (orderRequiredEnabled(orderConfig, "addressForDelivery") && pedidoIsDomicilio(p) && !pedidoHasAddress(p)) return orderMessage(orderConfig, "missingAddress");
  if (orderRequiredEnabled(orderConfig, "paymentForDelivery") && pedidoIsDomicilio(p) && pedidoHasAddress(p) && !pedidoHasPago(p)) return orderMessage(orderConfig, "missingPayment");
  if (orderRequiredEnabled(orderConfig, "hora") && !pedidoHasHora(p)) return orderMessage(orderConfig, "missingHora");
  if (orderRequiredEnabled(orderConfig, "nombre") && !pedidoHasNombreCompleto(p)) return orderMessage(orderConfig, "missingNombre");
  return orderMessage(orderConfig, "fallbackReady");
}

function pedidoHasRequiredFieldsForClose(pedido, orderConfig = null) {
  const p = normalizePedidoDateTimeFields(cloneJsonSafe(pedido) || {});
  if (orderRequiredEnabled(orderConfig, "items") && !pedidoHasAnyItems(p)) return false;
  if (orderRequiredEnabled(orderConfig, "entrega") && !pedidoEntregaValue(p)) return false;
  if (orderRequiredEnabled(orderConfig, "addressForDelivery") && pedidoIsDomicilio(p) && !pedidoHasAddress(p)) return false;
  if (orderRequiredEnabled(orderConfig, "paymentForDelivery") && pedidoIsDomicilio(p) && !pedidoHasPago(p)) return false;
  if (orderRequiredEnabled(orderConfig, "hora") && !pedidoHasHora(p)) return false;
  if (orderRequiredEnabled(orderConfig, "nombre") && !pedidoHasNombreCompleto(p)) return false;
  return true;
}

function applyCriticalPedidoGuards({ pedido, responseText, estado, currentText, orderConfig = null }) {
  let nextPedido = normalizePedidoDateTimeFields(cloneJsonSafe(pedido) || { Entrega: "", Domicilio: {}, items: [], total_pedido: 0 });
  let nextResponse = String(responseText || "").trim();
  let nextEstado = String(estado || "IN_PROGRESS").trim() || "IN_PROGRESS";
  const guardHits = [];

  if (!orderFeatureEnabled(orderConfig, "backendGuards")) {
    return { pedido: nextPedido, responseText: nextResponse, estado: nextEstado, guardHits };
  }


  const userCancelled = isExplicitUserCancellation(currentText);
  const assistantCancelled =
    nextEstado.toUpperCase() === "CANCELLED" ||
    /\bpedido cancelado\b/i.test(nextResponse);

  // ✅ Si el usuario canceló explícitamente o el modelo ya devolvió CANCELLED,
  // NO ejecutar guardas de flujo normal (pago, dirección, resumen, etc.).
  if (userCancelled || assistantCancelled) {
    nextEstado = "CANCELLED";
    if (!nextResponse) nextResponse = "Pedido cancelado ✅";
    return { pedido: nextPedido, responseText: nextResponse, estado: nextEstado, guardHits };
  }


  const missingMilanesaQuestion = (orderFeatureEnabled(orderConfig, "productRules") && orderFeatureEnabled(orderConfig, "milanesaMentionGuard"))
    ? nextMissingMilanesaQuestionFromText(currentText, nextPedido)
    : "";
  if (missingMilanesaQuestion) {
    nextEstado = "IN_PROGRESS";
    nextResponse = missingMilanesaQuestion;
    guardHits.push("milanesa_mentioned_but_missing_from_items");
    return { pedido: nextPedido, responseText: nextResponse, estado: nextEstado, guardHits };
  }


  if (orderRequiredEnabled(orderConfig, "addressForDelivery") && pedidoIsDomicilio(nextPedido) && !pedidoHasAddress(nextPedido)) {
    nextEstado = "IN_PROGRESS";
    nextPedido.distancia_km = null;
    stripEnvioItemsFromPedido(nextPedido);
    try {
      const { pedidoCorr } = recalcAndDetectMismatch(nextPedido);
      nextPedido = pedidoCorr;
    } catch {}
    nextResponse = orderMessage(orderConfig, "missingAddress");
    guardHits.push("delivery_address_required");
  }

  if (orderRequiredEnabled(orderConfig, "paymentForDelivery") && asksPaymentQuestion(nextResponse) && !(pedidoIsDomicilio(nextPedido) && pedidoHasAddress(nextPedido))) {
    nextEstado = "IN_PROGRESS";
    nextResponse = nextRequiredQuestionFromPedido(nextPedido, orderConfig);
    guardHits.push("payment_only_after_address");
  }

  if (orderRequiredEnabled(orderConfig, "paymentForDelivery") && pedidoIsDomicilio(nextPedido) && pedidoHasAddress(nextPedido) && !pedidoHasPago(nextPedido)) {
    if (!asksPaymentQuestion(nextResponse)) {
      nextEstado = "IN_PROGRESS";
      nextResponse = orderMessage(orderConfig, "missingPayment");
      guardHits.push("force_payment_question");
    }
  }

  if (orderFeatureEnabled(orderConfig, "productRules") && orderFeatureEnabled(orderConfig, "chickenCondimentGuard") && asksChickenCondimentQuestion(nextResponse) && !pedidoHasChickenMainItem(nextPedido)) {
    nextEstado = "IN_PROGRESS";
    nextResponse = nextRequiredQuestionFromPedido(nextPedido, orderConfig);
    guardHits.push("invalid_chicken_condiment_question");
  }

  if (asksMilanesaTypeQuestion(nextResponse) && pedidoHasResolvedMilanesaType(nextPedido)) {
    nextEstado = "IN_PROGRESS";
    nextResponse = nextRequiredQuestionFromPedido(nextPedido);
    guardHits.push("resolved_milanesa_type_no_reask");
  }

  if ((looksLikeSummaryOrConfirmation(nextResponse) || /^(COMPLETED|PENDIENTE)$/i.test(nextEstado)) && !pedidoHasRequiredFieldsForClose(nextPedido, orderConfig)) {
    nextEstado = "IN_PROGRESS";
    nextResponse = nextRequiredQuestionFromPedido(nextPedido, orderConfig);
    guardHits.push("summary_blocked_missing_required_fields");
  }

  return { pedido: nextPedido, responseText: nextResponse, estado: nextEstado, guardHits };
}

async function loadLastPedidoSnapshot(tenantId, conversationId) {
  try {
    if (!conversationId) return null;
    const db = await getDb();
    const convObjectId = new ObjectId(String(conversationId));

    const conv = await db.collection("conversations").findOne(
      withTenant({ _id: convObjectId }, tenantId),
      { projection: { lastPedidoSnapshot: 1 } }
    );
    const convSnap = conv?.lastPedidoSnapshot?.Pedido;
    if (convSnap && typeof convSnap === "object") {
      return cloneJsonSafe(convSnap) || convSnap;
    }

    const doc = await db.collection("messages").findOne(
      withTenant({
        conversationId: convObjectId,
        role: "assistant",
        type: "json",
        "meta.kind": "pedido-snapshot"
      }, tenantId),
      { sort: { ts: -1, createdAt: -1, _id: -1 }, projection: { content: 1 } }
    );
    if (!doc?.content) return null;
    const parsed = JSON.parse(String(doc.content));
    return (parsed?.Pedido && typeof parsed.Pedido === "object") ? parsed.Pedido : null;
  } catch (e) {
    console.warn("[snapshot] loadLastPedidoSnapshot error:", e?.message || e);
    return null;
  }
}

function _pedidoItemsToDisplayLines(pedido) {
  const items = Array.isArray(pedido?.items) ? pedido.items : [];
  return items
    .map((it) => {
      const desc = String(it?.descripcion || "").trim();
      if (!desc) return "";
      const qty = Number(it?.cantidad || 0);
      const qtyText = Number.isFinite(qty) && qty > 0 ? String(qty).replace(/\.0+$/, "") + " x " : "";
      return (qtyText + desc).trim();
    })
    .filter(Boolean);
}

function _safePedidoItemsForAdmin(pedido) {
  const items = Array.isArray(pedido?.items) ? pedido.items : [];
  return items
    .map((it) => {
      const desc = String(it?.descripcion || it?.nombre || "").trim();
      if (!desc) return null;
      const qtyNum = Number(it?.cantidad);
      const unitNum = Number(it?.importe_unitario);
      const totalNum = Number(it?.total);
      return {
        id: it?.id ?? "",
        descripcion: desc,
        cantidad: Number.isFinite(qtyNum) ? qtyNum : 0,
        importe_unitario: Number.isFinite(unitNum) ? unitNum : 0,
        total: Number.isFinite(totalNum) ? totalNum : 0,
      };
    })
    .filter(Boolean);
}

function _extractPedidoSummaryData(pedido) {
  if (!pedido || typeof pedido !== "object") {
    return { entregaLabel: "-", fechaEntrega: "-", horaEntrega: "-", direccion: "-" };
  }

  pedido = normalizePedidoDateTimeFields(cloneJsonSafe(pedido) || {});
  const items = Array.isArray(pedido.items) ? pedido.items : [];
  const entregaRaw = String(pedido.Entrega || pedido.entrega || "").trim().toLowerCase();
  const envio = items.find(i => /env[ií]o/i.test(String(i?.descripcion || "")));

  let entregaLabel = "-";
  if (entregaRaw === "domicilio") entregaLabel = "Envío";
  else if (entregaRaw === "retiro") entregaLabel = "Retiro";

  let direccion = "";
  const domicilio = pedido.Domicilio ?? pedido.domicilio;
  if (typeof domicilio === "string") {
    direccion = domicilio.trim();
  } else if (domicilio && typeof domicilio === "object") {
    direccion = String(
      domicilio.direccion ||
      domicilio.calle ||
      domicilio.address ||
      ""
    ).trim();
  }
  if (!direccion && envio) {
    direccion = String(envio.descripcion || "").trim();
  }

  const fechaRaw = String(
    pedido.Fecha ||
    pedido.fecha ||
    pedido.fecha_pedido ||
    ""
  ).trim();
  const horaRaw = String(
    pedido.Hora ||
    pedido.hora ||
    pedido.hora_pedido ||
    ""
  ).trim();

  const fechaEntrega = /^\d{4}-\d{2}-\d{2}$/.test(fechaRaw) ? fechaRaw : "-";
  const horaEntrega = /^\d{2}:\d{2}$/.test(horaRaw) ? horaRaw : "-";

  return { entregaLabel, fechaEntrega, horaEntrega, direccion: direccion || "-" };
}

async function _loadLastPedidoForConversation(db, convId, tenantId, orderHint = null) {
  let pedido =
    orderHint && orderHint.pedido && Array.isArray(orderHint.pedido.items)
      ? orderHint.pedido
      : null;

  if (!pedido) {
    try {
      const conv = await db.collection("conversations").findOne(
        withTenant({ _id: new ObjectId(String(convId)) }, tenantId),
        { projection: { lastPedidoSnapshot: 1 } }
      );
      const convSnap = conv?.lastPedidoSnapshot?.Pedido;
      if (convSnap && Array.isArray(convSnap.items)) {
        pedido = convSnap;
      }
    } catch {}
  }

  if (!pedido) {
    const filter = withTenant(
      { conversationId: new ObjectId(String(convId)), role: "assistant" },
      tenantId
    );
    const cursor = db.collection("messages")
      .find(filter)
      .sort({ ts: -1, createdAt: -1 })
      .limit(200);

    for await (const m of cursor) {
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

  return pedido || null;
}

async function _getLastPedidoProducts(db, convId, tenantId, orderHint = null) {
  try {
    const pedido = await _loadLastPedidoForConversation(db, convId, tenantId, orderHint);
    return _pedidoItemsToDisplayLines(pedido);
  } catch {
    return [];
  }
}

// === Helpers para resumen de Pedido (fecha/hora/entrega/envío) ===
async function _getLastPedidoSummary(db, convId, tenantId, orderHint = null) {
 try {
    const pedido = await _loadLastPedidoForConversation(db, convId, tenantId, orderHint);
    if (!pedido) return { entregaLabel: "-", fechaEntrega: "-", horaEntrega: "-", direccion: "-" };
    return _extractPedidoSummaryData(pedido);
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
      .find(withTenant({ conversationId: { $in: convIds } }, tenantId))
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
      kitchenSent: !!c.kitchenSent,
      kitchenAt: c.kitchenAt || null,
      delivered: !!c.delivered,
      deliveredAt: c.deliveredAt || null,
      lastAt: c.lastUserTs || c.lastAssistantTs || c.updatedAt || c.closedAt || c.openedAt
    };

    const ord = ordersByConvId.get(String(c._id));
    const distanceKm =
      ord && ord.distancia_km !== undefined && ord.distancia_km !== null
        ? ord.distancia_km
        : null;
    const pedido = await _loadLastPedidoForConversation(db, c._id, tenantId, ord);
    const products = _pedidoItemsToDisplayLines(pedido);
    const pedidoItems = _safePedidoItemsForAdmin(pedido);

    // Preferir campos persistidos en conversations; si faltan, fallback al último pedido detectado
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
      out.push({ ...base, ...extra, products, pedidoItems });
    } else {
      const extra = pedido ? _extractPedidoSummaryData(pedido) : { entregaLabel: "-", fechaEntrega: "-", horaEntrega: "-", direccion: "-" };
      out.push({
        ...base,
        ...extra,
        products,
        pedidoItems,
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

// ---------- Media proxy (para ver/descargar adjuntos en /admin y /admin/inbox) ----------
function _safeFileName(name) {
  const s = String(name || "").trim() || "archivo";
  // quitar caracteres peligrosos para header
  return s.replace(/[\r\n"]/g, "").slice(0, 180) || "archivo";
}
function _extFromMime(mime) {
  const mt = String(mime || "").toLowerCase();
  if (mt.includes("jpeg")) return "jpg";
  if (mt.includes("png")) return "png";
  if (mt.includes("webp")) return "webp";
  if (mt.includes("gif")) return "gif";
  if (mt.includes("pdf")) return "pdf";
  if (mt.includes("mp3")) return "mp3";
  if (mt.includes("wav")) return "wav";
  if (mt.includes("ogg") || mt.includes("opus")) return "ogg";
  if (mt.includes("mp4")) return "mp4";
  return "";
}
function _appendTenantParam(url, tenantId) {
  const t = String(tenantId || "").trim();
  if (!t) return url;
  const u0 = String(url || "");
  // No tocar URLs absolutas externas
  if (/^https?:\/\//i.test(u0)) return u0;
  try {
    const u = new URL(u0, "http://localhost");
    u.searchParams.set("tenant", t);
    return u.pathname + (u.search || "") + (u.hash || "");
  } catch {
    // fallback simple
    if (!u0) return u0;
    return u0.includes("?")
      ? (u0 + "&tenant=" + encodeURIComponent(t))
      : (u0 + "?tenant=" + encodeURIComponent(t));
  }
}

function sanitizeRawMessageForStorage(rawMsg) {
  try {
    const copy = cloneJsonSafe(rawMsg) || {};
    if (copy.__wwebMedia && typeof copy.__wwebMedia === "object") {
      const bytes = copy.__wwebMedia.bytes || copy.__wwebMedia.MediaBytes || 0;
      copy.__wwebMedia = { ...copy.__wwebMedia };
      if (copy.__wwebMedia.data) copy.__wwebMedia.data = `[base64 almacenado en meta.media.data ${bytes || ""} bytes]`;
      if (copy.__wwebMedia.base64) copy.__wwebMedia.base64 = `[base64 almacenado en meta.media.data ${bytes || ""} bytes]`;
    }
   if (copy.__media && typeof copy.__media === "object" && copy.__media.data) {
      copy.__media = { ...copy.__media, data: `[base64 almacenado en meta.media.data ${copy.__media.bytes || ""} bytes]` };
    }
    return copy;
  } catch {
    return rawMsg || null;
  }
}


function buildMediaDescriptorForAdmin(m, tenantId) {
  try {
    const raw = (m && m.meta && m.meta.raw) ? m.meta.raw : null;
    const type = String(m?.type || raw?.type || "").trim().toLowerCase();

    let mediaId = null;
    let filename = "";
    let mime = "";
    let caption = "";

    if (type === "image") {
      mediaId = raw?.image?.id || null;
      mime = raw?.image?.mime_type || "";
      caption = String(raw?.image?.caption || "").trim();
      filename = "imagen";
    } else if (type === "audio") {
      mediaId = raw?.audio?.id || null;
      mime = raw?.audio?.mime_type || "";
      filename = "audio";
    } else if (type === "document") {
      mediaId = raw?.document?.id || null;
      filename = String(raw?.document?.filename || raw?.document?.file_name || "archivo").trim();
      mime = raw?.document?.mime_type || "";
      caption = String(raw?.document?.caption || "").trim();
    } else if (type === "video") {
      mediaId = raw?.video?.id || null;
      mime = raw?.video?.mime_type || "";
      caption = String(raw?.video?.caption || "").trim();
      filename = "video";
    } else if (type === "sticker") {
      mediaId = raw?.sticker?.id || null;
      mime = raw?.sticker?.mime_type || "";
      filename = "sticker";
    }

   // fallback: media guardada por WhatsApp Web o cache del webhook.
    const inlineBase64 = m?.meta?.media?.data || m?.meta?.media?.base64 || m?.meta?.media?.MediaBase64 || null;
    const cachedPublicUrl = m?.meta?.media?.publicUrl || null;
    const cachedCacheId = m?.meta?.media?.cacheId || null;
    const cachedUrl = cachedPublicUrl || (cachedCacheId ? (`/cache/media/${cachedCacheId}`) : null);

    // Si es WWeb y quedó base64 persistido, siempre servimos por /api/media/:id.
    // Si es Meta API y hay mediaId, también usamos /api/media/:id para descargar con token.
    let url = (mediaId || inlineBase64) ? (`/api/media/${String(m._id)}`) : cachedUrl;
    if (!url) return null;

    url = _appendTenantParam(url, tenantId);

    const mimeFinal = (mime || (m?.meta?.media?.mime) || (m?.meta?.media?.mimetype) || "").toLowerCase();
    const filenameFinal = filename || (m?.meta?.media?.filename) || null;

    // infer kind por mime si ayuda (ej: image/pdf enviado como "document")
    let kind = type || (m?.meta?.media?.kind) || "file";
    if (mimeFinal.startsWith("image/")) kind = "image";
    else if (mimeFinal.startsWith("audio/")) kind = "audio";
    else if (mimeFinal.startsWith("video/")) kind = "video";
    else if (mimeFinal.includes("pdf")) kind = "pdf";
    else if (type === "document") kind = "document";

    return {
      kind,
      url,
      mime: mimeFinal || null,
      filename: filenameFinal,
      caption: caption || null,
    };
  } catch {
    return null;
  }
}


// GET /api/media/:msgId  -> proxy seguro (requiere login) para descargar/ver media desde WhatsApp
app.get("/api/media/:msgId", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const msgId = String(req.params.msgId || "").trim();
    if (!ObjectId.isValid(msgId)) return res.status(400).send("invalid_id");

    const db = await getDb();
    const msgDoc = await db.collection("messages").findOne(
      withTenant({ _id: new ObjectId(msgId) }, tenant)
    );
    if (!msgDoc) return res.status(404).send("not_found");

    const raw = msgDoc?.meta?.raw || {};
    const type = String(msgDoc?.type || raw?.type || "").trim().toLowerCase();

    let mediaId = null;
    let filename = "";
    let mimeHint = "";

    if (type === "image") {
      mediaId = raw?.image?.id || null;
      mimeHint = raw?.image?.mime_type || "";
      filename = "imagen";
    } else if (type === "audio") {
      mediaId = raw?.audio?.id || null;
      mimeHint = raw?.audio?.mime_type || "";
      filename = "audio";
    } else if (type === "document") {
      mediaId = raw?.document?.id || null;
      mimeHint = raw?.document?.mime_type || "";
      filename = String(raw?.document?.filename || raw?.document?.file_name || "archivo").trim();
    } else if (type === "video") {
      mediaId = raw?.video?.id || null;
      mimeHint = raw?.video?.mime_type || "";
      filename = "video";
    } else if (type === "sticker") {
      mediaId = raw?.sticker?.id || null;
      mimeHint = raw?.sticker?.mime_type || "";
      filename = "sticker";
    }

    // fallback: si el webhook guardó base64/cacheId/publicUrl (WhatsApp Web), lo servimos sin Graph API.
    if (!mediaId) {
      const metaMedia = (msgDoc?.meta?.media && typeof msgDoc.meta.media === "object") ? msgDoc.meta.media : {};
      const inlineBase64 = String(metaMedia.data || metaMedia.base64 || metaMedia.MediaBase64 || "").trim();
      if (inlineBase64) {
        let buf = null;
        try { buf = Buffer.from(inlineBase64, "base64"); } catch {}
        if (buf && buf.length) {
          const mimeInline = String(metaMedia.mime || metaMedia.mimetype || mimeHint || "application/octet-stream");
          let finalNameInline = _safeFileName(filename || metaMedia.filename || "archivo");
          const extInline = _extFromMime(mimeInline);
          if (extInline && !finalNameInline.toLowerCase().endsWith("." + extInline)) {
            finalNameInline += "." + extInline;
          }
          const forceDlInline = String(req.query?.download || "") === "1";
          const inlinePreferredInline =
            !forceDlInline && (
              mimeInline.startsWith("image/") ||
              mimeInline.startsWith("audio/") ||
              mimeInline.startsWith("video/") ||
              mimeInline.includes("pdf")
            );
          res.setHeader("Content-Type", mimeInline);
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Disposition", `${inlinePreferredInline ? "inline" : "attachment"}; filename="${finalNameInline}"`);
          return res.send(buf);
        }
      }

      const cached = metaMedia.cacheId || null;
      if (cached) {
        const item = getFromCache(cached);
        if (item) {
          res.setHeader("Content-Type", item.mime || "application/octet-stream");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Disposition", `inline; filename="${_safeFileName(filename || metaMedia.filename || ("archivo." + (_extFromMime(item.mime) || "bin")))}"`);
          return res.send(item.buffer);
        }
      }
      return res.status(400).send("no_media");
    }

    // Obtener token correcto (multi-phone) leyendo la conversación
    let convPhoneNumberId = null;
    try {
      if (msgDoc.conversationId) {
        const conv = await db.collection("conversations").findOne(
          withTenant({ _id: msgDoc.conversationId }, tenant),
          { projection: { phoneNumberId: 1 } }
        );
        convPhoneNumberId = conv?.phoneNumberId || null;
      }
    } catch {}

    let rt = null;
    try {
      if (convPhoneNumberId) rt = await getRuntimeByPhoneNumberId(convPhoneNumberId);
    } catch {}

    const waOpts = {
      whatsappToken: rt?.whatsappToken || null,
      phoneNumberId: rt?.phoneNumberId || convPhoneNumberId || null,
    };

    const info = await getMediaInfo(mediaId, waOpts);
    const buf = await downloadMediaBuffer(info.url, waOpts);
    const mime = String(info?.mime_type || mimeHint || "application/octet-stream");

    let finalName = _safeFileName(filename || "archivo");
    const ext = _extFromMime(mime);
    if (ext && !finalName.toLowerCase().endsWith("." + ext)) {
      finalName += "." + ext;
    }

    const forceDl = String(req.query?.download || "") === "1";
    const inlinePreferred =
      !forceDl && (
        mime.startsWith("image/") ||
        mime.startsWith("audio/") ||
        mime.startsWith("video/") ||
        mime.includes("pdf")
      );

    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `${inlinePreferred ? "inline" : "attachment"}; filename="${finalName}"`);
    return res.send(buf);
  } catch (e) {
    console.error("GET /api/media error:", e?.message || e);
    return res.status(500).send("internal");
  }
});


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
      media: buildMediaDescriptorForAdmin(m, t),
      createdAt: m.ts || m.createdAt
    })));
  } catch (e) {
    console.error("GET /api/logs/messages error:", e);
    res.status(500).json({ error: "internal" });
  }
});
// ---------- WhatsApp Inbox nuevo (aislado) ----------
// Monta rutas nuevas /api/admin/wa-inbox/* y una UI /admin/inbox antes del legacy.
// No modifica endpoints existentes de Conversaciones.
const { mountWhatsAppInboxPanel } = require("./wa_inbox_panel");
mountWhatsAppInboxPanel(app, { auth });


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
      kitchenSent: !!conv.kitchenSent,
      kitchenAt: conv.kitchenAt || null,
      delivered: !!conv.delivered,
      deliveredAt: conv.deliveredAt || null,
      channelType: conv.channelType || "whatsapp",
       // Canal/telefono del negocio por el que entró la conversación
       phoneNumberId: conv.phoneNumberId || null,
       displayPhoneNumber: conv.displayPhoneNumber || null,
      instagramAccountId: conv.instagramAccountId || null,
      instagramPageId: conv.instagramPageId || null,
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
  <title>Admin | WhatsApp</title>
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
        <h1>WhatsApp</h1>
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
            <span>Pausar bot</span>
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
          <small id="pauseHint" class="pill" style="display:flex;align-items:center">Bot activo</small>
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
  let activeStatusLabel = "";

  const convListEl = document.getElementById("convList");
  const searchInput = document.getElementById("searchInput");
  const refreshBtn = document.getElementById("refreshBtn");

  const chatAvatar = document.getElementById("chatAvatar");
  const chatName = document.getElementById("chatName");
  const chatSub = document.getElementById("chatSub");
  const chatStatus = document.getElementById("chatStatus");
  const deliveredToggle = document.getElementById("deliveredToggle");
  const manualToggle = document.getElementById("manualToggle");
 const pauseHint = document.getElementById("pauseHint");

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

  function syncManualUi(isManual){
    const paused = !!isManual;
    if (manualToggle) manualToggle.checked = paused;
    if (pauseHint) pauseHint.textContent = paused ? "Bot pausado" : "Bot activo";
    if (chatStatus) chatStatus.textContent = paused ? "BOT PAUSADO" : (activeStatusLabel || "");
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
      const manual = c.manualOpen ? "BOT PAUSADO" : "BOT";
      const deliveredMark = c.delivered ? '<span class="conv-delivered" title="Entregado">✓</span>' : '';
      const cls = id === activeConvId ? "conv-item active" : "conv-item";
      return \`
        <div class="\${cls}" data-id="\${id}">
          <div class="avatar">\${initials(name)}</div>
          <div class="conv-meta">
            <div class="conv-row">
              <div class="conv-name">\${name}</div>
               <span class="conv-status">\${status}</span>\${deliveredMark}
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

        function buildMediaNode(m){
      const md = m && m.media;
      if (!md || !md.url) return null;

      const url = api(md.url);
      const kind = String(md.kind || "").toLowerCase();
      const mime = String(md.mime || "").toLowerCase();
      const filename = String(md.filename || "archivo").trim() || "archivo";
      const fnameLower = filename.toLowerCase();

      const isImage = (kind === "image") || mime.startsWith("image/");
      const isAudio = (kind === "audio") || mime.startsWith("audio/");
      const isVideo = (kind === "video") || mime.startsWith("video/");
      const isPdf = (kind === "pdf") || mime.includes("pdf") || fnameLower.endsWith(".pdf");

      const wrap = document.createElement("div");
      wrap.style.marginTop = "6px";

      // helper: download link
      const dlUrl = url + (url.includes("?") ? "&" : "?") + "download=1";

      const links = document.createElement("div");
      links.style.display = "flex";
      links.style.gap = "10px";
      links.style.marginTop = "4px";
      links.style.alignItems = "center";

      const open = document.createElement("a");
      open.href = url;
      open.textContent = "Abrir";
      open.target = "_blank";
      open.rel = "noopener";
      open.style.fontSize = "11px";
      open.style.color = "rgba(255,255,255,.82)";
      open.style.textDecoration = "underline";

      const dl = document.createElement("a");
      dl.href = dlUrl;
      dl.textContent = "Descargar";
      dl.style.fontSize = "11px";
      dl.style.color = "rgba(255,255,255,.82)";
      dl.style.textDecoration = "underline";

      if (isImage) {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";

        const img = document.createElement("img");
        img.src = url;
        img.alt = filename;
        img.loading = "lazy";
        img.style.maxWidth = "280px";
        img.style.borderRadius = "10px";
        img.style.display = "block";

        a.appendChild(img);
        wrap.appendChild(a);

        links.appendChild(dl);
        wrap.appendChild(links);
        return wrap;
      }

      if (isAudio) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = url;
        audio.style.maxWidth = "320px";
        audio.style.display = "block";
        wrap.appendChild(audio);

        links.appendChild(open);
        links.appendChild(dl);
        wrap.appendChild(links);
        return wrap;
      }

      if (isVideo) {
        const video = document.createElement("video");
        video.controls = true;
        video.src = url;
        video.style.maxWidth = "320px";
        video.style.borderRadius = "10px";
        video.style.display = "block";
        wrap.appendChild(video);

        links.appendChild(open);
        links.appendChild(dl);
        wrap.appendChild(links);
        return wrap;
      }

      if (isPdf) {
        const frame = document.createElement("iframe");
        frame.src = url;
        frame.style.width = "320px";
        frame.style.maxWidth = "100%";
        frame.style.height = "380px";
        frame.style.border = "0";
        frame.style.borderRadius = "10px";
        frame.style.display = "block";
        wrap.appendChild(frame);

        links.appendChild(open);
        links.appendChild(dl);
        wrap.appendChild(links);
        return wrap;
      }

      // documentos u otros
      const a = document.createElement("a");
      a.href = dlUrl;
      a.textContent = filename ? ("📎 " + filename) : "📎 Archivo";
      a.style.color = "rgba(255,255,255,.92)";
      a.style.textDecoration = "underline";
      a.style.fontSize = "13px";
      wrap.appendChild(a);

      links.appendChild(open);
      links.appendChild(dl);
      wrap.appendChild(links);
      return wrap;
    }


    msgs.forEach(m => {
      const row = document.createElement("div");
      row.className = "msg-row";
      row.style.alignItems = (m.role === "user") ? "flex-start" : "flex-end";

      const bubble = document.createElement("div");
      bubble.className = "msg " + ((m.role === "user") ? "them" : "me");

      // texto del mensaje (si existe)
      const txt = document.createElement("div");
      txt.textContent = String(m.content || "");
      bubble.appendChild(txt);

      // media preview (si existe)
      const mediaNode = buildMediaNode(m);
      if (mediaNode) bubble.appendChild(mediaNode);

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
       const ch = (meta.displayPhoneNumber || meta.phoneNumberId || meta.instagramPageId || meta.instagramAccountId || "");
       const channelLabel = String(meta.channelType || 'whatsapp').toLowerCase() === 'instagram' ? 'Instagram' : 'WhatsApp';
       chatSub.textContent = meta.waId
         ? (channelLabel + ': ' + meta.waId + (ch ? (' · Canal: ' + ch) : ''))
         : "";
      activeStatusLabel = meta.status || "";
      syncManualUi(!!meta.manualOpen);
      if (deliveredToggle) deliveredToggle.checked = !!meta.delivered;

      const msgs = await loadMessages(convId);
      renderMessages(msgs);
    }catch(e){
      chatBody.innerHTML = '<div class="empty">No se pudo cargar la conversación.</div>';
    }
  }

  // Toggle pausa bot / modo humano
  if (manualToggle) {
    manualToggle.addEventListener("change", async () => {
      if (!activeConvId) return;
      try{
        const r = await fetch(api("/api/admin/conversation-manual"), {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ convId: activeConvId, manualOpen: manualToggle.checked })
        });
        const j = await r.json().catch(() => null);
        syncManualUi(j && typeof j.manualOpen === "boolean" ? j.manualOpen : manualToggle.checked);
        // refrescamos lista para que refleje pill BOT/BOT PAUSADO
        await refreshConversations();
      }catch{}
    });
  }


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

    const conv = result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")
      ? result.value
      : result;
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


// ---------- Marcar conversación como enviada a cocina / pendiente de cocina ----------
app.post("/api/admin/conversation-kitchen", async (req, res) => {
  try {
    const { convId, waId, kitchenSent } = req.body || {};
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
    const flag = !!kitchenSent;
    const update = flag
      ? { $set: { kitchenSent: true, kitchenAt: now, updatedAt: now } }
      : { $set: { kitchenSent: false, updatedAt: now }, $unset: { kitchenAt: "" } };

    const result = await db.collection("conversations").findOneAndUpdate(
      filter,
      update,
      { returnDocument: "after" }
    );

    const conv = result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")
      ? result.value
      : result;
    if (!conv) {
      return res.status(404).json({ error: "conv_not_found" });
    }

    res.json({
      ok: true,
      convId: String(conv._id),
      kitchenSent: !!conv.kitchenSent,
      kitchenAt: conv.kitchenAt || null,
    });
  } catch (e) {
    console.error("POST /api/admin/conversation-kitchen error:", e);
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

    const conv = result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")
      ? result.value
      : result;
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
    const channelType = String(conv.channelType || "whatsapp").trim().toLowerCase() || "whatsapp";
    let rt = null;
    try {
      if (channelType === "instagram") {
        rt = await getRuntimeByInstagramAccountId(conv.instagramAccountId || conv.instagramPageId || null);
      } else {
        const convPhoneNumberId = conv.phoneNumberId || null;
        if (convPhoneNumberId) {
          rt = await getRuntimeByPhoneNumberId(convPhoneNumberId);
        }
        if (!rt && conv.displayPhoneNumber) {
          rt = await getRuntimeByWwebPhone(tenant, conv.displayPhoneNumber);
        }
      }
    } catch {}

    const channelOpts = {
      channelType,
      whatsappToken: rt?.whatsappToken || null,
      phoneNumberId: rt?.phoneNumberId || conv.phoneNumberId || null,
      instagramAccountId: rt?.instagramAccountId || conv.instagramAccountId || null,
      instagramPageId: rt?.instagramPageId || conv.instagramPageId || null,
      instagramAccessToken: rt?.instagramAccessToken || null,
    };



    const now = new Date();

    if (isWwebConversation(conv, rt)) {
      const numeroWweb = getWwebNumeroForConversation(conv, rt);
      if (!numeroWweb) {
        return res.status(400).json({ error: "wweb_numero_missing" });
      }
      await db.collection("wa_wweb_actions").insertOne({
        lockId: wwebLockId(tenant, numeroWweb),
        tenantId: tenant,
        numero: numeroWweb,
        action: "send_message",
        to,
        text: body,
        payload: { convId: String(conv._id), to, text: body },
        requestedBy: req.user?.username || req.user?.uid || "admin",
        requestedAt: now,
        at: now,
      });
    } else {
      await require("./logic").sendChannelMessage(to, body, channelOpts);
    }



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

    // Actualizar timestamps y, si correspondiera, pasar de
    // "pendiente de informar importe" a "pendiente de comprobante".
    const convUpdate = {
      $set: { lastAssistantTs: now, updatedAt: now }
    };

    if (
      normalizeTransferFlowStatus(conv?.transferFlowStatus || "") === "PENDIENTE_IMPORTE_TRANSFERENCIA" &&
      manualTextLooksLikeAmountNotice(body)
    ) {
      convUpdate.$set.transferFlowStatus = "PENDIENTE_COMPROBANTE_TRANSFERENCIA";
      convUpdate.$set.status = "PENDIENTE";
      convUpdate.$set.pedidoEstado = "PENDIENTE";
    }

   await db.collection("conversations").updateOne(
      { _id: conv._id },
      convUpdate
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
    :root{
      --bg:#f3f7fc;
      --card:#ffffff;
      --card-soft:#f8fbff;
      --line:#dbe5f0;
      --line-strong:#c7d4e2;
      --text:#0f172a;
      --muted:#5b6472;
      --primary:#0f3b68;
      --primary-2:#164e86;
      --shadow:0 10px 28px rgba(15, 23, 42, .08);
      --radius:18px;
    }
    *{box-sizing:border-box}
    html,body{margin:0;padding:0}
    body{
      font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
      background:var(--bg);
      color:var(--text);
      padding:16px 18px 24px;
    }
    .page-shell{display:flex;flex-direction:column;gap:16px}
    .page-header{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:12px;
      padding:4px 2px 0;
    }
    .eyebrow{
      display:inline-flex;
      align-items:center;
      gap:6px;
      font-size:12px;
      font-weight:700;
      color:var(--primary-2);
      text-transform:uppercase;
      letter-spacing:.08em;
      margin-bottom:6px;
    }
    .eyebrow::before{
      content:"";
      width:8px;height:8px;border-radius:999px;background:#22c55e;
      box-shadow:0 0 0 4px rgba(34,197,94,.14);
    }
    .page-header h2{margin:0;font-size:28px;line-height:1.1}
    .subtitle{margin:6px 0 0;color:var(--muted);font-size:14px}
    .live-indicator{
      display:inline-flex;align-items:center;gap:8px;
      background:#fff;border:1px solid var(--line);border-radius:999px;
      padding:8px 12px;font-size:13px;color:#334155;box-shadow:var(--shadow);
      white-space:nowrap;
    }
    .live-indicator .dot{
      width:8px;height:8px;border-radius:999px;background:#22c55e;
      box-shadow:0 0 0 4px rgba(34,197,94,.16);
    }
    .toolbar-card,.table-card,.stat-card{
      background:var(--card);
      border:1px solid var(--line);
      border-radius:var(--radius);
      box-shadow:var(--shadow);
    }
    .toolbar-card{padding:10px 12px}
    .toolbar{display:flex;gap:10px;align-items:flex-end;justify-content:flex-start;flex-wrap:wrap}
    .field{display:flex;flex-direction:column;gap:4px;min-width:150px}
    .field.grow{flex:1 1 300px}
    .field label{font-size:11px;font-weight:700;color:#334155}
    .field input,.field select,#modalReplyText{
      width:100%;
      font-size:13px;
      padding:8px 10px;
      border:1px solid var(--line-strong);
      border-radius:12px;
      background:#fff;
      color:var(--text);
      outline:none;
      transition:border-color .16s ease, box-shadow .16s ease, background .16s ease;
    }
    .field input:focus,.field select:focus,#modalReplyText:focus{
      border-color:#8fb7df;
      box-shadow:0 0 0 4px rgba(59,130,246,.12);
    }
    .field.field-filter{position:relative}
    .field input[type="hidden"]{display:none}
    .filter-trigger{
      width:100%;
      font-size:13px;
      padding:8px 10px;
      border:1px solid var(--line-strong);
      border-radius:12px;
      background:#fff;
      color:var(--text);
      outline:none;
      transition:border-color .16s ease, box-shadow .16s ease, background .16s ease;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      min-height:35px;
      cursor:pointer;
      text-align:left;
      box-shadow:none;
      font-weight:400;
    }
    .filter-trigger:hover{background:#f8fafc}
    .filter-trigger:focus{
      border-color:#8fb7df;
      box-shadow:0 0 0 4px rgba(59,130,246,.12);
    }
    .filter-trigger .caret{font-size:10px;color:#64748b;flex:0 0 auto}
    .filter-trigger .filter-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .filter-popover{
      position:absolute;
      top:calc(100% + 6px);
      left:0;
      min-width:220px;
      width:max-content;
      max-width:280px;
      padding:10px;
      border:1px solid var(--line-strong);
      border-radius:14px;
      background:#fff;
      box-shadow:0 18px 40px rgba(15,23,42,.16);
      z-index:40;
    }
    .filter-popover[hidden]{display:none}
    .filter-popover-title{font-size:12px;font-weight:800;color:#0f172a;margin:0 0 8px}
    .filter-option{display:grid;grid-template-columns:16px minmax(0,1fr);align-items:start;justify-content:flex-start;column-gap:8px;row-gap:0;width:100%;padding:6px 2px;font-size:13px;color:#0f172a;cursor:pointer;text-align:left}
    .filter-option span{display:block;min-width:0;text-align:left;line-height:1.25;white-space:normal;word-break:break-word}
    .filter-option input[type="checkbox"]{width:16px !important;min-width:16px;max-width:16px;height:16px;margin:1px 0 0;padding:0;border:none;box-shadow:none;background:transparent;accent-color:var(--primary-2);appearance:auto;flex:none;justify-self:start;align-self:start}
    .filter-popover-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #e5e7eb}
    .btn.btn-mini{padding:7px 10px;font-size:11px;border-radius:10px}
    .toolbar-actions{display:flex;gap:6px;align-items:center;justify-content:flex-start;flex-wrap:wrap}
    .btn{
      appearance:none;
      border:1px solid var(--line-strong);
      background:#fff;
      color:#0f172a;
      border-radius:10px;
      padding:8px 12px;
      font-size:12px;
      font-weight:700;
      cursor:pointer;
      transition:transform .12s ease, box-shadow .16s ease, background .16s ease, border-color .16s ease;
      box-shadow:0 4px 12px rgba(15,23,42,.04);
    }
    .btn:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(15,23,42,.08)}
    .btn-primary{background:var(--primary);border-color:var(--primary);color:#fff}
    .btn-primary:hover{background:var(--primary-2);border-color:var(--primary-2)}
    .btn-soft{background:#eff6ff;border-color:#cfe0f2;color:var(--primary-2)}
    .btn-icon{padding:10px 11px;min-width:42px;text-align:center}
    .muted{color:var(--muted)}

    .table-card{padding:10px 12px}
    .table-toolbar{
      display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;
      margin-bottom:8px;
    }
    .table-toolbar h3{margin:0;font-size:16px}
    .table-toolbar p{margin:0;color:var(--muted);font-size:12px}
    .table-wrap{
      overflow:auto;
      border:1px solid var(--line);
      border-radius:16px;
      background:#fff;
    }
    .adminTable{border-collapse:separate;border-spacing:0;width:100%;min-width:0;table-layout:auto}
    .adminTable th,
    .adminTable td{padding:8px 5px;font-size:12px;vertical-align:top;word-break:break-word;border-bottom:1px solid #edf2f7}
    .adminTable th{
      position:sticky;top:0;z-index:2;
      background:#f8fbff;
      color:#475569;
      text-align:left;
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.04em;
      white-space:nowrap;
    }
    .adminTable tbody tr{background:#fff;transition:background .14s ease}
    .adminTable tbody tr:nth-child(even){background:#fcfdff}
    .adminTable tbody tr:hover{background:#f6fbff}
    .adminTable td{color:#1f2937;overflow:hidden;text-overflow:ellipsis}
    .adminTable td[data-label="Acciones"]{overflow:visible;text-overflow:clip}
    .adminTable td[data-label="Distancia"],
    .adminTable td[data-label="Día"],
    .adminTable td[data-label="Hora"],
    .adminTable td[data-label="Estado"],
    .adminTable th:nth-child(6),
    .adminTable th:nth-child(7),
    .adminTable th:nth-child(8),
    .adminTable th:nth-child(9){padding-left:6px;padding-right:6px;white-space:nowrap;font-size:11px}
    .cell-strong{font-weight:700;color:#0f172a}
    .cell-subtle{display:block;margin-top:2px;color:#64748b;font-size:11px}
    .cell-ellipsis{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cell-products{display:block;white-space:normal;overflow:visible;text-overflow:clip;line-height:1.32;word-break:break-word;overflow-wrap:anywhere}
    .cell-products > div + div{margin-top:2px}
    .cell-address{display:block;white-space:normal;overflow:visible;text-overflow:clip;line-height:1.32;word-break:break-word;overflow-wrap:anywhere}
    .delivery-pill{
      display:inline-flex;align-items:center;gap:5px;
      padding:4px 9px;border-radius:999px;
      background:#f8fafc;border:1px solid #dbe5f0;font-size:11px;font-weight:700;color:#334155;
    }
    .delivery-pill.is-envio{background:#eef6ff;border-color:#cfe0f2;color:#164e86}
    .delivery-pill.is-retiro{background:#f8fafc;border-color:#dbe5f0;color:#475569}
    .distance-badge{
      display:inline-flex;align-items:center;justify-content:center;
      min-width:40px;padding:4px 6px;border-radius:999px;background:#f8fafc;border:1px solid #dbe5f0;font-weight:700;color:#334155;font-size:11px;
    }
    .actions{display:flex;gap:4px;align-items:center;justify-content:flex-start;flex-wrap:nowrap;width:100%}
    .actions .btn{padding:0;border-radius:10px;min-width:30px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1}
    .actions .btn-detail{font-size:14px}
    .actions .btn-soft{background:#f8fafc;color:#334155;border-color:#dbe5f0}
    .actions .btn-icon{padding:0;min-width:30px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1}
    .c-actividad{width:72px}
    .c-telefono{width:84px}
    .c-nombre{width:92px}
    .c-productos{width:320px}
    .c-entrega{width:66px}
    .c-direccion{width:180px}
    .c-dist{width:52px}
    .c-dia{width:64px}
    .c-hora{width:54px}
    .c-estado{width:86px}
    .c-ent{width:34px}
    .c-acciones{width:96px}
    .delivered-row{opacity:.72}
    .kitchen-row{background:rgba(255,243,205,.45)}
    .delivChk{cursor:pointer;width:16px;height:16px;accent-color:#22c55e}

    .stats-panel{padding:10px 12px}
    .stats-panel.is-collapsed .stats-body{display:none}
    .stats-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}
    .stats-title{font-size:15px;font-weight:800;color:#0f172a}
    .stats-subtitle{margin:2px 0 0;color:var(--muted);font-size:12px}
    .stats-refresh{font-size:11px;white-space:nowrap}
    .stats-body{margin-top:10px;display:flex;flex-direction:column;gap:10px}
    .stats-grid{display:grid;grid-template-columns:repeat(5,minmax(110px,1fr));gap:8px}
    .kpi{
      border:1px solid var(--line);
      background:linear-gradient(180deg,#fff 0%,#f8fbff 100%);
      border-radius:14px;
      padding:10px 10px 8px;
      min-height:78px;
    }
    .kpi-value{font-size:24px;line-height:1;font-weight:800;color:#0f172a}
    .kpi-label{margin-top:4px;font-size:11px;font-weight:700;color:#475467;text-transform:uppercase;letter-spacing:.04em}
    .kpi-meta{margin-top:4px;font-size:11px;color:#64748b;line-height:1.25}
    .stats-charts{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .chart-card{
      border:1px solid var(--line);
      background:#fff;
      border-radius:14px;
      padding:10px;
    }
    .chart-title{font-size:12px;font-weight:800;color:#0f172a;margin-bottom:8px}
    .bar-list{display:flex;flex-direction:column;gap:8px}
    .bar-row{display:grid;grid-template-columns:minmax(74px,auto) 1fr auto;gap:8px;align-items:center}
    .bar-label,.top-item-label{font-size:11px;color:#475467;font-weight:700}
    .bar-track{
      position:relative;height:8px;border-radius:999px;background:#edf2f7;overflow:hidden;
    }
    .bar-fill{
      position:absolute;left:0;top:0;bottom:0;border-radius:999px;
      background:linear-gradient(90deg,#164e86 0%,#3b82f6 100%);
    }
    .bar-value,.top-item-value{font-size:11px;font-weight:800;color:#0f172a}
    .top-list{display:flex;flex-direction:column;gap:8px}
    .top-list.is-scrollable{max-height:240px;overflow-y:auto;padding-right:4px}
    .top-item{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start}
    .top-item + .top-item{padding-top:8px;border-top:1px dashed #e5edf6}

    .status-badge{
      display:inline-block;
      padding:4px 8px;
      border-radius:999px;
      font-size:10px;
      font-weight:800;
      letter-spacing:.02em;
      border:1px solid transparent;
      line-height:1.2;
      white-space:nowrap;
    }
    .st-open{background:#eef2ff;color:#1e3a8a;border-color:#c7d2fe}
    .st-progress{background:#fff7ed;color:#9a3412;border-color:#fed7aa}
    .st-completed{background:#ecfdf5;color:#065f46;border-color:#a7f3d0}
    .st-cancelled{background:#fef2f2;color:#991b1b;border-color:#fecaca}

    .modal-backdrop{position:fixed;inset:0;background:rgba(2,6,23,.42);display:none;align-items:center;justify-content:center;z-index:1000;padding:16px}
    .modal{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 24px 60px rgba(15,23,42,.22);width:min(960px,95vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
    .modal header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #eef2f7;margin:0}
    .modal header h3{margin:0;font-size:18px}
    .modal .body{padding:14px 16px;overflow:auto;background:#fbfdff}
    .chip{display:inline-flex;align-items:center;gap:8px}
    .iconbtn{border:none;background:#f8fafc;cursor:pointer;font-size:16px;width:36px;height:36px;border-radius:10px;border:1px solid #dbe5f0}
    .msg{border:1px solid #e7eef6;border-radius:14px;padding:10px 12px;margin-bottom:8px;background:#fff}
    .role-user{background:#f0fafc}
    .role-assistant{background:#f8f6ff}
    small{color:#64748b}
    pre{white-space:pre-wrap;margin:6px 0 0;font-family:inherit}
    .badge{padding:5px 10px;border-radius:999px;font-size:12px;font-weight:700}
    .badge-bot{background:#e3f7e3;color:#145214}
    .badge-manual{background:#ffe4e1;color:#8b0000}
    .modal-meta-row{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
    #modalChatBox{margin-top:14px;border-top:1px solid #eef2f7;padding-top:12px;display:flex;flex-direction:column;gap:8px}
    #modalReplyText{min-height:88px;font-family:inherit}
    .chat-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}

    .ticket-modal-backdrop {position: fixed;inset: 0;background: rgba(0,0,0,.45);display: none;align-items: center;justify-content: center;z-index: 1000;}
    .ticket-modal {background: #fff;border-radius: 12px;padding: 12px;box-shadow: 0 10px 30px rgba(0,0,0,.25);width: 90mm;max-height: 90vh;display: flex;flex-direction: column;overflow: auto;gap: 8px;}
    .ticket-modal iframe {border: none;width: 100%;flex: 1;}
    .ticket-modal-actions {display: flex;justify-content: flex-end;gap: 8px;margin-top: 6px;}

    @media (max-width: 1180px){
      .stats-grid{grid-template-columns:repeat(3,minmax(120px,1fr))}
      .stats-charts{grid-template-columns:1fr}
    }
    @media (max-width: 1080px){
      .page-header{flex-direction:column}
    }
    @media (max-width: 720px){
      body{padding:10px}
      .toolbar{align-items:stretch}
      .field{min-width:100%}
      .toolbar-actions{width:100%}
      .toolbar-actions .btn{flex:1 1 auto;justify-content:center}
      .stats-grid{grid-template-columns:repeat(2,minmax(120px,1fr))}
      .stats-panel,.table-card,.toolbar-card{padding:10px}
      .table-card{padding:10px}
      .table-wrap{border:none;background:transparent;overflow:visible}
      .adminTable colgroup,.adminTable thead{display:none}
      .adminTable,.adminTable tbody,.adminTable tr,.adminTable td{display:block;width:100%}
      .adminTable{min-width:0;border:0}
      .adminTable tr{border:1px solid var(--line);border-radius:16px;padding:10px 12px;margin:10px 0;background:#fff;box-shadow:0 8px 20px rgba(15,23,42,.05)}
      .adminTable td{border:none;padding:6px 0;overflow:visible;text-overflow:unset;display:flex;gap:10px;justify-content:space-between;align-items:flex-start}
      .adminTable td::before{content: attr(data-label);font-weight:700;color:#475467;min-width:42%;max-width:42%}
      .adminTable td[data-label="Acciones"]{display:block;padding-top:10px}
      .adminTable td[data-label="Acciones"]::before{display:none}
      .adminTable td[data-label="Acciones"] .actions{flex-wrap:wrap;white-space:normal;gap:8px}
    }
  </style>
</head>
<body>
  <div class="page-shell">
   
    
    <section class="stat-card stats-panel" id="statsPanel">
      <div class="stats-head">
        <div>
          <div class="stats-title">Resumen del movimiento</div>
          <p class="stats-subtitle" id="statsHint">Estados visibles sobre lo filtrado · pendientes y entrega sobre el total cargado.</p>
        </div>
        <div class="toolbar-actions">
          <span class="muted stats-refresh">Refresco automático cada 1 minuto</span>
          <button class="btn btn-soft" id="btnToggleStats">Ocultar resumen</button>
        </div>
      </div>
      <div class="stats-body" id="statsBody">
        <div class="stats-grid" id="statsGrid">
          <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Pendientes</div><div class="kpi-meta">Total cargado</div></div>
          <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Pollos</div><div class="kpi-meta">Pendientes totales</div></div>
          <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Papas</div><div class="kpi-meta">Pendientes totales</div></div>
          <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">A enviar</div><div class="kpi-meta">Pendientes totales</div></div>
          <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">A retirar</div><div class="kpi-meta">Pendientes totales</div></div>
        </div>
        <div class="stats-charts">
          <div class="chart-card">
            <div class="chart-title">Estados visibles</div>
            <div class="bar-list" id="statusBars"></div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Entrega pendiente</div>
            <div class="bar-list" id="deliveryBars"></div>
          </div>
        </div>
      </div>
    </section>

<section class="toolbar-card">
      <div class="toolbar">
        <div class="field grow">
          <label for="qFilter">Buscar</label>
          <input id="qFilter" placeholder="waId, nombre, dirección o producto"/>
        </div>
        <div class="field field-filter">
          <label for="delivFilter">Entrega</label>
          <input id="delivFilter" type="hidden" value="pending"/>
          <button type="button" class="filter-trigger" id="delivFilterBtn" aria-haspopup="true" aria-expanded="false">
            <span class="filter-text">No entregadas</span><span class="caret">▾</span>
          </button>
          <div class="filter-popover" id="delivFilterPopover" hidden>
            <div class="filter-popover-title">Entrega</div>
            <label class="filter-option"><input type="checkbox" value="pending" checked /> <span>No entregadas</span></label>
            <label class="filter-option"><input type="checkbox" value="kitchen" /> <span>En cocina</span></label>
            <label class="filter-option"><input type="checkbox" value="delivered" /> <span>Entregadas</span></label>
            <div class="filter-popover-actions">
              <button type="button" class="btn btn-mini" data-filter-all="delivFilter">Todas</button>
              <button type="button" class="btn btn-mini btn-primary" data-filter-apply="delivFilter">Aplicar</button>
            </div>
          </div>
        </div>
        <div class="field field-filter">
         <label for="statusFilter">Estado</label>
          <input id="statusFilter" type="hidden" value="completed"/>
          <button type="button" class="filter-trigger" id="statusFilterBtn" aria-haspopup="true" aria-expanded="false">
            <span class="filter-text">Completadas</span><span class="caret">▾</span>
          </button>
          <div class="filter-popover" id="statusFilterPopover" hidden>
            <div class="filter-popover-title">Estado</div>
            <label class="filter-option"><input type="checkbox" value="completed" checked /> <span>Completadas</span></label>
            <label class="filter-option"><input type="checkbox" value="open" /> <span>Abiertas</span></label>
            <label class="filter-option"><input type="checkbox" value="cancelled" /> <span>Canceladas</span></label>
            <label class="filter-option"><input type="checkbox" value="pending_importe" /> <span>Pendiente de importe</span></label>
            <label class="filter-option"><input type="checkbox" value="pending_comprobante" /> <span>Pendiente de comprobante</span></label>

            <div class="filter-popover-actions">
              <button type="button" class="btn btn-mini" data-filter-all="statusFilter">Todas</button>
              <button type="button" class="btn btn-mini btn-primary" data-filter-apply="statusFilter">Aplicar</button>
            </div>
          </div>
        </div>
        <div class="field">
          <label for="dateFrom">Desde</label>
          <input id="dateFrom" type="date"/>
        </div>
        <div class="field">
          <label for="dateTo">Hasta</label>
          <input id="dateTo" type="date"/>
        </div>
        <div class="toolbar-actions">
          <button class="btn btn-soft" id="btnToday">Hoy</button>
          <button class="btn" id="btnClearDates">Limpiar fechas</button>
          <button class="btn btn-primary" id="btnReload">Actualizar</button>

        </div>
      </div>
    </section>

    <section class="table-card">
      <div class="table-toolbar">
        <div>
           <p id="tableHint">Cargando conversaciones…</p>
        </div>
      </div>
      <div class="table-wrap">
        <table id="tbl" class="adminTable">
          <colgroup>
            <col class="c-actividad"/>
            <col class="c-telefono"/>
            <col class="c-nombre"/>
            <col class="c-productos"/>
            <col class="c-entrega"/>
            <col class="c-direccion"/>
            <col class="c-dist"/>
            <col class="c-dia"/>
            <col class="c-hora"/>
            <col class="c-estado"/>
            <col class="c-coc"/>
            <col class="c-ent"/>
            <col class="c-acciones"/>
          </colgroup>
          <thead>
            <tr>
              <th>Actividad</th>
              <th>Teléfono</th>
              <th>Nombre</th>
              <th>Productos</th>
              <th>Entrega</th>
              <th>Dirección</th>
              <th>Distancia</th>
              <th>Día</th>
              <th>Hora</th>
              <th>Estado</th>
              <th>Coc.</th>
              <th>Ent.</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  </div>

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

  function statusLabelEs(raw, kitchenSent){
    if (kitchenSent) return 'EN COCINA';
    const st = normalizeStatus(raw);
    if (st === 'CANCELLED') return 'CANCELADA';
    if (st === 'COMPLETED') return 'COMPLETADA';
    if (st === 'IN_PROGRESS') return 'EN CURSO';
    if (st === 'OPEN') return 'ABIERTA';
    return String(raw || st || '').trim();
  }

  function statusClass(raw, kitchenSent){
    if (kitchenSent) return 'st-progress';
    const st = normalizeStatus(raw);
    if (st === 'CANCELLED') return 'st-cancelled';
    if (st === 'COMPLETED') return 'st-completed';
    if (st === 'IN_PROGRESS') return 'st-progress';
    return 'st-open';
  }

  function renderStatusBadge(raw, kitchenSent){
    const label = statusLabelEs(raw, kitchenSent);
    const cls = statusClass(raw, kitchenSent);
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

    function mediaHtml(m){
      const md = m && m.media;
      if (!md || !md.url) return '';
      const kind = String(md.kind || '').toLowerCase();
      const filename = escHtml(String(md.filename || 'archivo'));
      const url = escHtml(String(md.url || ''));
      const dl = url + (url.includes('?') ? '&' : '?') + 'download=1';

      if (kind === 'image') {
        return (
          '<div style="margin-top:6px">' +
            '<a href="'+url+'" target="_blank" rel="noopener">' +
              '<img src="'+url+'" alt="'+filename+'" style="max-width:320px;border-radius:10px;display:block"/>' +
            '</a>' +
            '<a href="'+dl+'" style="display:inline-block;margin-top:4px;font-size:11px;text-decoration:underline">Descargar</a>' +
          '</div>'
        );
      }
      if (kind === 'audio') {
        return (
          '<div style="margin-top:6px">' +
            '<audio controls src="'+url+'" style="max-width:340px;display:block"></audio>' +
            '<a href="'+dl+'" style="display:inline-block;margin-top:4px;font-size:11px;text-decoration:underline">Descargar</a>' +
          '</div>'
        );
      }
      if (kind === 'video') {
        return (
          '<div style="margin-top:6px">' +
            '<video controls src="'+url+'" style="max-width:340px;border-radius:10px;display:block"></video>' +
            '<a href="'+dl+'" style="display:inline-block;margin-top:4px;font-size:11px;text-decoration:underline">Descargar</a>' +
          '</div>'
        );
      }
      // documentos u otros
      return (
        '<div style="margin-top:6px">' +
          '<a href="'+dl+'" style="text-decoration:underline">📎 '+(filename || 'Archivo')+'</a>' +
        '</div>'
      );
    }

    target.innerHTML = list.map(m => (
      '<div class="msg role-'+escHtml(m.role)+'">'+
        '<small>['+new Date(m.createdAt).toLocaleString()+'] '+escHtml(m.role)+'</small>'+
        '<pre>'+escHtml(m.content||'')+'</pre>'+
        mediaHtml(m) +
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

  async function verifyKitchen(convId){
    try{
      const r = await fetch('/api/admin/conversation-meta?convId=' + encodeURIComponent(convId));
      if(!r.ok) return null;
      const j = await r.json();
      return !!j.kitchenSent;
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

  function formatActivity(raw){
    try {
      const d = new Date(raw);
      return {
        date: d.toLocaleDateString('es-AR'),
        time: d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      };
    } catch {
      return { date: '-', time: '' };
    }
  }

  function todayIso(){
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  const ADMIN_FILTERS_STORAGE_KEY = 'adminConversationsFilters.v1';

  function saveAdminFilterState(){
    try {
      const payload = {
        q: String(document.getElementById('qFilter')?.value || ''),
        deliv: String(document.getElementById('delivFilter')?.value || 'pending'),
        status: String(document.getElementById('statusFilter')?.value || 'completed'),
        from: String(document.getElementById('dateFrom')?.value || ''),
        to: String(document.getElementById('dateTo')?.value || '')
      };
      localStorage.setItem(ADMIN_FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch {}
  }

  function initAdminFilters(){
    const today = todayIso();
    const from = document.getElementById('dateFrom');
    const to = document.getElementById('dateTo');
    const q = document.getElementById('qFilter');
    const deliv = document.getElementById('delivFilter');
    const status = document.getElementById('statusFilter');

    let restored = false;
    try {
      const raw = localStorage.getItem(ADMIN_FILTERS_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) || {};
        if (q && typeof saved.q === 'string') q.value = saved.q;
        if (from && typeof saved.from === 'string') from.value = saved.from;
        if (to && typeof saved.to === 'string') to.value = saved.to;
        if (deliv) deliv.value = parseMultiFilterValue(saved.deliv, DELIVERY_FILTER_ALLOWED, ['pending']).join(',');
        if (status) status.value = parseMultiFilterValue(saved.status, STATUS_FILTER_ALLOWED, ['completed']).join(',');
        restored = true;
      }
    } catch {}

    if (!restored) {
      if (from && !from.value) from.value = today;
      if (to && !to.value) to.value = today;
      if (deliv && !String(deliv.value || '').trim()) deliv.value = 'pending';
      if (status && !String(status.value || '').trim()) status.value = 'completed';
    }
    refreshFilterButtonLabels();
  }

  function getTextFilterValue(){
    return String(document.getElementById('qFilter')?.value || '').trim().toLowerCase();
  }

  const DELIVERY_FILTER_ALLOWED = ['pending', 'kitchen', 'delivered'];
  const STATUS_FILTER_ALLOWED = ['completed', 'open', 'cancelled', 'pending_importe', 'pending_comprobante'];
  const DELIVERY_FILTER_LABELS = { pending: 'No entregadas', kitchen: 'En cocina', delivered: 'Entregadas' };
  const STATUS_FILTER_LABELS = {
    completed: 'Completadas',
    open: 'Abiertas',
    cancelled: 'Canceladas',
    pending_importe: 'Pendiente de importe',
    pending_comprobante: 'Pendiente de comprobante'
  };

  function parseMultiFilterValue(raw, allowed, fallback){
    const allowedSet = new Set(Array.isArray(allowed) ? allowed : []);
    const values = String(raw || '')
      .split(',')
      .map(v => String(v || '').trim())
      .filter(v => allowedSet.has(v));
    const ordered = (Array.isArray(allowed) ? allowed : []).filter(v => values.includes(v));
    if (ordered.length) return ordered;
    return Array.isArray(fallback) ? fallback.slice() : [];
  }

  function getDeliveryFilterValue(){
    return parseMultiFilterValue(document.getElementById('delivFilter')?.value, DELIVERY_FILTER_ALLOWED, ['pending']);
  }

  function getStatusFilterValue(){
    return parseMultiFilterValue(document.getElementById('statusFilter')?.value, STATUS_FILTER_ALLOWED, ['completed']);
  }

  function formatMultiFilterLabel(selected, labels, allowed, allLabel){
    const ordered = (Array.isArray(allowed) ? allowed : []).filter(v => (Array.isArray(selected) ? selected : []).includes(v));
    if (!ordered.length || ordered.length === (Array.isArray(allowed) ? allowed.length : 0)) return allLabel;
    if (ordered.length === 1) return labels[ordered[0]] || ordered[0];
    if (ordered.length === 2) return (labels[ordered[0]] || ordered[0]) + ' + ' + (labels[ordered[1]] || ordered[1]);
    return ordered.length + ' seleccionados';
  }

  function refreshFilterButtonLabels(){
    const delivBtnTxt = document.querySelector('#delivFilterBtn .filter-text');
    if (delivBtnTxt) delivBtnTxt.textContent = formatMultiFilterLabel(getDeliveryFilterValue(), DELIVERY_FILTER_LABELS, DELIVERY_FILTER_ALLOWED, 'Todas');
    const statusBtnTxt = document.querySelector('#statusFilterBtn .filter-text');
    if (statusBtnTxt) statusBtnTxt.textContent = formatMultiFilterLabel(getStatusFilterValue(), STATUS_FILTER_LABELS, STATUS_FILTER_ALLOWED, 'Todos');
  }

  function syncPopoverChecks(hiddenId){
    const hidden = document.getElementById(hiddenId);
    const pop = document.getElementById(hiddenId + 'Popover');
    if (!hidden || !pop) return;
    const allowed = hiddenId === 'delivFilter' ? DELIVERY_FILTER_ALLOWED : STATUS_FILTER_ALLOWED;
    const fallback = hiddenId === 'delivFilter' ? ['pending'] : ['completed'];
    const selected = parseMultiFilterValue(hidden.value, allowed, fallback);
    pop.querySelectorAll('input[type="checkbox"]').forEach(chk => { chk.checked = selected.includes(chk.value); });
  }

  function setHiddenMultiValue(hiddenId, values){
    const hidden = document.getElementById(hiddenId);
    if (!hidden) return;
    const allowed = hiddenId === 'delivFilter' ? DELIVERY_FILTER_ALLOWED : STATUS_FILTER_ALLOWED;
    const fallback = hiddenId === 'delivFilter' ? ['pending'] : ['completed'];
    const ordered = parseMultiFilterValue((Array.isArray(values) ? values : []).join(','), allowed, fallback);
    hidden.value = ordered.join(',');
    refreshFilterButtonLabels();
    saveAdminFilterState();
  }

  function closeAllFilterPopovers(){
    ['delivFilter', 'statusFilter'].forEach(id => {
      const pop = document.getElementById(id + 'Popover');
      const btn = document.getElementById(id + 'Btn');
      if (pop) pop.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }

  function openFilterPopover(hiddenId){
    const pop = document.getElementById(hiddenId + 'Popover');
    const btn = document.getElementById(hiddenId + 'Btn');
    if (!pop || !btn) return;
    const willOpen = pop.hidden;
    closeAllFilterPopovers();
    if (!willOpen) return;
    syncPopoverChecks(hiddenId);
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  function initAdminFilterPopovers(){
    ['delivFilter', 'statusFilter'].forEach(hiddenId => {
      const btn = document.getElementById(hiddenId + 'Btn');
      const pop = document.getElementById(hiddenId + 'Popover');
      if (!btn || !pop) return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFilterPopover(hiddenId);
      });
      pop.addEventListener('click', (e) => e.stopPropagation());
    });

    document.querySelectorAll('[data-filter-all]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const hiddenId = btn.getAttribute('data-filter-all');
        const allowed = hiddenId === 'delivFilter' ? DELIVERY_FILTER_ALLOWED : STATUS_FILTER_ALLOWED;
        setHiddenMultiValue(hiddenId, allowed);
        syncPopoverChecks(hiddenId);
      });
    });

    document.querySelectorAll('[data-filter-apply]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const hiddenId = btn.getAttribute('data-filter-apply');
        const pop = document.getElementById(hiddenId + 'Popover');
        if (!pop) return;
        const checked = Array.from(pop.querySelectorAll('input[type="checkbox"]:checked')).map(chk => chk.value);
        const fallback = hiddenId === 'delivFilter' ? ['pending'] : ['completed'];
        setHiddenMultiValue(hiddenId, checked.length ? checked : fallback);
        closeAllFilterPopovers();
        loadTable();
      });
    });

    document.addEventListener('click', () => closeAllFilterPopovers());
    refreshFilterButtonLabels();
  }

  function getDateRangeValue(){
    return {
      from: String(document.getElementById('dateFrom')?.value || '').trim(),
      to: String(document.getElementById('dateTo')?.value || '').trim()
    };
  }

  function convMatchesText(c, textFilter){
   if (!textFilter) return true;
    const productLines = Array.isArray(c?.products) ? c.products.join(' ') : '';
    const haystack = [
      c.waId,
      c.contactName,
      c.direccion,
      c.entregaLabel,
      c.fechaEntrega,
      c.horaEntrega,
      productLines
    ].map(v => String(v || '').toLowerCase()).join(' ');
    return haystack.includes(textFilter);
  }

  function getConversationStatusTags(c){
    const st = normalizeStatus(c?.status);
    const raw = String(c?.status || '').trim().toUpperCase();
    const tags = [];
    if (st === 'COMPLETED') tags.push('completed');
    if (st === 'OPEN' || st === 'IN_PROGRESS') tags.push('open');
    if (st === 'CANCELLED') tags.push('cancelled');
    if (raw === 'PENDIENTE IMPORTE') tags.push('pending_importe');
    if (raw === 'PENDIENTE COMPROBANTE') tags.push('pending_comprobante');
    return tags;
  }

  function convMatchesStatus(c, statusFilter){
    const selected = Array.isArray(statusFilter) ? statusFilter : getStatusFilterValue();
    if (!selected.length || selected.length === STATUS_FILTER_ALLOWED.length) return true;
    const tags = getConversationStatusTags(c);
    return selected.some(tag => tags.includes(tag));
  }

  function convMatchesDelivered(c, deliveryFilter){
    const selected = Array.isArray(deliveryFilter) ? deliveryFilter : getDeliveryFilterValue();
    if (!selected.length || selected.length === DELIVERY_FILTER_ALLOWED.length) return true;
    const delivered = !!c?.delivered;
    const kitchen = !!c?.kitchenSent && !delivered;
    const pending = !delivered && !kitchen;
    return (pending && selected.includes('pending')) ||
           (kitchen && selected.includes('kitchen')) ||
           (delivered && selected.includes('delivered'));
  }

 function convDateKey(c){
    const raw = String(c?.fechaEntrega || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const m = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    const last = c?.lastAt ? new Date(c.lastAt) : null;
    if (last && Number.isFinite(last.getTime())) {
      const yyyy = last.getFullYear();
      const mm = String(last.getMonth() + 1).padStart(2, '0');
      const dd = String(last.getDate()).padStart(2, '0');
      return yyyy + '-' + mm + '-' + dd;
    }
    return '';
  }

 function convMatchesDateRange(c, from, to){
    const fecha = convDateKey(c);
    if (!from && !to) return true;
    if (!fecha) return false;
    if (from && fecha < from) return false;
    if (to && fecha > to) return false;
    return true;
  }

  function convDateTimeSortValue(c){
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(c?.fechaEntrega || '').trim()) ? String(c.fechaEntrega).trim() : '';
    const hora = /^\d{2}:\d{2}$/.test(String(c?.horaEntrega || '').trim()) ? String(c.horaEntrega).trim() : '23:59';
    if (fecha) {
      const ms = Date.parse(fecha + 'T' + hora + ':00-03:00');
      if (Number.isFinite(ms)) return ms;
    }
    const fallback = Date.parse(c?.lastAt || '');
    return Number.isFinite(fallback) ? fallback : 0;
  }

  function statusPriorityForAdmin(raw, statusFilter, kitchenSent){
    const tags = [];
    const st = normalizeStatus(raw);
    if (kitchenSent) tags.push('kitchen');
    if (st === 'COMPLETED') tags.push('completed');
    if (st === 'OPEN') tags.push('open');
    if (st === 'IN_PROGRESS') tags.push('in_progress');
    if (st === 'CANCELLED') tags.push('cancelled');
    const preferred = ['kitchen', 'completed', 'open', 'in_progress', 'cancelled'];
    const selected = Array.isArray(statusFilter) && statusFilter.length
      ? preferred.filter(v => statusFilter.includes(v))
      : preferred;
    for (let i = 0; i < selected.length; i++) {
      if (tags.includes(selected[i])) return i;
    }
    return preferred.length + 1;
  }

  function entregaPriorityForAdmin(row){
    const mode = getEntregaMode(row);
    if (mode === 'retiro') return 0;
    if (mode === 'envio') return 1;
    return 2;
  }

  function sortAdminConversations(list, statusFilter){
    return (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
      const statusDelta = statusPriorityForAdmin(a?.status, statusFilter, !!a?.kitchenSent) - statusPriorityForAdmin(b?.status, statusFilter, !!b?.kitchenSent);
      if (statusDelta !== 0) return statusDelta;

      const entregaDelta = entregaPriorityForAdmin(a) - entregaPriorityForAdmin(b);
      if (entregaDelta !== 0) return entregaDelta;

      const aWhen = convDateTimeSortValue(a);
      const bWhen = convDateTimeSortValue(b);
      if (aWhen !== bWhen) return aWhen - bWhen;
      const aLast = Date.parse(a?.lastAt || '');
      const bLast = Date.parse(b?.lastAt || '');
      return (Number.isFinite(bLast) ? bLast : 0) - (Number.isFinite(aLast) ? aLast : 0);
    });
  }

  function updateAdminSummary(list, allCount){
    const rows = Array.isArray(list) ? list : [];
    const total = rows.length;
    const deliveredFilter = getDeliveryFilterValue();
    const statusFilter = getStatusFilterValue();
    const range = getDateRangeValue();
    const hint = document.getElementById('tableHint');
    if (hint) {
      const deliveryLabel = formatMultiFilterLabel(deliveredFilter, DELIVERY_FILTER_LABELS, DELIVERY_FILTER_ALLOWED, 'Todas las entregas').toLowerCase();
      const statusLabel = formatMultiFilterLabel(statusFilter, STATUS_FILTER_LABELS, STATUS_FILTER_ALLOWED, 'Todos los estados').toLowerCase();
      const dateLabel = (range.from || range.to)
        ? ('fechas ' + (range.from || '...') + ' a ' + (range.to || '...'))
        : 'sin rango de fechas';
      const base = [deliveryLabel, statusLabel, dateLabel].join(' · ');

      hint.textContent = total
        ? (total + ' conversaciones visibles' + (Number.isFinite(allCount) ? (' de ' + allCount) : '') + ' · ' + base + '.')
        : ('No hay conversaciones para mostrar con los filtros actuales.');

    }
  }


  function parseQtyFromProductLine(line){
    const m = String(line || '').trim().match(/^(\d+(?:[\.,]\d+)?)\s*x\s+/i);
    if (!m) return 1;
    const n = Number(String(m[1]).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function normalizeProductLine(line){
    return String(line || '').replace(/^(\d+(?:[\.,]\d+)?)\s*x\s+/i, '').trim();
  }

  function foldText(raw){
    return String(raw || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isDeliveryProductLine(line){
    const name = foldText(normalizeProductLine(line));
    return !!name && (
      name.includes('envio') ||
      name.includes('costo de envio') ||
      name.includes('delivery') ||
      /\\b\\d+\\s*-\\s*\\d+\\s*km\\b/.test(name)
    );
  }

  function rowHasPedido(row){
    const lines = Array.isArray(row?.products) ? row.products.filter(Boolean) : [];
    if (lines.length) return true;
    if (String(row?.fechaEntrega || '').trim() && String(row?.fechaEntrega || '').trim() !== '-') return true;
    if (String(row?.horaEntrega || '').trim() && String(row?.horaEntrega || '').trim() !== '-') return true;
    if (String(row?.entregaLabel || '').trim() && String(row?.entregaLabel || '').trim() !== '-') return true;
    if (String(row?.direccion || '').trim() && String(row?.direccion || '').trim() !== '-') return true;
    return false;
  }

  function isPendingConversation(row){
    if (!row || row.delivered) return false;
    if (normalizeStatus(row?.status) === 'CANCELLED') return false;
    return rowHasPedido(row);
  }

  function getEntregaMode(row){
    const label = foldText(row?.entregaLabel || '');
    if (label.includes('env')) return 'envio';
    if (label.includes('ret')) return 'retiro';
    const lines = Array.isArray(row?.products) ? row.products : [];
    if (lines.some(isDeliveryProductLine)) return 'envio';
    return '';
  }

  function getWeightedQty(line, kind){
    const name = foldText(normalizeProductLine(line));
    if (!name || isDeliveryProductLine(name)) return 0;
    const qty = parseQtyFromProductLine(line);
    if (kind === 'pollo') {
      if (!/\\bpollo\\b/.test(name)) return 0;
      if (/\\bmedio\\s+pollo\\b|\\b1\\/2\\s+pollo\\b/.test(name)) return qty * 0.5;
      if (/\\bcuarto\\s+de\\s+pollo\\b|\\b1\\/4\\s+pollo\\b/.test(name)) return qty * 0.25;
      return qty;
    }
    if (kind === 'papa') {
      if (!/\\bpapa(?:s)?\\b|\\bfrita(?:s)?\\b/.test(name)) return 0;
      const paraMatch = name.match(/\\bpara\\s+(\\d+)\\b/);
      const porciones = paraMatch ? Number(paraMatch[1]) : 0;
      if (porciones > 0) return qty * porciones;
      return qty;
    }
    return 0;
  }

  function sumProductQty(rows, kind){
    return (Array.isArray(rows) ? rows : []).reduce((acc, row) => {
      const pedidoItems = Array.isArray(row?.pedidoItems) ? row.pedidoItems : [];
      if (pedidoItems.length) {
        const itemSum = pedidoItems.reduce((sum, it) => {
          const desc = String(it?.descripcion || '').trim();
          const qty = Number(it?.cantidad || 0);
          if (!desc || !Number.isFinite(qty) || qty <= 0) return sum;
          return sum + getWeightedQty(String(qty).replace(/\.0+$/, '') + ' x ' + desc, kind);
        }, 0);
        return acc + itemSum;
      }
      const lines = Array.isArray(row?.products) ? row.products : [];
      return acc + lines.reduce((sum, line) => sum + getWeightedQty(line, kind), 0);
    }, 0);
  }

  function countByEntrega(rows, mode){
    return (Array.isArray(rows) ? rows : []).filter((row) => getEntregaMode(row) === mode).length;
  }

  function buildBarRows(items){
    const safeItems = (Array.isArray(items) ? items : []).filter(Boolean);
    const max = safeItems.reduce((m, item) => Math.max(m, Number(item?.value || 0)), 0) || 1;
    return safeItems.map((item) => {
      const value = Number(item?.value || 0);
      const width = Math.max(6, Math.round((value / max) * 100));
      return '<div class="bar-row">' +
        '<div class="bar-label">' + escHtml(item.label || '-') + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div>' +
        '<div class="bar-value">' + escHtml(String(value)) + '</div>' +
      '</div>';
    }).join('');
  }

  function renderAdminStats(rows, allRows){
    const visible = Array.isArray(rows) ? rows : [];
    const loaded = Array.isArray(allRows) ? allRows : [];
    const pendingAll = loaded.filter(isPendingConversation);
    const completedCount = visible.filter(row => normalizeStatus(row?.status) === 'COMPLETED').length;
    const openCount = visible.filter(row => ['OPEN','IN_PROGRESS'].includes(normalizeStatus(row?.status))).length;
    const envioCount = countByEntrega(pendingAll, 'envio');
    const retiroCount = countByEntrega(pendingAll, 'retiro');
    const polloQty = sumProductQty(pendingAll, 'pollo');
    const papaQty = sumProductQty(pendingAll, 'papa');

    const statsGrid = document.getElementById('statsGrid');
    if (statsGrid) {
      const cards = [
        { value: pendingAll.length, label: 'Pendientes', meta: 'Total no entregado con pedido válido' },
        { value: String(polloQty).replace(/\.0+$/, ''), label: 'Pollos', meta: 'Unidades pendientes totales' },
        { value: String(papaQty).replace(/\.0+$/, ''), label: 'Papas', meta: 'Unidades pendientes totales' },
        { value: envioCount, label: 'A enviar', meta: 'Pendientes totales con envío' },
        { value: retiroCount, label: 'A retirar', meta: 'Pendientes totales para retiro' }
      ];
      statsGrid.innerHTML = cards.map((card) =>
        '<div class="kpi">' +
          '<div class="kpi-value">' + escHtml(String(card.value)) + '</div>' +
          '<div class="kpi-label">' + escHtml(card.label) + '</div>' +
          '<div class="kpi-meta">' + escHtml(card.meta) + '</div>' +
        '</div>'
      ).join('');
    }

    const statusBars = document.getElementById('statusBars');
    if (statusBars) {
      statusBars.innerHTML = buildBarRows([
        { label: 'Completadas', value: completedCount },
        { label: 'Abiertas', value: openCount },
        { label: 'Canceladas', value: visible.filter(row => normalizeStatus(row?.status) === 'CANCELLED').length }
      ]);
    }

    const deliveryBars = document.getElementById('deliveryBars');
    if (deliveryBars) {
      deliveryBars.innerHTML = buildBarRows([
        { label: 'Envío', value: envioCount },
        { label: 'Retiro', value: retiroCount },
        { label: 'Sin definir', value: pendingAll.filter(row => !getEntregaMode(row)).length }
      ]);
    }


    const statsHint = document.getElementById('statsHint');
    if (statsHint) {
      const now = new Date();
      const hhmm = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      statsHint.textContent = 'Última actualización ' + hhmm + ' · estados visibles sobre lo filtrado · pendientes y entrega sobre el total cargado.';
    }
  }

  function setStatsCollapsed(collapsed){
    const panel = document.getElementById('statsPanel');
    const btn = document.getElementById('btnToggleStats');
    if (!panel || !btn) return;
    panel.classList.toggle('is-collapsed', !!collapsed);
    btn.textContent = collapsed ? 'Mostrar resumen' : 'Ocultar resumen';
    try { localStorage.setItem('adminStatsCollapsed', collapsed ? '1' : '0'); } catch {}
  }

  function initAdminUiState(){
    let collapsed = false;
    try { collapsed = localStorage.getItem('adminStatsCollapsed') === '1'; } catch {}
    setStatsCollapsed(collapsed);
    document.getElementById('btnToggleStats')?.addEventListener('click', () => {
      const next = !document.getElementById('statsPanel')?.classList.contains('is-collapsed');
      setStatsCollapsed(next);
    });
  }

  function renderEntregaPill(raw){
    const label = String(raw || '-').trim() || '-';
    const cls = label.toLowerCase().includes('env') ? 'delivery-pill is-envio' : (label.toLowerCase().includes('ret') ? 'delivery-pill is-retiro' : 'delivery-pill');
    return '<span class="' + cls + '">' + escHtml(label) + '</span>';
  }

  function renderDistanceBadge(raw){
    if (raw === undefined || raw === null || raw === '') return '<span class="distance-badge">-</span>';
    return '<span class="distance-badge">' + escHtml(raw) + '</span>';
  }

  function renderProductsCell(lines){
    const safeLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
    if (!safeLines.length) return '<span class="cell-subtle">-</span>';
    return '<div class="cell-products">' + safeLines.map(line => '<div>' + escHtml(line) + '</div>').join('') + '</div>';
  }

  let adminTablePollTimer = null;
  let adminTableLoadDebounceTimer = null;
  let lastAdminTableFingerprint = "";
  let adminLastUserInteractionAt = 0;
  function markAdminInteraction(){
    adminLastUserInteractionAt = Date.now();
  }

  function adminUserIsInteracting(){
    return (Date.now() - adminLastUserInteractionAt) < 5000;
  }

  function buildAdminTableFingerprint(allRows, visibleRows){
    const all = Array.isArray(allRows) ? allRows : [];
    const visible = Array.isArray(visibleRows) ? visibleRows : [];
    return JSON.stringify({
      totalAll: all.length,
      totalVisible: visible.length,
      all: all.map(c => [
        c._id || '',
        c.status || '',
        c.lastAt || '',
        c.delivered ? 1 : 0,
        c.kitchenSent ? 1 : 0,
        c.fechaEntrega || '',
        c.horaEntrega || '',
        c.distanceKm ?? '',
        c.contactName || '',
        c.direccion || '',
        Array.isArray(c.products) ? c.products.join('¦') : ''
      ].join('|'))
    });
  }

  function debounceAdminTableLoad(ms = 250, opts = {}){
    if (adminTableLoadDebounceTimer) {
      clearTimeout(adminTableLoadDebounceTimer);
    }
    adminTableLoadDebounceTimer = setTimeout(() => {
      loadTable(opts);
    }, ms);
  }

  function startAdminTablePolling(){
    stopAdminTablePolling();
    adminTablePollTimer = setInterval(async () => {
      try {
        if (document.hidden) return;
        if (currentConvId) return;
        if (adminUserIsInteracting()) return;
        await loadTable({ soft: true, preserveScroll: true });
      } catch (e) {
        console.warn('admin table polling error', e);
      }
    }, 15000);
  }

  function stopAdminTablePolling(){
    if (adminTablePollTimer) {
      clearInterval(adminTablePollTimer);
      adminTablePollTimer = null;
    }
  }
  // =========================
  // Tabla conversaciones (ÚNICA versión)
  // =========================
  async function loadTable(opts = {}){
    const soft = !!opts.soft;
    const preserveScroll = !!opts.preserveScroll;
    const tableWrap = document.querySelector('.table-wrap');
    const prevScrollTop = (preserveScroll && tableWrap) ? tableWrap.scrollTop : 0;
    const prevScrollLeft = (preserveScroll && tableWrap) ? tableWrap.scrollLeft : 0;
    const tb = document.querySelector('#tbl tbody');
    try{
      const deliveredFilter = getDeliveryFilterValue();
      const statusFilter = getStatusFilterValue();
      const textFilter = getTextFilterValue();
      const range = getDateRangeValue();
      saveAdminFilterState();

      let url = '/api/logs/conversations?limit=200';
      if (deliveredFilter.length === 1 && deliveredFilter[0] === 'delivered') url += '&delivered=true';
      else if (deliveredFilter.length === 1 && deliveredFilter[0] === 'pending') url += '&delivered=false';

      if (tb && !soft) {
        tb.innerHTML = '<tr><td colspan="13" style="text-align:center;color:#64748b;padding:20px">Cargando conversaciones…</td></tr>';
      }

      const r = await fetch(url, { cache: 'no-store' });
      const data = await r.json().catch(()=>[]);
      if (!tb) return;
      const filtered = (Array.isArray(data) ? data : []).filter(c =>
        convMatchesDelivered(c, deliveredFilter) &&
        convMatchesText(c, textFilter) &&
        convMatchesStatus(c, statusFilter) &&
        convMatchesDateRange(c, range.from, range.to)
      );
      const rows = sortAdminConversations(filtered, statusFilter);
      const fingerprint = buildAdminTableFingerprint(Array.isArray(data) ? data : [], rows);

      if (soft && fingerprint === lastAdminTableFingerprint) {
        return;
      }
      lastAdminTableFingerprint = fingerprint;


      tb.innerHTML = '';
      updateAdminSummary(rows, Array.isArray(data) ? data.length : 0);
      renderAdminStats(rows, Array.isArray(data) ? data : []);

      for(const c of rows){
        const tr = document.createElement('tr');
        if (c.delivered) tr.classList.add('delivered-row');
        if (c.kitchenSent) tr.classList.add('kitchen-row');
        const act = formatActivity(c.lastAt);
        const direccion = String(c.direccion || '-').trim() || '-';
        const nombre = String(c.contactName || '-').trim() || '-';
        tr.innerHTML =
          '<td data-label="Actividad">' +
            '<span class="cell-strong">' + escHtml(act.date) + '</span>' +
            '<span class="cell-subtle">' + escHtml(act.time || '') + '</span>' +
          '</td>' +
          '<td data-label="Teléfono"><span class="cell-strong">' + escHtml(c.waId || '-') + '</span></td>' +
          '<td data-label="Nombre" title="' + escHtml(nombre) + '"><span class="cell-strong cell-ellipsis">' + escHtml(nombre) + '</span></td>' +
          '<td data-label="Productos">' + renderProductsCell(c.products) + '</td>' +
          '<td data-label="Entrega">' + renderEntregaPill(c.entregaLabel || '-') + '</td>' +
          '<td data-label="Dirección" title="' + escHtml(direccion) + '"><span class="cell-address">' + escHtml(direccion) + '</span></td>' +
          '<td data-label="Distancia">' + renderDistanceBadge(c.distanceKm) + '</td>' +
          '<td data-label="Día"><span class="cell-ellipsis">' + escHtml(c.fechaEntrega || '-') + '</span></td>' +
          '<td data-label="Hora"><span class="cell-strong">' + escHtml(c.horaEntrega || '-') + '</span></td>' +
          '<td data-label="Estado">' + renderStatusBadge(c.status, c.kitchenSent) + '</td>' +
          '<td data-label="Coc." style="text-align:center">' +
            '<input class="kitchenChk" type="checkbox" data-id="' + escHtml(c._id) + '" ' +
            (c.kitchenSent ? 'checked' : '') + ' title="Enviado a cocina" />' +
          '</td>' +
          '<td data-label="Ent." style="text-align:center">' +
            '<input class="delivChk" type="checkbox" data-id="' + escHtml(c._id) + '" ' +
            (c.delivered ? 'checked' : '') + ' title="Entregado" />' +
          '</td>' +
          '<td data-label="Acciones" style="overflow:visible">' +
            '<div class="actions">' +
              '<button class="btn btn-primary btn-detail btn-icon" data-conv="' + escHtml(c._id) + '" title="Ver conversación">👁</button>' +
              '<button class="btn btn-soft btn-icon" data-pedido="' + escHtml(c._id) + '" title="Ver pedido">🧾</button>' +
              '<button class="btn btn-soft btn-icon" data-print="' + escHtml(c._id) + '" title="Imprimir ticket">🖨️</button>' +
            '</div>' +
          '</td>';

        tb.appendChild(tr);
      }

      if (preserveScroll && tableWrap) {
        tableWrap.scrollTop = prevScrollTop;
        tableWrap.scrollLeft = prevScrollLeft;
      }

      tb.querySelectorAll('button[data-conv]').forEach(b=>{
        b.addEventListener('click',()=>openDetailModal(b.getAttribute('data-conv')));
      });
      tb.querySelectorAll('button[data-pedido]').forEach(b=>{
        b.addEventListener('click',()=>openPedidoModal(b.getAttribute('data-pedido')));
      });
      tb.querySelectorAll('button[data-print]').forEach(b=>{
        b.addEventListener('click',()=>openTicketModal(b.getAttribute('data-print')));
      });
      tb.querySelectorAll('input.kitchenChk').forEach(chk=>{
        chk.addEventListener('change', async()=>{
          const convId = chk.getAttribute('data-id');
          if (!convId) return;
          const flag = chk.checked;
          chk.disabled = true;
          try{
            const rr = await fetch('/api/admin/conversation-kitchen', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ convId, kitchenSent: flag })
            });
            let ok = rr.ok;
            if (ok) {
              const jj = await rr.json().catch(()=>({}));
              ok = !!jj.ok;
            } else {
              const actual = await verifyKitchen(convId);
              ok = (actual === flag);
            }
            if (!ok) throw new Error('not_updated');
            await loadTable({ soft: true, preserveScroll: true });
          }catch(e){
            chk.checked = !flag;
            alert('No se pudo actualizar el estado de cocina');
          }finally{
            chk.disabled = false;
          }
        });
      });
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
            if (!ok) {
              const actual = await verifyDelivered(convId);
              ok = (actual === flag);
            }
            if (!ok) throw new Error('not_updated');

           await loadTable({ soft: true, preserveScroll: true });
          }catch(e){
            chk.checked = !flag;
            alert('No se pudo actualizar el estado de entrega');
          }finally{
            chk.disabled = false;
          }
        });
      });

     if(!rows.length){
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="13" style="text-align:center;color:#64748b;padding:26px">Sin conversaciones para mostrar</td>';
        tb.appendChild(tr);
      }

    }catch(e){
      console.error('loadTable error', e);
      renderAdminStats([]);
      if (tb) tb.innerHTML = '<tr><td colspan="13" style="text-align:center;color:#b91c1c;padding:20px">No se pudo cargar la tabla</td></tr>';
    }
  }

  

  // =========================
  // Bind general
  // =========================
  document.getElementById('dateFrom')?.addEventListener('change', ()=> loadTable({ soft: true, preserveScroll: true }));
  document.getElementById('dateTo')?.addEventListener('change', ()=> loadTable({ soft: true, preserveScroll: true }));
  document.getElementById('qFilter')?.addEventListener('input', ()=>{
    markAdminInteraction();
    debounceAdminTableLoad(250, { soft: true, preserveScroll: true });
  });

  
  document.getElementById('btnReload')?.addEventListener('click', ()=> loadTable());
  document.getElementById('btnToday')?.addEventListener('click', ()=>{
    markAdminInteraction();
    const today = todayIso();
    const from = document.getElementById('dateFrom');
    const to = document.getElementById('dateTo');
    if (from) from.value = today;
    if (to) to.value = today;
    loadTable({ soft: true, preserveScroll: true });
  });
  document.getElementById('btnClearDates')?.addEventListener('click', ()=>{
    markAdminInteraction();
    const from = document.getElementById('dateFrom');
    const to = document.getElementById('dateTo');
    if (from) from.value = '';
    if (to) to.value = '';
    loadTable({ soft: true, preserveScroll: true });
  });
  document.getElementById('qFilter')?.addEventListener('keydown', (e)=>{
    markAdminInteraction();

    if (e.key === 'Enter') {
      e.preventDefault();
       loadTable({ soft: true, preserveScroll: true });
    }
  });

  ['mousedown','keydown','touchstart','wheel','focusin'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      const el = e.target;
      if (!el || !el.closest) return;
      if (
        el.closest('.toolbar-card') ||
        el.closest('.table-card') ||
        el.closest('#modalRoot') ||
        el.closest('#pedidoModalBackdrop')
      ) {
        markAdminInteraction();
      }
    }, true);
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
  initAdminFilters();
  initAdminFilterPopovers();
  initAdminUiState();
  loadTable();
  startAdminTablePolling();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadTable({ soft: true, preserveScroll: true });
  });


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
             const small = document.createElement('small');
             small.textContent = '['+when+'] '+m.role;
             d.appendChild(small);

             const pre = document.createElement('pre');
             pre.textContent = (m.content||'');
             d.appendChild(pre);

                          // media
             try {
               const md = m.media;
               if (md && md.url) {
                 const kind = String(md.kind||'').toLowerCase();
                 const mime = String(md.mime||'').toLowerCase();
                 const filename = String(md.filename || 'Archivo').trim() || 'Archivo';
                 const fnameLower = filename.toLowerCase();
                 const url = String(md.url||'');
                 const dl = url + (url.includes('?') ? '&' : '?') + 'download=1';

                 const isImage = (kind === 'image') || mime.startsWith('image/');
                 const isAudio = (kind === 'audio') || mime.startsWith('audio/');
                 const isVideo = (kind === 'video') || mime.startsWith('video/');
                 const isPdf = (kind === 'pdf') || mime.includes('pdf') || fnameLower.endsWith('.pdf');

                 const links = document.createElement('div');
                 links.style.display = 'flex';
                 links.style.gap = '10px';
                 links.style.marginTop = '4px';
                 links.style.alignItems = 'center';

                 const open = document.createElement('a');
                 open.href = url;
                 open.textContent = 'Abrir';
                 open.target = '_blank';
                 open.rel = 'noopener';
                 open.style.display = 'inline-block';
                 open.style.fontSize = '12px';

                 const adl = document.createElement('a');
                 adl.href = dl;
                 adl.textContent = 'Descargar';
                 adl.style.display = 'inline-block';
                 adl.style.fontSize = '12px';

                 if (isImage) {
                   const a = document.createElement('a');
                   a.href = url; a.target = '_blank'; a.rel = 'noopener';
                   const img = document.createElement('img');
                   img.src = url;
                   img.style.maxWidth = '360px';
                   img.style.borderRadius = '10px';
                   img.style.display = 'block';
                   img.style.marginTop = '6px';
                   a.appendChild(img);
                   d.appendChild(a);

                   links.appendChild(adl);
                   d.appendChild(links);
                 } else if (isAudio) {
                   const audio = document.createElement('audio');
                   audio.controls = true;
                   audio.src = url;
                   audio.style.display = 'block';
                   audio.style.marginTop = '6px';
                   d.appendChild(audio);

                   links.appendChild(open);
                   links.appendChild(adl);
                   d.appendChild(links);
                 } else if (isVideo) {
                   const video = document.createElement('video');
                   video.controls = true;
                   video.src = url;
                   video.style.maxWidth = '360px';
                   video.style.borderRadius = '10px';
                   video.style.display = 'block';
                   video.style.marginTop = '6px';
                   d.appendChild(video);

                   links.appendChild(open);
                   links.appendChild(adl);
                   d.appendChild(links);
                 } else if (isPdf) {
                   const frame = document.createElement('iframe');
                   frame.src = url;
                   frame.style.width = '360px';
                   frame.style.maxWidth = '100%';
                   frame.style.height = '420px';
                   frame.style.border = '0';
                   frame.style.borderRadius = '10px';
                   frame.style.display = 'block';
                   frame.style.marginTop = '6px';
                   d.appendChild(frame);

                   links.appendChild(open);
                   links.appendChild(adl);
                   d.appendChild(links);
                 } else {
                   const a = document.createElement('a');
                   a.href = dl;
                   a.textContent = '📎 ' + filename;
                   a.style.display = 'inline-block';
                   a.style.marginTop = '6px';
                   d.appendChild(a);

                   links.appendChild(open);
                   links.appendChild(adl);
                   d.appendChild(links);
                 }
               }
             } catch {}

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
    const tenant = resolveTenantId(req);
    const convObjectId = new ObjectId(convId);

    // Traemos la conversación para nombre / teléfono
    let pedido = null;
    let nombre = "";
    let waId = "";

    try {
      const conv = await db
        .collection("conversations")
        .findOne(withTenant({ _id: convObjectId }, tenant));
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
      const msgs = await getConversationMessagesByConvId(convId, 1000, tenant);
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




// GET /api/products  → lista (activos por defecto; status=all|active|inactive)
app.get("/api/products", async (req, res) => {
  try {
    const db = await getDb();
    const tenant = resolveTenantId(req);
    const status = String(req.query.status || "").trim().toLowerCase();
    const allFlag = req.query.all === "true" || status === "all";
    const inactiveFlag = status === "inactive";
    const q = inactiveFlag ? { active: false } : (allFlag ? {} : { active: { $ne: false } });
    if (tenant) q.tenantId = tenant; else if (TENANT_ID) q.tenantId = TENANT_ID;
    const items = await db.collection("products")
      .find(q).sort({ active: -1, descripcion: 1, createdAt: -1 }).toArray();
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
    let { descripcion, tag, importe, cantidad, observacion, active } = req.body || {};
    descripcion = String(descripcion || "").trim();
    tag = String(tag || "").trim();
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
    if (tag) doc.tag = tag;
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
    ["descripcion","tag","observacion","active","importe","cantidad"].forEach(k => {
      if (req.body[k] !== undefined) upd[k] = req.body[k];
    });
    if (upd.tag !== undefined) {
      upd.tag = String(upd.tag || "").trim();
    }
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

// POST /api/products/bulk-save  → guardar cambios masivos
app.post("/api/products/bulk-save", async (req, res) => {
  try {
    const db = await getDb();
    const tenant = resolveTenantId(req);
    const tenantValue = tenant || TENANT_ID || DEFAULT_TENANT_ID || null;
    const rows = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!rows.length) return res.json({ ok: true, created: 0, updated: 0, skipped: 0 });

    const now = new Date();
    const ops = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of rows) {
      if (!raw || typeof raw !== "object") { skipped++; continue; }

      let descripcion = String(raw.descripcion || "").trim();
      const tag = String(raw.tag || "").trim();
      const observacion = String(raw.observacion || "").trim();
      let active = raw.active;
      if (typeof active !== "boolean") active = !!active;

      const emptyDraft = !String(raw._id || "").trim()
        && !descripcion
        && !tag
        && !String(raw.importe ?? "").trim()
        && !String(raw.cantidad ?? "").trim()
        && !observacion;
      if (emptyDraft) { skipped++; continue; }

      if (!descripcion) {
        return res.status(400).json({ error: "descripcion requerida" });
      }

      let imp = null;
      if (typeof raw.importe === "number") imp = raw.importe;
      else if (typeof raw.importe === "string") {
        const n = Number(raw.importe.replace(/[^\d.,-]/g, "").replace(",", "."));
        imp = Number.isFinite(n) ? n : null;
      }

      let qty = null;
      if (typeof raw.cantidad === "number") {
        qty = Number.isFinite(raw.cantidad) ? Math.trunc(raw.cantidad) : null;
      } else if (typeof raw.cantidad === "string") {
        const t = raw.cantidad.trim();
        if (t) {
          const n = parseInt(t.replace(/[^\d-]/g, ""), 10);
          qty = Number.isFinite(n) ? n : null;
        }
      }

      const doc = { tenantId: tenantValue, descripcion, observacion, active, updatedAt: now };
      if (tag) doc.tag = tag; else doc.tag = "";
      if (qty !== null) doc.cantidad = qty; else doc.cantidad = null;
      if (imp !== null) doc.importe = imp; else doc.importe = null;

      const id = String(raw._id || "").trim();
      if (id) {
        ops.push({
          updateOne: {
            filter: { _id: new ObjectId(id), ...(tenantValue ? { tenantId: tenantValue } : {}) },
            update: { $set: doc },
            upsert: false
          }
        });
        updated++;
      } else {
        ops.push({
          insertOne: {
            document: { ...doc, createdAt: now }
          }
        });
        created++;
      }
    }

    if (!ops.length) return res.json({ ok: true, created: 0, updated: 0, skipped });

    const result = await db.collection("products").bulkWrite(ops, { ordered: true });
    res.json({
      ok: true,
      created,
      updated,
      skipped,
      result: {
        insertedCount: Number(result?.insertedCount || 0),
        modifiedCount: Number(result?.modifiedCount || 0),
        matchedCount: Number(result?.matchedCount || 0)
      }
    });
  } catch (e) {
    console.error("POST /api/products/bulk-save error:", e);
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

// GET /productos  → UI HTML mejorada para administrar
app.get("/productos", async (req, res) => {
  try {
    const db = await getDb();
    const tenant = resolveTenantId(req);
    const filtro = {};
    if (tenant) filtro.tenantId = tenant; else if (TENANT_ID) filtro.tenantId = TENANT_ID;
    const productos = await db.collection("products").find(filtro).sort({ active: -1, descripcion: 1, createdAt: -1 }).toArray();

    const escAttr = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const escText = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const initialRows = productos.map(p => `<tr data-id="${p._id}">
        <td class="col-desc"><input class="descripcion" type="text" value="${escAttr(p.descripcion || "")}" placeholder="Descripción del producto" /></td>
        <td class="col-tag"><input class="tag" type="text" value="${escAttr(p.tag || "")}" placeholder="Tag" /></td>
        <td class="col-price"><input class="importe" type="number" step="0.01" value="${escAttr(p.importe ?? "")}" placeholder="0" /></td>
        <td class="col-qty"><input class="cantidad" type="number" step="1" value="${escAttr(p.cantidad ?? "")}" placeholder="0" /></td>
        <td class="col-obs"><textarea class="observacion" placeholder="Observaciones, categoría, presentación...">${escText(p.observacion || "")}</textarea></td>
        <td class="col-active">
          <label class="active-check" title="Activo">
            <input class="active" type="checkbox" ${p.active !== false ? "checked" : ""} />
            <span></span>
          </label>
        </td>
        <td class="col-actions">
          <div class="actions-stack">
  
            <button class="del btn btn-danger" type="button">Eliminar</button>
          
          </div>
        </td>
      </tr>`).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" /><title>Productos</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        :root{
          --bg:#f8fafc;
          --card:#ffffff;
          --line:#e6edf5;
          --line-strong:#d8e2ee;
          --text:#17304f;
          --muted:#7a8da5;
          --primary:#264a78;
          --primary-2:#315683;
          --primary-soft:#f4f8fc;
          --danger:#8f7480;
          --danger-bg:#fffafb;
          --danger-line:#eadde2;
          --success:#7d9689;
          --success-bg:#f1f6f3;
          --success-line:#d7e2db;
          --shadow:0 8px 20px rgba(15,23,42,.045);
          --shadow-soft:0 4px 12px rgba(15,23,42,.035);
          --radius:18px;
          --control-h:38px;
        }
        *{box-sizing:border-box}
        html,body{margin:0;padding:0;background:transparent;color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
        body{padding:16px 18px 22px;overflow-x:hidden}
        .page{width:100%;max-width:none;margin:0 auto}
        .hero{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px}
        .hero h1{margin:0;font-size:21px;line-height:1.08;letter-spacing:-.01em}
        .hero p{margin:5px 0 0;color:var(--muted);font-size:13px}
        .hero-side{display:flex;gap:8px;flex-wrap:wrap}
        .chip{
          display:inline-flex;align-items:center;justify-content:center;gap:6px;
          min-height:34px;padding:0 13px;border-radius:999px;background:#fff;border:1px solid var(--line);
          font-size:12px;font-weight:700;color:var(--primary);box-shadow:none
        }
        .toolbar{
          background:var(--card);border:1px solid var(--line);border-radius:20px;padding:16px 18px;
          box-shadow:var(--shadow);display:flex;flex-direction:column;gap:12px;align-items:stretch;
          margin-bottom:18px
        }
        .toolbar-search{width:100%}
        .toolbar-bottom{display:flex;gap:10px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap}
        .search{position:relative;display:block;width:100%}
        .search input,.filter-select{
          width:100%;height:var(--control-h);border-radius:13px;border:1px solid var(--line-strong);
          padding:0 13px;background:#fcfdff;font-size:13px;outline:none;color:var(--text);
          transition:border-color .18s ease, box-shadow .18s ease, background .18s ease
        }
        .search input::placeholder{color:#95a5b9}
        .search input:focus,.filter-select:focus{
          border-color:#a9bcd3;box-shadow:0 0 0 4px rgba(54,93,145,.07);background:#fff
        }
        .filterBox{display:flex;flex-direction:column;gap:5px;min-width:156px;max-width:170px}
        .filterBox label{font-size:11px;color:var(--muted);font-weight:700;padding-left:2px}
        .toolbar-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
        .btn{
          appearance:none;border:1px solid var(--line-strong);background:#fff;color:var(--text);
          border-radius:13px;height:var(--control-h);padding:0 14px;font-weight:700;font-size:12px;
          cursor:pointer;transition:background .18s ease,border-color .18s ease,box-shadow .18s ease,color .18s ease;
          line-height:1;display:inline-flex;align-items:center;justify-content:center;min-width:112px
        }
        .btn:hover{box-shadow:var(--shadow-soft);background:#fff}
        .btn-primary{background:var(--primary);border-color:var(--primary);color:#fff}
        .btn-primary:hover{background:var(--primary-2);border-color:var(--primary-2)}
        .btn-soft{background:var(--primary-soft);border-color:var(--line);color:var(--primary)}
        .btn-danger{background:var(--danger-bg);border-color:var(--danger-line);color:var(--danger)}
        .btn-danger:hover{background:#fff5f7;border-color:#e4d3da;color:#7f646f}
        .flash{display:none;margin:0 0 14px;padding:11px 13px;border-radius:13px;font-size:12px;font-weight:600}
        .flash.show{display:block}
        .flash.ok{background:var(--success-bg);border:1px solid rgba(12,122,67,.22);color:var(--success)}
        .flash.err{background:var(--danger-bg);border:1px solid rgba(180,35,24,.22);color:var(--danger)}
        .table-card{background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}
        .table-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:16px 18px 11px;border-bottom:1px solid var(--line)}
        .table-head h2{margin:0;font-size:15px}
        .table-head p{margin:4px 0 0;color:var(--muted);font-size:12px}
        .table-wrap{overflow-x:hidden;overflow-y:auto}
        table{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;min-width:0}
        thead th{
          position:sticky;top:0;z-index:1;background:#fbfdff;color:#667d99;font-size:11px;letter-spacing:.05em;
          text-transform:uppercase;padding:12px 10px;border-bottom:1px solid var(--line);text-align:left
        }
        tbody td{padding:12px 10px;border-bottom:1px solid #edf2f7;vertical-align:top;background:#fff}
        tbody tr:hover td{background:#fdfefe}
        tbody tr:last-child td{border-bottom:none}
         tbody tr.row-dirty td{background:#fffdf8}
        tbody tr.row-dirty td{background:#fffcf1}
        .col-desc{width:24%}
        .col-tag{width:12%}
        .col-tag{width:14%}
        .col-price{width:12%}
        .col-qty{width:11%}
        .col-obs{width:24%}
        .col-active{width:8%;text-align:center}
        .col-actions{width:10%}
        input[type=text],input[type=number],textarea{
          width:100%;border:1px solid var(--line-strong);border-radius:14px;background:#fcfdff;padding:9px 12px;
          font-size:13px;color:var(--text);outline:none;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease
        }
        input[type=text]:focus,input[type=number]:focus,textarea:focus{
          border-color:#a9bcd3;box-shadow:0 0 0 4px rgba(54,93,145,.07);background:#fff
        }
        textarea{min-height:76px;resize:vertical;line-height:1.4}
        .active-check{display:inline-flex;align-items:center;justify-content:center;width:100%;padding-top:4px}
        .active-check input{
          width:16px;height:16px;margin:0;cursor:pointer;accent-color:#859a8d;
        }
       
        .actions-stack{display:grid;grid-template-columns:1fr;gap:6px;align-items:start}
        .actions-stack .btn{width:100%;min-width:0;height:38px}
        .empty-row td{padding:34px 20px;text-align:center;color:var(--muted);font-weight:600}
        .row-draft td{background:#fffdf8}
        @media (max-width: 1180px){
          .toolbar-actions .btn{min-width:104px}
        }
        @media (max-width: 1100px){
          .col-desc{width:20%}
          .col-tag{width:12%}
          .col-price{width:10%}
          .col-qty{width:9%}
          .col-obs{width:20%}
          .col-active{width:8%}
          .col-actions{width:10%}
        }
        @media (max-width: 960px){
          body{padding:12px}
          .toolbar{padding:14px}
          .toolbar-bottom,.toolbar-actions{width:100%}
          .toolbar-actions .btn{flex:1 1 148px}
          .table-card{border-radius:20px}
          .table-wrap{overflow:auto}
          table{min-width:1080px}
          
        }
      </style></head><body>
      <div class="page">
        <div class="hero">
          <div>
            <h1>Productos</h1>
            <p>Administrá el catálogo del Usuario.</p>
          </div>
          <div class="hero-side">
            <span class="chip" id="metaFilter">Todos</span>
            <span class="chip" id="metaCount">0 productos</span>
             <span class="chip" id="metaDirty">0 cambios pendientes</span>
          </div>
        </div>
<div id="flash" class="flash" role="status" aria-live="polite"></div>
        <div class="toolbar">
         <div class="toolbar-search">
            <label class="search">
              <input id="searchInput" type="text" placeholder="Buscar por descripción, tag, observación, importe o cantidad..." />
            </label>
          </div>
          <div class="toolbar-bottom">
            <div class="filterBox">
              <label for="statusFilter">Filtro</label>
              <select id="statusFilter" class="filter-select">
                <option value="all">Todos</option>
                <option value="active">Activos</option>
                <option value="inactive">Inactivos</option>
              </select>
            </div>
            <div class="toolbar-actions">
              <button id="btnSaveAll" class="btn btn-primary" type="button">Guardar cambios</button>
              <button id="btnAdd" class="btn btn-soft" type="button">Nuevo producto</button>
              <button id="btnReload" class="btn" type="button">Recargar</button>
            </div>
          </div>
        </div>

        <section class="table-card">
          <div class="table-head">
            <div>
              <h2>Listado</h2>
              <p id="tableHint">Editá varios productos y usá “Guardar cambios” .</p>
            </div>
          </div>
          <div class="table-wrap">
            <table id="tbl">
              <thead>
              <tr>
                <th class="col-desc">Descripción</th>
                <th class="col-tag">Tag</th>
                <th class="col-price">Importe</th>
                <th class="col-qty">Cantidad máx.</th>
                <th class="col-obs">Observación</th>
                <th class="col-active">Activo</th>
                <th class="col-actions">Acciones</th>
              </tr>
              </thead>
               <tbody id="productRows">${initialRows || `<tr class="empty-row"><td colspan="7">No hay productos para mostrar.</td></tr>`}</tbody>
            </table>
          </div>
        </section>
      </div>

      <template id="row-tpl"><tr data-id="" data-draft="1" class="row-draft">
        <td class="col-desc"><input class="descripcion" type="text" placeholder="Descripción del producto" /></td>
        <td class="col-tag"><input class="tag" type="text" placeholder="Tag" /></td>
        <td class="col-price"><input class="importe" type="number" step="0.01" placeholder="0" /></td>
        <td class="col-qty"><input class="cantidad" type="number" step="1" placeholder="0" /></td>
        <td class="col-obs"><textarea class="observacion" placeholder="Observaciones, categoría, presentación..."></textarea></td>
        <td class="col-active">
          <label class="active-check" title="Activo">
            <input class="active" type="checkbox" checked />
           
          </label>
        </td>
        <td class="col-actions">
          <div class="actions-stack">
            <button class="del btn btn-danger" type="button" title="Eliminar" aria-label="Eliminar">Eliminar</button>          </div>
        </td>
      </tr></template>

      <script>
        function q(s,c){return (c||document).querySelector(s)}
        function all(s,c){return Array.from((c||document).querySelectorAll(s))}
        async function j(url,opts){
          const r=await fetch(url,opts||{});
          if(!r.ok){
            let message='HTTP '+r.status;
            try{
              const data=await r.json();
              if(data && (data.error || data.message)) message=data.error || data.message;
            }catch(_){}
            throw new Error(message);
          }
          const ct=r.headers.get('content-type')||'';
          return ct.includes('application/json')?r.json():r.text();
        }

        function setFlash(kind,text){
          const el=q('#flash');
          if(!el) return;
          if(!text){
            el.className='flash';
            el.textContent='';
            return;
          }
          el.className='flash show ' + (kind==='err'?'err':'ok');
          el.textContent=String(text);
        }

        function setRowValues(tr,it){
          tr.dataset.id=it && it._id ? String(it._id) : '';
          tr.dataset.draft = it && it._id ? '' : '1';
          tr.dataset.dirty = '';
          tr.classList.toggle('row-draft', !(it && it._id));
           tr.classList.remove('row-dirty');
          q('.descripcion',tr).value=it && it.descripcion ? it.descripcion : '';
          q('.tag',tr).value=it && it.tag ? it.tag : '';
          q('.importe',tr).value=(it && (typeof it.importe==='number' || it.importe)) ? it.importe : '';
          q('.cantidad',tr).value=(it && (typeof it.cantidad==='number' || it.cantidad)) ? it.cantidad : '';
          q('.observacion',tr).value=it && it.observacion ? it.observacion : '';
          q('.active',tr).checked=!(it && it.active===false);
          
        }

        function dataRows(){
          return all('#productRows tr').filter(tr => !tr.classList.contains('empty-row'));
        }

        function markDirty(tr){
          if(!tr) return;
          tr.dataset.dirty='1';
          tr.classList.add('row-dirty');
          updateMeta();
        }

        function clearDirty(tr){
          if(!tr) return;
          tr.dataset.dirty='';
          tr.classList.remove('row-dirty');
        }

        function currentFilterValue(){
          return String((q('#statusFilter') && q('#statusFilter').value) || 'all');
        }

        function rowMatches(tr, term, status){
          const haystack=[
            q('.descripcion',tr)?.value||'',
            q('.tag',tr)?.value||'',
            q('.observacion',tr)?.value||'',
            q('.importe',tr)?.value||'',
            q('.cantidad',tr)?.value||''
          ].join(' ').toLowerCase();
          const active = !!q('.active',tr)?.checked;
          const matchTerm=!term || haystack.includes(term);
          const matchStatus = status==='all' ? true : (status==='active' ? active : !active);
          return matchTerm && matchStatus;
        }

        function updateMeta(){
          const term=(q('#searchInput').value||'').trim().toLowerCase();
          const status=currentFilterValue();
          const rows=dataRows();
          let visibles=0, dirty=0;
          rows.forEach(tr=>{
            const show=rowMatches(tr, term, status);
            tr.style.display=show?'':'none';
            if(show) visibles++;
            if(tr.dataset.dirty==='1') dirty++;
          });
          const filterLabel = status==='active' ? 'Activos' : (status==='inactive' ? 'Inactivos' : 'Todos');
          q('#metaFilter').textContent = filterLabel;
          q('#metaCount').textContent = visibles + ' / ' + rows.length + ' visibles';
          q('#metaDirty').textContent = dirty + ' cambios pendientes';
          q('#tableHint').textContent = rows.length
            ? (term || status!=='all'
                ? ('Filtrando ' + visibles + ' de ' + rows.length + ' productos. Los cambios se guardan de forma masiva.')
                : 'Editá varios productos y usá “Guardar cambios” para persistir todo junto.')
            : 'No hay productos para mostrar.';
        }

        function bindRow(tr){
          
          q('.del',tr).addEventListener('click',()=>deleteRow(tr));
          all('input,textarea',tr).forEach(el=>{
            const evt = el.tagName==='TEXTAREA' ? 'input' : 'input';
            el.addEventListener(evt,()=>markDirty(tr));
            if(el.type==='checkbox') el.addEventListener('change',()=>markDirty(tr));
          });
        }

        function showEmptyIfNeeded(){
          const tb=q('#productRows');
          const rows=dataRows();
          const currentEmpty=q('.empty-row',tb);
          if(!rows.length){
            if(!currentEmpty){
              const tr=document.createElement('tr');
              tr.className='empty-row';
              tr.innerHTML='<td colspan="7">No hay productos para mostrar.</td>';
              tb.appendChild(tr);
            }
          }else if(currentEmpty){
            currentEmpty.remove();
          }
        }

        function buildPayloadFromRow(tr){
          return {
            _id: tr.dataset.id || '',
            descripcion:q('.descripcion',tr).value.trim(),
            tag:q('.tag',tr).value.trim(),
            importe:q('.importe',tr).value.trim(),
            cantidad:q('.cantidad',tr).value.trim(),
            observacion:q('.observacion',tr).value.trim(),
            active:q('.active',tr).checked
          };
        }

        function isBlankDraft(payload){
          return !payload._id
            && !payload.descripcion
            && !payload.tag
            && !String(payload.importe || '').trim()
            && !String(payload.cantidad || '').trim()
            && !payload.observacion;
        }

        async function reload(){
           const data=await j('/api/products?status=all');
          const tb=q('#productRows');
          tb.innerHTML='';
          if(Array.isArray(data) && data.length){
            data.forEach(it=>{
              const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);
              setRowValues(tr,it);
              bindRow(tr);
              tb.appendChild(tr);
            });
          }
          showEmptyIfNeeded();
          updateMeta();
        }

        async function saveAll(){
          const rows=dataRows();
          if(!rows.length){ setFlash('ok','No hay cambios para guardar.'); return; }
          const payloads=[];
          for(const tr of rows){
            const payload=buildPayloadFromRow(tr);
            if(isBlankDraft(payload)) continue;
            if(!payload.descripcion){
              alert('Descripción requerida en todos los productos antes de guardar.');
              q('.descripcion',tr).focus();
              return;
            }
            payloads.push(payload);
          }
          if(!payloads.length){
            setFlash('ok','No hay cambios para guardar.');
            return;
          }
          const btn=q('#btnSaveAll');
          const prev=btn.textContent;
          btn.disabled=true;
          btn.textContent='Guardando...';
          try{
            await j('/api/products/bulk-save',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({ items: payloads })
            });
            setFlash('ok','Se guardaron todos los cambios del catálogo.');
            await reload();
          }catch(e){
            setFlash('err', e.message||String(e));
          }finally{
            btn.disabled=false;
            btn.textContent=prev;
          }
          
        }

        async function deleteRow(tr){
          const id=tr.dataset.id;
          if(!id){
            tr.remove();
            showEmptyIfNeeded();
            updateMeta();
            return;
          }
          if(!confirm('¿Eliminar definitivamente este producto?')) return;
          await j('/api/products/'+encodeURIComponent(id),{method:'DELETE'});
          tr.remove();
          showEmptyIfNeeded();
          updateMeta();
          setFlash('ok','Producto eliminado.');
        }

       

        q('#btnReload').addEventListener('click',()=>reload().catch(e=>setFlash('err', e.message||String(e))));
        q('#btnSaveAll').addEventListener('click',()=>saveAll());
        q('#btnAdd').addEventListener('click',()=>{
          const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);
          bindRow(tr);
          q('#productRows').prepend(tr);
          showEmptyIfNeeded();
          markDirty(tr);
          q('.descripcion',tr).focus();
        });
        q('#statusFilter').addEventListener('change',updateMeta);

        all('#productRows tr').forEach(tr=>{
          if(!tr.classList.contains('empty-row')) bindRow(tr);
        });
        showEmptyIfNeeded();
        updateMeta();
      </script></body></html>`);
  } catch (e) {
    console.error("/productos error:", e);
    res.status(500).send("internal");
  }
});


// ================== Horarios de atención (UI L-V) ==================
// Página visual para cargar horarios de lunes a domingo (hasta 2 franjas por día)
app.get("/horarios", async (req, res) => {
  try {
    const tenant = resolveTenantId(req);
    const db = await getDb();
    const _id = `store_hours:${tenant}`;
    const doc = (await db.collection("settings").findOne({ _id })) || {};
    const hours = doc.hours || {};
    const hoursJson = JSON.stringify(hours).replace(/</g, "\u003c");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8" />
      <title>Horarios de atención (${tenant})</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        :root{
          --bg:#f6f9fc;
          --card:#ffffff;
          --text:#11253b;
          --muted:#64758a;
          --line:#d9e4ef;
          --line-strong:#c6d4e3;
          --primary:#173c67;
          --primary-2:#204b7c;
          --soft:#f3f7fb;
          --success:#557a66;
          --success-bg:#e6efe9;
          --shadow:0 10px 24px rgba(15,23,42,.05);
          --radius:18px;
        }
        *{box-sizing:border-box}
        html,body{margin:0;padding:0;background:transparent;color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
        body{padding:12px 14px 18px;overflow-x:hidden}
        .page{width:100%;max-width:none;margin:0 auto}
        .hero{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:14px}
        .hero h1{margin:0;font-size:20px;line-height:1.08}
        .hero p{margin:5px 0 0;color:var(--muted);font-size:13px}
        .hero-side{display:flex;gap:8px;flex-wrap:wrap}
        .chip{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;background:#fff;border:1px solid var(--line);font-size:12px;font-weight:700;color:var(--primary)}
        .toolbar{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:12px 13px;box-shadow:var(--shadow);display:flex;gap:10px;align-items:end;justify-content:space-between;flex-wrap:wrap;margin-bottom:14px}        .toolbar-left{display:flex;gap:10px;flex-wrap:wrap;align-items:end;flex:1 1 360px}
        .field{display:flex;flex-direction:column;gap:5px;min-width:200px;flex:1 1 240px}
        .field.small{flex:0 0 210px;min-width:210px}
        .field label{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#50657d}
        .field input{width:100%;height:40px;border-radius:13px;border:1px solid var(--line-strong);padding:0 12px;background:#fff;font-size:13px;outline:none;color:var(--text)}
        .field input:focus{border-color:#93b2d3;box-shadow:0 0 0 4px rgba(32,75,124,.08)}
        .toolbar-actions{display:flex;gap:8px;flex-wrap:wrap}
        .btn{appearance:none;border:1px solid var(--line-strong);background:#fff;color:var(--text);border-radius:12px;padding:0 14px;height:40px;font-weight:700;font-size:13px;cursor:pointer;transition:.18s ease;line-height:1}
        .btn:hover{transform:translateY(-1px);box-shadow:0 8px 18px rgba(16,24,40,.06)}
        .btn-primary{background:var(--primary);border-color:var(--primary);color:#fff}
        .btn-primary:hover{background:var(--primary-2);border-color:var(--primary-2)}
        .btn-soft{background:var(--soft);border-color:var(--line);color:var(--primary)}
        .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
        .day-card{background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}
        .day-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
        .day-title{margin:0;font-size:17px;line-height:1.08}
        .day-sub{margin:4px 0 0;color:var(--muted);font-size:12px}
        .day-body{padding:14px 16px 16px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
        .range{background:#fbfdff;border:1px solid var(--line);border-radius:15px;padding:11px}
        .range h3{margin:0 0 9px;font-size:12px;color:#4e647d;letter-spacing:.04em;text-transform:uppercase}
        .time-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
        .time-field{display:flex;flex-direction:column;gap:5px}
        .time-field label{font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#61758b}
        input[type=time]{width:100%;height:38px;border-radius:12px;border:1px solid var(--line-strong);padding:0 10px;background:#fff;font-size:13px;color:var(--text);outline:none}
        input[type=time]:focus{border-color:#93b2d3;box-shadow:0 0 0 4px rgba(32,75,124,.08)}
        .switch-row{display:flex;align-items:center;gap:9px;white-space:nowrap}
       .switch-label{font-size:12px;font-weight:700;color:var(--muted)}
        .switch{position:relative;display:inline-flex;align-items:center;width:44px;height:26px}
      
        .switch input{position:absolute;opacity:0;pointer-events:none}
        .switch span{display:block;width:44px;height:26px;border-radius:999px;background:#dee6ef;border:1px solid #ced9e4;position:relative;transition:.18s ease}
        .switch span:before{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(16,24,40,.12);transition:.18s ease}
        .switch input:checked + span{background:var(--success-bg);border-color:#c4d8cb}
        .switch input:checked + span:before{left:21px;background:var(--success)}
        .day-card.is-off .range{opacity:.58}
        .day-card.is-off .day-title{color:#728199}
        .hint-card{margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:13px 15px;color:var(--muted);font-size:12px;box-shadow:var(--shadow)}
        .toast{position:fixed;right:16px;bottom:16px;background:#13253a;color:#fff;padding:11px 13px;border-radius:13px;box-shadow:0 14px 30px rgba(15,23,42,.18);font-size:12px;font-weight:700;opacity:0;transform:translateY(10px);pointer-events:none;transition:.18s ease;z-index:50}
        .toast.show{opacity:1;transform:translateY(0)}
        @media (max-width: 980px){
          body{padding:12px}
          .grid{grid-template-columns:1fr}
        }
        @media (max-width: 680px){
          .day-body,.time-grid{grid-template-columns:1fr}
          .field.small,.field{min-width:0;flex:1 1 100%}
          .toolbar-actions{width:100%}
          .toolbar-actions .btn{flex:1 1 0}
        }
      </style></head><body>
      <div class="page">
        <div class="hero">
          <div>
            <h1>Horarios de atención</h1>
            <p>Configurá la disponibilidad horaria.</p>
          </div>
          <div class="hero-side">
            <span class="chip">Lunes a domingo</span>
            <span class="chip" id="metaEnabled">0 días activos</span>
          </div>
        </div>

        <div class="toolbar">
          <div class="toolbar-left">
            <div class="field small">
              <label for="tenant">Dominio</label>
              <input id="tenant" type="text" value="${tenant.replace(/"/g,'&quot;')}" />
            </div>
          </div>
          <div class="toolbar-actions">
            <button id="btnReload" class="btn btn-soft" type="button">Recargar</button>
            <button id="btnSave" class="btn btn-primary" type="button">Guardar cambios</button>
          </div>
        </div>

        <section class="grid" id="hoursGrid">
          ${STORE_HOURS_DAYS.map((d, idx) => `
          <article class="day-card" data-day="${d.key}">
            <div class="day-head">
              <div>
                <h2 class="day-title">${d.label}</h2>
                <p class="day-sub">${idx < 5 ? 'Jornada configurable' : 'Disponibilidad especial de fin de semana'}</p>
              </div>
              <div class="switch-row">
                <span class="switch-label">Habilitado</span>
                <label class="switch">
                  <input type="checkbox" class="enabled" />
                  <span></span>
                </label>
              </div>
            </div>
            <div class="day-body">
              <section class="range">
                <h3>Franja 1</h3>
                <div class="time-grid">
                  <div class="time-field">
                    <label>Desde</label>
                    <input type="time" class="from1" />
                  </div>
                  <div class="time-field">
                    <label>Hasta</label>
                    <input type="time" class="to1" />
                  </div>
                </div>
              </section>
              <section class="range">
                <h3>Franja 2</h3>
                <div class="time-grid">
                  <div class="time-field">
                    <label>Desde</label>
                    <input type="time" class="from2" />
                  </div>
                  <div class="time-field">
                    <label>Hasta</label>
                    <input type="time" class="to2" />
                  </div>
                </div>
              </section>
            </div>
          </article>`).join("")}
        </section>

        <div class="hint-card">
          Deshabilitá un día o dejalo sin franjas para que no pueda elegirse en nuevos pedidos. 
        </div>
      </div>
      <div id="toast" class="toast" aria-live="polite"></div>
      <script>
        const DAYS = ${JSON.stringify(STORE_HOURS_DAYS).replace(/</g,"\u003c")};

        function q(s,c){return (c||document).querySelector(s)}
        function all(s,c){return Array.from((c||document).querySelectorAll(s))}

        function showToast(msg){
          const t = q('#toast');
          t.textContent = msg || '';
          t.classList.add('show');
          clearTimeout(showToast._tm);
          showToast._tm = setTimeout(()=>t.classList.remove('show'), 1800);
        }

        function setDayState(card, enabled){
          card.classList.toggle('is-off', !enabled);
        }

        function updateMeta(){
          const enabledCount = all('.day-card .enabled').filter(el=>el.checked).length;
          q('#metaEnabled').textContent = enabledCount + ' día' + (enabledCount === 1 ? '' : 's') + ' activos';
          all('.day-card').forEach(card => setDayState(card, q('.enabled', card).checked));
        }

        function setForm(data){
          DAYS.forEach(d => {
            const row = document.querySelector('[data-day="'+d.key+'"]');
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
          updateMeta();
        }

        function collectForm(){
          const out = {};
          DAYS.forEach(d => {
            const row = document.querySelector('[data-day="'+d.key+'"]');
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
          showToast('Horarios recargados');
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
          showToast('Horarios guardados ✅');
        }

        document.getElementById('btnReload').addEventListener('click', reloadHours);
        document.getElementById('btnSave').addEventListener('click', saveHours);
        all('.enabled').forEach(el => el.addEventListener('change', updateMeta));
        all('input[type=time]').forEach(el => el.addEventListener('change', updateMeta));

        // Inicializar con lo que vino del servidor
        setForm(${hoursJson});
      </script></body></html>`);
  } catch (e) {
    console.error("/horarios error:", e);
    res.status(500).send("internal");
  }
});

function normalizeBehaviorExternalActionName(value) {
  return String(value || "")
    .trim().toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function behaviorBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "si", "sí", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeBehaviorExternalActionType(value) {
  const v = String(value || "api").trim().toLowerCase();
  return ["web", "web_search", "internet", "buscar_web"].includes(v) ? "web" : "api";
}

function publicBehaviorExternalActions(actions) {
  return (Array.isArray(actions) ? actions : []).map((raw) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const { auth_value, authValue, ...safe } = item;
    return {
      ...safe,
      auth_value_set: !!(auth_value || authValue)
    };
  });
}

function legacyBehaviorActionFromBody(body = {}) {
  const enabledRaw = body?.external_api_enabled ?? body?.externalApiEnabled ?? false;
  const hasLegacyFields = body?.external_api_enabled !== undefined || body?.externalApiEnabled !== undefined ||
    body?.external_api_url !== undefined || body?.externalApiUrl !== undefined ||
    body?.external_api_action_name !== undefined || body?.externalApiActionName !== undefined;
  if (!hasLegacyFields) return null;
  return {
    id: "legacy_external_api",
    type: "api",
    enabled: behaviorBool(enabledRaw, false),
    name: body?.external_api_action_name ?? body?.externalApiActionName ?? "consulta_externa",
    description: body?.external_api_description ?? body?.externalApiDescription ?? "",
    url: body?.external_api_url ?? body?.externalApiUrl ?? "",
    method: body?.external_api_method ?? body?.externalApiMethod ?? "GET",
    query_param: body?.external_api_query_param ?? body?.externalApiQueryParam ?? "buscar",
    body_template: body?.external_api_body_template ?? body?.externalApiBodyTemplate ?? "",
    auth_header: body?.external_api_auth_header ?? body?.externalApiAuthHeader ?? "",
    auth_value: body?.external_api_auth_value ?? body?.externalApiAuthValue ?? "",
    auth_clear: body?.external_api_auth_clear ?? body?.externalApiAuthClear ?? false,
    timeout_ms: body?.external_api_timeout_ms ?? body?.externalApiTimeoutMs ?? 10000,
    max_chars: body?.external_api_max_chars ?? body?.externalApiMaxChars ?? 30000,
    result_instructions: body?.external_api_result_instructions ?? body?.externalApiResultInstructions ?? ""
  };
}

function sanitizeBehaviorExternalActions(rawActions, existingActions = []) {
  const input = Array.isArray(rawActions) ? rawActions.slice(0, 20) : [];
  const existing = Array.isArray(existingActions) ? existingActions : [];
  const out = [];
  const usedNames = new Set();
  const usedIds = new Set();

  for (let i = 0; i < input.length; i++) {
    const raw = input[i] && typeof input[i] === "object" ? input[i] : {};
    const type = normalizeBehaviorExternalActionType(raw.type ?? raw.action_type ?? raw.actionType ?? "api");
    const name = normalizeBehaviorExternalActionName(raw.name ?? raw.action_name ?? raw.actionName ?? `accion_${i + 1}`);
    if (!name) throw new Error(`external_action_name_required:${i}`);
    if (usedNames.has(name)) throw new Error(`external_action_name_duplicate:${name}`);
    usedNames.add(name);

    let id = String(raw.id || raw.action_id || raw.actionId || name).trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || name;
    if (usedIds.has(id)) id = `${id}_${i + 1}`.slice(0, 120);
    usedIds.add(id);

    const previous = existing.find((item) => String(item?.id || "") === id) ||
      existing.find((item) => normalizeBehaviorExternalActionName(item?.name) === name) || null;

    const enabled = behaviorBool(raw.enabled ?? raw.habilitada ?? raw.active, true);
    const timeout_ms = Math.max(1000, Math.min(60000, Number(raw.timeout_ms ?? raw.timeoutMs ?? 10000) || 10000));
    const max_chars = Math.max(2000, Math.min(100000, Number(raw.max_chars ?? raw.maxChars ?? 30000) || 30000));
    const result_instructions = String(raw.result_instructions ?? raw.resultInstructions ?? "").trim().slice(0, 6000);
    const description = String(raw.description ?? raw.descripcion ?? "").trim().slice(0, 1500);

    const item = { id, type, enabled, name, description, result_instructions, timeout_ms, max_chars };

    if (type === "web") {
      const ctx = String(raw.web_search_context_size ?? raw.webSearchContextSize ?? raw.search_context_size ?? "medium").trim().toLowerCase();
      item.web_search_context_size = ["low", "medium", "high"].includes(ctx) ? ctx : "medium";
      item.web_model = String(raw.web_model ?? raw.webModel ?? "").trim().slice(0, 120);
    } else {
      item.url = String(raw.url ?? "").trim().slice(0, 3000);
      item.method = String(raw.method ?? "GET").trim().toUpperCase() === "POST" ? "POST" : "GET";
      item.query_param = String(raw.query_param ?? raw.queryParam ?? "buscar").trim().slice(0, 100);
      item.body_template = String(raw.body_template ?? raw.bodyTemplate ?? "").trim().slice(0, 20000);
      item.auth_header = String(raw.auth_header ?? raw.authHeader ?? "").trim().replace(/[\r\n]/g, "").slice(0, 200);

      if (enabled && !/^https?:\/\//i.test(item.url)) {
        throw new Error(`external_action_url_invalid:${name}`);
      }
      if (item.body_template) {
        let parsed;
        try { parsed = JSON.parse(item.body_template); }
        catch { throw new Error(`external_action_body_template_invalid_json:${name}`); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`external_action_body_template_must_be_object:${name}`);
        }
      }

      const incomingSecret = String(raw.auth_value ?? raw.authValue ?? "").trim().replace(/[\r\n]/g, "").slice(0, 4000);
      const clearSecret = behaviorBool(raw.auth_clear ?? raw.authClear, false);
      if (incomingSecret) item.auth_value = incomingSecret;
      else if (!clearSecret && previous?.auth_value) item.auth_value = String(previous.auth_value);
    }

    out.push(item);
  }
  return out;
}



// JavaScript del panel de Comportamiento servido como archivo externo.
// Evita que el panel quede inerte si el navegador/proxy bloquea scripts inline
// dentro del iframe de /ui/comportamiento.
app.get("/comportamiento-ui.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(String.raw`


        var externalActions=[];

        function esc(v){
          return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
        }
        function makeId(prefix){
          return String(prefix||'accion')+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
        }
        function defaultAction(type){
          if(type==='web') return {
            id:makeId('web'),type:'web',enabled:true,name:'buscar_web',description:'Buscar información pública y actualizada en Internet para complementar el asesoramiento.',
            web_model:'',web_search_context_size:'medium',timeout_ms:30000,max_chars:30000,result_instructions:''
          };
          return {
           id:makeId('api'),type:'api',enabled:true,name:'consulta_externa',description:'Consultar información actualizada en una API externa.',
            url:'',method:'GET',query_param:'buscar',body_template:'',auth_header:'',auth_value:'',auth_value_set:false,auth_clear:false,
            timeout_ms:10000,max_chars:30000,result_instructions:''
          };
        }
        function normalizeClientAction(a){
          a=a&&typeof a==='object'?Object.assign({},a):{};
          a.id=a.id||makeId(a.type==='web'?'web':'api');
          a.type=a.type==='web'?'web':'api';
          a.enabled=a.enabled!==false;
          a.name=a.name||(a.type==='web'?'buscar_web':'consulta_externa');
          a.description=a.description||'';
          a.timeout_ms=Number(a.timeout_ms|| (a.type==='web'?30000:10000));
          a.max_chars=Number(a.max_chars||30000);
          a.result_instructions=a.result_instructions||'';
          if(a.type==='api'){
            a.url=a.url||''; a.method=a.method==='POST'?'POST':'GET'; a.query_param=a.query_param==null?'buscar':a.query_param;
            a.body_template=a.body_template||''; a.auth_header=a.auth_header||''; a.auth_value=''; a.auth_clear=false;
          } else {
            a.web_model=a.web_model||'';
            a.web_search_context_size=['low','medium','high'].indexOf(a.web_search_context_size)>=0?a.web_search_context_size:'medium';
         }
          return a;
        }
        function commonFields(a,i){
          return '<div class="externalGrid">'+
            '<label>Nombre exacto de la acción<input data-i="'+i+'" data-field="name" type="text" value="'+esc(a.name)+'" placeholder="consulta_lista_precios" /></label>'+
            '<label>Tipo<select data-i="'+i+'" data-field="type" class="typeSelect"><option value="api"'+(a.type==='api'?' selected':'')+'>API HTTP</option><option value="web"'+(a.type==='web'?' selected':'')+'>Búsqueda web</option></select></label>'+
            '<label style="grid-column:1/-1">Descripción para la IA<input data-i="'+i+'" data-field="description" type="text" value="'+esc(a.description)+'" placeholder="Cuándo y para qué debe usar esta acción" /></label>';
        }
        function apiFields(a,i){
         return '<label style="grid-column:1/-1">URL de la API<input data-i="'+i+'" data-field="url" type="text" value="'+esc(a.url||'')+'" placeholder="https://servidor/api/..." /></label>'+
            '<label>Método<select data-i="'+i+'" data-field="method"><option value="GET"'+(a.method==='GET'?' selected':'')+'>GET</option><option value="POST"'+(a.method==='POST'?' selected':'')+'>POST</option></select></label>'+
            '<label>Parámetro/campo de búsqueda<input data-i="'+i+'" data-field="query_param" type="text" value="'+esc(a.query_param==null?'buscar':a.query_param)+'" placeholder="buscar" /><span class="hint">GET: ?campo=... · POST simple: {campo:...}. El Body JSON tiene prioridad.</span></label>'+
            '<label>Timeout (ms)<input data-i="'+i+'" data-field="timeout_ms" type="number" min="1000" max="60000" value="'+esc(a.timeout_ms||10000)+'" /></label>'+
            '<label>Límite enviado a la IA (caracteres)<input data-i="'+i+'" data-field="max_chars" type="number" min="2000" max="100000" value="'+esc(a.max_chars||30000)+'" /></label>'+
            '<label>Header de autenticación (opcional)<input data-i="'+i+'" data-field="auth_header" type="text" value="'+esc(a.auth_header||'')+'" placeholder="Authorization o X-API-Key" /></label>'+
            '<label>Valor del header (secreto)<input data-i="'+i+'" data-field="auth_value" type="password" autocomplete="new-password" value="" placeholder="Bearer ... / key" /><span class="hint">'+(a.auth_value_set?'Hay una credencial guardada. Dejá vacío para conservarla.':'Sin credencial guardada.')+'</span><span><input data-i="'+i+'" data-field="auth_clear" type="checkbox" '+(a.auth_clear?'checked':'')+' /> Borrar credencial guardada</span></label>'+
            '<label style="grid-column:1/-1">Body JSON para POST (opcional)<textarea data-i="'+i+'" data-field="body_template" class="smallArea" placeholder=\'{"Tel_Origen":"{{telefono_cliente}}","Tel_Destino":"{{telefono_qr}}","Mensaje":"{{consulta}}"}\'>'+esc(a.body_template||'')+'</textarea><span class="hint">Variables: {{telefono_cliente}}, {{telefono_qr}} y {{consulta}}.</span></label>';
        }
       function webFields(a,i){
          return '<label>Modelo para búsqueda web (opcional)<input data-i="'+i+'" data-field="web_model" type="text" value="'+esc(a.web_model||'')+'" placeholder="Vacío = mismo modelo del chat" /></label>'+
            '<label>Contexto de búsqueda<select data-i="'+i+'" data-field="web_search_context_size"><option value="low"'+(a.web_search_context_size==='low'?' selected':'')+'>low</option><option value="medium"'+(a.web_search_context_size==='medium'?' selected':'')+'>medium</option><option value="high"'+(a.web_search_context_size==='high'?' selected':'')+'>high</option></select></label>'+
            '<label>Timeout (ms)<input data-i="'+i+'" data-field="timeout_ms" type="number" min="3000" max="60000" value="'+esc(a.timeout_ms||30000)+'" /></label>'+
            '<label>Límite enviado a la IA (caracteres)<input data-i="'+i+'" data-field="max_chars" type="number" min="2000" max="100000" value="'+esc(a.max_chars||30000)+'" /></label>'+
            '<div class="hint" style="grid-column:1/-1">Usa la misma API key de OpenAI configurada para el canal y la herramienta web_search de Responses API. No necesita URL ni credencial adicional.</div>';
        }
        function renderActions(){
          var c=document.getElementById('actionsContainer');
          if(!externalActions.length){ c.innerHTML='<div class="emptyActions">No hay acciones configuradas.</div>'; return; }
         c.innerHTML=externalActions.map(function(a,i){
            var typeLabel=a.type==='web'?'WEB':'API';
            return '<div class="actionCard" data-card="'+i+'">'+
              '<div class="actionHeader"><div class="actionHeaderLeft"><label><input data-i="'+i+'" data-field="enabled" type="checkbox" '+(a.enabled?'checked':'')+' /> Habilitada</label><span class="actionType">'+typeLabel+'</span><strong>'+esc(a.name||('Acción '+(i+1)))+'</strong></div><button class="danger removeAction" data-i="'+i+'" type="button">Eliminar</button></div>'+
              commonFields(a,i)+(a.type==='web'?webFields(a,i):apiFields(a,i))+
              '<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;margin-top:10px">Cómo interpretar el resultado (opcional)<textarea data-i="'+i+'" data-field="result_instructions" class="smallArea" placeholder="Indicaciones específicas para interpretar la respuesta">'+esc(a.result_instructions||'')+'</textarea></label>'+
              '</div>';
          }).join('');
        }
        function updateActionFromElement(el){
          var i=Number(el.getAttribute('data-i')); var field=el.getAttribute('data-field');
          if(!Number.isInteger(i)||!externalActions[i]||!field) return;
          var value=el.type==='checkbox'?el.checked:el.value;
          if(field==='timeout_ms'||field==='max_chars') value=Number(value||0);
          externalActions[i][field]=value;
          if(field==='type'){
            var old=externalActions[i]; var base=defaultAction(value);
            externalActions[i]=Object.assign(base,old,{type:value,id:old.id,name:old.name,description:old.description,result_instructions:old.result_instructions});
            renderActions();
          }
        }
        document.getElementById('actionsContainer').addEventListener('input',function(e){ if(e.target&&e.target.getAttribute('data-field')) updateActionFromElement(e.target); });
        document.getElementById('actionsContainer').addEventListener('change',function(e){ if(e.target&&e.target.getAttribute('data-field')) updateActionFromElement(e.target); });
        document.getElementById('actionsContainer').addEventListener('click',function(e){
          var btn=e.target.closest('.removeAction'); if(!btn) return;
          var i=Number(btn.getAttribute('data-i')); if(!Number.isInteger(i)) return;
          externalActions.splice(i,1); renderActions();
        });
        document.getElementById('btnAddApi').addEventListener('click',function(){ externalActions.push(defaultAction('api')); renderActions(); });
        document.getElementById('btnAddWeb').addEventListener('click',function(){ externalActions.push(defaultAction('web')); renderActions(); });

        function setBehaviorStatus(message,isError){
          var el=document.getElementById('behaviorStatus');
          if(!el) return;
          el.textContent=String(message||'');
          el.style.color=isError?'#b91c1c':'#666';
          el.style.fontWeight=isError?'600':'400';
        }

        function toggleHelpUi(){
          var enabled=document.getElementById('helpEnabled') && document.getElementById('helpEnabled').checked;
          var box=document.getElementById('helpConfigFields');
          if(box) box.style.opacity=enabled?'1':'0.58';
        }

        function applyHelpEditable(editable,serviceAccountEmail,apiKeyConfigured){
          ['helpEnabled','helpModel','helpSourceUrl','helpSourceCacheMinutes','helpAiCacheDays','helpMaxVideos','helpBehavior'].forEach(function(id){
            var el=document.getElementById(id); if(el) el.disabled=!editable;
          });
          var note=document.getElementById('helpConfigNote');
          if(note){
            var parts=[editable
              ? 'La habilitación de Ayuda corresponde al dominio seleccionado. Modelo, fuente, comportamiento y caches son globales para MANAGER.'
              : 'La habilitación corresponde a este dominio; la configuración general de MANAGER solo la puede modificar SuperAdmin.'];
            if(serviceAccountEmail) parts.push('Compartí la hoja con '+serviceAccountEmail+' como Lector.');
            else parts.push('No hay Service Account configurada: la hoja debe estar publicada o accesible sin login.');
            if(!apiKeyConfigured) parts.push('Falta configurar HELP_API_KEY (o DOMAIN_STATUS_API_KEY/WWEB_API_KEY) para habilitar el acceso externo.');
            note.textContent=parts.join(' ');
          }
        }


        function toggleQrUi(){
          var enabled=document.getElementById('qrEnabled') && document.getElementById('qrEnabled').checked;
          var cfg=document.getElementById('qrConfigFields');
          if(cfg) cfg.style.display=enabled?'grid':'none';
          var aiEnabled=document.getElementById('qrAiEnabled') && document.getElementById('qrAiEnabled').checked;
          var aiRow=document.getElementById('qrAiToggleRow');
          if(aiRow) aiRow.style.display=enabled?'flex':'none';
          var aiBox=document.getElementById('qrAiConfig');
          if(aiBox) aiBox.style.display=(enabled&&aiEnabled)?'grid':'none';
          var same=document.getElementById('qrAiUseSameBehavior') && document.getElementById('qrAiUseSameBehavior').checked;
          var own=document.getElementById('qrAiOwnBehaviorWrap');
          if(own) own.style.display=(enabled&&aiEnabled&&!same)?'flex':'none';
          var tenant=String(document.getElementById('tenant')?.value||'DOMINIO').trim()||'DOMINIO';
          var example=document.getElementById('qrExampleUrl');
          if(example) example.textContent=location.origin+'/qr/'+encodeURIComponent(tenant)+'?codigo=CODIGO_ARTICULO';
        }

        ['qrEnabled','qrAiEnabled','qrAiUseSameBehavior'].forEach(function(id){
          var node=document.getElementById(id); if(node) node.addEventListener('change',toggleQrUi);
        });
        var helpEnabledNode=document.getElementById('helpEnabled'); if(helpEnabledNode) helpEnabledNode.addEventListener('change',toggleHelpUi);
        var tenantNode=document.getElementById('tenant'); if(tenantNode) tenantNode.addEventListener('input',toggleQrUi);


        async function load(){

          try{
            setBehaviorStatus('Cargando...',false);
            const t = document.getElementById('tenant').value || '';
            const r=await fetch('/api/behavior?tenant='+encodeURIComponent(t),{credentials:'same-origin',cache:'no-store'});
            let j={};
            try{j=await r.json();}catch{}
            if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
            document.getElementById('txt').value=j.text||'';
            document.getElementById('botMode').value = (j.bot_mode || 'pedidos');
            document.getElementById('historyMode').value = (j.history_mode || 'standard');
            document.getElementById('leadCaptureEnabled').checked = j.lead_capture_enabled === true;
            document.getElementById('helpEnabled').checked = j.help_enabled !== false;
            document.getElementById('helpAgent').value = j.help_agent || 'MANAGER';
            document.getElementById('helpModel').value = j.help_model || 'gpt-5.6-luna';
            document.getElementById('helpSourceUrl').value = j.help_source_url || '';
            document.getElementById('helpSourceCacheMinutes').value = j.help_source_cache_minutes || 5;
            document.getElementById('helpAiCacheDays').value = j.help_ai_cache_days || 3650;
            document.getElementById('helpMaxVideos').value = j.help_max_videos || 20;
            document.getElementById('helpBehavior').value = j.help_behavior || '';
            applyHelpEditable(j.help_config_editable === true,j.help_google_service_account_email||'',j.help_api_key_configured===true);
            toggleHelpUi();

            document.getElementById('qrEnabled').checked = j.qr_enabled === true;
            document.getElementById('qrPageTitle').value = j.qr_page_title || 'Información del producto';
            document.getElementById('qrPageSubtitle').value = j.qr_page_subtitle || '';
            document.getElementById('qrCompanyName').value = j.qr_company_name || '';
            document.getElementById('qrCompanyLogoUrl').value = j.qr_company_logo_url || '';
            document.getElementById('qrButtonColor').value = j.qr_button_color || '#0f766e';
            document.getElementById('qrButtonTextColor').value = j.qr_button_text_color || '#ffffff';
            document.getElementById('qrCurrency').value = j.qr_currency || 'ARS';
            document.getElementById('qrApiUrl').value = j.qr_api_url || '';
            document.getElementById('qrApiMethod').value = j.qr_api_method || 'GET';
            document.getElementById('qrApiCodeParam').value = j.qr_api_code_param || 'codigo';
            document.getElementById('qrApiBodyTemplate').value = j.qr_api_body_template || '';
            document.getElementById('qrApiAuthHeader').value = j.qr_api_auth_header || '';
            document.getElementById('qrApiAuthValue').value = '';
            document.getElementById('qrApiAuthValue').placeholder = j.qr_api_auth_value_set ? 'Hay una credencial guardada. Dejá vacío para conservarla.' : 'Opcional';
            document.getElementById('qrApiAuthClear').checked = false;
            document.getElementById('qrApiTimeout').value = j.qr_api_timeout_ms || 45000;
            document.getElementById('qrFieldCode').value = j.qr_field_code || 'Codigo';
            document.getElementById('qrFieldDescription').value = j.qr_field_description || 'Descripcion';
            document.getElementById('qrFieldPrice').value = j.qr_field_price || 'Precio_Lp1';
            document.getElementById('qrPriceLabel').value = j.qr_price_label || 'Precio';
            document.getElementById('qrPriceNote').value = j.qr_price_note || '';
            document.getElementById('qrAdditionalPrices').value = j.qr_additional_prices || '';
            document.getElementById('qrFieldStock').value = j.qr_field_stock || 'Stock';
            document.getElementById('qrFieldImage').value = j.qr_field_image || '';
            document.getElementById('qrImageMimeType').value = j.qr_image_mime_type || 'image/jpeg';
            document.getElementById('qrFieldBrand').value = j.qr_field_brand || '';
            document.getElementById('qrFieldCategory').value = j.qr_field_category || 'Desc_Rubro';
            document.getElementById('qrFieldSubcategory').value = j.qr_field_subcategory || 'Desc_Subrubro';
            document.getElementById('qrAiEnabled').checked = j.qr_ai_enabled !== false;
            document.getElementById('qrAiUseSameBehavior').checked = j.qr_ai_use_same_behavior !== false;
            document.getElementById('qrAiBehavior').value = j.qr_ai_behavior || '';
            document.getElementById('qrAiWebSearch').checked = j.qr_ai_web_search_enabled !== false;
            document.getElementById('qrAiWebContext').value = j.qr_ai_web_search_context_size || 'medium';
            document.getElementById('qrAiWebTimeout').value = j.qr_ai_web_search_timeout_ms || 90000;
            toggleQrUi();

            externalActions=(Array.isArray(j.external_actions)?j.external_actions:[]).map(normalizeClientAction);
            renderActions();
            setBehaviorStatus('Configuración cargada.',false);
          }catch(e){
            console.error('[behavior-ui] load error',e);
            setBehaviorStatus('Error al recuperar: '+String(e&&e.message||e),true);
          }

        }
        async function save(){
          const t=document.getElementById('tenant').value||'';
          const v=document.getElementById('txt').value||'';
          const m=document.getElementById('historyMode').value||'standard';
          const b=document.getElementById('botMode').value||'pedidos';
          const leadCaptureEnabled=document.getElementById('leadCaptureEnabled').checked === true;
          const helpPayload={
            help_enabled:document.getElementById('helpEnabled').checked===true,
            help_agent:document.getElementById('helpAgent').value||'MANAGER',
            help_model:document.getElementById('helpModel').value||'gpt-5.6-luna',
            help_source_url:document.getElementById('helpSourceUrl').value||'',
            help_source_cache_minutes:Number(document.getElementById('helpSourceCacheMinutes').value||5),
            help_ai_cache_days:Number(document.getElementById('helpAiCacheDays').value||3650),
            help_max_videos:Number(document.getElementById('helpMaxVideos').value||20),
            help_behavior:document.getElementById('helpBehavior').value||''
          };
          const qrPayload={
            qr_enabled:document.getElementById('qrEnabled').checked===true,
            qr_page_title:document.getElementById('qrPageTitle').value||'',
            qr_page_subtitle:document.getElementById('qrPageSubtitle').value||'',
            qr_company_name:document.getElementById('qrCompanyName').value||'',
            qr_company_logo_url:document.getElementById('qrCompanyLogoUrl').value||'',
            qr_button_color:document.getElementById('qrButtonColor').value||'#0f766e',
            qr_button_text_color:document.getElementById('qrButtonTextColor').value||'#ffffff',
            qr_currency:document.getElementById('qrCurrency').value||'ARS',
            qr_api_url:document.getElementById('qrApiUrl').value||'',
            qr_api_method:document.getElementById('qrApiMethod').value||'GET',
            qr_api_code_param:document.getElementById('qrApiCodeParam').value||'codigo',
            qr_api_body_template:document.getElementById('qrApiBodyTemplate').value||'',
            qr_api_auth_header:document.getElementById('qrApiAuthHeader').value||'',
            qr_api_auth_value:document.getElementById('qrApiAuthValue').value||'',
            qr_api_auth_clear:document.getElementById('qrApiAuthClear').checked===true,
            qr_api_timeout_ms:Number(document.getElementById('qrApiTimeout').value||45000),
            qr_field_code:document.getElementById('qrFieldCode').value||'Codigo',
            qr_field_description:document.getElementById('qrFieldDescription').value||'Descripcion',
            qr_field_price:document.getElementById('qrFieldPrice').value||'Precio_Lp1',
            qr_price_label:document.getElementById('qrPriceLabel').value||'Precio',
            qr_price_note:document.getElementById('qrPriceNote').value||'',
            qr_additional_prices:document.getElementById('qrAdditionalPrices').value||'',
            qr_field_stock:document.getElementById('qrFieldStock').value||'Stock',
            qr_field_image:document.getElementById('qrFieldImage').value||'',
            qr_image_mime_type:document.getElementById('qrImageMimeType').value||'image/jpeg',
            qr_field_brand:document.getElementById('qrFieldBrand').value||'',
            qr_field_category:document.getElementById('qrFieldCategory').value||'Desc_Rubro',
            qr_field_subcategory:document.getElementById('qrFieldSubcategory').value||'Desc_Subrubro',
            qr_ai_enabled:document.getElementById('qrAiEnabled').checked===true,
            qr_ai_use_same_behavior:document.getElementById('qrAiUseSameBehavior').checked===true,
            qr_ai_behavior:document.getElementById('qrAiBehavior').value||'',
            qr_ai_web_search_enabled:document.getElementById('qrAiWebSearch').checked===true,
            qr_ai_web_search_context_size:document.getElementById('qrAiWebContext').value||'medium',
            qr_ai_web_search_timeout_ms:Number(document.getElementById('qrAiWebTimeout').value||90000)
          };

          setBehaviorStatus('Guardando...',false);
          
          const r=await fetch('/api/behavior?tenant='+encodeURIComponent(t),{
            method:'POST',
            credentials:'same-origin',
            cache:'no-store',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
              text:v,tenantId:t,history_mode:m,bot_mode:b,lead_capture_enabled:leadCaptureEnabled,
              external_actions:externalActions,
              ...helpPayload,
              ...qrPayload
            })
          });
          
          let j={}; try{j=await r.json();}catch{}
          if(!r.ok){
            setBehaviorStatus('Error al guardar: '+(j.error||('HTTP '+r.status)),true);
            alert('Error al guardar: '+(j.error||'internal'));
            return;
          }
          setBehaviorStatus('Guardado ✅',false);
          await load();
        }
        document.getElementById('btnSave').addEventListener('click',save);
        document.getElementById('btnReload').addEventListener('click',load);
      
        load();
      
`);
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
      <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:1100px}
      textarea{width:100%;min-height:360px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}
      .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.hint{color:#666;font-size:12px}.tag{padding:2px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px}
      input[type=text],input[type=password],input[type=number],select{padding:6px 8px}
      .externalCard{margin-top:14px;padding:14px;border:1px solid #ddd;border-radius:10px;background:#fafafa}
      .externalGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;margin-top:10px}
      .externalGrid label{display:flex;flex-direction:column;gap:4px;font-size:13px}
      .externalGrid input,.externalGrid select{width:100%;box-sizing:border-box}
      textarea.smallArea{min-height:90px}
      .actionsToolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
      .actionCard{margin-top:12px;padding:14px;border:1px solid #cfd6dd;border-radius:10px;background:#fff}
      .actionHeader{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
      .actionHeaderLeft{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .actionType{font-size:12px;font-weight:700;padding:3px 8px;border-radius:999px;background:#eef2ff;color:#3730a3}
      .danger{background:#b91c1c;color:#fff;border:0;border-radius:7px;padding:7px 10px;cursor:pointer}
      .addBtn{background:#0f766e;color:#fff;border:0;border-radius:7px;padding:8px 11px;cursor:pointer;font-weight:600}
      .emptyActions{padding:16px;border:1px dashed #bbb;border-radius:8px;color:#666;margin-top:12px}
      @media(max-width:760px){.externalGrid{grid-template-columns:1fr}}
      </style></head><body>
      <h1>Comportamiento del Bot</h1>
      <div class="row">
        <label>Dominio:&nbsp;<input id="tenant" type="text" value="${tenant}" /></label>
        <button id="btnReload">Recargar</button>
        <button id="btnSave">Guardar</button>
      </div>
      <div class="row" style="margin-top:8px">
        <label>Tipo de bot:&nbsp;
          <select id="botMode">
            <option value="pedidos">Pedidos (modo actual)</option>
            <option value="conversacional">Conversacional / pruebas</option>
          </select>
        </label>
        <span class="hint">Conversacional usa solo Comportamiento + historial y no ejecuta reglas de pedidos.</span>
      </div>
      <div class="row" style="margin-top:8px">
        <label>Modo de historial:&nbsp;
          <select id="historyMode">
            <option value="standard">standard (completo)</option>
            <option value="compact">compact (recomendado para Conversacional)</option>
            <option value="minimal">minimal (solo Pedidos)</option>
          </select>
        </label>
        <span class="hint">Compact conserva hasta 10 intercambios recientes y evita que una conversación larga reenvíe todo el historial a la IA.</span>
      </div>
      <div class="row" style="margin-top:8px">
        <label>
          <input id="leadCaptureEnabled" type="checkbox" />
          Capturar leads / solicitudes de cotización automáticamente
        </label>
        <span class="hint">Solo se aplica al modo Conversacional. Los pedidos no usan esta opción.</span>
      </div>

      <div class="externalCard" style="margin-top:18px">
        <div class="row"><strong>Ayuda contextual de Manager</strong><span class="tag">Nueva herramienta</span></div>
        <div class="hint" style="margin-top:4px">La habilitación es por dominio Asisto y el agente identifica a qué dominio pertenece. La fuente, modelo y reglas de cada agente son globales. Las ventanas técnicas exactas se resuelven sin IA; solo las categorías escritas en lenguaje natural consumen tokens.</div>
        <div class="row" style="margin-top:10px"><label><input id="helpEnabled" type="checkbox" /> Habilitar API de Ayuda en este dominio</label></div>
        <div id="helpConfigFields" class="externalGrid" style="margin-top:10px">
          <label>Agente<input id="helpAgent" type="text" value="MANAGER" readonly /></label>
          <label>Modelo para categorías<input id="helpModel" type="text" value="gpt-5.6-luna" placeholder="gpt-5.6-luna" /></label>
          <label style="grid-column:1/-1">Fuente Google Sheets / CSV<input id="helpSourceUrl" type="text" placeholder="https://docs.google.com/spreadsheets/d/.../edit?gid=0" /><span class="hint">Si hay Service Account configurada, la hoja puede quedar privada y debe compartirse como lector con esa cuenta. Sin Service Account, la hoja debe ser accesible por enlace/publicación CSV.</span></label>
          <label>Cache de la hoja (minutos)<input id="helpSourceCacheMinutes" type="number" min="1" max="60" value="5" /></label>
          <label>Cache decisiones IA (días)<input id="helpAiCacheDays" type="number" min="1" max="3650" value="3650" /></label>
          <label>Máximo de videos por respuesta<input id="helpMaxVideos" type="number" min="1" max="100" value="20" /></label>
          <label style="grid-column:1/-1">Comportamiento para resolver categorías<textarea id="helpBehavior" class="smallArea" placeholder="Reglas para decidir si una ventana técnica pertenece a una categoría..."></textarea></label>
          <div style="grid-column:1/-1" class="hint">API: <b>/api/ext/help</b> o <b>/api/ext/ayuda</b>. Requiere <code>X-API-Key</code> y los parámetros agente, ventana, version, dominio y usuario. La fecha la fija Asisto.</div>
          <div id="helpConfigNote" style="grid-column:1/-1" class="hint"></div>
        </div>
      </div>

        <div class="row" style="margin-top:18px"><strong>Ficha pública de producto por QR</strong></div>
        <div class="hint" style="margin-top:4px">El escaneo consulta únicamente esta API y muestra la ficha sin consumir tokens. La IA se activa recién cuando el visitante toca “Mostrar más info” o abre el chat.</div>
        <div class="row" style="margin-top:10px"><label><input id="qrEnabled" type="checkbox" /> Habilitar ficha QR para este dominio</label></div>
        <div id="qrConfigFields" class="externalGrid" style="margin-top:12px">
          <label>Nombre de la empresa<input id="qrCompanyName" type="text" placeholder="FERROMAQ Industrial" /></label>
          <label>Moneda<input id="qrCurrency" type="text" value="ARS" maxlength="10" /></label>
          <label style="grid-column:1/-1">URL del logo de la empresa<input id="qrCompanyLogoUrl" type="text" placeholder="https://empresa.com/logo.png" /><span class="hint">Debe ser una imagen pública accesible desde el celular. Si queda vacío se muestra la inicial de la empresa.</span></label>
          <label>Título de la página<input id="qrPageTitle" type="text" value="Información del producto" /></label>
          <label>Color de botones<input id="qrButtonColor" type="color" value="#0f766e" /></label>
          <label style="grid-column:1/-1">Subtítulo<input id="qrPageSubtitle" type="text" value="Consultá precio, disponibilidad y más información." /></label>
          <label>Color de texto de botones<input id="qrButtonTextColor" type="color" value="#ffffff" /></label>
          <label style="grid-column:1/-1">URL API de producto<input id="qrApiUrl" type="text" placeholder="https://servidor/api/articulos/consulta?key=..." /><span class="hint">Podés usar {{codigo}} dentro de la URL o indicar el parámetro en el campo siguiente.</span></label>
          <label>Método<select id="qrApiMethod"><option value="GET">GET</option><option value="POST">POST</option></select></label>
          <label>Parámetro de código<input id="qrApiCodeParam" type="text" value="codigo" placeholder="codigo" /></label>
          <label>Timeout API producto (ms)<input id="qrApiTimeout" type="number" min="5000" max="120000" value="45000" /><span class="hint">Tiempo máximo por intento. Para GET, Asisto reintenta una vez ante timeout o error transitorio.</span></label>
          <label>Header de autenticación<input id="qrApiAuthHeader" type="text" placeholder="X-API-Key / Authorization (opcional)" /></label>
          <label style="grid-column:1/-1">Valor del header / secreto<input id="qrApiAuthValue" type="password" autocomplete="new-password" placeholder="Opcional" /><span><input id="qrApiAuthClear" type="checkbox" /> Borrar credencial guardada</span></label>
          <label style="grid-column:1/-1">Body JSON para POST (opcional)<textarea id="qrApiBodyTemplate" class="smallArea" placeholder='{"codigo":"{{codigo}}"}'></textarea></label>
          <label>Campo código / SKU<input id="qrFieldCode" type="text" value="Codigo" /></label>
          <label>Campo descripción<input id="qrFieldDescription" type="text" value="Descripcion" /></label>
          <label>Campo precio principal<input id="qrFieldPrice" type="text" value="Precio_Lp1" /></label>
          <label>Rótulo precio principal<input id="qrPriceLabel" type="text" value="Precio" placeholder="Precio" /></label>
          <label style="grid-column:1/-1">Texto debajo del precio principal (opcional)<input id="qrPriceNote" type="text" placeholder="Ej.: Precio de lista" /></label>
          <label style="grid-column:1/-1">Precios adicionales<textarea id="qrAdditionalPrices" class="smallArea" placeholder="Precio_Lp2|con Transferencia o depósito&#10;Precio_Lp3|en 3 cuotas"></textarea><span class="hint">Una línea por lista. Formato simple: CAMPO|texto. También admite CAMPO|rótulo|texto. Solo se muestran los campos que el API devuelva con un valor.</span></label>

          <label>Campo stock/disponibilidad<input id="qrFieldStock" type="text" value="Stock" /></label>
          <label>Campo imagen (opcional)<input id="qrFieldImage" type="text" placeholder="Imagen" /><span class="hint">Puede devolver URL, data:image/...;base64 o Base64 puro.</span></label>
          <label>MIME imagen Base64<input id="qrImageMimeType" type="text" value="image/jpeg" placeholder="image/jpeg" /><span class="hint">Se usa solamente cuando el API devuelve Base64 puro.</span></label>
          <label>Campo marca (opcional)<input id="qrFieldBrand" type="text" placeholder="Marca" /></label>
          <label>Campo rubro<input id="qrFieldCategory" type="text" value="Desc_Rubro" /></label>
          <label>Campo subrubro<input id="qrFieldSubcategory" type="text" value="Desc_Subrubro" /></label>
          <div style="grid-column:1/-1" class="hint">URL que deberán contener los QR: <b id="qrExampleUrl"></b></div>
        </div>
        <div class="row" id="qrAiToggleRow" style="margin-top:14px"><label><input id="qrAiEnabled" type="checkbox" checked /> Habilitar “Mostrar más info” + chat con IA</label></div>
        <div id="qrAiConfig" class="externalGrid" style="margin-top:10px">
          <label style="grid-column:1/-1"><span><input id="qrAiUseSameBehavior" type="checkbox" checked /> Usar el mismo comportamiento Conversacional del dominio</span><span class="hint">Si lo desmarcás, podés escribir un comportamiento exclusivo para la ficha QR.</span></label>
          <label id="qrAiOwnBehaviorWrap" style="grid-column:1/-1;display:none">Comportamiento exclusivo para QR<textarea id="qrAiBehavior" class="smallArea" placeholder="Cómo debe responder el asesor IA de la ficha QR..."></textarea></label>
          <label><span><input id="qrAiWebSearch" type="checkbox" checked /> Permitir búsqueda en Internet</span><span class="hint">Se usa para ampliar información técnica. Nunca reemplaza precio ni stock de la API.</span></label>
          <label>Contexto de búsqueda<select id="qrAiWebContext"><option value="low">low</option><option value="medium" selected>medium</option><option value="high">high</option></select></label>
          <label>Timeout búsqueda web (ms)<input id="qrAiWebTimeout" type="number" min="10000" max="120000" step="1000" value="90000" /><span class="hint">Tiempo máximo para la búsqueda de Internet. Recomendado: 90000.</span></label>
        </div>
      </div>

      <div class="externalCard">
        <div class="row"><strong>Acciones externas</strong></div>
        <div class="hint" style="margin-top:4px">Podés configurar varias APIs y búsquedas web. El bot conversacional elige la acción por su nombre/descripción y puede encadenar hasta 4 acciones en un mismo turno.</div>
        <div class="actionsToolbar">
          <button id="btnAddApi" class="addBtn" type="button">+ Agregar API</button>
          <button id="btnAddWeb" class="addBtn" type="button">+ Agregar búsqueda web</button>
        </div>
        <div id="actionsContainer"></div>
        <div id="behaviorStatus" class="hint" style="margin-top:10px"></div>
      </div>

     <p></p><textarea id="txt" placeholder="Escribí aquí el comportamiento para este dominio..."></textarea>
      <script src="/comportamiento-ui.js"></script></body></html>`);
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
  <h1>Canales (WhatsApp / Instagram / OpenAI)</h1>
  <div class="muted">Configurá por <b>dominio</b> un canal de WhatsApp o Instagram y la API key de OpenAI (colección <code>tenant_channels</code>). Podés marcar un canal como <b>Default</b> por dominio.</div>

  <div id="msg"></div>

  <div class="row" style="margin-top:14px">
    <div class="card">
      <h3 style="margin:0 0 8px">Crear / actualizar</h3>
      <form id="f">
      <input type="hidden" name="_id" value=""/>
        <label>Dominio</label>
        <input name="tenantId" value="${String(tenant||'').replace(/"/g,'&quot;')}" placeholder="default"/>

        <label>Tipo de canal</label>
        <select name="channelType" id="channelType" style="width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:8px">
          <option value="whatsapp">WhatsApp</option>
          <option value="instagram">Instagram</option>
        </select>

        <div id="waFields">
          <label>Phone Number ID (Meta)</label>
          <input name="phoneNumberId" placeholder="1234567890"/>

          <label>Display phone (opcional)</label>
          <input name="displayPhoneNumber" placeholder="+54 9 ..."/>

          <label>Transporte</label>
          <select name="whatsappTransport" style="width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:8px">
            <option value="api">API Meta</option>
            <option value="wweb">WhatsApp Web</option>
          </select>

          <label>Lógica WhatsApp Web</label>
          <select name="wwebBotLogicMode" style="width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:8px">
            <option value="api">API configurada / mensajes</option>
            <option value="chatgpt">Asisto ChatGPT / pedidos</option>
          </select>
          <div class="muted">Solo se usa cuando el transporte del canal es WhatsApp Web.</div>

          <label>WhatsApp Token</label>
          <input name="whatsappToken" placeholder="EAAG..." />

          <label>Verify Token</label>
          <input name="verifyToken" placeholder="mi-token-verificacion" />
        </div>

        <div id="igFields" style="display:none">
          <label>Instagram Account ID</label>
          <input name="instagramAccountId" placeholder="1784..." />

          <label>Facebook Page ID vinculada</label>
          <input name="instagramPageId" placeholder="1234567890" />

          <label>Instagram Access Token</label>
          <input name="instagramAccessToken" placeholder="EAAG..." />
        </div>

        <label>OpenAI API Key</label>
        <input name="openaiApiKey" placeholder="sk-..." />

        <label>Espera antes de procesar (ms)</label>
        <input name="messageDebounceMs" placeholder="0 = sin espera (ej: 1200)" />
        <div class="muted">Si el cliente manda varios textos seguidos, se juntan y se envían a ChatGPT como uno solo, separados por coma.</div>

        <label style="display:flex;gap:10px;align-items:center;margin-top:12px">
          <input type="checkbox" name="isDefault" value="1" style="width:auto"/>
          <span>Canal default (por dominio)</span>
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
               <th>Dominio</th>
              <th>Tipo</th>
              <th>Canal ID</th>
              <th>Display</th>
              <th>Transporte</th>
              <th>Lógica WWeb</th>
              <th>Default</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="tbody">
            <tr><td colspan="9" class="muted">Cargando...</td></tr>
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
    tbody.innerHTML = '<tr><td colspan="9" class="muted">Cargando...</td></tr>';

    let items = [];
    try {
      const tenantId = (form.tenantId.value||'').trim();
      const qs = tenantId ? ('?tenantId='+encodeURIComponent(tenantId)) : '';

      const r = await fetch('/api/tenant-channels'+qs, {
        headers: { 'Accept':'application/json' },
        credentials: 'same-origin',
      });

      if(!r.ok){
        const jErr = await r.json().catch(()=>null);
        const msg = (jErr && (jErr.error || jErr.message)) ? (jErr.error || jErr.message) : ('HTTP ' + r.status);
        tbody.innerHTML = '<tr><td colspan="9">No se pudo cargar: '+esc(msg)+'</td></tr>';
        return;
      }

      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      if(!ct.includes('application/json')){
        tbody.innerHTML = '<tr><td colspan="9">No se pudo cargar (respuesta no JSON). Probable sesión vencida/redirección a login. Refrescá o volvé a iniciar sesión.</td></tr>';
        return;
      }

      const j = await r.json();
      items = Array.isArray(j.items) ? j.items : [];
      if(!items.length){
        tbody.innerHTML = '<tr><td colspan="9" class="muted">No hay canales cargados.</td></tr>';
        return;
      }

      const defaultCountByTenant = items.reduce((acc, it) => {
        const key = String((it && it.tenantId) || '');
        if (it && it.isDefault) acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});


      tbody.innerHTML = items.map(it => {
        const tenantKey = String((it && it.tenantId) || '');
        const hasDuplicateDefault = !!(it && it.isDefault && defaultCountByTenant[tenantKey] > 1);
        const def = (it && it.isDefault) ? (hasDuplicateDefault ? '✅ ⚠️' : '✅') : '';
        const channelId = (it.channelType === 'instagram')
          ? (it.instagramAccountId || '')
          : (it.phoneNumberId || '');
        const btnDefault = (!it.isDefault || hasDuplicateDefault) ?
          '<button type="button" class="secondary" data-make-default="1" data-id="'+esc(it._id||'')+'" data-tenant="'+esc(it.tenantId||'')+'" data-type="'+esc(it.channelType||'whatsapp')+'" data-phone="'+esc(it.phoneNumberId||'')+'" data-ig="'+esc(it.instagramAccountId||'')+'">Hacer default</button>' : '';

        return '<tr>'+
          '<td><span class="pill">'+esc(it.tenantId||'')+'</span></td>'+
          '<td>'+esc(it.channelType||'whatsapp')+'</td>'+
          '<td>'+esc(channelId)+'</td>'+
          '<td>'+esc(it.displayPhoneNumber || it.instagramPageId || '')+'</td>'+
          '<td>'+esc((it.channelType === 'whatsapp' ? (it.whatsappTransport || 'api') : ''))+'</td>'+
          '<td>'+esc((it.channelType === 'whatsapp' && (it.whatsappTransport || 'api') === 'wweb' ? (it.wwebBotLogicMode || 'api') : ''))+'</td>'+
          '<td>'+def+'</td>'+
          '<td class="muted">'+esc(it.updatedAt||it.createdAt||'')+'</td>'+
          '<td class="actions">'+
            '<button type="button" class="secondary" data-edit="'+esc(it._id)+'">Editar</button>'+
            '<button type="button" class="secondary" data-delete="'+esc(it._id)+'" data-delete-name="'+esc(it.displayPhoneNumber || it.phoneNumberId || it.instagramAccountId || '')+'">Eliminar</button>'+
            btnDefault +
          '</td>'+
        '</tr>';
      }).join('');

      // Editar
      tbody.querySelectorAll('button[data-edit]').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const id = btn.getAttribute('data-edit');
          const it = items.find(x => String(x._id)===String(id));
          if(!it) return;

          if (form._id) form._id.value = it._id || '';
          form.tenantId.value = it.tenantId || '';
          if (form.channelType) form.channelType.value = it.channelType || 'whatsapp';
          form.phoneNumberId.value = it.phoneNumberId || '';
          form.displayPhoneNumber.value = it.displayPhoneNumber || '';
          if (form.whatsappTransport) form.whatsappTransport.value = it.whatsappTransport || 'api';
          if (form.wwebBotLogicMode) form.wwebBotLogicMode.value = it.wwebBotLogicMode || 'api';
          form.instagramAccountId.value = it.instagramAccountId || '';
          form.instagramPageId.value = it.instagramPageId || '';

          // secretos pueden venir enmascarados si no sos superadmin
          form.whatsappToken.value = (it.whatsappToken && it.whatsappToken !== '********') ? it.whatsappToken : '';
          form.instagramAccessToken.value = (it.instagramAccessToken && it.instagramAccessToken !== '********') ? it.instagramAccessToken : '';
          form.verifyToken.value   = (it.verifyToken && it.verifyToken !== '********') ? it.verifyToken : '';
          form.openaiApiKey.value  = (it.openaiApiKey && it.openaiApiKey !== '********') ? it.openaiApiKey : '';
          if (form.messageDebounceMs) form.messageDebounceMs.value = String(it.messageDebounceMs ?? '');
          const cb = form.querySelector('input[name="isDefault"]');
          if (cb) cb.checked = !!it.isDefault;
          toggleChannelFields();

          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      });

      // Eliminar canal
      tbody.querySelectorAll('button[data-delete]').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const id = btn.getAttribute('data-delete') || '';
          const name = btn.getAttribute('data-delete-name') || '';
          if(!id) return;
          if(!window.confirm('¿Eliminar el canal '+name+'?')) return;

          setMsg('', '');
          const rr = await fetch('/api/tenant-channels/'+encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'Accept':'application/json' },
            credentials: 'same-origin'
          });
          const jj = await rr.json().catch(()=>null);
          if(!rr.ok){
           setMsg('err', (jj && jj.error) ? jj.error : 'Error eliminando canal.');
            return;
          }
          if (form._id && String(form._id.value||'') === String(id)) {
            form._id.value = '';
          }
          setMsg('ok', 'Canal eliminado ✅');
          await load();
        });
      });


      // Hacer default
      tbody.querySelectorAll('button[data-make-default]').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const id = btn.getAttribute('data-id') || '';
          const t = btn.getAttribute('data-tenant') || '';
          const type = btn.getAttribute('data-type') || 'whatsapp';
          const p = btn.getAttribute('data-phone') || '';
          const ig = btn.getAttribute('data-ig') || '';
          if(!id || !t || (type === 'instagram' ? !ig : !p)) return;

          setMsg('', '');
          const data = new URLSearchParams();
          data.set('_id', id);
          data.set('tenantId', t);
          data.set('channelType', type);
          if (type === 'instagram') data.set('instagramAccountId', ig);
          else data.set('phoneNumberId', p);
          data.set('isDefault', '1');

          const rr = await fetch('/api/tenant-channels', {
            method: 'POST',
            headers: { 'Content-Type':'application/x-www-form-urlencoded' },
            credentials: 'same-origin',
            body: data
          });

          const jj = await rr.json().catch(()=>null);
          if(!rr.ok){
            setMsg('err', (jj && jj.error) ? jj.error : 'Error seteando default.');
            return;
          }
          setMsg('ok', 'Default actualizado ✅');
          await load();
        });
      });

    } catch (e) {
      console.error('[canales] load error:', e);
      tbody.innerHTML = '<tr><td colspan="9">Error cargando canales: '+esc(e?.message || String(e))+'</td></tr>';
    }
  }

  // Guardar (upsert)
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    setMsg('', '');
    const data = new URLSearchParams(new FormData(form));

    const r = await fetch('/api/tenant-channels', {
      method: 'POST',
      headers: { 'Content-Type':'application/x-www-form-urlencoded' },
      credentials: 'same-origin',
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

  function toggleChannelFields(){
    const type = (form.channelType && form.channelType.value) || 'whatsapp';
    const wa = document.getElementById('waFields');
    const ig = document.getElementById('igFields');
    if (wa) wa.style.display = type === 'instagram' ? 'none' : '';
    if (ig) ig.style.display = type === 'instagram' ? '' : 'none';
  }

  if (form.channelType) {
    form.channelType.addEventListener('change', toggleChannelFields);
    toggleChannelFields();
  }

  btnClear.addEventListener('click', ()=>{
    const keepTenant = form.tenantId.value;
    form.reset();
    if (form._id) form._id.value = '';
    form.tenantId.value = keepTenant;
    if (form.channelType) form.channelType.value = 'whatsapp';
    if (form.wwebBotLogicMode) form.wwebBotLogicMode.value = 'api';
    toggleChannelFields();
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
    const [cfg, helpDomainCfg] = await Promise.all([
      loadBehaviorConfigFromMongo(tenant),
      loadHelpDomainConfig(tenant, { force: true })
    ]);
    const helpCfg = await loadHelpConfig(helpDomainCfg.agent || "MANAGER");
    const helpPublic = publicHelpConfig(helpCfg);

    res.json({
      source: "mongo",
      tenant,
      text: cfg.text,
      history_mode: cfg.history_mode,
      bot_mode: normalizeBotMode(cfg.bot_mode),
      lead_capture_enabled: cfg.lead_capture_enabled === true,
      external_actions: publicBehaviorExternalActions(cfg.external_actions || []),

      // Campos históricos: se conservan para clientes/versiones anteriores.
      external_api_enabled: cfg.external_api_enabled === true,
      external_api_action_name: cfg.external_api_action_name || "consulta_externa",
      external_api_description: cfg.external_api_description || "",
      external_api_url: cfg.external_api_url || "",
      external_api_method: cfg.external_api_method || "GET",
      external_api_query_param: cfg.external_api_query_param ?? "buscar",
      external_api_body_template: cfg.external_api_body_template || "",
      external_api_auth_header: cfg.external_api_auth_header || "",
      external_api_auth_value_set: !!cfg.external_api_auth_value,
      external_api_timeout_ms: cfg.external_api_timeout_ms || 10000,
      external_api_max_chars: cfg.external_api_max_chars || 30000,
      external_api_result_instructions: cfg.external_api_result_instructions || "",

      // Ayuda: habilitación por dominio; configuración general MANAGER global.
      help_enabled: helpDomainCfg.enabled === true,
      help_agent: helpDomainCfg.agent || helpPublic.agent || "MANAGER",
      help_source_url: helpPublic.source_url || "",
      help_model: helpPublic.model || "gpt-5.6-luna",
      help_behavior: helpPublic.behavior || "",
      help_source_cache_minutes: helpPublic.source_cache_minutes || 5,
      help_ai_cache_days: helpPublic.ai_cache_days || 3650,
      help_max_videos: helpPublic.max_videos || 20,
      help_google_service_account_email: helpPublic.google_service_account_email || null,
      help_api_key_configured: helpPublic.api_key_configured === true,
      help_config_editable: String(req.user?.role || "").toLowerCase() === "superadmin",


      // Ficha pública por QR. El secreto nunca se devuelve al navegador.
      qr_enabled: cfg.qr_enabled === true,
      qr_page_title: cfg.qr_page_title || "Información del producto",
      qr_page_subtitle: cfg.qr_page_subtitle || "",
      qr_company_name: cfg.qr_company_name || "",
      qr_company_logo_url: cfg.qr_company_logo_url || "",
      qr_button_color: cfg.qr_button_color || "#0f766e",
      qr_button_text_color: cfg.qr_button_text_color || "#ffffff",
      qr_currency: cfg.qr_currency || "ARS",
      qr_api_url: cfg.qr_api_url || "",
      qr_api_method: cfg.qr_api_method || "GET",
      qr_api_code_param: cfg.qr_api_code_param || "codigo",
      qr_api_body_template: cfg.qr_api_body_template || "",
      qr_api_auth_header: cfg.qr_api_auth_header || "",
      qr_api_auth_value_set: !!cfg.qr_api_auth_value,
      qr_api_timeout_ms: cfg.qr_api_timeout_ms || 45000,
      qr_field_code: cfg.qr_field_code || "Codigo",
      qr_field_description: cfg.qr_field_description || "Descripcion",
      qr_field_price: cfg.qr_field_price || "Precio_Lp1",
      qr_price_label: cfg.qr_price_label || "Precio",
      qr_price_note: cfg.qr_price_note || "",
      qr_additional_prices: cfg.qr_additional_prices || "",
      qr_field_stock: cfg.qr_field_stock || "Stock",
      qr_field_image: cfg.qr_field_image || "",
      qr_image_mime_type: cfg.qr_image_mime_type || "image/jpeg",
      qr_field_brand: cfg.qr_field_brand || "",
      qr_field_category: cfg.qr_field_category || "Desc_Rubro",
      qr_field_subcategory: cfg.qr_field_subcategory || "Desc_Subrubro",
      qr_ai_enabled: cfg.qr_ai_enabled !== false,
      qr_ai_use_same_behavior: cfg.qr_ai_use_same_behavior !== false,
      qr_ai_behavior: cfg.qr_ai_behavior || "",
      qr_ai_web_search_enabled: cfg.qr_ai_web_search_enabled !== false,
      qr_ai_web_search_context_size: cfg.qr_ai_web_search_context_size || "medium",
      qr_ai_web_search_timeout_ms: cfg.qr_ai_web_search_timeout_ms || 90000
    });
  } catch (e) {
    console.error("GET /api/behavior error:", e?.message || e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/behavior", async (req, res) => {
  try {
    const tenant = (req.body?.tenantId || resolveTenantId(req)).toString().trim();
    const text = String(req.body?.text || "").trim();
    const history_mode = String(req.body?.history_mode || "").trim() || "standard";
    const bot_mode = normalizeBotMode(req.body?.bot_mode || req.body?.botMode || "pedidos");
    const leadCaptureRaw = req.body?.lead_capture_enabled ?? req.body?.leadCaptureEnabled ?? false;
    const lead_capture_enabled = behaviorBool(leadCaptureRaw, false);
    const db = await require("./db").getDb();
    const _id = `behavior:${tenant}`;
    const existing = await db.collection("settings").findOne({ _id }) || {};

    const isSuperadmin = String(req.user?.role || "").toLowerCase() === "superadmin";
    const hasHelpPayload = Object.keys(req.body || {}).some((key) => String(key).startsWith("help_"));
    const helpDomainEnabled = (isSuperadmin && hasHelpPayload)
      ? behaviorBool(req.body?.help_enabled, false)
      : null;

    const helpPayload = (isSuperadmin && hasHelpPayload) ? {

      agent: req.body?.help_agent || "MANAGER",
      source_url: req.body?.help_source_url,
      model: req.body?.help_model,
      behavior: req.body?.help_behavior,
      source_cache_ms: Math.max(1, Math.min(60, Number(req.body?.help_source_cache_minutes || 5) || 5)) * 60000,
      ai_cache_days: Math.max(1, Math.min(3650, Number(req.body?.help_ai_cache_days || 3650) || 3650)),
      max_videos: Math.max(1, Math.min(100, Number(req.body?.help_max_videos || 20) || 20))
    } : null;


    let rawActions = req.body?.external_actions ?? req.body?.externalActions;
    if (!Array.isArray(rawActions)) {
      const legacy = legacyBehaviorActionFromBody(req.body || {});
      rawActions = legacy ? [legacy] : (Array.isArray(existing.external_actions) ? existing.external_actions : []);
    }

    const existingActionsForSecrets = Array.isArray(existing.external_actions)
      ? existing.external_actions
      : (String(existing.external_api_url || "").trim() || existing.external_api_auth_value
          ? [{
              id: "legacy_external_api",
              type: "api",
              name: existing.external_api_action_name || "consulta_externa",
              auth_value: existing.external_api_auth_value || ""
            }]
          : []);

    let external_actions;
    try {
      external_actions = sanitizeBehaviorExternalActions(rawActions, existingActionsForSecrets);
    } catch (validationError) {
      return res.status(400).json({ error: String(validationError?.message || validationError || "external_actions_invalid") });
    }
 
    // Espejar la primera acción API a los campos históricos para que una versión
    // vieja del runtime siga funcionando durante despliegues escalonados.
    const firstApi = external_actions.find((item) => item.type === "api" && item.enabled) ||
      external_actions.find((item) => item.type === "api") || null;

    // Configuración de ficha pública por QR. Esta API se consulta sin OpenAI;
    // la IA queda separada y se activa recién desde "Mostrar más info"/chat.
    const qr_enabled = behaviorBool(req.body?.qr_enabled, false);
    const qr_page_title = String(req.body?.qr_page_title || "Información del producto").trim().slice(0, 120);
    const qr_page_subtitle = String(req.body?.qr_page_subtitle || "").trim().slice(0, 220);
    const qr_company_name = String(req.body?.qr_company_name || "").trim().slice(0, 140);
    const qr_company_logo_url = String(req.body?.qr_company_logo_url || "").trim().replace(/[\r\n]/g, "").slice(0, 3000);
    const qrButtonColorRaw = String(req.body?.qr_button_color || "#0f766e").trim();
    const qr_button_color = /^#[0-9a-f]{6}$/i.test(qrButtonColorRaw) ? qrButtonColorRaw : "#0f766e";
    const qrButtonTextColorRaw = String(req.body?.qr_button_text_color || "#ffffff").trim();
    const qr_button_text_color = /^#[0-9a-f]{6}$/i.test(qrButtonTextColorRaw) ? qrButtonTextColorRaw : "#ffffff";
    const qr_currency = String(req.body?.qr_currency || "ARS").trim().toUpperCase().slice(0, 10) || "ARS";
    const qr_api_url = String(req.body?.qr_api_url || "").trim().slice(0, 3000);
    const qr_api_method = String(req.body?.qr_api_method || "GET").trim().toUpperCase() === "POST" ? "POST" : "GET";
    const qr_api_code_param = String(req.body?.qr_api_code_param || "codigo").trim().slice(0, 100);
    const qr_api_body_template = String(req.body?.qr_api_body_template || "").trim().slice(0, 20000);
    const qr_api_auth_header = String(req.body?.qr_api_auth_header || "").trim().replace(/[\r\n]/g, "").slice(0, 200);
    const qr_api_timeout_ms = Math.max(5000, Math.min(120000, Number(req.body?.qr_api_timeout_ms || 45000) || 45000));
    const qr_field_code = String(req.body?.qr_field_code || "Codigo").trim().slice(0, 120);
    const qr_field_description = String(req.body?.qr_field_description || "Descripcion").trim().slice(0, 120);
    const qr_field_price = String(req.body?.qr_field_price || "Precio_Lp1").trim().slice(0, 120);
    const qr_price_label = String(req.body?.qr_price_label || "Precio").trim().slice(0, 80) || "Precio";
    const qr_price_note = String(req.body?.qr_price_note || "").trim().slice(0, 180);
    const qr_additional_prices = String(req.body?.qr_additional_prices || "").trim().slice(0, 8000);
    const qr_field_stock = String(req.body?.qr_field_stock || "Stock").trim().slice(0, 120);
    const qr_field_image = String(req.body?.qr_field_image || "").trim().slice(0, 120);
    const qrImageMimeRaw = String(req.body?.qr_image_mime_type || "image/jpeg").trim().toLowerCase();
    const qr_image_mime_type = /^image\/[a-z0-9.+-]+$/i.test(qrImageMimeRaw) ? qrImageMimeRaw : "image/jpeg";
    const qr_field_brand = String(req.body?.qr_field_brand || "").trim().slice(0, 120);
    const qr_field_category = String(req.body?.qr_field_category || "Desc_Rubro").trim().slice(0, 120);
    const qr_field_subcategory = String(req.body?.qr_field_subcategory || "Desc_Subrubro").trim().slice(0, 120);
    const qr_ai_enabled = behaviorBool(req.body?.qr_ai_enabled, true);
    const qr_ai_use_same_behavior = behaviorBool(req.body?.qr_ai_use_same_behavior, true);
    const qr_ai_behavior = String(req.body?.qr_ai_behavior || "").trim().slice(0, 30000);
    const qr_ai_web_search_enabled = behaviorBool(req.body?.qr_ai_web_search_enabled, true);
    const qrWebCtxRaw = String(req.body?.qr_ai_web_search_context_size || "medium").trim().toLowerCase();
    const qr_ai_web_search_context_size = ["low", "medium", "high"].includes(qrWebCtxRaw) ? qrWebCtxRaw : "medium";
    const qr_ai_web_search_timeout_ms = Math.max(10000, Math.min(120000, Number(req.body?.qr_ai_web_search_timeout_ms || 90000) || 90000));
    const qrIncomingSecret = String(req.body?.qr_api_auth_value || "").trim().replace(/[\r\n]/g, "").slice(0, 4000);
    const qrClearSecret = behaviorBool(req.body?.qr_api_auth_clear, false);

    if (qr_enabled && !/^https?:\/\//i.test(qr_api_url)) {
      return res.status(400).json({ error: "qr_api_url_invalid" });
    }
    if (qr_api_method === "POST" && qr_api_body_template) {
      try {
        const parsedQrBody = JSON.parse(qr_api_body_template);
        if (!parsedQrBody || typeof parsedQrBody !== "object" || Array.isArray(parsedQrBody)) {
          return res.status(400).json({ error: "qr_api_body_template_must_be_object" });
        }
      } catch {
        return res.status(400).json({ error: "qr_api_body_template_invalid_json" });
      }
    }


    const setDoc = {
      text,
      history_mode,
      bot_mode,
      lead_capture_enabled,
      external_actions,
      tenantId: tenant,
      updatedAt: new Date(),
      external_api_enabled: !!firstApi?.enabled,
      external_api_action_name: firstApi?.name || "consulta_externa",
      external_api_description: firstApi?.description || "",
      external_api_url: firstApi?.url || "",
      external_api_method: firstApi?.method || "GET",
      external_api_query_param: firstApi?.query_param ?? "buscar",
      external_api_body_template: firstApi?.body_template || "",
      external_api_auth_header: firstApi?.auth_header || "",
      external_api_timeout_ms: firstApi?.timeout_ms || 10000,
      external_api_max_chars: firstApi?.max_chars || 30000,
      external_api_result_instructions: firstApi?.result_instructions || "",

      qr_enabled,
      qr_page_title,
      qr_page_subtitle,
      qr_company_name,
      qr_company_logo_url,
      qr_button_color,
      qr_button_text_color,
      qr_currency,
      qr_api_url,
      qr_api_method,
      qr_api_code_param,
      qr_api_body_template,
      qr_api_auth_header,
      qr_api_timeout_ms,
      qr_field_code,
      qr_field_description,
      qr_field_price,
      qr_price_label,
      qr_price_note,
      qr_additional_prices,
      qr_field_stock,
      qr_field_image,
      qr_image_mime_type,
      qr_field_brand,
      qr_field_category,
      qr_field_subcategory,
      qr_ai_enabled,
      qr_ai_use_same_behavior,
      qr_ai_behavior,
      qr_ai_web_search_enabled,
     qr_ai_web_search_context_size,
      qr_ai_web_search_timeout_ms
    };

    if (firstApi?.auth_value) setDoc.external_api_auth_value = firstApi.auth_value;
    if (qrIncomingSecret) setDoc.qr_api_auth_value = qrIncomingSecret;

    const update = { $set: setDoc };
    const unset = {};
    if (!firstApi?.auth_value) unset.external_api_auth_value = "";
    if (qrClearSecret) unset.qr_api_auth_value = "";
    if (Object.keys(unset).length) update.$unset = unset;

    await db.collection("settings").updateOne({ _id }, update, { upsert: true });
    if (helpPayload) {
      try {
        // Fuente/modelo/comportamiento siguen siendo globales para MANAGER.
        await saveHelpConfig(helpPayload.agent || "MANAGER", helpPayload);
       // El checkbox de habilitación pertenece EXCLUSIVAMENTE al dominio actual.
        await saveHelpDomainEnabled(
          tenant,
          helpDomainEnabled === true,
          helpPayload.agent || "MANAGER"
        );
      } catch (helpError) {
        const helpMessage = String(helpError?.message || helpError || "help_config_invalid");
        console.error("POST /api/behavior help config error:", helpMessage);
        return res.status(400).json({ error: helpMessage });
      }
    }
    invalidateBehaviorCache(tenant);
    res.json({
      ok: true,
      tenant,
      history_mode,
      bot_mode,
      lead_capture_enabled,
      external_actions: publicBehaviorExternalActions(external_actions),
      qr_enabled,
      qr_ai_enabled,
      qr_ai_use_same_behavior
    });
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


function cleanConversationalLeadValue(value, maxLen = 500) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.slice(0, Math.max(1, Number(maxLen) || 500));
}

function conversationalLeadPhone(channelType, from, sessionFrom) {
  if (String(channelType || "").trim().toLowerCase() !== "whatsapp") return "";
  const raw = String(sessionFrom || from || "");
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 20) : "";
}

async function upsertConversationalLead({
  tenant,
  convId,
  from,
  sessionFrom,
  channelType,
  lead,
  userText
} = {}) {
 try {
    if (!lead || lead.capture !== true) return null;

    const tenantId = String(tenant || DEFAULT_TENANT_ID || "default").trim();
    const conversationId = ObjectId.isValid(String(convId || ""))
      ? new ObjectId(String(convId))
      : String(convId || "").trim();

    if (!tenantId || !conversationId) return null;

    const now = new Date();
    const typeRaw = cleanConversationalLeadValue(lead.type, 40).toLowerCase();
    const leadType = typeRaw === "contacto" ? "contacto" : "cotizacion";
    const phone = conversationalLeadPhone(channelType, from, sessionFrom);
    const waId = cleanConversationalLeadValue(sessionFrom || from, 120);
    const lastMessage = cleanConversationalLeadValue(userText, 2000);

    const set = {
      tenantId,
      source: "bot_conversacional",
      leadType,
      status: "open",
      channelType: cleanConversationalLeadValue(channelType || "whatsapp", 40).toLowerCase(),
      waId,
      phone,
      updatedAt: now,
      lastMessage
    };

    const topLevel = {
      name: cleanConversationalLeadValue(lead.name, 200),
      company: cleanConversationalLeadValue(lead.company, 200),
      email: cleanConversationalLeadValue(lead.email, 300)
    };
    for (const [key, value] of Object.entries(topLevel)) {
      if (value) set[key] = value;
    }

    const quoteFields = {
      origin: cleanConversationalLeadValue(lead.origin, 300),
      destination: cleanConversationalLeadValue(lead.destination, 300),
      cargo: cleanConversationalLeadValue(lead.cargo, 800),
      packages: cleanConversationalLeadValue(lead.packages, 300),
      weight: cleanConversationalLeadValue(lead.weight, 300),
      dimensions: cleanConversationalLeadValue(lead.dimensions, 500),
      notes: cleanConversationalLeadValue(lead.notes, 1000)
    };
    for (const [key, value] of Object.entries(quoteFields)) {
      if (value) set[`quote.${key}`] = value;
    }

    const db = await getDb();
    const filter = {
      tenantId,
      source: "bot_conversacional",
      conversationId
    };

    const update = {
      $set: set,
      $setOnInsert: {
        createdAt: now,
        conversationId,
        message: lastMessage,
        quoteReady: false,
        page: `bot/${cleanConversationalLeadValue(channelType || "whatsapp", 40).toLowerCase()}`
      }
    };

    const result = await db.collection("leads").findOneAndUpdate(
      filter,
      update,
      { upsert: true, returnDocument: "after" }
    );
    let doc = result?.value || result || null;
    if (!doc?._id) {
      try { doc = await db.collection("leads").findOne(filter); } catch {}
    }
    const leadId = doc?._id || null;
    const quoteReady = !!(
      cleanConversationalLeadValue(doc?.quote?.origin, 300) &&
      cleanConversationalLeadValue(doc?.quote?.destination, 300) &&
      cleanConversationalLeadValue(doc?.quote?.cargo, 800)
    );

    if (leadId && doc?.quoteReady !== quoteReady) {
      try {
        await db.collection("leads").updateOne(
          { _id: leadId },
          { $set: { quoteReady, updatedAt: now } }
        );
        doc.quoteReady = quoteReady;
      } catch (e) {
        console.warn("[LEAD] no se pudo actualizar quoteReady:", e?.message || e);
      }
    }

    if (leadId && ObjectId.isValid(String(convId || ""))) {
      try {
        await db.collection("conversations").updateOne(
          { _id: new ObjectId(String(convId)), tenantId },
          {
            $set: {
              leadId,
              hasLead: true,
              leadType,
              leadUpdatedAt: now
            }
          }
        );
      } catch (e) {
        console.warn("[LEAD] no se pudo vincular conversación:", e?.message || e);
      }
    }

    console.log(
      `[LEAD] upsert tenant=${tenantId} convId=${String(convId || "")} ` +
      `type=${leadType} ready=${quoteReady}`
    );
    return doc;
  } catch (e) {
    console.error("[LEAD] error guardando lead conversacional:", e?.message || e);
    return null;
  }
}


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

function apiChatCabCleanDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function apiChatCabBoolLike(value) {
  if (value === true || value === 1) return true;
  const v = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "si", "sí", "on"].includes(v);
}

function apiChatCabNormalizeMediaType(value, mimeValue) {
  const t = String(value || "").trim().toLowerCase();
  const mime = String(mimeValue || "").trim().toLowerCase();
  if (["ptt", "voice", "audio"].includes(t) || mime.startsWith("audio/")) return "audio";
  if (t === "image" || mime.startsWith("image/")) return "image";
  if (t === "document" || t === "file" || mime.includes("pdf")) return "document";
  if (t === "video" || mime.startsWith("video/")) return "video";
  if (t === "sticker") return "sticker";
  return "text";
}

function apiChatCabReadMediaFromBody(body = {}) {
  const mediaObj = (body.media && typeof body.media === "object") ? body.media : {};
  const mimeType = String(
    body.MediaMimeType || body.mediaMimeType || body.mimetype || body.mimeType || mediaObj.mimetype || mediaObj.mime || ""
  ).trim();
  const typeRaw = body.TipoMensaje || body.tipoMensaje || body.type || body.messageType || body.MediaType || body.mediaType || "";
  const mediaType = apiChatCabNormalizeMediaType(typeRaw, mimeType);
 const base64 = String(
    body.MediaBase64 || body.MediaData || body.mediaBase64 || body.mediaData || mediaObj.data || mediaObj.base64 || ""
  ).trim();
  const hasMedia = apiChatCabBoolLike(body.HasMedia ?? body.hasMedia ?? body.mediaAttached) || !!base64 || mediaType !== "text";
  if (!hasMedia || mediaType === "text") return null;

  const filename = String(
    body.MediaFilename || body.mediaFilename || body.filename || body.fileName || mediaObj.filename || ""
 ).trim();
  const bytes = Number(body.MediaBytes || body.mediaBytes || mediaObj.bytes || 0) || (base64 ? Buffer.byteLength(base64, "base64") : 0);
  const caption = String(body.MediaCaption || body.mediaCaption || body.caption || body.Mensaje || body.mensaje || "").trim();

  return {
    source: "wweb",
    kind: mediaType,
    mimetype: mimeType,
    mime: mimeType,
    filename,
    caption,
    data: base64,
    bytes,
    omittedBySize: apiChatCabBoolLike(body.MediaOmittedBySize ?? body.mediaOmittedBySize ?? mediaObj.omittedBySize),
    error: String(body.MediaError || body.mediaError || mediaObj.error || "").trim(),
    transcription: String(
      body.MediaTranscription || body.mediaTranscription || body.Transcripcion || body.transcripcion || mediaObj.transcription || ""
    ).trim()
  };
}



function apiChatCabReadTenantId(req) {
  return String(
    req.body?.TenantId ||
    req.body?.tenantId ||
    req.body?.tenantid ||
    req.headers?.["x-tenant-id"] ||
    req.query?.tenantId ||
    req.query?.tenant ||
    resolveTenantId(req) ||
    DEFAULT_TENANT_ID ||
    TENANT_ID ||
    "default"
  ).trim();
}

function apiChatCabBuildMessageId(body, tenantId) {
  const explicit = String(
    body?.MessageId ||
    body?.messageId ||
    body?.Id_Ws ||
    body?.id_ws ||
    body?.id ||
    ""
  ).trim();
  if (explicit) return explicit;

  const base = [
    tenantId,
    body?.Tel_Origen,
    body?.Tel_Destino,
    body?.Mensaje,
    Date.now(),
    Math.random().toString(16).slice(2)
  ].join("|");
  return "wweb_" + crypto.createHash("sha1").update(base).digest("hex");
}

function apiChatCabFakeWebhookBody({ body, runtime, tenantId }) {
  const from = apiChatCabCleanDigits(body?.Tel_Origen || body?.tel_origen || body?.from || body?.telefono || "");
  const to = apiChatCabCleanDigits(body?.Tel_Destino || body?.tel_destino || body?.to || body?.numero || runtime?.displayPhoneNumber || "");
  const text = String(body?.Mensaje ?? body?.mensaje ?? body?.text ?? body?.body ?? "").trim();
  const phoneNumberId = String(runtime?.phoneNumberId || body?.phoneNumberId || body?.PhoneNumberId || `wweb:${tenantId}:${to || "default"}`).trim();
  const messageId = apiChatCabBuildMessageId(body || {}, tenantId);
  const media = apiChatCabReadMediaFromBody(body || {});

  const msg = {
    from,
    id: messageId,
   timestamp: String(Math.floor(Date.now() / 1000)),
    type: "text",
    text: { body: text },
  };

  if (media) {
    msg.type = media.kind;
    msg.__wwebMedia = media;
    if (media.kind === "audio") {
      msg.audio = { id: `wweb:${messageId}`, mime_type: media.mimetype || "audio/ogg" };
      delete msg.text;
    } else if (media.kind === "image") {
      msg.image = { id: `wweb:${messageId}`, mime_type: media.mimetype || "image/jpeg", caption: text || media.caption || "" };
      if (!text) delete msg.text;
    } else if (media.kind === "document") {
      msg.document = { id: `wweb:${messageId}`, mime_type: media.mimetype || "application/octet-stream", filename: media.filename || "archivo", caption: text || media.caption || "" };
     if (!text) delete msg.text;
    } else if (media.kind === "video") {
      msg.video = { id: `wweb:${messageId}`, mime_type: media.mimetype || "video/mp4", caption: text || media.caption || "" };
      if (!text) delete msg.text;
    } else if (media.kind === "sticker") {
      msg.sticker = { id: `wweb:${messageId}`, mime_type: media.mimetype || "image/webp" };
      delete msg.text;
    }
  }

  return {
    object: "whatsapp_business_account",
    entry: [{
      id: String(tenantId || ""),
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: to || null,
            phone_number_id: phoneNumberId,
          },
          contacts: [{ wa_id: from }],
         messages: [msg]
        }
      }]
    }]
  };
}

function createApiChatCabCaptureRes() {
  return {
    statusCode: 200,
   body: null,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = Number(code) || this.statusCode || 200; return this; },
    sendStatus(code) { this.statusCode = Number(code) || this.statusCode || 200; this.body = this.body ?? ""; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end(value) { if (value !== undefined) this.body = value; return this; },
  };
}

async function handleApiChatCabProcesarMensajePost(req, res) {
  const body = req.body || {};
  let tenantId = apiChatCabReadTenantId(req);
 const text = String(body?.Mensaje ?? body?.mensaje ?? body?.text ?? body?.body ?? "").trim();
  const from = apiChatCabCleanDigits(body?.Tel_Origen || body?.tel_origen || body?.from || body?.telefono || "");
  const incomingMedia = apiChatCabReadMediaFromBody(body);
  const tokenUsageMessageId = apiChatCabBuildMessageId(body, tenantId);
  if (!String(body?.MessageId || body?.messageId || body?.Id_Ws || body?.id_ws || body?.id || "").trim()) {
    body.MessageId = tokenUsageMessageId;
  }

  if ((!text && !incomingMedia) || !from) {
    return res.status(400).json([{ cod_error: "bad_request", msj_error: "Tel_Origen y Mensaje/Media son obligatorios" }]);
   }
  const to = apiChatCabCleanDigits(body?.Tel_Destino || body?.tel_destino || body?.to || body?.numero || "");

  let runtime = null;
  try {
    runtime = (tenantId && to ? await getRuntimeByWwebPhone(tenantId, to) : null);
    if (!runtime && to) runtime = await getRuntimeByWwebPhoneAny(to);
    if (!runtime && tenantId) runtime = await getRuntimeByTenantId(tenantId);
    if (runtime?.tenantId) tenantId = String(runtime.tenantId).trim();
  } catch (e) {
    console.warn("[WWEB_CHATGPT] no se pudo leer tenant runtime:", e?.message || e);
  }

  const transport = normalizeWhatsappTransport(runtime?.whatsappTransport || "api");
  if (transport !== "wweb") {
    return res.status(409).json([{ cod_error: "transport_api", msj_error: "El tenant no está configurado para WhatsApp Web" }]);
  }

  if (incomingMedia) {
    console.log('[WWEB_CHATGPT] media recibido', {
      kind: incomingMedia.kind,
      mime: incomingMedia.mimetype || incomingMedia.mime || '',
      filename: incomingMedia.filename || '',
      hasBase64: !!incomingMedia.data,
      bytes: incomingMedia.bytes || 0,
      omittedBySize: !!incomingMedia.omittedBySize,
      mediaError: incomingMedia.error || ''
    });
  }


  // WhatsApp Web ya envía el audio descargado en MediaBase64. Lo transcribimos
  // antes de construir el webhook interno para garantizar que la lógica de pedidos
  // reciba el texto real, igual que cuando el audio entra por la API oficial.
  if (incomingMedia?.kind === "audio" && incomingMedia.data && !incomingMedia.transcription) {
    try {
      const audioBuffer = Buffer.from(String(incomingMedia.data), "base64");
      if (audioBuffer.length) {
        const tr = await transcribeAudioExternal({
          buffer: audioBuffer,
          mime: incomingMedia.mimetype || incomingMedia.mime || "audio/ogg",
          tenantId,
          openaiApiKey: runtime?.openaiApiKey || null,
          waId: from,
          channelType: "whatsapp",
          usageTraceId: ["token", tenantId, "whatsapp", tokenUsageMessageId].join(":"),
        });
        const transcription = String(tr?.text || "").trim();
       if (transcription) {
          body.MediaTranscription = transcription;
          body.Mensaje = transcription;
          console.log(`[WWEB_CHATGPT] audio transcripto: ${transcription.slice(0, 160)}`);
        } else {
          console.warn("[WWEB_CHATGPT] audio sin transcripción");
        }
      }
    } catch (e) {
      console.error("[WWEB_CHATGPT] error transcribiendo audio:", e?.message || e);
    }
  } else if (incomingMedia?.kind === "audio" && !incomingMedia.data && !incomingMedia.transcription) {
    console.warn('[WWEB_CHATGPT] audio recibido sin MediaBase64', {
      bytes: incomingMedia.bytes || 0,
      omittedBySize: !!incomingMedia.omittedBySize,
      mediaError: incomingMedia.error || ''
    });
  }


  const fakeReq = Object.create(req);
  fakeReq.body = apiChatCabFakeWebhookBody({ body, runtime, tenantId });
  fakeReq.rawBody = Buffer.from(JSON.stringify(fakeReq.body));
  fakeReq.asistoWwebApiRequest = true;
  fakeReq.asistoWhatsappTransport = "wweb";
  fakeReq.asistoTenantId = tenantId;
  fakeReq.asistoRuntime = runtime || { tenantId, channelType: "whatsapp", whatsappTransport: "wweb" };
  fakeReq.asistoReturnReplies = [];

  const fakeRes = createApiChatCabCaptureRes();
  await handleWebhookPost(fakeReq, fakeRes);

  if (fakeReq.asistoClientAccessBlocked === true) {
    return res.json({
      ok: true,
      ignored: true,
      reason: "client_not_allowed"
    });
  }


  if (Number(fakeRes.statusCode || 200) >= 400) {
    return res.status(500).json([{ cod_error: String(fakeRes.statusCode), msj_error: "Error procesando mensaje" }]);
  }

  const replies = fakeReq.asistoReturnReplies
    .map((r) => String(r?.text || "").trim())
    .filter(Boolean)
    .map((txt) => ({ Respuesta: txt.replace(/\r?\n/g, "|") }));

  return res.json(replies);
}

app.post("/api/ext/wweb/chatgpt/process", handleApiChatCabProcesarMensajePost);
app.post("/v200/api/Api_Chat_Cab/ProcesarMensajePost", handleApiChatCabProcesarMensajePost);
app.post("/api-chat-cab/procesar-mensaje", handleApiChatCabProcesarMensajePost);

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
async function handleWebhookPost(req, res) {
  try {
    if (!req.asistoWwebApiRequest && process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) {
      if (process.env.NODE_ENV === "production") return res.sendStatus(403);
      console.warn("⚠️ Webhook: firma inválida (ignorada en dev).");
    }
// ✅ PARSEO CORRECTO DEL PAYLOAD WHATSAPP

    const entry0 = req.body?.entry?.[0] || {};
    const change = entry0?.changes?.[0];
    const value  = change?.value;
    const messagingEvt = entry0?.messaging?.[0] || null;
const phoneNumberIdInbound =
  value?.metadata?.phone_number_id ||
  value?.metadata?.phoneNumberId ||
  value?.metadata?.phone_number ||
  null;

  const displayPhoneNumberInbound =
  value?.metadata?.display_phone_number ||
  value?.metadata?.displayPhoneNumber ||
  null;


const instagramAccountIdInbound =
  value?.metadata?.instagram_account_id ||
  value?.metadata?.instagram_accountId ||
  value?.metadata?.page_id ||
  value?.metadata?.pageId ||
  value?.recipient?.id ||
  messagingEvt?.recipient?.id ||
  null;

// Runtime por canal desde Mongo.
// Si no existe, cae a .env (retrocompatible para WhatsApp).
let runtime = null;
let channelType = "whatsapp";
let msg = value?.messages?.[0];   // mensaje entrante (texto/audio/etc.)
const status = value?.statuses?.[0];   // (se ignora para persistencia)

if (!msg && messagingEvt?.message) {
  channelType = "instagram";
  const attachments = Array.isArray(messagingEvt.message.attachments) ? messagingEvt.message.attachments : [];
  const firstAttachment = attachments[0] || null;
  msg = {
    from: messagingEvt.sender?.id || "",
    text: messagingEvt.message.text ? { body: messagingEvt.message.text } : undefined,
    type: messagingEvt.message.text ? "text" : (firstAttachment?.type || "text"),
    instagram_mid: messagingEvt.message.mid || null,
    attachments,
  };
  if (!msg.text?.body && firstAttachment) {
    msg.text = { body: `[adjunto instagram: ${firstAttachment.type || "archivo"}]` };
  }
} else if (String(value?.messaging_product || "").trim().toLowerCase() === "instagram") {
  channelType = "instagram";
}

try {
  runtime = req.asistoRuntime || null;
  if (!runtime) {
    if (channelType === "instagram") runtime = await getRuntimeByInstagramAccountId(instagramAccountIdInbound);
    else runtime = await getRuntimeByPhoneNumberId(phoneNumberIdInbound);
  }
} catch {}
const tenant = String(runtime?.tenantId || req.asistoTenantId || DEFAULT_TENANT_ID || TENANT_ID || "default").trim();
const whatsappTransport = normalizeWhatsappTransport(req.asistoWhatsappTransport || runtime?.whatsappTransport || "api");
 
if (channelType === "whatsapp" && phoneNumberIdInbound) {
  console.log(
    `[webhook] phone_number_id=${phoneNumberIdInbound} -> tenant=${tenant} transport=${whatsappTransport}` +
    `${runtime?.displayPhoneNumber ? ` display=${runtime.displayPhoneNumber}` : ""}`
  );
}


if (channelType === "whatsapp" && whatsappTransport === "wweb" && !req.asistoWwebApiRequest) {
  console.log(`[webhook] tenant=${tenant} configurado con WhatsApp Web; se ignora webhook Meta.`);
  return res.sendStatus(200);
}

const orderConfig = await loadOrderConfig(tenant);
const behaviorConfig = await loadBehaviorConfigFromMongo(tenant);
const effectiveBotMode = normalizeBotMode(behaviorConfig?.bot_mode || "pedidos");
const isOrderBot = effectiveBotMode === "pedidos";

const channelOpts = {
  channelType,
  whatsappTransport,
  returnReplies: Array.isArray(req.asistoReturnReplies) ? req.asistoReturnReplies : null,
  whatsappToken: runtime?.whatsappToken || null,
  phoneNumberId: runtime?.phoneNumberId || phoneNumberIdInbound || null,
  instagramAccountId: runtime?.instagramAccountId || instagramAccountIdInbound || null,
  instagramPageId: runtime?.instagramPageId || null,
  instagramAccessToken: runtime?.instagramAccessToken || null,
};

const aiOpts = {
  tenantId: tenant,
  openaiApiKey: runtime?.openaiApiKey || null
};

    if (!msg) {
      console.warn("[webhook] evento sin messages; se ignora");
      return res.sendStatus(200);
    }
  

    const from = String(msg.from || "").trim();

    // Filtro global por cliente. Se aplica antes de descargar medios, crear
    // conversaciones o ejecutar cualquier lógica. Si el filtro está activo y
    // el número/ID no figura, se confirma el webhook pero no se responde nada.
    const clientAccess = await isClientPhoneAllowed(tenant, from);
    if (!clientAccess.allowed) {
      req.asistoClientAccessBlocked = true;
      req.asistoClientAccessDecision = clientAccess;
      console.log(
        `[CLIENT_ACCESS] ignorado tenant=${tenant} channel=${channelType} transport=${whatsappTransport} ` +
        `from=${from || "(vacio)"} normalized=${clientAccess.normalized || "(vacio)"} reason=${clientAccess.reason}`
      );
      return res.sendStatus(200);
    }


    const sessionFrom = channelType === "instagram" ? `instagram:${from}` : from;
    const tokenUsageTraceId = [
      "token",
      tenant,
      channelType,
      String(msg.id || "").trim() || crypto.randomBytes(12).toString("hex")
    ].join(":");
    aiOpts.waId = sessionFrom;
    aiOpts.channelType = channelType;
    aiOpts.usageTraceId = tokenUsageTraceId;
    aiOpts.externalApiContext = {
      telefono_cliente: digitsOnlyForWweb(from),
      telefono_qr: digitsOnlyForWweb(runtime?.displayPhoneNumber || displayPhoneNumberInbound || "")
    };

    let text   = (msg.text?.body || "").trim();
    const msgType = msg.type;
    let inboundLocation = null;

    // Normalización del texto según tipo de mensaje
    const wwebInlineMedia = (msg && msg.__wwebMedia && typeof msg.__wwebMedia === "object") ? msg.__wwebMedia : null;
    if (msg.type === "text" && msg.text?.body) {
      text = msg.text.body;
    } else if (wwebInlineMedia && ["audio", "ptt", "voice", "image", "document", "video", "sticker"].includes(String(msg.type || "").toLowerCase())) {
      const kind = apiChatCabNormalizeMediaType(msg.type, wwebInlineMedia.mimetype || wwebInlineMedia.mime);
      const mime = String(wwebInlineMedia.mimetype || wwebInlineMedia.mime || "application/octet-stream").trim() || "application/octet-stream";
      const filename = String(wwebInlineMedia.filename || "archivo").trim() || "archivo";
      const caption = String(wwebInlineMedia.caption || msg.text?.body || msg.image?.caption || msg.document?.caption || msg.video?.caption || "").trim();
      const b64 = String(wwebInlineMedia.data || wwebInlineMedia.base64 || "").trim();
      let buf = null;
      if (b64) {
        try { buf = Buffer.from(b64, "base64"); } catch {}
      }

      let cacheId = null;
      let publicUrl = null;
      if (buf && buf.length) {
        cacheId = putInCache(buf, mime);
        publicUrl = `${req.protocol}://${req.get("host")}/cache/media/${cacheId}`;
      }

      msg.__media = {
        kind,
        cacheId,
        publicUrl,
        mime,
        filename,
        bytes: buf?.length || Number(wwebInlineMedia.bytes || 0) || 0,
        source: "wweb",
        data: b64 || "",
        error: String(wwebInlineMedia.error || "").trim() || null,
      };

      if (kind === "audio") {
        const preTranscribed = String(wwebInlineMedia.transcription || "").trim();
        if (preTranscribed) {
          text = preTranscribed;
          msg.__media.transcription = preTranscribed;
        } else if (buf && buf.length) {
          try {
            const tr = await transcribeAudioExternal({ publicAudioUrl: publicUrl, buffer: buf, mime, ...aiOpts });
            text = String(tr?.text || "").trim() || "(audio sin texto)";
            msg.__media.transcription = text;
          } catch (e) {
            console.error("Audio/transcripción WWeb:", e?.message || e);
            text = "(no se pudo transcribir el audio)";
          }
        } else {
          text = caption || "(audio recibido sin archivo descargable)";
        }
      } else if (kind === "image") {
        let img = null;
        if (isOrderBot && publicUrl && orderFeatureEnabled(orderConfig, "transferReceiptAnalysis")) {
          try {
            img = await analyzeImageExternal({
              publicImageUrl: publicUrl,
              mime,
              purpose: "payment-proof",
              ...aiOpts
            });
          } catch (e) {
            console.error("Imagen/análisis WWeb:", e?.message || e);
          }
        }
        text = img?.userText || caption || "[imagen recibida]";
        if (img?.json) msg.__media.analysis = img.json;
      } else if (kind === "document") {
        text = caption ? `${caption}\n[archivo: ${filename}]` : `[archivo: ${filename}]`;
      } else if (kind === "video") {
        text = caption || "[video]";
      } else if (kind === "sticker") {
        text = "[sticker]";
      } else {
        text = caption || `[archivo: ${filename}]`;
      }
    } else if (msg.type === "audio" && msg.audio?.id) {
      try {
        const info = await getMediaInfo(msg.audio.id, channelOpts);
        const buf = await downloadMediaBuffer(info.url, channelOpts);
        const id = putInCache(buf, info.mime_type || "audio/ogg");
        const publicAudioUrl = `${req.protocol}://${req.get("host")}/cache/audio/${id}`;
        const tr = await transcribeAudioExternal({ publicAudioUrl, buffer: buf, mime: info.mime_type, ...aiOpts });
        text = String(tr?.text || "").trim() || "(audio sin texto)";
        // enriquecemos meta para admin/UI
        msg.__media = { kind: "audio", cacheId: id, publicUrl: publicAudioUrl, mime: info.mime_type || "audio/ogg" };
      } catch (e) {
        console.error("Audio/transcripción:", e.message);
        text = "(no se pudo transcribir el audio)";
      }
     } else if (msg.type === "image" && msg.image?.id) {
      try {
        const info = await getMediaInfo(msg.image.id, channelOpts);
        const buf = await downloadMediaBuffer(info.url, channelOpts);
        const id = putInCache(buf, info.mime_type || "image/jpeg");
        const publicImageUrl = `${req.protocol}://${req.get("host")}/cache/media/${id}`;

        let img = null;
        if (isOrderBot && orderFeatureEnabled(orderConfig, "transferReceiptAnalysis")) {
          img = await analyzeImageExternal({
            publicImageUrl,
            mime: info.mime_type,
            purpose: "payment-proof",
            ...aiOpts
          });
        }

        // Texto que alimenta al modelo conversacional
        text = img?.userText || "[imagen recibida]";

        // enriquecemos meta para admin/debug
        msg.__media = { cacheId: id, publicUrl: publicImageUrl, mime: info.mime_type, analysis: img?.json || null };
      } catch (e) {
        console.error("Imagen/análisis:", e?.message || e);
        text = "[imagen recibida]";
      }
    }

    else if (msg.type === "document" && msg.document?.id) {
      // Documento/archivo (no analizamos; solo registramos para el panel)
      const fn = String(msg.document?.filename || msg.document?.file_name || "archivo").trim() || "archivo";
      const cap = String(msg.document?.caption || "").trim();
      text = cap ? cap : `[archivo: ${fn}]`;
      if (cap) text += `\n[archivo: ${fn}]`;
      msg.__media = { kind: "document", filename: fn, mime: msg.document?.mime_type || null };
    } else if (msg.type === "video" && msg.video?.id) {
      const cap = String(msg.video?.caption || "").trim();
      text = cap ? cap : "[video]";
      msg.__media = { kind: "video", mime: msg.video?.mime_type || null };
    } else if (msg.type === "sticker" && msg.sticker?.id) {
      text = "[sticker]";
      msg.__media = { kind: "sticker", mime: msg.sticker?.mime_type || null };
    }

    else if (msg.type === "location" && msg.location) {
      // Ubicación compartida: intentamos reverse geocoding para obtener una dirección aproximada.
      const lat = Number(msg.location?.latitude);
      const lon = Number(msg.location?.longitude);
      const name = String(msg.location?.name || "").trim();
      const addr = String(msg.location?.address || "").trim();

      let formatted = addr;
      let rev = null;
      try {
        if (!formatted && Number.isFinite(lat) && Number.isFinite(lon)) {
          rev = await reverseGeocode(lat, lon);
          formatted = String(rev?.formatted_address || "").trim();
        }
      } catch {}

      inboundLocation = {
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        name: name || null,
        address: addr || null,
        formatted_address: formatted || null,
        rev: rev || null,
      };
      msg.__location = inboundLocation;

      const link = (Number.isFinite(lat) && Number.isFinite(lon))
        ? `https://www.google.com/maps?q=${lat},${lon}`
        : "";

      // Texto que alimenta al modelo conversacional
      text = [
        "📍 El usuario compartió su ubicación.",
        (Number.isFinite(lat) && Number.isFinite(lon)) ? `Coordenadas: ${lat}, ${lon}.` : null,
        formatted ? `Dirección aproximada: ${formatted}.` : null,
        link ? `Link: ${link}` : null,
      ].filter(Boolean).join("\n");
    }


        // Asegurar conversación y guardar mensaje de usuario
    let conv = null;
     try {
       // Guardamos el canal/telefono por el que entró el mensaje para poder verlo en Admin UI
       conv = await upsertConversation(from, {
         channelType,
         phoneNumberId: channelOpts?.phoneNumberId || null,
         displayPhoneNumber: runtime?.displayPhoneNumber || null,
         instagramAccountId: channelOpts?.instagramAccountId || null,
         instagramPageId: channelOpts?.instagramPageId || null,
         botMode: effectiveBotMode,
       }, tenant, {
         reuseCompletedWithinMinutes: isOrderBot ? orderPostCompletionReuseMinutes(orderConfig) : 0,
       });
     } catch (e) { console.error("upsertConversation:", e?.message); }
     // Guardamos phoneNumberId para poder responder/operar por el mismo canal luego (admin, etc.)
 
    const convId = conv?._id;
    const transferFlowStatusBeforeMessage = normalizeTransferFlowStatus(conv?.transferFlowStatus || "");

    if (convId) {
      aiOpts.conversationId = String(convId);

     // Los audios se transcriben antes de crear/recuperar la conversación.
      // Los asociamos después mediante usageTraceId para que el panel pueda
      // sumar también esos tokens dentro de la conversación/pedido correcto.
      if (msg.__media && aiOpts.usageTraceId) {
        try {
          const db = await getDb();
          await db.collection("ai_token_usage_log").updateMany(
            {
             tenantId: tenant,
              usageTraceId: aiOpts.usageTraceId,
              $or: [
                { conversationId: { $exists: false } },
                { conversationId: null },
                { conversationId: "" }
              ]
            },
            {
              $set: {
                conversationId: String(convId),
                waId: sessionFrom,
                channelType
              }
            }
          );
        } catch (e) {
          console.warn("[tokens] no se pudo asociar media a conversación:", e?.message || e);
        }
      }
    }

console.log("[convId] "+ convId);

    // ✅ Si se creó una conversación nueva, reseteamos historial del LLM
    // para que un nuevo pedido no arrastre contexto del pedido anterior.
    if (convId) syncSessionConversation(tenant, sessionFrom, convId);

    if (convId && String(msg?.id || "").trim()) {
      try {
        const db = await getDb();
        const dupInbound = await db.collection("messages").findOne(
          withTenant({ conversationId: new ObjectId(String(convId)), "meta.raw.id": String(msg.id).trim() }, tenant),
          { projection: { _id: 1 } }
        );
        if (dupInbound) {
          console.log("[webhook] duplicate inbound already processed:", String(msg.id).trim());
          return res.sendStatus(200);
        }
      } catch (e) {
        console.warn("[webhook] duplicate inbound check error:", e?.message || e);
      }
    }

    const lastAssistantTextBeforeUser = convId
      ? await loadLastAssistantTextMessage(tenant, convId)
      : "";


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
           meta: { raw: sanitizeRawMessageForStorage(msg), media: msg.__media || null, location: msg.__location || null, channelType }
        });
      } catch (e) { console.error("saveMessage(user):", e?.message); }
    }

    // 🧑‍💻 Si la conversación está en modo manual, no respondemos automáticamente
    if (conv && conv.manualOpen) {
      console.log("[webhook] conversación en modo manualOpen=true; se omite respuesta automática.");
      return res.sendStatus(200);
   }

    // ✅ Si el pedido ya fue confirmado y estamos dentro de la ventana configurada,
   // los cierres cortos tipo "gracias", "ok", "listo" no deben iniciar otro pedido
    // ni llamar al modelo. Esto también funciona si el proceso se reinició y se perdió
    // el flag en memoria, porque se basa en closedAt/status persistidos.
    try {
      const reuseMinutes = orderPostCompletionReuseMinutes(orderConfig);
      if (isOrderBot && convId && conversationIsRecentlyCompleted(conv, reuseMinutes) && isPoliteClosingMessage(text)) {
        const politeReply = orderPoliteFollowupReply(orderConfig);
        await require("./logic").sendChannelMessage(from, politeReply, channelOpts);
        try {
         await saveMessageDoc({
            tenantId: tenant,
            conversationId: convId,
            waId: from,
            role: "assistant",
            content: politeReply,
            type: "text",
            meta: { model: "backend-post-completion", kind: "polite-followup" }
         });
        } catch (e) {
          console.error("saveMessage(assistant polite post-completion):", e?.message);
        }
        return res.sendStatus(200);
      }
    } catch (e) {
      console.warn("[post-completion] polite followup error:", e?.message || e);
    }


    // ==============================
    // ✅ Fast-path backend: si la conversación está esperando comprobante
    // y el usuario manda imagen o archivo, cerramos directamente.
    // Esto evita que el flujo normal vuelva a mostrar el resumen anterior.
    // ==============================
    try {
      const flowStatus = normalizeTransferFlowStatus(conv?.transferFlowStatus || "");
      const inboundReceipt = isInboundTransferReceiptMedia(msg);

    if (isOrderBot && orderFeatureEnabled(orderConfig, "paymentTransferFlow") && orderFeatureEnabled(orderConfig, "transferReceiptAnalysis") && convId && inboundReceipt && flowStatus === "PENDIENTE_COMPROBANTE_TRANSFERENCIA") {
        const pedidoPrev = await loadLastPedidoSnapshot(tenant, convId);
        const pagoPrev = String(pedidoPrev?.Pago || "").trim();

        if (/^transferencia$/i.test(pagoPrev)) {
          const receiptReply = "Perfecto, recibimos el comprobante. Será revisado a la brevedad. 😊";
          const pedidoFinal = normalizePedidoDateTimeFields(
            cloneJsonSafe(pedidoPrev) || { Entrega: "", Domicilio: {}, items: [], total_pedido: 0, Pago: "transferencia" }
          );

          try {
            replaceLastAssistantHistory(tenant, sessionFrom, JSON.stringify({
              response: receiptReply,
              estado: "COMPLETED",
              Pedido: pedidoFinal
            }));
          } catch (e) {
            console.warn("[history] no se pudo reemplazar la última respuesta del asistente:", e?.message || e);
          }

          await require("./logic").sendChannelMessage(from, receiptReply, channelOpts);

          try {
            await saveMessageDoc({
              tenantId: tenant,
              conversationId: convId,
              waId: from,
              role: "assistant",
              content: receiptReply,
              type: "text",
              meta: { model: "backend-fastpath", kind: "receipt-confirmed" }
            });
          } catch (e) {
            console.error("saveMessage(assistant text receipt):", e?.message);
          }

          try {
            await saveMessageDoc({
              tenantId: tenant,
              conversationId: convId,
              waId: from,
              role: "assistant",
              content: JSON.stringify({
                response: receiptReply,
               estado: "COMPLETED",
                Pedido: pedidoFinal
              }),
             type: "json",
              meta: { model: "backend-fastpath", kind: "pedido-snapshot" }
            });
          } catch (e) {
            console.error("saveMessage(assistant json receipt):", e?.message);
          }

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
                  pedido: pedidoFinal,
                  estado: "COMPLETED",
                  status: "COMPLETED",
                  updatedAt: nowOrder,
                },
                $setOnInsert: { createdAt: nowOrder }
              },
              { upsert: true }
            );
          } catch (e) {
            console.error("[orders] error upsert receipt COMPLETED:", e?.message || e);
          }

          await closeConversation(convId, "COMPLETED");
          markSessionEnded(tenant, sessionFrom);
          return res.sendStatus(200);
        }
      }
    } catch (e) {
      console.warn("[receipt-fastpath] error:", e?.message || e);
    }
    // ================== Debounce configurable (solo mensajes text) ==================
// - Retrocompatible: si messageDebounceMs=0 => no cambia nada
// - Si >0: junta varios mensajes text y llama al LLM una sola vez
const debounceMs = clampInt(runtime?.messageDebounceMs ?? runtime?.debounceMs ?? 0, 0, 5000);
const debounceKey = convId
  ? `${tenant}:${channelType}:${channelOpts?.phoneNumberId || channelOpts?.instagramAccountId || "env"}:${convId}`
  : `${tenant}:${channelType}:${channelOpts?.phoneNumberId || channelOpts?.instagramAccountId || "env"}:${from}`;

// Si entra un mensaje NO-text (ej. location), cancelamos cualquier tanda
// pendiente de texto para que no se procese una dirección vieja después.
if (debounceMs > 0 && msg.type !== "text") {
  const pending = pendingTextBatches.get(debounceKey);
  if (pending) {
    pending.cancelled = true;
    pendingTextBatches.delete(debounceKey);
    console.log(`[debounce] lote cancelado por mensaje ${msg.type} key=${debounceKey}`);
  }
}

if (debounceMs > 0 && msg.type === "text") {
  // key estable: convId si existe; si no, tenant+canal+from
  const key = debounceKey;
  let batch = pendingTextBatches.get(key);
  if (!batch) {
    batch = { texts: [], leader: false, createdAt: Date.now(), cancelled: false };
    pendingTextBatches.set(key, batch);
  }

  // guardamos el texto de este mensaje
  const t = String(text || "").trim();
  if (t) {
    // dedupe simple: no agregar si es igual al último
    const last = batch.texts.length ? batch.texts[batch.texts.length - 1] : null;
    if (last !== t) batch.texts.push(t);
  }

  // si ya hay otro request “líder” esperando, este request termina acá
  if (batch.leader) {
    return res.sendStatus(200);
  }

  // este request se convierte en líder: espera y luego procesa todo junto
  batch.leader = true;
  await sleep(debounceMs);

  // recuperar lote final y liberarlo
  const finalBatch = pendingTextBatches.get(key);
  pendingTextBatches.delete(key);

  if (!finalBatch || finalBatch.cancelled) {
    console.log(`[debounce] líder cancelado key=${key}`);
    return res.sendStatus(200);
  }

  const parts = Array.isArray(finalBatch?.texts) ? finalBatch.texts : [];

  // dedupe extra (caso típico: "hola" al inicio y repetido al final)
  if (parts.length >= 2 && parts[0] === parts[parts.length - 1]) {
    parts.pop();
  }

  // limpiar vacíos
  const clean = parts.map(x => String(x || "").trim()).filter(Boolean);

  // unir como pidió el usuario: separados por coma
  // ejemplo: "hola", "quiero 2", "y 1" => "hola, quiero 2, y 1"
  text = clean.join(", ");

  if (!text) {
    console.log(`[debounce] lote vacío, no se procesa key=${key}`);
    return res.sendStatus(200);
  }
}

    const runKey = buildProcessingRunKey(tenant, `${channelType}:${channelOpts?.phoneNumberId || channelOpts?.instagramAccountId || "env"}`, convId, from);

    await withConversationRunLock(runKey, async ({ runSeq, isStale }) => {
      if (isStale()) {
        console.log(`[webhook][stale-run] abort before processing key=${runKey} seq=${runSeq}`);
        return;
      }

      // Los flags de sesión terminada pertenecen exclusivamente al flujo de pedidos.
      // Un bot conversacional nunca debe responder con textos heredados de cierre de pedido.
      if (isOrderBot) {
        if (!isPoliteClosingMessage(text)) {
          clearEndedFlag(tenant, sessionFrom);
        }
        if (hasActiveEndedFlag(tenant, sessionFrom) && isPoliteClosingMessage(text)) {
          if (isStale()) {
            console.log(`[webhook][stale-run] polite close dropped key=${runKey} seq=${runSeq}`);
            return;
          }
          await require("./logic").sendChannelMessage(
            from,
            "¡Gracias! 😊 Cuando quieras hacemos otro pedido.",
            channelOpts
          );
          return;
        }
      }

      // ⚡ Fast-path real: cuando el usuario confirma el resumen anterior,
      // usamos el último snapshot persistido y no volvemos a llamar a OpenAI.
      const userConfirms = isExplicitUserConfirmation(text, {
        lastAssistantText: lastAssistantTextBeforeUser
      });

      let gptReply = "";
      if (
        isOrderBot &&
        userConfirms &&
        convId &&
        looksLikeSummaryOrConfirmation(lastAssistantTextBeforeUser)
      ) {
        const snapshot = await loadLastPedidoSnapshot(tenant, convId);
        if (snapshot && pedidoHasRequiredFieldsForClose(snapshot, orderConfig)) {
          gptReply = JSON.stringify({
            response: "Perfecto, tu pedido quedó confirmado ✅",
           estado: "COMPLETED",
            Pedido: snapshot
          });
          console.log(`[confirm-fastpath] snapshot reutilizado convId=${String(convId)}`);
        }
      }

      // Solo consulta al modelo cuando no hay un snapshot válido para confirmar.
      if (!gptReply) {
        gptReply = await getGPTReply(tenant, sessionFrom, text, aiOpts);
      }
      
      if (isStale()) {
        console.log(`[webhook][stale-run] drop GPT reply key=${runKey} seq=${runSeq}`);
        return;
      }

      // ============================================================
      // MODO CONVERSACIONAL
      // - No ejecuta guardas, horarios, productos, pagos ni confirmaciones.
      // - No crea ni actualiza orders ni snapshots de Pedido.
      // - Mantiene conversación, historial, canales y control de tokens existentes.
      // ============================================================
      if (!isOrderBot) {
        let conversationalText = "";
        let conversationalPayload = null;
        try {
          conversationalPayload = JSON.parse(String(gptReply || ""));
          conversationalText = String(conversationalPayload?.response || "").trim();
        } catch {
          conversationalText = String(gptReply || "").trim();
        }
        if (!conversationalText) {
          conversationalText = "Lo siento, ocurrió un error. Intenta nuevamente.";
        }

        if (isStale()) {
          console.log(`[webhook][stale-run] conversational reply dropped key=${runKey} seq=${runSeq}`);
          return;
        }

        await require("./logic").sendChannelMessage(from, conversationalText, channelOpts);

        let capturedLead = null;
        if (behaviorConfig?.lead_capture_enabled === true && conversationalPayload?.lead?.capture === true) {
          capturedLead = await upsertConversationalLead({
            tenant,
            convId,
            from,
            sessionFrom,
            channelType,
            lead: conversationalPayload.lead,
            userText: text
          });
        }


        if (convId) {
          try {
            await saveMessageDoc({
              tenantId: tenant,
              conversationId: convId,
              waId: from,
              role: "assistant",
              content: conversationalText,
              type: "text",
              meta: {
                model: "gpt",
                kind: "conversational",
                botMode: effectiveBotMode,
               leadCapture: behaviorConfig?.lead_capture_enabled === true,
                leadId: capturedLead?._id ? String(capturedLead._id) : null
              }
            });
          } catch (e) {
            console.error("saveMessage(assistant conversational):", e?.message);
          }

          try {
            const db = await getDb();
            await db.collection("conversations").updateOne(
              { _id: new ObjectId(String(convId)) },
              { $set: { updatedAt: new Date(), botMode: effectiveBotMode } }
            );
          } catch (e) {
            console.warn("[conv] no se pudo persistir botMode conversacional:", e?.message || e);
          }
        }

        return;
      }
  
    // También dispara si el usuario pide "total" o está en fase de confirmar
   const wantsDetail = /\b(detalle|detall|resumen|desglose|total|confirm(a|o|ar))\b/i
      .test(String(text || ""));


    let responseText = "Perdón, hubo un error. ¿Podés repetir?";
    let estado = null;
    let pedido = null;
    let transferFlowStatusToPersist = orderFeatureEnabled(orderConfig, "paymentTransferFlow") ? transferFlowStatusBeforeMessage : "";
    const prevPedidoSnapshot = convId ? await loadLastPedidoSnapshot(tenant, convId) : null;

    try {
      const parsed = JSON.parse(gptReply);
      estado = parsed.estado;
      pedido = mergePedidoState(prevPedidoSnapshot, parsed.Pedido || { items: [] });

      // 📍 Si el mensaje entrante fue una ubicación, la volcamos al Pedido.
      // Esto permite que el flujo siga aunque el usuario no escriba una dirección textual.
      try {
        if (inboundLocation && pedido && typeof pedido === "object") {
          if (!String(pedido.Entrega || "").trim()) {
            pedido.Entrega = "domicilio";
          }
          const dom0 = (typeof pedido.Domicilio === "string")
            ? { direccion: pedido.Domicilio }
            : (pedido.Domicilio || {});
          pedido.Domicilio = dom0;

          if (Number.isFinite(Number(inboundLocation.lat)) && Number.isFinite(Number(inboundLocation.lon))) {
            pedido.Domicilio.lat = Number(inboundLocation.lat);
            pedido.Domicilio.lon = Number(inboundLocation.lon);
          }

          const addr = String(
            inboundLocation.formatted_address ||
            inboundLocation.address ||
            inboundLocation.name ||
            ""
          ).trim();
          if (addr && !String(pedido.Domicilio.direccion || "").trim()) {
            pedido.Domicilio.direccion = addr;
          }
          if (!String(pedido.Domicilio.direccion || "").trim() &&
              Number.isFinite(Number(pedido.Domicilio.lat)) &&
              Number.isFinite(Number(pedido.Domicilio.lon))) {
            pedido.Domicilio.direccion = `Ubicación compartida (${pedido.Domicilio.lat}, ${pedido.Domicilio.lon})`;
          }

          const rev = inboundLocation.rev || null;
          if (rev && typeof rev === "object") {
            if (rev.street && !pedido.Domicilio.calle) pedido.Domicilio.calle = rev.street;
            if (rev.street_number && !pedido.Domicilio.numero) pedido.Domicilio.numero = rev.street_number;
            if (rev.barrio && !pedido.Domicilio.barrio) pedido.Domicilio.barrio = rev.barrio;
            if (rev.ciudad && !pedido.Domicilio.ciudad && !pedido.Domicilio.localidad) pedido.Domicilio.ciudad = rev.ciudad;
            if (rev.provincia && !pedido.Domicilio.provincia) pedido.Domicilio.provincia = rev.provincia;
            if (rev.cp && !pedido.Domicilio.cp) pedido.Domicilio.cp = rev.cp;
          }
        }
      } catch {}
      // 💰 Hidratar precios desde catálogo ANTES de recalcular (evita “Pollo entero @ 0”)
      try { pedido = await hydratePricesFromCatalog(pedido, tenant || null); } catch {}
      // 🚚 Asegurar ítem Envío con geocoding/distancia (awaitable, sin race)
      if (orderFeatureEnabled(orderConfig, "deliveryDistance")) {
        try { pedido = await ensureEnvioSmart(pedido, tenant || null); } catch {}
      }

      // 🧽 Normalización defensiva: si el modelo puso la HORA en `Entrega`, corrige campos.
      if (pedido && typeof pedido.Entrega === "string" && /^\d{1,2}:\d{2}$/.test(pedido.Entrega)) {
        const hhmm = pedido.Entrega.length === 4 ? ("0" + pedido.Entrega) : pedido.Entrega;
        pedido.Hora = pedido.Hora || hhmm;
        // Si `Entrega` no es "domicilio" ni "retiro", dejalo vacío para que no bloquee isPedidoCompleto
        if (!/^(domicilio|retiro)$/i.test(pedido.Entrega)) pedido.Entrega = "";
      }

      const { pedidoCorr, mismatch, hasItems } = recalcAndDetectMismatch(pedido);
      pedido = pedidoCorr;

      const originalResponseText = coalesceResponse(parsed.response, pedido);

      // ✅ Si el modelo devuelve {"error":"..."} lo tratamos como MENSAJE AL USUARIO (no fatal):
      if (typeof parsed?.error === "string" && parsed.error.trim()) {
        responseText = parsed.error.trim();
      } else if (mismatch && hasItems) {
        // 🔒 La corrección de importes la resuelve el backend en silencio.
        // No volvemos a consultar al modelo porque eso altera el flujo visible,
        // puede repetir preguntas ya respondidas y ensucia el historial con prompts internos.
        console.log("[fix] importes corregidos por backend; se preserva el response original del asistente");
        responseText = originalResponseText;
      } else {
        responseText = originalResponseText;
      }
    } catch (e) {
      console.error("Error al parsear/corregir JSON:", e.message);
    }

    // ==============================
    // ✅ Guarda dura #1: si el pedido quedó como DOMICILIO pero no hay dirección válida,
    // forzar pregunta de dirección y evitar resumen/confirmación.
    // ==============================
    try {
      if (orderFeatureEnabled(orderConfig, "backendGuards") && orderRequiredEnabled(orderConfig, "addressForDelivery") && pedidoIsDomicilio(pedido) && !pedidoHasAddress(pedido)) {
        estado = "IN_PROGRESS";
        pedido = stripEnvioItemsFromPedido(pedido || {});
        try {
          const { pedidoCorr } = recalcAndDetectMismatch(pedido);
          pedido = pedidoCorr;
        } catch {}
        responseText = orderMessage(orderConfig, "missingAddress");
      }
    } catch (e) {
      console.warn("[delivery] Guarda de dirección obligatoria falló:", e?.message || e);
    }

    // ✅ Validar día y horario del pedido contra los horarios configurados del local
    try {
      // Normalizar fecha/hora usando fecha_pedido/hora_pedido como fuente de verdad.
      if (pedido && typeof pedido === "object") {
        pedido = normalizePedidoDateTimeFields(pedido);
      }

      if (orderFeatureEnabled(orderConfig, "scheduleValidation") && pedido && typeof pedido === "object" && pedido.Fecha && pedido.Hora) {
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
      const pagoEsTransferencia = /^transferencia$/i.test(String(pedido?.Pago || "").trim());
      const showTotalInSummary = !!(wantsDetail || pagoEsTransferencia);


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
        responseText = buildBackendSummary(pedido, { showTotal: showTotalInSummary });
        finalBody = String(responseText || "").trim();
      }

      if (!finalBody) {
        // No forzar resumen a menos que lo pidan explícitamente
        if (wantsDetail && pedido && Array.isArray(pedido.items) && pedido.items.length > 0) {
          responseText = buildBackendSummary(pedido, {
            showEnvio: wantsDetail,
            showTotal: showTotalInSummary
          });
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

      if (!orderFeatureEnabled(orderConfig, "milanesaWeightLegend") || !hasMilanesas) {
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


     let geoAddressWarning = "";
    let geoShouldPrependToSummary = false;

    // ==============================
    // ✅ Validación de dirección exacta (Google Maps)
    // Si Google Maps no la encuentra de forma exacta, NO borramos la dirección:
    // la conservamos tal cual la mandó el cliente, la dejamos registrada
    // para búsqueda manual del operador y evitamos usar coords/distancia/envío.
    // ==============================
    try {
      if (orderFeatureEnabled(orderConfig, "geocodeAddressValidation") && pedido?.Entrega?.toLowerCase() === "domicilio" && pedido?.Domicilio) {
        const dom = (typeof pedido.Domicilio === "string")
          ? { direccion: pedido.Domicilio }
          : (pedido.Domicilio || {});
        pedido.Domicilio = dom;


        const originalAddress = String(
          dom.direccion ||
          [dom.calle, dom.numero].filter(Boolean).join(" ") ||
          ""
        ).trim();
        const geoManualPending = !!dom.geo_manual_pending;
        const geoManualPendingAddress = String(dom.geo_manual_pending_address || "").trim();
        const samePendingAddress =
          geoManualPending &&
          geoManualPendingAddress &&
          geoManualPendingAddress === originalAddress;
        // Si ya tenemos coordenadas (ubicación compartida), NO forzamos geocoding exacto.
        const hasCoords = Number.isFinite(Number(dom.lat)) && Number.isFinite(Number(dom.lon));

        const addrParts = [
          dom.direccion,
          [dom.calle, dom.numero].filter(Boolean).join(" "),
          dom.barrio,
          dom.ciudad || dom.localidad,
          dom.provincia,
          dom.cp
        ].filter(Boolean);
        const address = addrParts.join(", ").trim();
        if (address && !hasCoords && !samePendingAddress) {
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
              pedido.Domicilio.direccion = originalAddress || String(dom.direccion || "").trim();
              pedido.Domicilio.geo_manual_pending = true;
              pedido.Domicilio.geo_manual_pending_address = pedido.Domicilio.direccion;

            }

            // Reemplazar cualquier envío previo por el envío más caro (fallback Infinity)
            if (!Array.isArray(pedido.items)) pedido.items = [];
            pedido.items = pedido.items.filter(i => !/env[ií]o/i.test(String(i?.descripcion || "")));
            try {
              const db = await getDb();
              const envioProd = await pickEnvioProductByDistance(db, tenant || null, Infinity);
              if (envioProd) {
                pedido.items.push({
                  id: envioProd._id || envioProd.id || 0,
                  descripcion: envioProd.descripcion,
                  cantidad: 1,
                  importe_unitario: Number(envioProd.importe || 0),
                  total: Number(envioProd.importe || 0),
                });
              }
            } catch (e) {
              console.warn("[geo] no se pudo aplicar envío fallback Infinity:", e?.message || e);
            }

            // Recalcular total con el envío fallback ya insertado
            try {
              const { pedidoCorr } = recalcAndDetectMismatch(pedido);
              pedido = pedidoCorr;
            } catch {}

            geoAddressWarning =
              `📍 Google Maps no encontró esa dirección, pero la registré igualmente como:\n*${pedido?.Domicilio?.direccion || originalAddress || address}*\n\n` +
              `La vamos a dejar guardada para que el operador la busque manualmente.`;
              geoShouldPrependToSummary = true;
 
            const nextStep = nextRequiredQuestionFromPedido(pedido, orderConfig);
            responseText = nextStep
              ? `${geoAddressWarning}\n\n${nextStep}`
              : geoAddressWarning;
          } else if (pedido.Domicilio && typeof pedido.Domicilio === "object") {
            delete pedido.Domicilio.geo_manual_pending;
            delete pedido.Domicilio.geo_manual_pending_address;
          }
        }
      }
    } catch (e) {
      console.warn("[geo] Validación de dirección exacta falló:", e?.message || e);
    }





    // ==============================
    // ✅ Guardas backend imprescindibles:
    // 1) domicilio sin dirección → pedir dirección
    // 2) forma de pago solo con domicilio + dirección
    // 3) no preguntar condimento de pollo sin pollo real en Pedido.items
    // 4) no repreguntar tipo de milanesa si ya quedó resuelto
    // 5) bloquear resumen/confirmación/COMPLETED si faltan datos obligatorios
    // ==============================
    try {
      const guardRes = applyCriticalPedidoGuards({ pedido, responseText, estado, currentText: text, orderConfig });
      pedido = guardRes.pedido;
      responseText = guardRes.responseText;
      estado = guardRes.estado;
      if (Array.isArray(guardRes.guardHits) && guardRes.guardHits.length) {
        console.log("[guard] backend:", guardRes.guardHits.join(", "));
      }
    } catch (e) {
      console.warn("[guard] applyCriticalPedidoGuards error:", e?.message || e);
    }

    
    // Si todavía está pendiente que el operador informe el importe final,
    // no aceptar comprobantes/imágenes como cierre.
    try {
      const inboundCouldBeReceipt = !!(msg?.type === "image" || msg?.type === "document");
      const esperandoImporte =
        orderFeatureEnabled(orderConfig, "paymentTransferFlow") &&
        orderFeatureEnabled(orderConfig, "transferMilanesaFinalAmount") &&
        transferFlowStatusBeforeMessage === "PENDIENTE_IMPORTE_TRANSFERENCIA" &&
        /^transferencia$/i.test(String(pedido?.Pago || "").trim()) &&
        pedidoHasMilanesas(pedido);

      if (esperandoImporte && inboundCouldBeReceipt) {
        estado = "PENDIENTE";
        transferFlowStatusToPersist = "PENDIENTE_IMPORTE_TRANSFERENCIA";
        responseText =
          "Todavía falta que un operador te informe el importe final de las milanesas para que puedas enviar la transferencia. 😊";
      }
    } catch (e) {
      console.warn("[transfer-milanesa] no se pudo bloquear comprobante anticipado:", e?.message || e);
    }

    // ==============================
    // ✅ Confirmación obligatoria antes de cerrar:
    // si el pedido ya está completo:
    // - NO transferencia: jamás cerramos sin confirmación explícita
    // - transferencia: SIEMPRE mostrar resumen primero, y recién
    //   después de la confirmación pasar a PENDIENTE
    // ==============================
    try {
      const pedidoListoParaCerrar = pedidoHasRequiredFieldsForClose(pedido, orderConfig);
      const transferFlowEnabled = orderFeatureEnabled(orderConfig, "paymentTransferFlow");
      const pagoEsTransferencia = transferFlowEnabled && /^transferencia$/i.test(String(pedido?.Pago || "").trim());
      const transferenciaConMilanesas = pagoEsTransferencia && orderFeatureEnabled(orderConfig, "transferMilanesaFinalAmount") && pedidoHasMilanesas(pedido);
      const userConfirmedNow = isExplicitUserConfirmation(text, {
        lastAssistantText: lastAssistantTextBeforeUser
      });
      const assistantTryingToClose =
        looksLikeSummaryOrConfirmation(responseText) ||
        /^(COMPLETED|PENDIENTE)$/i.test(String(estado || "").trim());


      const transferSummaryText = buildBackendSummary(pedido, {
        showEnvio: false,
        showTotal: !transferenciaConMilanesas,
        askConfirmation: false,
        intro: "🧾 Resumen del pedido:"
      });

      const transferSummaryWithInstructions = transferenciaConMilanesas
        ? `${transferSummaryText}\n\n` +
          `Como el pedido incluye milanesas, el importe final te lo va a informar un operador cuando estén pesadas.\n` +
          `¿Confirmás? ✅`
        : `${transferSummaryText}\n\n` +
          `Para que podamos realizar tu pedido, por favor enviá el comprobante de la transferencia.\n` +
          `¿Confirmás? ✅`;

      // ⚠️ IMPORTANTE:
      // Solo forzamos resumen si el asistente realmente está intentando
      // cerrar / confirmar el pedido. Si el modelo respondió otra cosa
      // (por ejemplo: "¿Qué sabor de Aquarius querés?"), NO hay que pisarlo.
      if (orderFeatureEnabled(orderConfig, "forceSummaryBeforeClose") && pedidoListoParaCerrar && !pagoEsTransferencia && assistantTryingToClose && !userConfirmedNow) {

        estado = "IN_PROGRESS";
        const summaryText = buildBackendSummary(pedido, {
          showEnvio: wantsDetail,
          showTotal: wantsDetail || pagoEsTransferencia
        });
        responseText = (geoShouldPrependToSummary && geoAddressWarning)
          ? `${geoAddressWarning}\n\n${summaryText}`
          : summaryText;
      } else if (orderFeatureEnabled(orderConfig, "forceSummaryBeforeClose") && pedidoListoParaCerrar && pagoEsTransferencia && assistantTryingToClose && !userConfirmedNow) {
        estado = "IN_PROGRESS";
        responseText = (geoShouldPrependToSummary && geoAddressWarning)
          ? `${geoAddressWarning}\n\n${transferSummaryWithInstructions}`
          : transferSummaryWithInstructions;
      } else if (pedidoListoParaCerrar && pagoEsTransferencia && !transferenciaConMilanesas && userConfirmedNow) {
        estado = "PENDIENTE";
        transferFlowStatusToPersist = "PENDIENTE_COMPROBANTE_TRANSFERENCIA";
        responseText =
          "Perfecto. Para avanzar con tu pedido, por favor enviame el comprobante de la transferencia. 😊";

      } else if (pedidoListoParaCerrar && transferenciaConMilanesas && userConfirmedNow) {
        estado = "PENDIENTE";
        transferFlowStatusToPersist = "PENDIENTE_IMPORTE_TRANSFERENCIA";
        responseText =
          "Perfecto 😊 Te vamos a enviar el importe final cuando estén pesadas las milanesas.";
 
      }
    } catch (e) {
      console.warn("[confirm] no se pudo forzar confirmación previa:", e?.message || e);
    }
    // ==============================
    // ✅ Si el pedido es a domicilio y ya tiene dirección,
    // forzar que el resumen / confirmación / mensaje final
    // muestre: "Modalidad: Envío ({dirección})"
    // ==============================
    try {
      const entrega = String(pedido?.Entrega || "").trim().toLowerCase();
      const domDir = String(
        (typeof pedido?.Domicilio === "string")
          ? pedido.Domicilio
          : (pedido?.Domicilio?.direccion || "")
      ).trim();

      if (entrega === "domicilio" && domDir) {
        const txt = String(responseText || "");
        const looksLikeSummaryOrFinal =
          /(?:\btu pedido es\b|\bresumen\b|\bpedido ha sido confirmado\b|¿\s*confirm|\bmodalidad\s*:|\bhora\s*:|\bnombre(?: y apellido)?\s*:)/i.test(txt);

        if (looksLikeSummaryOrFinal) {
          const desiredLine = `🚚 Modalidad: Envío (${domDir})`;

          if (/\bmodalidad\s*:/i.test(txt)) {
            responseText = txt.replace(
              /(🚚\s*)?Modalidad\s*:\s*(?:domicilio|env[ií]o)(?:\s*\([^\n)]*\))?/i,
              desiredLine
            );
          } else if (!new RegExp(`Envío\\s*\\(${domDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, "i").test(txt)) {
            if (/🕒\s*Hora\s*:/i.test(txt)) {
              responseText = txt.replace(/(🕒\s*Hora\s*:)/i, `${desiredLine}\n$1`);
            } else if (/👤\s*(?:Nombre|Nombre y apellido)\s*:/i.test(txt)) {
              responseText = txt.replace(/(👤\s*(?:Nombre|Nombre y apellido)\s*:)/i, `${desiredLine}\n$1`);
            } else {
              responseText = `${txt.trim()}\n${desiredLine}`.trim();
            }
          }
        }
      }
    } catch (e) {
      console.warn("[delivery] no se pudo forzar dirección visible en response:", e?.message || e);
    }
 
    const responseTextSafe = String(responseText || "").trim()
      || (wantsDetail && pedido && Array.isArray(pedido.items) && pedido.items.length
          ? buildBackendSummary(pedido, {
              showEnvio: wantsDetail,
              showTotal:
                /^transferencia$/i.test(String(pedido?.Pago || "").trim()) &&
                !pedidoHasMilanesas(pedido)
            })
         : "Perfecto, sigo acá. ¿Querés confirmar o cambiar algo?");

    // ==============================
    // ✅ Determinar el estado final ANTES de enviar/persistir texto
    // para que el mensaje visible y el estado guardado queden sincronizados.
    // ==============================
    const _tNormPre = String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const userWantsCancelRaw =
      /\b(cancel|anul)(ar|o|a|e|en|ado|ada)?\b/.test(_tNormPre) ||
      /\bdar de baja\b/.test(_tNormPre);
    const userCancelNeg =
      /\bno\s+(quiero\s+)?cancel/.test(_tNormPre) ||
      /\bno\s+(quiero\s+)?anul/.test(_tNormPre);
    const userCancelled = !!(userWantsCancelRaw && !userCancelNeg);

	const userConfirmsFast = isExplicitUserConfirmation(text);
  const pagoEsTransferenciaFinal = orderFeatureEnabled(orderConfig, "paymentTransferFlow") && /^transferencia$/i.test(String(pedido?.Pago || "").trim());
	const willComplete = !!(!pagoEsTransferenciaFinal && userConfirmsFast && pedidoHasRequiredFieldsForClose(pedido, orderConfig));
    const closeStatus =
      (userCancelled || estado === "CANCELLED")
        ? "CANCELLED"
        : (willComplete ? "COMPLETED" : null);
    const finalEstado = closeStatus || (typeof estado === "string" ? estado : "IN_PROGRESS");

    let outboundText = String(responseTextSafe || "").trim();
    if (closeStatus === "COMPLETED") {
      const hasConfirmedPhrase =
        /\b(qued[oó]\s+confirmado|pedido\s+confirmado)\b/i.test(outboundText);
      const stillAsksConfirmation =
        /¿\s*confirm(amos|ás|as)\b/i.test(outboundText);

      if (!hasConfirmedPhrase || stillAsksConfirmation) {
        outboundText = buildBackendSummary(pedido, {
          showEnvio: wantsDetail,
          showTotal: wantsDetail || pagoEsTransferenciaFinal,
          askConfirmation: false,
          intro: "Perfecto, tu pedido quedó confirmado ✅\n\n🧾 Resumen del pedido:"
        });
      }
    }
    try {
      setAssistantPedidoSnapshot(tenant, sessionFrom, pedido, finalEstado);
      replaceLastAssistantHistory(tenant, sessionFrom, JSON.stringify({
        response: outboundText,
        estado: finalEstado,
        Pedido: (pedido && typeof pedido === "object")
          ? pedido
          : { Entrega: "", Domicilio: {}, items: [], total_pedido: 0 }
      }));
    } catch (e) {
      console.warn("[history] no se pudo reemplazar la última respuesta del asistente:", e?.message || e);
    }

    if (isStale()) {
      console.log(`[webhook][stale-run] abort before send key=${runKey} seq=${runSeq}`);
      return;
    }
     await require("./logic").sendChannelMessage(from, outboundText, channelOpts);
    if (isStale()) {
      console.log(`[webhook][stale-run] abort after send before persist key=${runKey} seq=${runSeq}`);
      return;
    }
   
    
    
    
    // 2) Guardar ahora el mismo texto y el snapshot JSON (mismo estado/pedido finales)




    if (convId) {
      try {
        await saveMessageDoc({
          tenantId: tenant,
          conversationId: convId,
          waId: from,
          role: "assistant",
          content: String(outboundText || ""),
          type: "text",
          meta: { model: "gpt" }
        });
      } catch (e) {
        console.error("saveMessage(assistant text final):", e?.message);
      }
      try {
        const snap = {
          response: typeof outboundText === "string" ? outboundText : "",
          estado: finalEstado,
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

      // 🔹 Persistir SIEMPRE el último pedido en orders, aunque todavía no esté completed.
      // Así el ticket y el panel leen una única fuente consistente.
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
              estado: typeof estado === "string" ? estado : "IN_PROGRESS",
              status: typeof estado === "string" ? estado : "IN_PROGRESS",
              updatedAt: nowOrder,
            },
            $setOnInsert: { createdAt: nowOrder }
          },
          { upsert: true }
        );
      } catch (e) {
        console.error("[orders] error upsert live snapshot:", e?.message || e);
      }
    }

    if (convId) {
      try {
        const db = await getDb();
        const convUpdate = { $set: { updatedAt: new Date() } };

        if (String(estado || "").trim().toUpperCase() === "PENDIENTE") {
          convUpdate.$set.status = "PENDIENTE";
        }

        if (transferFlowStatusToPersist) {
          convUpdate.$set.transferFlowStatus = transferFlowStatusToPersist;
        } else if (/^(COMPLETED|CANCELLED)$/i.test(String(estado || "").trim())) {
          convUpdate.$unset = { transferFlowStatus: "" };
        }

        await db.collection("conversations").updateOne(
          { _id: new ObjectId(String(convId)) },
          convUpdate
        );
      } catch (e) {
        console.warn("[conv] no se pudo persistir transferFlowStatus:", e?.message || e);
      }
    }



    if (isStale()) {
      console.log(`[webhook][stale-run] abort before post-send side effects key=${runKey} seq=${runSeq}`);
      return;
    }

    try {
     // 🔹 Distancia + geocoding + Envío dinámico
      let distKm = null;
      if (orderFeatureEnabled(orderConfig, "deliveryDistance") && orderFeatureEnabled(orderConfig, "geocodeAddressValidation") && pedido?.Entrega?.toLowerCase() === "domicilio" && pedido?.Domicilio) {
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
setAssistantPedidoSnapshot(tenant, sessionFrom, pedido, estado);

 
	

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
	        markSessionEnded(tenant, sessionFrom);
	      }
    } catch {}
    });

    res.sendStatus(200);
  } catch (e) {
    console.error("POST /webhook error:", e?.message || e);
    res.sendStatus(500);
  }
}

app.post("/webhook", handleWebhookPost);

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

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal} recibido. Cerrando server + MongoDB...`);

    const forceExitTimer = setTimeout(() => process.exit(0), 10000);
    if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

    try {
      await new Promise((resolve) => server.close(resolve));
    } catch {}

    try {
      await closeDb();
    } catch (e) {
      console.error('Error cerrando MongoDB:', e?.message || e);
    }

    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });;
}

// Exportar la app para que otros módulos (tests/otros entrypoints) puedan importarla sin abrir un puerto.
module.exports = app;
// --- reemplazar hasta aquí ---
