// server.js
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai"); // SDK oficial

const app = express();

// Render y Meta envían JSON; conservamos el raw body para validar firma
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf }
}));

/**
 * Valida firma X-Hub-Signature-256 de Meta para asegurar integridad del payload.
 * Requiere WHATSAPP_APP_SECRET (el App Secret de tu app de Meta).
 */
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

// --- OpenAI: función para consultar a ChatGPT (Responses API)
async function askChatGPT(prompt, {
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
  instructions = "Sos un asistente útil y conciso. Respondé en español."
} = {}) {
  const client = new OpenAI.OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.responses.create({ model, instructions, input: prompt });
  return (resp.output_text || "").trim();
}

// Salud simple
app.get("/", (_req, res) => {
  res.status(200).send("WhatsApp Webhook up ✅");
});

// Verificación del webhook (configuración inicial en Meta)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // define el tuyo

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  } else {
    console.warn("❌ Verificación fallida");
    return res.sendStatus(403);
  }
});

// Recepción de eventos (mensajes, status, etc.)
app.post("/webhook", async (req, res) => {
  try {
    // (Opcional) activar validación de firma si configuraste WHATSAPP_APP_SECRET
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

    // Responder 200 rápido para evitar reintentos de Meta
    res.sendStatus(200);

    // Procesar entradas (pueden venir batched)
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const message = value.messages?.[0];
        if (!message) continue;

        const from = message.from; // número del cliente (E.164 sin +)
        const type = message.type;
        const phoneNumberId = value.metadata?.phone_number_id;

        let text = "";
        if (type === "text") {
          text = message.text?.body || "";
        } else if (type === "interactive") {
          const it = message.interactive;
          if (it?.type === "button_reply") text = it.button_reply?.title || "";
          if (it?.type === "list_reply")   text = it.list_reply?.title || "";
        } else if (type === "image") {
          text = "Recibí una imagen. ¿Podés contarme en texto qué necesitás?";
        } else if (type === "audio") {
          text = "Recibí un audio. ¿Podés escribir tu consulta?";
        }

        console.log("📩 Recibido:", { from, type, text });

        // Si no hay texto interpretable, respondemos amable
        if (!text) {
          await sendMessage(from,
            "¡Hola! Para ayudarte mejor, escribime tu consulta en texto. 😊",
            phoneNumberId
          );
          continue;
        }

        // 🔮 Consultar a ChatGPT y responder por WhatsApp
        const reply = await askChatGPT(text);
        await sendMessage(from,
          reply || "Perdón, no pude generar respuesta. ¿Podés reformular?",
          phoneNumberId
        );
        console.log("📤 Respondido a", from);
      }
    }
  } catch (err) {
    console.error("⚠️ Error en webhook:", err);
    // ya respondimos 200 arriba
  }
});

// --- Función para enviar mensaje usando la API de WhatsApp ---
async function sendMessage(to, message, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN; // Tu token de acceso (permanent)
  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: message }
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error("❌ Error WhatsApp:", resp.status, data);
    } else {
      console.log("📤 Enviado:", data);
    }
  } catch (err) {
    console.error("⚠️ Error enviando mensaje:", err);
  }
}

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook listening on port ${PORT}`);
});
