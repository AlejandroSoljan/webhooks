// server.js
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();

// ========= Body / firma =========
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

function isValidSignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");
  if (!appSecret || !signature) return false;

  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(req.rawBody);
  const expected = "sha256=" + hmac.digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ========= OpenAI =========
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: parseo seguro de JSON (limpia fences si aparecieran)
function safeJsonParse(raw) {
  if (raw == null) return null;
  let txt = String(raw).trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    console.error("❌ No se pudo parsear JSON:", e.message, "\nRaw:", raw);
    return null;
  }
}

// ========= Sesiones (historial) =========
const comportamiento = process.env.COMPORTAMIENTO ||
  "Sos un asistente claro, amable y conciso. Respondé en español.";

const sessions = new Map(); // waId -> { messages, updatedAt }

/** Crea/obtiene sesión por waId */
function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      messages: [{ role: "system", content: comportamiento }],
      updatedAt: Date.now()
    });
  }
  return sessions.get(waId);
}

/** Reinicia (borra) la sesión del usuario */
function resetSession(waId) {
  sessions.delete(waId);
}

/** Agrega mensaje y recorta historial (últimos 20 turnos) */
function pushMessage(session, role, content, maxTurns = 20) {
  session.messages.push({ role, content });
  const system = session.messages[0];
  const tail = session.messages.slice(-2 * maxTurns);
  session.messages = [system, ...tail];
  session.updatedAt = Date.now();
}

/**
 * Chat con historial → fuerza salida JSON:
 * { "response": "texto", "estado": "IN_PROGRESS|COMPLETED" }
 */
async function chatWithHistoryJSON(
  waId,
  userText,
  model = process.env.OPENAI_MODEL || "gpt-4o-mini"
) {
  const session = getSession(waId);
  pushMessage(session, "user", userText);

  const completion = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" }, // fuerza JSON válido
    messages: [
      ...session.messages,
      {
        role: "system",
        content:
          "Respondé SOLO con JSON válido (sin ```). Estructura exacta: " +
          '{ "response": "texto para WhatsApp", "estado": "IN_PROGRESS|COMPLETED" }'
      }
    ],
    temperature: 0.6
  });

  const content = completion.choices?.[0]?.message?.content || "";
  const data = safeJsonParse(content);

  // Normalización + fallback
  const responseText =
    (data && typeof data.response === "string" && data.response.trim()) ||
    (typeof content === "string" ? content.trim() : "") ||
    "Perdón, no pude generar una respuesta. ¿Podés reformular?";

  const estado =
    (data && typeof data.estado === "string" && data.estado.trim().toUpperCase()) ||
    "IN_PROGRESS";

  // Guardar en historial lo que se envía al usuario
  pushMessage(session, "assistant", responseText);

  return { response: responseText, estado };
}

// ========= WhatsApp / Media helpers =========
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const TRANSCRIBE_API_URL = (process.env.TRANSCRIBE_API_URL || "https://transcribegpt-569454200011.northamerica-northeast1.run.app").replace(/\/+$/,"");
const TRANSCRIBE_FORCE_GET = process.env.TRANSCRIBE_FORCE_GET === "true";
const CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10); // 5 min

// ---- Cache en memoria de binarios (audio e imagen) ----
const fileCache = new Map(); // id -> { buffer, mime, expiresAt }

function makeId(n = 16) {
  return crypto.randomBytes(n).toString("hex");
}
function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/,"");
  const proto = (req.headers["x-forwarded-proto"] || "https");
  const host = req.headers.host;
  return `${proto}://${host}`;
}
function putInCache(buffer, mime) {
  const id = makeId();
  fileCache.set(id, {
    buffer,
    mime: mime || "application/octet-stream",
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  return id;
}
function getFromCache(id) {
  const item = fileCache.get(id);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    fileCache.delete(id);
    return null;
  }
  return item;
}

// 🧹 Limpiador periódico de cache (cada 60s)
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of fileCache.entries()) {
    if (now > item.expiresAt) {
      fileCache.delete(id);
    }
  }
}, 60 * 1000);

// Endpoints públicos para servir el binario cacheado
app.get("/cache/audio/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});
app.get("/cache/image/:id", (req, res) => {
  const item = getFromCache(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});

async function getMediaInfo(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(`Media info error: ${resp.status} ${JSON.stringify(data)}`);
  }
  return resp.json();
}

async function downloadMediaBuffer(mediaUrl) {
  const token = process.env.WHATSAPP_TOKEN;
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Media download error: ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---- OCR de imagen con OpenAI Chat Completions (o4-mini) ----
async function transcribeImageWithOpenAI(publicImageUrl) {
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: "o4-mini",
    messages: [
      {
        role: "system",
        content: "Muestra solo el texto sin saltos de linea ni caracteres especiales que veas en la imagen"
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: publicImageUrl }
          }
        ]
      }
    ],
    temperature: 1
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`OpenAI vision error: ${resp.status} ${errTxt}`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  return text;
}

