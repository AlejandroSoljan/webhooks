// server.js
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai"); // SDK oficial

const app = express();

// ====== Body / firma ======
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf }
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

// ====== OpenAI ======
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

comportamiento = process.env.COMPORTAMIENTO;

// --- Almacén de sesiones en memoria (por wa_id) ---
const sessions = new Map();
/**
 * Obtiene o crea la sesión de chat para un usuario.
 * Estructura: { messages: [{role, content}, ...], updatedAt }
 */
function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      messages: [
        {
          role: "system",
          content: comportamiento
        }
      ],
      updatedAt: Date.now()
    });
  }
  return sessions.get(waId);
}

// --- Push helper con recorte ---
function pushMessage(session, role, content, maxTurns = 20) {
  session.messages.push({ role, content });
  // recortar: conservamos system + últimos 2*maxTurns (user+assistant)
  const system = session.messages[0];
  const tail = session.messages.slice(-2 * maxTurns);
  session.messages = [system, ...tail];
  session.updatedAt = Date.now();
}

// --- Llama al modelo con historial completo ---
async function chatWithHistory(waId, userText, model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
  const session = getSession(waId);
  pushMessage(session, "user", userText);

  const completion = await openai.chat.completions.create({
    model,
    messages: session.messages,
    temperature: 0.6
  });

  const reply = completion.choices?.[0]?.message?.content?.trim() || "";
  if (reply) pushMessage(session, "assistant", reply);
  return reply;
}

// Transcribe audio con Whisper (whisper-1)
async function transcribeAudio(filePath) {
  try {
    const rs = fs.createReadStream(filePath);
    const tr = await openai.audio.transcriptions.create({
      file: rs,
      model: "whisper-1"
      // language: "es", // opcional
    });
    return (tr.text || "").trim();
  } catch (e) {
    console.error("❌ Error transcribiendo:", e);
    return "";
  }
}

// ====== WhatsApp Cloud helpers ======
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

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
    headers: { Authorization: `Bearer ${token}", "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    console.warn("⚠️ markAsRead falló:", resp.status, data);
  }
}

// Devuelve { url, mime_type }
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

// Descarga binario usando la URL firmada de WhatsApp
async function downloadMediaToFile(mediaId, preferredName = "media.bin") {
  const token = process.env.WHATSAPP_TOKEN;
  const info = await getMediaInfo(mediaId); // { url, mime_type, ... }
  const resp = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Media download error: ${resp.status}`);

  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const ext = (() => {
    const m = (info.mime_type || "").toLowerCase();
    if (m.includes("ogg")) return ".ogg";
    if (m.includes("mpeg")) return ".mp3";
    if (m.includes("mp4")) return ".mp4";
    if (m.includes("aac")) return ".aac";
    if (m.includes("wav")) return ".wav";
    return path.extname(preferredName) || ".bin";
  })();

  const outPath = path.join("/tmp", `${Date.now()}_${preferredName.replace(/[^\w.-]/g,"")}${ext}`);
  fs.writeFileSync(outPath, buffer);
  return { filePath: outPath, mime: info.mime_type || "application/octet-stream" };
}

// ====== Rutas ======
app.get("/", (_req, res) => res.status(200).send("WhatsApp Webhook up ✅"));

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
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
    if (process.env.WHATSAPP_APP_SECRET) {
      if (!isValidSignature(req)) {
        console.warn("❌ Firma inválida");
        return res.sendStatus(403);
      }
    }

    const body = req.body;
    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(404);
    }

    // Respondemos 200 de inmediato
    res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const msg = value.messages?.[0];
        if (!msg) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        const from = msg.from;               // E.164 sin '+'
        const type = msg.type;
        const messageId = msg.id;

        if (messageId && phoneNumberId) markAsRead(messageId, phoneNumberId).catch(() => {});

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
            if (mediaId) {
              const { filePath } = await downloadMediaToFile(mediaId, "audio");
              const transcript = await transcribeAudio(filePath);
              fs.unlink(filePath, () => {});
              if (transcript) {
                userText = `Transcripción del audio del usuario: "${transcript}"`;
              } else {
                userText = "No pude transcribir tu audio. ¿Podés escribir tu consulta?";
              }
            } else {
              userText = "Recibí un audio. ¿Podés escribir tu consulta?";
            }
          } catch (e) {
            console.error("⚠️ Audio fallback:", e);
            userText = "Tu audio no se pudo procesar. ¿Podés escribir tu consulta?";
          }

        } else if (type === "image") {
          userText = "Recibí una imagen. Contame en texto qué necesitás y te ayudo.";

        } else if (type === "document") {
          userText = "Recibí un documento. Pegá el texto relevante o contame tu consulta.";

        } else {
          userText = "Hola 👋 ¿Podés escribir tu consulta en texto?";
        }

        console.log("📩 IN:", { from, type, userText: userText?.slice(0, 120) });

        // === Chat con historial por wa_id ===
        let reply = "";
        try {
          reply = await chatWithHistory(from, userText);
        } catch (e) {
          console.error("❌ OpenAI error:", e);
        }
        const out = reply || "Perdón, no pude generar una respuesta. ¿Podés reformular?";

        await sendText(from, out, phoneNumberId);
        console.log("📤 OUT →", from);
      }
    }
  } catch (err) {
    console.error("⚠️ Error en webhook:", err);
  }
});

// ====== Start ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));
