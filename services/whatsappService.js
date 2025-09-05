// services/whatsappService.js

// Robust fetch polyfill for CommonJS:
// - Uses global fetch on Node >=18
// - Falls back to node-fetch (v2 or v3) seamlessly
let _fetch = globalThis.fetch;
if (!_fetch) {
  try {
    // Try require (works for node-fetch v2; for v3 we use .default)
    const nf = require("node-fetch");
    _fetch = nf.default || nf;
  } catch (e) {
    // Dynamic import for ESM-only node-fetch v3
    _fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
  }
}
// Wrap to always return a promise regardless of impl
const fetch = (...args) => Promise.resolve(_fetch(...args));

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v18.0";
const BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function sendText(to, text) {
  const url = `${BASE_URL}/${process.env.PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error("sendText error:", resp.status, body);
  }
}

async function markAsRead(messageId) {
  const url = `${BASE_URL}/${process.env.PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.warn("markAsRead error:", resp.status, body);
  }
}

module.exports = { sendText, markAsRead };
