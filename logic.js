// logic.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// 🔐 Reemplaza con tus tokens reales
const WHATSAPP_TOKEN = 'EAAOlXEb393oBPHtpnFvgynk7k1Tg6tuVW7wtguIHkU3sfWGT9b0epaGKnDeJ59UvEZBlUdmcZBhGXs8qkkPfCla5wFEP0U7hLtsh6eAABUQRE1kr4UYHDkoaTurrmZAkSZBc6UY9iS2l0W7EleZAvhO7m30Bh51BBNXa46aqyqg4Ex8hA6d8ZCZBP3y4TZAC5X8YxAZDZD'; // Token de acceso de WhatsApp Cloud API
const VERIFY_TOKEN = 'aleds5200'; // Token para verificación del webhook
const PHONE_NUMBER_ID = '764414663425868'; // ID del número de teléfono de WhatsApp
const OPENAI_API_KEY = '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'; // Tu clave de API de OpenAI

// Historial por número (almacenado en memoria)
const chatHistories = {};

/**
 * Procesa el mensaje y devuelve una respuesta de ChatGPT.
 */
async function getGPTReply(from, userMessage) {
  if (!chatHistories[from]) {
    chatHistories[from] = [
      { role: "system", content: "Eres un asistente útil de WhatsApp." }
    ];
  }

  chatHistories[from].push({ role: "user", content: userMessage });

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: chatHistories[from],
        temperature: 0.2
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
    await axios.post(
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        text: { body: text }
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

// 📥 Endpoint para recibir mensajes entrantes de WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!entry || !entry.text) return res.sendStatus(200);

    const from = entry.from; // número de teléfono del usuario
    const text = entry.text.body;

    console.log(`📩 Mensaje recibido de ${from}: ${text}`);

    const gptReply = await getGPTReply(from, text);

    console.log(`🤖 Respuesta GPT: ${gptReply}`);

    await sendWhatsAppMessage(from, gptReply);

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
