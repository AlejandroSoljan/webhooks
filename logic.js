// logic.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
// ⬇️ Cliente oficial de OpenAI para fallback de STT
const OpenAI = require("openai");
let openai = null;
// util de SDK para crear File desde Buffer en Node
let toFile = null;

const app = express();
app.use(bodyParser.json());


///Variables
const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; 
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHAT_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0.1) || 0.1;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID.trim()
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v17.0";
const ENDED_SESSION_TTL_MINUTES = Number(process.env.ENDED_SESSION_TTL_MINUTES || 15);
const CALC_FIX_MAX_RETRIES = Number(process.env.CALC_FIX_MAX_RETRIES || 3);
const STORE_TZ = (process.env.STORE_TZ || "America/Argentina/Cordoba").trim();
const SIMULATED_NOW_ISO = (process.env.SIMULATED_NOW_ISO || "").trim();
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "").trim().replace(/\/+$/, "");
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10);
const TRANSCRIBE_MODEL = process.env.WHISPER_MODEL || process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

// Historial por número (almacenado en memoria)
const chatHistories = {};
// Marcador de conversaciones finalizadas (COMPLETED/CANCELLED)

// Guardamos timestamp para TTL
const endedSessions = {};

// ================== Fecha/Hora local para el modelo ==================

