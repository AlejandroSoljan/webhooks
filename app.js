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

// ========= WhatsApp Cloud helpers =========
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";
const TRANSCRIBE_API_URL = process.env.TRANSCRIBE_API_URL ||
  "https://transcribegpt-569454200011.northamerica-northeast1.run.app";
const AUDIO_CACHE_TTL_MS = parseInt(process.env.AUDIO_CACHE_TTL_MS || "300000", 10); // 5 min

// ---- Cache en memoria de binarios para exponerlos temporalmente ----
const audioCache = new Map(); // id -> { buffer, mime, expiresAt }
function makeId(n = 16) {
  return crypto.randomBytes(n).toString("hex");
}
function getBaseUrl(req) {
  // Preferí configurar PUBLIC_BASE_URL en env (p.ej. https://tuapp.onrender.com)
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/,"");
  const proto = (req.headers["x-forwarded-proto"] || "https");
  const host = req.headers.host;
  return `${proto}://${host}`;
}

// Endpoint público que sirve el binario cacheado
app.get("/cache/audio/:id", (req, res) => {
  const id = req.params.id;
  const item = audioCache.get(id);
  if (!item || Date.now() > item.expiresAt) {
    audioCache.delete(id);
    return res.status(404).send("Not found");
  }
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(item.buffer);
});

// Utilidad: info de media (devuelve { url, mime_type })
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

// Descarga binario protegido de WhatsApp (requiere Authorization)
async function downloadMediaBuffer(mediaUrl) {
  const token = process.env.WHATSAPP_TOKEN;
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Media download error: ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Crea un URL público temporal en este server para el binario
function putInAudioCache(buffer, mime) {
  const id = makeId();
  audioCache.set(id, {
    buffer,
    mime: mime || "application/octet-stream",
    expiresAt: Date.now() + AUDIO_CACHE_TTL_MS
  });
  return id;
}

// Enviar texto
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
            // 1) Obtener mediaId
            const mediaId = msg.audio?.id;
            if (!mediaId) {
              userText = "Recibí un audio, pero no pude obtenerlo. ¿Podés escribir tu consulta?";
            } else {
              // 2) Traer URL protegida y MIME desde WhatsApp
              const info = await getMediaInfo(mediaId); // { url, mime_type }
              // 3) Descargar binario con Authorization
              const buffer = await downloadMediaBuffer(info.url);
              // 4) Guardarlo temporalmente en memoria y armar URL público
              const id = putInAudioCache(buffer, info.mime_type);
              const baseUrl = getBaseUrl(req);
              const publicUrl = `${baseUrl}/cache/audio/${id}`;

              // 5) Llamar a tu API de transcripción con { audio_url: publicUrl }
              const trResp = await fetch(TRANSCRIBE_API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ audio_url: publicUrl })
              });

              if (!trResp.ok) {
                const err = await trResp.text().catch(() => "");
                console.error("❌ Transcribe API error:", trResp.status, err);
                userText = "No pude transcribir tu audio. ¿Podés escribir tu consulta?";
              } else {
                const trData = await trResp.json().catch(() => ({}));
                // Toleramos distintos esquemas de respuesta
                const transcript = trData.text || trData.transcript || trData.transcription || "";
                userText = transcript
                  ? `Transcripción del audio del usuario: "${transcript}"`
                  : "No obtuve texto de la transcripción. ¿Podés escribir tu consulta?";
              }
            }
          } catch (e) {
            console.error("⚠️ Audio/transcripción fallback:", e);
            userText = "Tu audio no se pudo procesar. ¿Podés escribir tu consulta?";
          }

        } else if (type === "image") {
          userText = "Recibí una imagen. Contame en texto qué necesitás y te ayudo.";

        } else if (type === "document") {
          userText = "Recibí un documento. Pegá el texto relevante o contame tu consulta.";

        } else {
          userText = "Hola 👋 ¿Podés escribir tu consulta en texto?";
        }

        console.log("📩 IN:", { from, type, preview: userText.slice(0, 120) });

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
