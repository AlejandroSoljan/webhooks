// services/whatsappService.js
const fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const PHONE_ID =
  process.env.WHATSAPP_PHONE_ID ||
  process.env.PHONE_NUMBER_ID ||
  process.env.PHONE_ID ||
  null;

const WA_TOKEN = process.env.WHATSAPP_TOKEN;

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
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
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

async function getMediaUrl(mediaId) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
  if (!resp.ok) throw new Error(`getMediaUrl ${resp.status}: ${await resp.text()}`);
  const j = await resp.json();
  return j.url;
}

async function downloadBuffer(fileUrl) {
  const resp = await fetch(fileUrl, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
  if (!resp.ok) throw new Error(`downloadBuffer ${resp.status}`);
  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

module.exports = { sendText, getMediaUrl, downloadBuffer };
