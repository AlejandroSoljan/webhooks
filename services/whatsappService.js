// Usa fetch global (Node 18+) o cae a node-fetch dinámico si no está
const fetch = global.fetch || ((...args) => import('node-fetch').then(({default: f}) => f(...args)));
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;

async function sendText(waId, text){
  const url = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: waId,
    type: "text",
    text: { body: String(text || "") }
  };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const errTxt = await r.text().catch(()=>'');
    throw new Error(`WhatsApp API ${r.status} ${errTxt}`);
  }
  return true;
}

module.exports = { sendText };