function _nowLabelInTZ() {
  const base = SIMULATED_NOW_ISO ? new Date(SIMULATED_NOW_ISO) : new Date();
  const fmt = new Intl.DateTimeFormat("es-AR", {
    timeZone: STORE_TZ, hour12: false,
    weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(base).map(p => [p.type, p.value]));
  const weekday = String(parts.weekday || "").toLowerCase();
  return `${weekday}, ${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}
function buildNowBlock() {
  return [
    "[AHORA]",
    `Zona horaria: ${STORE_TZ}`,
    `Fecha y hora actuales (local): ${_nowLabelInTZ()}`
  ].join("\n");
}
// ================== OpenAI client (para fallback STT) ==================
try {
  if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    // import diferido para evitar error si se usa una versión vieja del SDK
    try {
      ({ toFile } = require("openai/uploads"));
    } catch { /* opcional */ }
  }
} catch (e) {
  console.error("OpenAI init error:", e.message);
}



let baseText = "";
  baseText = String(process.env.COMPORTAMIENTO );

const fullText = [
    buildNowBlock(),
    "[COMPORTAMIENTO]\n" + baseText,
  ].join("\n\n").trim();

/**
 * Procesa el mensaje y devuelve una respuesta de ChatGPT.
 */
async function getGPTReply(from, userMessage) {
  if (!chatHistories[from]) {
    chatHistories[from] = [
      { role: "system", content: fullText

}
    ];
  }
  chatHistories[from].push({ role: "user", content: userMessage });

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: CHAT_MODEL,
        messages: chatHistories[from],
        temperature: CHAT_TEMPERATURE,
        response_format: { type: "json_object" } // ⬅️ JSON MODE
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;

    chatHistories[from].push({ role: "assistant", content: reply });
    console.log("Historial:  "+ JSON.stringify( chatHistories[from]));

    return reply;
  } catch (error) {
    console.error("Error OpenAI:", error.response?.data || error.message);
    return "Lo siento, ocurrió un error. Intenta nuevamente.";
  }
}

/**
 * Envía mensaje por WhatsApp usando la Cloud API.
 */
async function sendWhatsAppMessage(to, text) {
  try {
    // ⚠️ Nunca enviar body vacío a WhatsApp
    const body = String(text ?? "").trim();
    if (!body) {
      console.error("WhatsApp: intento de envío con text.body vacío. Se omite el envío.");
      return;
    }

    await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        //text: { body: text }
        text: { body }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error("Error enviando WhatsApp:", error.response?.data || error.message);
  }
}
// ==========================
// WhatsApp Media helpers (audio)
// ==========================


// ==========================
// Utilidades de fin de sesión con TTL
// ==========================


function hasActiveEndedFlag(from) {
  const rec = endedSessions[from];
  if (!rec) return false;
  const ageMin = (Date.now() - rec.endedAt) / 60000;
  if (ageMin > ENDED_SESSION_TTL_MINUTES) {
    // Expiró: limpiamos y permitimos nueva conversación
    delete endedSessions[from];
    return false;
  }
  return true;
}

async function transcribeAudioExternal({ publicAudioUrl, buffer, mime }) {
  // 1) Servicio externo (si está configurado y accesible)
  const prefer = TRANSCRIBE_API_URL;
  if (prefer && publicAudioUrl) {
    try {
      console.log("🎙️ STT externo →", `${prefer}/transcribe?url=...`);
      const r = await fetch(`${prefer}/transcribe?url=${encodeURIComponent(publicAudioUrl)}`);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j && typeof j.text === "string" && j.text.trim()) {
          return { text: j.text, usage: j.tokens || j.usage || null, engine: "external" };
        }
        console.warn("STT externo: respuesta sin texto útil");
      } else {
        console.warn("STT externo: HTTP", r.status);
      }
    } catch (e) {
      console.error("STT externo error:", e.message);
    }
  }
  // 2) Fallback: OpenAI (requiere OPENAI_API_KEY)
  try {
    if (!openai) {
      console.warn("STT fallback OpenAI no disponible (sin cliente).");
      return { text: "" };
    }
    let buf = buffer, mt = mime;
    if (!buf && publicAudioUrl) {
      const r2 = await fetch(publicAudioUrl);
      mt = r2.headers.get("content-type") || mime || "audio/ogg";
      const ab = await r2.arrayBuffer(); buf = Buffer.from(ab);
    }
    if (!buf) return { text: "" };
    const ext =
      (mt || "").includes("wav") ? "wav" :
      (mt || "").includes("mp3") ? "mp3" :
      ((mt || "").includes("ogg") || (mt || "").includes("opus")) ? "ogg" : "mp3";

    // usar util del SDK si está disponible
    let fileObj = null;
    if (toFile) {
      fileObj = await toFile(buf, `audio.${ext}`, { type: mt || "audio/ogg" });
    } else {
      // fallback simple con Blob/File de node@18+
      const FileCtor = global.File || require("node:buffer").Blob;
      fileObj = new FileCtor([buf], `audio.${ext}`, { type: mt || "audio/ogg" });
    }
    console.log("🎙️ STT OpenAI →", TRANSCRIBE_MODEL);
    const r = await openai.audio.transcriptions.create({ file: fileObj, model: TRANSCRIBE_MODEL });
    const text = (r.text || "").trim();
    if (!text) console.warn("STT OpenAI devolvió vacío");
    return { text, usage: r.usage || null, engine: "openai" };
  } catch (e) {
    console.error("STT OpenAI error:", e.message);
    return { text: "" };
  }
}

// ==========================
// Detección de saludo/agradecimiento breve
// ==========================
function isPoliteClosingMessage(textRaw) {
  const text = String(textRaw || "").trim().toLowerCase();
  if (!text) return false;
  // saludos y agradecimientos típicos cortos
  const exacts = [
    "gracias","muchas gracias","mil gracias","ok","oka","okey","dale","listo",
    "genial","perfecto","buenas","buenas noches","buen dia","buen día",
    "👍","👌","🙌","🙏","🙂","😊","👏","✌️"
  ];
  if (exacts.includes(text)) return true;
  // variantes cortas frecuentes
  if (/^(gracias+!?|ok+|dale+|listo+|genial+|perfecto+)\b/.test(text)) return true;
  if (/(saludos|abrazo)/.test(text) && text.length <= 40) return true;
  return false;
}

function markSessionEnded(from) {
  delete chatHistories[from];     // limpia historial
  endedSessions[from] = true;     // marca que terminó
}



// 📥 Endpoint para recibir mensajes entrantes de WhatsApp
// helper: sanea "20.000", "20,000", etc.
const num = v => Number(String(v).replace(/[^\d.-]/g, '') || 0);

// Fallback de resumen correcto calculado por backend
/*function buildBackendSummary(pedido) {
  return [
    '🧾 Resumen del pedido:',
    ...(pedido.items || []).map(i => `- ${i.cantidad} ${i.descripcion}`),
    `💰 Total: ${Number(pedido.total_pedido || 0).toLocaleString('es-AR')}`,
    '¿Confirmamos el pedido? ✅'
  ].join('\n');
}*/

// Usa la respuesta del modelo si viene, si no usa un fallback seguro
const START_FALLBACK = "¡Hola! 👋 ¿Qué te gustaría pedir? Pollo (entero/mitad) y papas (2, 4 o 6).";
function coalesceResponse(maybeText, pedidoObj) {
  const s = String(maybeText ?? "").trim();
  return s || ((pedidoObj?.items?.length || 0) > 0 ? buildBackendSummary(pedidoObj) : START_FALLBACK);
}
 
// helper: quita acentos para comparar texto
const strip = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

// helper: agrega "Envio" si Entrega = domicilio y no está en items
function ensureEnvio(pedido) {
  const entrega = (pedido?.Entrega || '').toLowerCase();
  const tieneEnvio = (pedido.items || []).some(i =>
    (i.descripcion || '').toLowerCase().includes('envio')
  );
  if (entrega === 'domicilio' && !tieneEnvio) {
    (pedido.items ||= []).push({
      descripcion: 'Envio',
      cantidad: 1,
      importe_unitario: 1500,
      total: 1500
    });
  }
}

// Helper para armar resumen con total correcto (fallback)
function buildBackendSummary(pedido) {
  return [
    '🧾 Resumen del pedido:',
    ...(pedido.items || []).map(i => `- ${i.cantidad} ${i.descripcion}`),
    `💰 Total: ${Number(pedido.total_pedido || 0).toLocaleString('es-AR')}`,
    '¿Confirmamos el pedido? ✅'
  ].join('\n');
}


// Recalcula totales y detecta diferencias con lo que vino del modelo
// Recalcula totales y detecta diferencias SOLO cuando hay ítems
function recalcAndDetectMismatch(pedido) {
  pedido.items ||= [];
  const hasItems = pedido.items.length > 0;
  let mismatch = false;

 // Añadir envío solo si corresponde
  const beforeCount = pedido.items.length;
  ensureEnvio(pedido);
  if (pedido.items.length !== beforeCount && hasItems) mismatch = true;

  // Recalcular ítems
  let totalCalc = 0;
  pedido.items = pedido.items.map(it => {
   const cantidad = num(it.cantidad);
    const unit = num(it.importe_unitario);
    const totalOk = cantidad * unit;
    const totalIn = it.total != null ? num(it.total) : null;
    // Solo marcar mismatch por ítems si efectivamente hay ítems
    if (hasItems && (totalIn === null || totalIn !== totalOk)) mismatch = true;
    totalCalc += totalOk;
    return { ...it, cantidad, importe_unitario: unit, total: totalOk };
  });

  // Comparar total_pedido SOLO cuando hay ítems
  const totalModelo = (pedido.total_pedido == null) ? null : num(pedido.total_pedido);
  if (hasItems && (totalModelo === null || totalModelo !== totalCalc)) mismatch = true;

  pedido.total_pedido = totalCalc; // 0 si no hay ítems
  return { pedidoCorr: pedido, mismatch, hasItems };
}
async function getMediaInfo(mediaId) {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !mediaId) throw new Error("media_info_missing");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const resp = await fetch(`${url}?fields=url,mime_type`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`media_info_failed_${resp.status}`);
  return resp.json();
}
async function downloadMediaBuffer(mediaUrl) {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`download_media_failed_${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

// cache simple en memoria
const fileCache = new Map();
function makeId() { return Math.random().toString(36).slice(2, 10); }
function putInCache(buffer, mime) {
  const id = makeId();
  fileCache.set(id, { buffer, mime: mime || "application/octet-stream", expiresAt: Date.now() + CACHE_TTL_MS });
  return id;
}
// endpoint público para el audio cacheado
app.get("/cache/audio/:id", (req, res) => {
  const rec = fileCache.get(req.params.id);
  if (!rec || rec.expiresAt < Date.now()) return res.status(404).send("expired");
  res.set("Content-Type", rec.mime); res.send(rec.buffer);
});



app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
     if (!entry) return res.sendStatus(200); // admitimos audio o texto
    const from = entry.from;
    let text = (entry.text?.body || "").trim();

      // Texto directo
    if (entry.type === "text" && entry.text?.body) {
      text = entry.text.body;
    }
    // 🎙️ Audio → transcribir
    else if (entry.type === "audio" && entry.audio?.id) {
      try {
        const info = await getMediaInfo(entry.audio.id);
        const buf = await downloadMediaBuffer(info.url);
        const id = putInCache(buf, info.mime_type || "audio/ogg");
        const publicAudioUrl = `${req.protocol}://${req.get("host")}/cache/audio/${id}`;
        const tr = await transcribeAudioExternal({ publicAudioUrl, buffer: buf, mime: info.mime_type });
        text = String(tr?.text || "").trim() || "(audio sin texto)";
      } catch (e) {
        console.error("❌ Audio/transcripción:", e.message);
        text = "(no se pudo transcribir el audio)";
      }
    }

    // Si la conversación anterior terminó (y no expiró por TTL) y el cliente
    // solo saluda/agradece, respondemos corto y NO iniciamos conversación nueva.
    if (hasActiveEndedFlag(from)) {
      if (isPoliteClosingMessage(text)) {
        await sendWhatsAppMessage(
          from,
          "¡Gracias! 😊 Cuando quieras hacemos otro pedido."
        );
        return res.sendStatus(200);
      }
      // Mensaje “real”: limpiamos el flag para iniciar conversación nueva.
      delete endedSessions[from];
    
    
  }
    const gptReply = await getGPTReply(from, text);

    let responseText = 'Perdón, hubo un error. ¿Podés repetir?';
    let estado = null;
    let pedido = null;

    try {
      // 1) Parsear UNA sola vez
      const parsed = JSON.parse(gptReply);
      estado = parsed.estado;
      pedido = parsed.Pedido || { items: [] };

      // 2) Recalcular y detectar inconsistencias respecto al JSON del modelo
       const { pedidoCorr, mismatch, hasItems } = recalcAndDetectMismatch(pedido);
      pedido = pedidoCorr; // pedido corregido

        if (mismatch && hasItems) {
        // 3a) FEEDBACK LOOP con límite de reintentos
        const itemsForModel = (pedido.items || [])
          .map(i => `- ${i.cantidad} x ${i.descripcion} @ ${i.importe_unitario}`)
          .join('\n');

        const baseCorrection =
          [
            "[CORRECCION_DE_IMPORTES]",
            "Detectamos que los importes de tu JSON no coinciden con la suma de ítems según el catálogo.",
            "Recalculá los totales DESDE CERO usando solo los precios del catálogo del prompt.",
            "Usá estos ítems interpretados (cantidad y precio unitario):",
            itemsForModel,
            `Total esperado por backend: ${pedido.total_pedido}`,
            "Devolvé UN ÚNICO objeto JSON con: response, estado (IN_PROGRESS|COMPLETED|CANCELLED),",
            "y Pedido { Entrega, Domicilio, items[ {descripcion, cantidad, importe_unitario, total} ], total_pedido }.",
            "No incluyas texto fuera del JSON."
          ].join('\n');

        let fixedOk = false;
        let parsedFixLast = null;

        for (let attempt = 1; attempt <= CALC_FIX_MAX_RETRIES; attempt++) {
          const correctionMessage = `${baseCorrection}\n[INTENTO:${attempt}/${CALC_FIX_MAX_RETRIES}]`;
          const fixReply = await getGPTReply(from, correctionMessage);

        console.log("------------------------------------------------");
        console.log("Recalculando totales............................");
        console.log("------------------------------------------------");

        // Llamada adicional al modelo con la corrección
       // await sendWhatsAppMessage(from, "recalculo de totales.....");  

          try {
            const parsedFix = JSON.parse(fixReply);
            parsedFixLast = parsedFix;
            estado = parsedFix.estado || estado;

            let pedidoFix = parsedFix.Pedido || { items: [] };
            const { pedidoCorr: pedidoFixCorr, mismatch: mismatchFix, hasItems: hasItemsFix } =
              recalcAndDetectMismatch(pedidoFix);

            // actualizamos referencia de pedido por si mejora
            pedido = pedidoFixCorr;

            if (!mismatchFix && hasItemsFix) {
              fixedOk = true;
              break;
            }
          } catch (e2) {
            console.error('❌ Error al parsear fixReply JSON:', e2.message);
            // sigue el loop
          }
        }

        if (fixedOk && parsedFixLast) {
          // 3a.1) Ahora está consistente: usamos la respuesta del modelo corregida
          //responseText = parsedFixLast.response;
          responseText = coalesceResponse(parsedFixLast.response, pedido);
        } else {
          // 3a.2) El modelo siguió inconsistente: fallback al resumen del backend
          responseText = buildBackendSummary(pedido);
        }
      } else {
        // 3b) Si todo coincide, usamos la respuesta original del modelo
       // responseText = parsed.response;
        responseText = coalesceResponse(parsed.response, pedido);
      }

      // (opcional) logs
      console.log('📦 Estado:', estado);
      console.log('🧾 Pedido:', JSON.stringify(pedido, null, 2));
    } catch (e) {
      console.error('❌ Error al parsear/corregir JSON:', e.message);
    }

    
    // 5) Guardia FINAL: si el cuerpo quedó vacío, enviar SIEMPRE un resumen del pedido
    //    (esto cubre especialmente el caso luego del recalculo por diferencia)
    try {
      const finalBody = String(responseText ?? "").trim();
      if (!finalBody) {
        if (pedido && Array.isArray(pedido.items) && pedido.items.length > 0) {
          responseText = buildBackendSummary(pedido);
        } else {
          responseText = START_FALLBACK;
        }
      }
    } catch {}

    await sendWhatsAppMessage(from, responseText);

    // 6) Si el pedido terminó, limpiar historial y marcar sesión finalizada.
    try {
      if (estado === "COMPLETED" || estado === "CANCELLED") {
        markSessionEnded(from);
      }
    } catch {}



    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error en webhook:", error.message);
    res.sendStatus(500);
  }
});


// 🔐 Verificación de Webhook de Meta (una sola vez)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("🟢 Webhook verificado correctamente");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
