// server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

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
  // timingSafeEqual para evitar ataques de tiempo
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
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
// --- Endpoint mensajes entrantes ---
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (message) {
      const from = message.from; // número del cliente
      const type = message.type;
      let text = "";

      if (type === "text") {
        text = message.text.body;
      }

      console.log("📩 Recibido:", text);

      // 🔄 Reenviar mismo mensaje
      if (text) {
        await sendMessage(from, text, value.metadata.phone_number_id);
      }
    }

    res.sendStatus(200); // Siempre respondemos 200 rápido
  } else {
    res.sendStatus(404);
  }
});

// --- Función para enviar mensaje usando la API de WhatsApp ---
async function sendMessage(to, message, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN; // Tu token de acceso (permanent)
  const url = `https://graph.facebook.com/v22.0/731664510029283/messages`;

  const payload = {
     "messaging_product": "whatsapp",
    "to": "543462674128", 
    "type": "template", "template": { "name": "hello_world", "language": { "code": "en_US" } } 
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer EAARMwGcchbYBPMPnXC0np1FmFPIb9oFUZBFrKChOFVPp06g2AEFEpeMayZCaRX4hJ8A0qwt3IenQNp4u0RL5hUbfsuKcGwqwunbO9D5LFioro4JZCpHrWpj4w3rmZA3fzxgFEPXbzeplQTbxPC74SEc0mXgDm6SBf4M8e5NZAYuQT61beh7k9d5QeSY18cUYcZCZBbMkSAp7QLLvu1knx5B7FZCY9aHSdZArZCTV1nNeZBcJTeDIhPJGnALczWZCEQIU`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();
    console.log("📤 Enviado:", data);
  } catch (err) {
    console.error("⚠️ Error enviando mensaje:", err);
  }
}

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook listening on port ${PORT}`);
});