// ---- Transcriptor externo con POST y fallback GET ----
async function transcribeAudioExternal(publicAudioUrl) {
  const base = TRANSCRIBE_API_URL;

  // Si nos piden forzar GET, vamos directo
  if (TRANSCRIBE_FORCE_GET) {
    const g = await fetch(`${base}?audio_url=${encodeURIComponent(publicAudioUrl)}`);
    if (!g.ok) {
      const err2 = await g.text().catch(() => "");
      throw new Error(`Transcribe GET error: ${g.status} ${err2}`);
    }
    return g.json().catch(() => ({}));
  }

  // 1) Intento POST
  const r = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: publicAudioUrl })
  });
  if (r.ok) return r.json().catch(() => ({}));

  // 2) Fallback GET si 405/404
  if (r.status === 405 || r.status === 404) {
    const errTxt = await r.text().catch(() => "");
    console.warn("Transcribe POST no permitido:", r.status, errTxt);
    const g = await fetch(`${base}?audio_url=${encodeURIComponent(publicAudioUrl)}`);
    if (!g.ok) {
      const err2 = await g.text().catch(() => "");
      throw new Error(`Transcribe GET error: ${g.status} ${err2}`);
    }
    return g.json().catch(() => ({}));
  }

  // 3) Otro error
  const err = await r.text().catch(() => "");
  throw new Error(`Transcribe POST error: ${r.status} ${err}`);
}

// ========= WhatsApp send / mark =========
async function sendText(to, body, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!resp.ok) console.error("❌ Error WhatsApp sendText:", resp.status, data);
  else console.log("📤 Enviado:", data);
  return data;
}

async function markAsRead(messageId, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", status: "read", message_id: messageId };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    console.warn("⚠️ markAsRead falló:", resp.status, data);
  }
}

// ========= Rutas =========
app.get("/", (_req, res) => res.status(200).send("WhatsApp Webhook up ✅"));

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Verificación fallida");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    if (process.env.WHATSAPP_APP_SECRET && !isValidSignature(req)) {
      console.warn("❌ Firma inválida");
      return res.sendStatus(403);
    }

    const body = req.body;
    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(404);
    }

    // Responder 200 rápido
    res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const msg = value.messages?.[0];
        if (!msg) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        const from = msg.from;         // E.164 sin '+'
        const type = msg.type;
        const messageId = msg.id;

        if (messageId && phoneNumberId) markAsRead(messageId, phoneNumberId).catch(() => {});

        // ---- Normalizamos la entrada del usuario ----
        let userText = "";

        if (type === "text") {
          userText = msg.text?.body || "";

        } else if (type === "interactive") {
          const it = msg.interactive;
          if (it?.type === "button_reply") userText = it.button_reply?.title || "";
          if (it?.type === "list_reply")   userText = it.list_reply?.title || "";
          if (!userText) userText = "Seleccionaste una opción. ¿En qué puedo ayudarte?";

        } else if (type === "audio") {
          try {
            const mediaId = msg.audio?.id;
            if (!mediaId) {
              userText = "Recibí un audio, pero no pude obtenerlo. ¿Podés escribir tu consulta?";
            } else {
              const info = await getMediaInfo(mediaId); // { url, mime_type }
              const buffer = await downloadMediaBuffer(info.url);
              const id = putInCache(buffer, info.mime_type);
              const baseUrl = getBaseUrl(req);
              const publicUrl = `${baseUrl}/cache/audio/${id}`;

              // Transcripción con POST y fallback GET
              try {
                const trData = await transcribeAudioExternal(publicUrl);
                const transcript = trData.text || trData.transcript || trData.transcription || trData.result || "";
                userText = transcript
                  ? `Transcripción del audio del usuario: "${transcript}"`
                  : "No obtuve texto de la transcripción. ¿Podés escribir tu consulta?";
              } catch (e) {
                console.error("❌ Transcribe API error (POST/GET):", e.message);
                userText = "No pude transcribir tu audio. ¿Podés escribir tu consulta?";
              }
            }
          } catch (e) {
            console.error("⚠️ Audio/transcripción fallback:", e);
            userText = "Tu audio no se pudo procesar. ¿Podés escribir tu consulta?";
          }

        } else if (type === "image") {
          try {
            const mediaId = msg.image?.id;
            if (!mediaId) {
              userText = "Recibí una imagen pero no pude descargarla. ¿Podés describir lo que dice?";
            } else {
              const info = await getMediaInfo(mediaId); // { url, mime_type }
              const buffer = await downloadMediaBuffer(info.url);
              const id = putInCache(buffer, info.mime_type);
              const baseUrl = getBaseUrl(req);
              const publicUrl = `${baseUrl}/cache/image/${id}`;

              const text = await transcribeImageWithOpenAI(publicUrl);
              userText = text
                ? `Texto detectado en la imagen: "${text}"`
                : "No pude detectar texto en la imagen. ¿Podés escribir lo que dice?";
            }
          } catch (e) {
            console.error("⚠️ Imagen/OCR fallback:", e);
            userText = "No pude procesar la imagen. ¿Podés escribir lo que dice?";
          }

        } else if (type === "document") {
          userText = "Recibí un documento. Pegá el texto relevante o contame tu consulta.";

        } else {
          userText = "Hola 👋 ¿Podés escribir tu consulta en texto?";
        }

        console.log("📩 IN:", { from, type, preview: (userText || "").slice(0, 120) });

        // ---- Llamamos al modelo con historial y JSON en la salida ----
        let responseText = "Perdón, no pude generar una respuesta. ¿Podés reformular?";
        let estado = "IN_PROGRESS";
        try {
          const out = await chatWithHistoryJSON(from, userText);
          responseText = out.response || responseText;
          estado = (out.estado || "IN_PROGRESS").toUpperCase();
        } catch (e) {
          console.error("❌ OpenAI error:", e);
        }

        // ---- Enviar respuesta al usuario ----
        await sendText(from, responseText, phoneNumberId);
        console.log("📤 OUT →", from, "| estado:", estado);

        // ---- Si COMPLETED, reiniciar historial del contacto ----
        if (estado === "COMPLETED") {
          resetSession(from);
          console.log("🔁 Historial reiniciado para", from);
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error en webhook:", err);
  }
});

// ========= Start =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));
