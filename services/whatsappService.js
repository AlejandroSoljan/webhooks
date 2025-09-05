// services/whatsappService.js
// Usa fetch nativo (Node 18+) o cae a node-fetch dinámico si no está
const fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

// Leer variables de entorno con *fallbacks* para evitar 'undefined' en la URL
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const PHONE_ID =
  process.env.WHATSAPP_PHONE_ID ||
  process.env.PHONE_NUMBER_ID ||   // nombre alternativo muy común
  process.env.PHONE_ID ||          // por las dudas
  null;

const WA_TOKEN = process.env.WHATSAPP_TOKEN;

// Validaciones tempranas (log claro)
function assertEnv() {
  const missing = [];
  if (!WA_TOKEN) missing.push("WHATSAPP_TOKEN");
  if (!PHONE_ID) missing.push("WHATSAPP_PHONE_ID (o PHONE_NUMBER_ID)");
  if (missing.length) {
    const msg = "Faltan variables de entorno: " + missing.join(", ");
    console.error("❌", msg);
    throw new Error(msg);
  }
}

async function sendText(waId, text) {
  assertEnv();
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: waId,
    type: "text",
    text: { body: String(text || "") },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    const err = `WhatsApp API ${resp.status} ${errBody}`;
    console.error("❌ sendText error:", err);
    throw new Error(err);
  }
  return true;
}

module.exports = { sendText };
