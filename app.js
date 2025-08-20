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
app.post("/webhook", (req, res) => {
  // Si configuraste WHATSAPP_APP_SECRET, validamos firma
  if (process.env.WHATSAPP_APP_SECRET) {
    if (!isValidSignature(req)) {
      console.warn("❌ Firma inválida");
      return res.sendStatus(403);
    }
  }

  const body = req.body;

  // Estructura estándar de WhatsApp Cloud API
  if (body.object === "whatsapp_business_account") {
    try {
      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value || {};
          const messages = value.messages || [];
          const statuses = value.statuses || []; // entregas/lecturas

          // Procesar mensajes entrantes
          for (const msg of messages) {
            const from = msg.from; // número del usuario en formato internacional
            const type = msg.type; // text, image, interactive, etc.

            let text = "";
            if (type === "text" && msg.text) text = msg.text.body;
            else if (type === "interactive" && msg.interactive?.type === "button_reply") {
              text = msg.interactive.button_reply.title;
            } else if (type === "interactive" && msg.interactive?.type === "list_reply") {
              text = msg.interactive.list_reply.title;
            }

            // Aquí haces tu lógica: guardar en DB, encolar, responder, etc.
            console.log("📩 Mensaje entrante:", {
              wa_id: from,
              type,
              text,
              full: msg
            });
          }

          // Procesar estados (delivered, read, failed, etc.)
          for (const st of statuses) {
            console.log("📦 Status:", {
              id: st.id,
              status: st.status,
              timestamp: st.timestamp,
              recipient_id: st.recipient_id,
              full: st
            });
          }
        }
      }

      // Meta exige 200 rápido
      return res.sendStatus(200);
    } catch (e) {
      console.error("⚠️ Error procesando payload:", e);
      return res.sendStatus(500);
    }
  }

  // Si no es de WhatsApp, 404
  return res.sendStatus(404);
});

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook listening on port ${PORT}`);
});
