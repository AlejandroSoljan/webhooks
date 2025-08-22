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

const sessions = new Map();
/** Obtiene/crea sesión por waId */
function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      messages: [{ role: "system", content: comportamiento }],
      updatedAt: Date.now()
    });
  }
  return sessions.get(waId);
}

/** Agrega mensaje y recorta historial (últimos 20 turnos) */
function pushMessage(session, role, content, maxTurns = 20) {
  session.messages.push({ role, content });
  const system = session.messages[0];
  const tail = session.messages.slice(-2 * maxTurns);
  session.messages = [system, ...tail];
  session.updatedAt = Date.now();
}

/** Chat con historial → siempre devuelve { reply, meta } desde JSON del modelo */
async function chatWithHistoryJSON(waId, userText, model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
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
          '{ "reply": "texto para WhatsApp", "meta": { "intent": "string", "confidence": 0.0 } }'
      }
    ],
    temperature: 0.6
  });

  const content = completion.choices?.[0]?.message?.content || "";
  const data = safeJsonParse(content);
console.log("respuesta gpt: " + data.reply)
  if (data && typeof data.reply === "string") {
    pushMessage(session, "assistant", data.reply);
    return { reply: data.reply, meta: data.meta || {} };
  }

  const fallback = (content || "").trim() || "Perdón, no pude generar una respuesta. ¿Podés reformular?";
  pushMessage(session, "assistant", fallback);
  return { reply: fallback, meta: {} };
}

// ========= WhatsApp Cloud helpers =========
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
  if (!resp.ok) {
    console.error("❌ Error WhatsApp sendText:", resp.status, data);
  } else {
    console.log("📤 Enviado:", data);
  }
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

        let userText = "";

        if (type === "text") {
          userText = msg.text?.body || "";

        } else if (type === "interactive") {
          const it = msg.interactive;
          if (it?.type === "button_reply") userText = it.button_reply?.title || "";
          if (it?.type === "list_reply")   userText = it.list_reply?.title || "";
          if (!userText) userText = "Seleccionaste una opción. ¿En qué puedo ayudarte?";

        } else if (type === "image") {
          userText = "Recibí una imagen. Contame en texto qué necesitás y te ayudo.";

        } else if (type === "audio") {
          userText = "Recibí un audio. ¿Podés escribir tu consulta?";

        } else {
          userText = "Hola 👋 ¿Podés escribir tu consulta en texto?";
        }

        console.log("📩 IN:", { from, type, preview: userText.slice(0, 120) });

        // === Chat con historial + salida JSON ===
        let out = "Perdón, no pude generar una respuesta. ¿Podés reformular?";
        try {
          const { reply } = await chatWithHistoryJSON(from, userText);
          out = reply || out;
        } catch (e) {
          console.error("❌ OpenAI error:", e);
        }

       // out = JSON.parse(out);
        
        await sendText(from, out, phoneNumberId);
        console.log("📤 OUT →", from);
      }
    }
  } catch (err) {
    console.error("⚠️ Error en webhook:", err);
  }
});

// ========= Start =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));
