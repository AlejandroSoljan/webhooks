// services/whatsappService.js
const fetch = global.fetch || require("node-fetch");

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

function getPhoneNumberId(value) {
  let id = value?.metadata?.phone_number_id;
  if (!id && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    id = process.env.WHATSAPP_PHONE_NUMBER_ID.trim();
  }
  return id || null;
}

async function sendText(to, body, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body } };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) console.error("❌ Error WhatsApp sendText:", resp.status, data);
  else console.log("📤 Enviado:", data);
  return data;
}

async function sendSafeText(to, body, value) {
  const phoneNumberId = getPhoneNumberId(value);
  if (!phoneNumberId) {
    console.error("❌ No hay phone_number_id ni en metadata ni en ENV. No se puede enviar WhatsApp.");
    return { error: "missing_phone_number_id" };
  }
  try {
    return await sendText(to, body, phoneNumberId);
  } catch (e) {
    console.error("❌ Error en sendSafeText:", e);
    return { error: e.message || "send_failed" };
  }
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

async function sendAudioLink(to, publicUrl, phoneNumberId) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "audio",
    audio: { link: publicUrl }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) console.error("❌ Error WhatsApp sendAudioLink:", resp.status, data);
  else console.log("📤 Enviado AUDIO:", data);
  return data;
}

module.exports = { getPhoneNumberId, sendText, sendSafeText, markAsRead, sendAudioLink };
