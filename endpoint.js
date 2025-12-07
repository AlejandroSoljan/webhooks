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
app.use(express.urlencoded({ extended: true }));

const {
  loadBehaviorTextFromMongo,
  loadBehaviorConfigFromMongo,
  invalidateBehaviorCache,
  getGPTReply, hasActiveEndedFlag, markSessionEnded, isPoliteClosingMessage,
  START_FALLBACK, buildBackendSummary, coalesceResponse, recalcAndDetectMismatch,
  hydratePricesFromCatalog,
  putInCache, getFromCache, getMediaInfo, downloadMediaBuffer, transcribeAudioExternal,
  DEFAULT_TENANT_ID, setAssistantPedidoSnapshot, calcularDistanciaKm,
  geocodeAddress, getStoreCoords, pickEnvioProductByDistance,clearEndedFlag,
  ensureEnvioSmart,hasContext,
} = require("./logic");

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

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
  return (req.query.tenant || req.headers["x-tenant-id"] || process.env.TENANT_ID || DEFAULT_TENANT_ID).toString().trim();
}

// Health
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Cache público (audio)
app.get("/cache/audio/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
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
              ...(nombreFromPedido ? { contactName: nombreFromPedido } : {})
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
async function listConversations(limit = 50, tenantId) {
  const db = await getDb();
  const q = withTenant({}, tenantId);

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
      status: c.finalized ? "COMPLETED" : (c.status || "OPEN"),
      manualOpen: !!c.manualOpen,
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
    const rows = await listConversations(limit, resolveTenantId(req));
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
      status: conv.finalized ? "COMPLETED" : (conv.status || "OPEN"),
      manualOpen: !!conv.manualOpen,
    });
  } catch (e) {
    console.error("GET /api/admin/conversation-meta error:", e);
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

    // Enviar por WhatsApp
    await require("./logic").sendWhatsAppMessage(to, body);

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
     input,button,select{font-size:14px; padding:6px 8px;}
     table{border-collapse:collapse; width:100%}
     th,td{border:1px solid #ddd; padding:8px; vertical-align:top}
     th{background:#f5f5f5; text-align:left}
     .row{display:flex; gap:16px; align-items:center}
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
    .chat-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}

    table{border-collapse:collapse; width:100%; margin-top:12px}
    th,td{border:1px solid #ddd; padding:8px; vertical-align:top; font-size:14px}
    th{background:#f7f7f7; text-align:left}
    .btn{padding:6px 10px; border:1px solid #333; background:#fff; border-radius:6px; cursor:pointer}
    .actions{display:flex; gap:8px}

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
   </div>
   <p></p>
   <table id="tbl">
     <thead>
       <tr>
         <th>Actividad</th>
         <th>Teléfono</th>
         <th>Nombre y Apellido</th>
         <th>Entrega</th>
         <th>Dirección</th>
          <th>Distancia (km)</th>
          <th>Día</th>
         <th>Hora</th>
         <th>Estado</th>
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
     // ===== Modal helpers =====
    const modalRoot = document.getElementById('modalRoot');
    const modalBody = document.getElementById('modalBody');
    const modalMsgs = () => document.getElementById('modalMsgs');
    const modalManualBadge = () => document.getElementById('modalManualBadge');
    const modalToggleManualBtn = () => document.getElementById('modalToggleManualBtn');
    const modalReplyText = () => document.getElementById('modalReplyText');
    const modalSendBtn = () => document.getElementById('modalSendBtn');

    let currentConvId = null;
    let modalManualOpen = false;
    const modalCloseBtn = document.getElementById('modalCloseBtn');
     const modalPrintBtn = document.getElementById('modalPrintBtn');
      const pedidoModalBackdrop = document.getElementById('pedidoModalBackdrop');
     const pedidoModalBody = document.getElementById('pedidoModalBody');
     const pedidoModalCloseBtn = document.getElementById('pedidoModalCloseBtn');

    function closeModal(){ modalRoot.style.display='none'; modalRoot.setAttribute('aria-hidden','true'); }
    modalCloseBtn.addEventListener('click', closeModal);
    modalRoot.addEventListener('click', (e)=>{ if(e.target===modalRoot) closeModal(); });

     function closePedidoModal() {
       pedidoModalBackdrop.style.display = 'none';
       pedidoModalBackdrop.setAttribute('aria-hidden', 'true');
     }
     pedidoModalCloseBtn.addEventListener('click', closePedidoModal);
     pedidoModalBackdrop.addEventListener('click', (e)=>{ if(e.target===pedidoModalBackdrop) closePedidoModal(); });
    function renderMessages(list){
      const target = modalMsgs();
      if (!target) return;
      if(!Array.isArray(list) || !list.length){
        target.innerHTML = '<p class="muted">Sin mensajes para mostrar</p>';
        return;
      }
      target.innerHTML = list.map(m => (
        '<div class="msg role-'+m.role+'">'+
          '<small>['+new Date(m.createdAt).toLocaleString()+'] '+m.role+'</small>'+
          '<pre>'+String(m.content||'').replace(/</g,'&lt;')+'</pre>'+
        '</div>'
      )).join('');
    }

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

    

    async function loadModalMeta(){
      if (!currentConvId) return;
      const r = await fetch('/api/admin/conversation-meta?convId=' + encodeURIComponent(currentConvId));
      if (!r.ok) return;
      const j = await r.json().catch(()=>null);
      modalManualOpen = !!(j && j.manualOpen);
      updateModalManualUI();
    }

    async function toggleModalManual(){
      if (!currentConvId) return;
      const r = await fetch('/api/admin/conversation-manual', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ convId: currentConvId, manualOpen: !modalManualOpen })
      });
      const j = await r.json().catch(()=>({}));
      if (!r.ok || !j.ok) {
        alert('No se pudo cambiar el estado manual.');
        return;
      }
      modalManualOpen = !!j.manualOpen;
      updateModalManualUI();
    }

    async function sendModalMessage(){
      if (!currentConvId) return;
      const ta = modalReplyText();
      const text = String(ta?.value || '').trim();
      if (!text) return;

      const r = await fetch('/api/admin/send-message', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ convId: currentConvId, text })
      });
      const j = await r.json().catch(()=>({}));
      if (!r.ok || !j.ok) {
        alert('Error al enviar el mensaje.');
        return;
      }
      if (ta) ta.value = '';

      // refrescar mensajes
      const rm = await fetch('/api/logs/messages?convId=' + encodeURIComponent(currentConvId));
      const data = await rm.json().catch(()=>[]);
      renderMessages(data);
    }



     function escHtml(str) {
       return String(str || '')
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;');
     }

     function formatMoney(n) {
       const num = Number(n || 0);
       if (!Number.isFinite(num)) return '-';
       return num.toLocaleString('es-AR', { minimumFractionDigits: 0 });
     }

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
    async function openDetailModal(convId){
  try{
    currentConvId = convId; // ✅ necesario para manual y enviar

    modalRoot.style.display = 'flex';
    modalRoot.setAttribute('aria-hidden','false');

    const msgsEl = modalMsgs();
    if (msgsEl) msgsEl.innerHTML = '<p class="muted">Cargando…</p>';

    // ✅ cargar estado manual del chat
    await loadModalMeta();

    const r = await fetch('/api/logs/messages?convId=' + encodeURIComponent(convId));
    if (!r.ok) throw new Error('HTTP ' + r.status);

    const data = await r.json().catch(()=>[]);
    renderMessages(data);

    // si vas a usar imprimir desde el modal
    modalPrintBtn.onclick = () => openTicketModal(convId); 
    // o si querés otra función:
    // modalPrintBtn.onclick = () => goPrint(convId);

  }catch(e){
    console.error('Detalle modal error:', e);
    const msgsEl = modalMsgs();
    if (msgsEl) msgsEl.innerHTML = '<p class="muted">Error al cargar.</p>';
  }
}


    function openDetail(){
      const sel = document.getElementById('convSel');
      const id = sel ? sel.value : '';
      if(!id){ alert('Elegí una conversación'); return; }
       openDetailModal(id);
    }
    
 
    async function reloadTable(){
      try{
        const r = await fetch('/api/logs/conversations?limit=200');
        const data = await r.json();
        // Recontruir tabla
        const tb = document.querySelector('#tbl tbody');
        tb.innerHTML = data.map(c => \`
          <tr>
            <td>\${new Date(c.lastAt||Date.now()).toLocaleString()}</td>
            <td>\${c.waId||'-'}</td>
            <td>\${c.contactName||'-'}</td>
            <td>\${c.entregaLabel||'-'}</td>
            <td>\${c.direccion||'-'}</td>
            <td>\${(c.distanceKm !== undefined && c.distanceKm !== null) ? c.distanceKm : '-'}</td>
            <td>\${c.fechaEntrega||'-'}</td>
            <td>\${c.horaEntrega||'-'}</td>
            <td>\${c.status||'-'}</td>
            <td class="actions">
              <button class="btn" onclick="openDetailModal('\${c._id}')">Detalle</button>
              <button class="btn" onclick="openPedidoModal('\${c._id}')">Pedido</button>
              <button onclick="openTicketModal('\${c._id}')">🖨️ Imprimir</button>
            </td>
          </tr>\`).join('');
        // Refrescar selector
        const sel = document.getElementById('convSel');
        if(sel){
          sel.innerHTML = data.map(c => {
            const label = \`\${c.waId||'sin waId'} — \${new Date(c.lastAt||Date.now()).toLocaleString()}\${c.contactName ? ' — ' + c.contactName : ''}\`;
            return '<option value=\"'+c._id+'\">'+label+'</option>';
          }).join('');
        }
      }catch(e){ console.error('reloadTable error', e); }
    }
  


     function fmt(d){ try{ return new Date(d).toLocaleString(); }catch{ return '-'; } }
     function openDetailByConv(convId){ window.open('/admin/conversation?convId='+encodeURIComponent(convId),'_blank'); }
     function openDetailByWaId(wa){ window.open('/admin/conversation?waId='+encodeURIComponent(wa),'_blank'); }

      // Abre el modal y carga el ticket en el iframe
      function openTicketModal(conversationId) {
        const backdrop = document.getElementById('ticketModalBackdrop');
        const frame = document.getElementById('ticketFrame');
        if (frame) {
          frame.src = '/admin/ticket/' + conversationId;
        }
        if (backdrop) {
          backdrop.style.display = 'flex';
        }
      }

      // Cierra el modal y limpia el iframe
      function closeTicketModal() {
        const backdrop = document.getElementById('ticketModalBackdrop');
        const frame = document.getElementById('ticketFrame');
        if (frame) {
          frame.src = 'about:blank';
        }
        if (backdrop) {
          backdrop.style.display = 'none';
        }
      }

      // Dispara la impresión del contenido del iframe
      function printTicket() {
        const frame = document.getElementById('ticketFrame');
        if (frame && frame.contentWindow) {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        }
      }
     async function loadTable(){
       const r = await fetch('/api/logs/conversations?limit=200');
       const data = await r.json();
       const tb = document.querySelector('#tbl tbody');
       tb.innerHTML = '';
       for(const c of data){
         const tr = document.createElement('tr');
         tr.innerHTML = \`
           <td>\${fmt(c.lastAt)}</td>
           <td>\${c.waId || '-'}</td>
           <td>\${c.contactName || '-'}</td>
           <td>\${c.entregaLabel || '-'}</td>
           <td>\${c.direccion || '-'}</td>
           <td>\${(c.distanceKm !== undefined && c.distanceKm !== null) ? c.distanceKm : '-'}</td>
           <td>\${c.fechaEntrega || '-'}</td>
           <td>\${c.horaEntrega || '-'}</td>
           <td>\${c.status || '-'}</td>
           <td>
            <button class="btn" data-conv="\${c._id}">Detalle</button>
            <button class="btn" data-pedido="\${c._id}">Pedido</button>
            <button class="btn" data-print="\${c._id}">Imprimir</button>
           </td>\`;
        tb.appendChild(tr);
       }
       // bind
       tb.querySelectorAll('button[data-conv]').forEach(b=>{
        b.addEventListener('click',()=>openDetailModal(b.getAttribute('data-conv')));
       });
       tb.querySelectorAll('button[data-pedido]').forEach(b=>{
         b.addEventListener('click',()=>openPedidoModal(b.getAttribute('data-pedido')));
        });
        tb.querySelectorAll('button[data-print]').forEach(b=>{
         b.addEventListener('click',()=>openTicketModal(b.getAttribute('data-print')));
       });
     }
 
     document.getElementById('btnReload').addEventListener('click', loadTable);
     document.getElementById('btnBuscar').addEventListener('click', ()=>{
       const v=(document.getElementById('waIdI').value||'').trim();
       if(!v){ alert('Ingresá un waId'); return; }
       openDetailByWaId(v);
     });
 
     // primera carga y refresco cada 20s para ver conversaciones nuevas
     loadTable();
     setInterval(loadTable, 20000);


     // ===== Bind manual chat modal =====
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


// ---------- Ticket imprimible (80mm) ----------
app.get("/admin/ticket/:convId", async (req, res) => {
  try {
    const convId = String(req.params.convId || "").trim();
    if (!convId) return res.status(400).send("convId requerido");

    const db = await getDb();
    const convObjectId = new ObjectId(convId);

    // Datos básicos de la conversación
    let waId = "";
    let contactName = "";
    let fecha = "";
    try {
      const conv = await db.collection("conversations").findOne(
        withTenant({ _id: convObjectId })
      );
      waId = conv?.waId || "";
      contactName = conv?.contactName || "";
      fecha = conv?.lastAt
        ? new Date(conv.lastAt).toLocaleString("es-AR")
        : new Date().toLocaleString("es-AR");
    } catch (e) {
      console.warn("[ticket] no se pudo leer conversation:", e?.message);
      fecha = new Date().toLocaleString("es-AR");
    }

    // 1) Intentar leer el pedido desde la colección orders (camino nuevo)
    let pedido = null;
    try {
      const order = await db.collection("orders").findOne(
        withTenant({ conversationId: convObjectId }),
        { sort: { createdAt: -1 } }
      );
      if (order && order.pedido) {
        pedido = order.pedido;
      }
    } catch (e) {
      console.warn("[ticket] no se pudo leer order:", e?.message);
    }

    // 2) Fallback: si no hay pedido en orders, buscar JSON viejo en mensajes
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
        } catch {
          // no era JSON, seguimos
        }
      }
    }

    const items = (pedido?.items || []).map(it => ({
      desc: String(it.descripcion || "").trim(),
      qty: Number(it.cantidad || 0),
    }));
    const total = Number(pedido?.total_pedido || 0);

    const modalidadText =
      pedido?.Entrega === "domicilio"
        ? "Envío"
        : pedido?.Entrega === "retiro"
        ? "Retiro"
        : "-";

    const direccionText =
      pedido?.Entrega === "domicilio"
        ? (pedido?.Domicilio?.direccion || "-")
        : "-";

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
  .warn{font-size:11px; margin-top:6px}
</style></head>
<body>
  <h3>Comanda Cliente</h3>
  <div class="line"><span>Fecha</span><span>${fecha}</span></div>
  <div class="line"><span>Teléfono</span><span>${waId || "-"}</span></div>
  <div class="line"><span>Nombre</span><span>${contactName || "-"}</span></div>
  <div class="line"><span>Entrega</span><span>${modalidadText}</span></div>
  <div class="line"><span>Dirección</span><span>${direccionText}</span></div>
  <div class="sep"></div>
  ${
    items.length
      ? items
          .map(
            i =>
              `<div class="line"><span>${i.qty} x ${i.desc}</span><span></span></div>`
          )
          .join("")
      : "<div class='line'><em>Sin ítems detectados</em></div>"
  }
  <div class="sep"></div>
  <div class="line"><strong>Total</strong><strong>$ ${total.toLocaleString(
    "es-AR"
  )}</strong></div>
  ${
    items.some(x => /milanesa/i.test(x.desc))
      ? `<div class="warn">* Las milanesas se pesan al entregar; el precio se informa al momento de la entrega.</div>`
      : ``
  }
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
    const q = req.query.all === "true" ? {} : { active: { $ne: false } };
    if (TENANT_ID) q.tenantId = TENANT_ID;
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
    let { descripcion, importe, observacion, active } = req.body || {};
    descripcion = String(descripcion || "").trim();
    observacion = String(observacion || "").trim();
    if (typeof active !== "boolean") active = !!active;
    let imp = null;
    if (typeof importe === "number") imp = importe;
    else if (typeof importe === "string") {
      const n = Number(importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      imp = Number.isFinite(n) ? n : null;
    }
    if (!descripcion) return res.status(400).json({ error: "descripcion requerida" });
    const now = new Date();
    const doc = { tenantId: (TENANT_ID || DEFAULT_TENANT_ID || null), descripcion, observacion, active, createdAt: now, updatedAt: now };
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
    ["descripcion","observacion","active","importe"].forEach(k => {
      if (req.body[k] !== undefined) upd[k] = req.body[k];
    });
    if (upd.importe !== undefined && typeof upd.importe === "string") {
      const n = Number(upd.importe.replace(/[^\d.,-]/g, "").replace(",", "."));
      upd.importe = Number.isFinite(n) ? n : undefined;
    }
    if (Object.keys(upd).length === 0) return res.status(400).json({ error: "no_fields" });
    upd.updatedAt = new Date();
    const filter = { _id: new ObjectId(String(id)) };
    if (TENANT_ID) filter.tenantId = TENANT_ID;
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
    const filter = { _id: new ObjectId(String(id)) };
    if (TENANT_ID) filter.tenantId = TENANT_ID;
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
    const filter = { _id: new ObjectId(String(id)) };
    if (TENANT_ID) filter.tenantId = TENANT_ID;
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
    const filter = { _id: new ObjectId(String(id)) };
    if (TENANT_ID) filter.tenantId = TENANT_ID;
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
    const filtro = verTodos ? {} : { active: { $ne: false } };
    if (TENANT_ID) filtro.tenantId = TENANT_ID;
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
      <table id="tbl"><thead><tr><th>Descripción</th><th>Importe</th><th>Obs.</th><th>Activo</th><th>Acciones</th></tr></thead>
      <tbody>${productos.map(p => `<tr data-id="${p._id}">
        <td><input class="descripcion" type="text" value="${(p.descripcion||'').replace(/\"/g,'&quot;')}" /></td>
        <td><input class="importe" type="number" step="0.01" value="${p.importe ?? ''}" /></td>
        <td><textarea class="observacion">${(p.observacion||'').replace(/</g,'&lt;')}</textarea></td>
        <td><input class="active" type="checkbox" ${p.active!==false?'checked':''} /></td>
        <td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">${p.active!==false?'Inactivar':'Reactivar'}</button></td>
      </tr>`).join('')}</tbody></table>
      <template id="row-tpl"><tr data-id="">
        <td><input class="descripcion" type="text" /></td>
        <td><input class="importe" type="number" step="0.01" /></td>
        <td><textarea class="observacion"></textarea></td>
        <td><input class="active" type="checkbox" checked /></td>
        <td><button class="save btn">Guardar</button><button class="del btn">Eliminar</button><button class="toggle btn">Inactivar</button></td>
      </tr></template>
      <script>
        function q(s,c){return (c||document).querySelector(s)}function all(s,c){return Array.from((c||document).querySelectorAll(s))}
        async function j(url,opts){const r=await fetch(url,opts||{});if(!r.ok)throw new Error('HTTP '+r.status);const ct=r.headers.get('content-type')||'';return ct.includes('application/json')?r.json():r.text()}
        async function reload(){const url=new URL(location.href);const allFlag=url.searchParams.get('all')==='true';const data=await j('/api/products'+(allFlag?'?all=true':''));const tb=q('#tbl tbody');tb.innerHTML='';for(const it of data){const tr=q('#row-tpl').content.firstElementChild.cloneNode(true);tr.dataset.id=it._id||'';q('.descripcion',tr).value=it.descripcion||'';q('.importe',tr).value=typeof it.importe==='number'?it.importe:(it.importe||'');q('.observacion',tr).value=it.observacion||'';q('.active',tr).checked=it.active!==false;q('.toggle',tr).textContent=(it.active!==false)?'Inactivar':'Reactivar';bindRow(tr);tb.appendChild(tr);}if(!data.length){const r=document.createElement('tr');r.innerHTML='<td colspan="5" style="text-align:center;color:#666">Sin productos para mostrar</td>';tb.appendChild(r);}}
        async function saveRow(tr){const id=tr.dataset.id;const payload={descripcion:q('.descripcion',tr).value.trim(),importe:q('.importe',tr).value.trim(),observacion:q('.observacion',tr).value.trim(),active:q('.active',tr).checked};if(!payload.descripcion){alert('Descripción requerida');return;}if(id){await j('/api/products/'+encodeURIComponent(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}else{await j('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}await reload();}
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
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
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
    const tenant = resolveTenantId(req);

    // ✅ PARSEO CORRECTO DEL PAYLOAD WHATSAPP
    const change = req.body?.entry?.[0]?.changes?.[0];
    const value  = change?.value;
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
        const info = await getMediaInfo(msg.audio.id);
        const buf = await downloadMediaBuffer(info.url);
        const id = putInCache(buf, info.mime_type || "audio/ogg");
        const publicAudioUrl = `${req.protocol}://${req.get("host")}/cache/audio/${id}`;
        const tr = await transcribeAudioExternal({ publicAudioUrl, buffer: buf, mime: info.mime_type });
        text = String(tr?.text || "").trim() || "(audio sin texto)";
      } catch (e) {
        console.error("Audio/transcripción:", e.message);
        text = "(no se pudo transcribir el audio)";
      }
     } else if (msg.type === "image" && msg.image?.id) {
      text = "[imagen]";
    }

        // Asegurar conversación y guardar mensaje de usuario
    let conv = null;
    try { conv = await upsertConversation(from, {}, tenant); } catch (e) { console.error("upsertConversation:", e?.message); }
    const convId = conv?._id;

   
console.log("[convId] "+ convId);

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
          meta: { raw: msg }
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
          "¡Gracias! 😊 Cuando quieras hacemos otro pedido."
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
    const gptReply = await getGPTReply(tenant, from, text);
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
          const fixReply = await getGPTReply(tenant, from, `${baseCorrection}\n[INTENTO:${attempt}/${process.env.CALC_FIX_MAX_RETRIES || 3}]`);
          console.log(`[fix][${attempt}] assistant.content =>\n${fixReply}`);
          try {
            const parsedFix = JSON.parse(fixReply);
            parsedFixLast = parsedFix;
            estado = parsedFix.estado || estado;

            let pedidoFix = parsedFix.Pedido || { items: [] };
             // 💰 Rehidratar también en el ciclo de fix
            try { pedidoFix = await hydratePricesFromCatalog(pedidoFix, TENANT_ID || null); } catch {}
         
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
    const responseTextSafe = String(responseText || "").trim()
      || (wantsDetail && pedido && Array.isArray(pedido.items) && pedido.items.length
          ? buildBackendSummary(pedido, { showEnvio: wantsDetail })
          : "Perfecto, sigo acá. ¿Querés confirmar o cambiar algo?");
    await require("./logic").sendWhatsAppMessage(from, responseTextSafe);
    
    
    
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
              if (geo) {
                lat = geo.lat; lon = geo.lon;
                pedido.Domicilio.lat = lat;
                pedido.Domicilio.lon = lon;
                console.log(`[geo] OK lat=${lat}, lon=${lon}`);
              } else {
                console.warn("[geo] No hubo resultado de geocoding (¿API key/billing/localidad?)");
          
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
            const envioProd = await pickEnvioProductByDistance(db, TENANT_ID || null, distKm);
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

// 🔹 Persistir pedido definitivo en MongoDB SOLO si está COMPLETED
if (estado === "COMPLETED" && pedido && convId) {
  try {
    const db = await getDb();
    await db.collection("orders").insertOne({
      tenantId: (tenant || null),
      from,
      // vinculamos el pedido con la conversación para poder recuperar el ticket
      conversationId: convId ? new ObjectId(String(convId)) : null,
      pedido,
      estado,
      distancia_km: typeof pedido?.distancia_km === "number" ? pedido.distancia_km : distKm ?? null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error("[orders] error insert COMPLETED:", e?.message || e);
  }
}
    } catch {}
    try {
            const userConfirms =
        /\bconfirm(ar|o|a)\b/i.test(text) || /^s(i|í)\b.*confirm/i.test(text);


      // Cerramos si:
      // 1) el flujo terminó (COMPLETED) o fue cancelado, o
      // 2) el usuario confirmó explícitamente y el pedido está completo.
      if (estado === "CANCELLED" || estado === "COMPLETED" || (userConfirms && isPedidoCompleto(pedido))) {
     await closeConversation(convId, estado);
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
