// services/webhookService.js
const { getDb } = require("./mongoService");
const { sendText, markAsRead } = require("./whatsappService");
const { chatWithOpenAI } = require("./openaiService");

async function handleWebhookGet(req, res) {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } catch (err) {
    console.error("Error en GET /webhook:", err);
    res.sendStatus(500);
  }
}

async function handleWebhookPost(req, res) {
  try {
    const body = req.body;
    if (!body.entry) return res.sendStatus(200);

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const messages = change.value?.messages;
        if (messages) {
          for (const message of messages) {
            await processMessage(message);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error en POST /webhook:", err);
    res.sendStatus(500);
  }
}

async function processMessage(message) {
  const from = message.from;
  const text = message.text?.body || "";

  const db = await getDb();

  await db.collection("messages").insertOne({
    from,
    text,
    timestamp: new Date(),
  });

  const reply = await chatWithOpenAI(text);
  await sendText(from, reply);
  await markAsRead(message.id);
}

module.exports = { handleWebhookGet, handleWebhookPost };
