// services/webhookService.js
const { ensureOpenConversation, appendMessage } = require("./conversationService");
const { sendText, getMediaUrl, downloadBuffer } = require("./whatsappService");
const { chatWithOpenAI, transcribeAudioBuffer, ocrImageFromUrl } = require("./openaiService");
const { buildSystemPrompt } = require("./behaviorService");
const { estimateCost } = require("./pricing");

async function handleWebhookGet(req, res) {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === (process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN)) {
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
        const value = change.value || {};
        const messages = value.messages || [];
        const contactName = value?.contacts?.[0]?.profile?.name || null;

        for (const message of messages) {
          await processMessage(message, { value, contactName });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error en POST /webhook:", err);
    res.sendStatus(500);
  }
}

async function processMessage(message, { value, contactName } = {}) {
  const from = message.from;
  const type = message.type || "text";
  const conv = await ensureOpenConversation(from, { contactName });

  if (type === "text" || message.text?.body) {
    const text = message.text?.body || "";
    await appendMessage(conv._id, {
      role: "user",
      content: text,
      type: "text",
      meta: { msgId: message.id || null }
    });

    const system = await buildSystemPrompt();
    const { text: reply, usage, model } = await chatWithOpenAI(text, { system });
    const cost = estimateCost(usage, model);

    await sendText(from, reply);
    await appendMessage(conv._id, {
      role: "assistant",
      content: reply,
      type: "text",
      meta: { usage, cost_estimate: cost }
    });
    return;
  }

  if (type === "audio" && message.audio?.id) {
    const mediaId = message.audio.id;
    const mediaUrl = await getMediaUrl(mediaId);
    const buf = await downloadBuffer(mediaUrl);
    const tr = await transcribeAudioBuffer(buf, {
      filename: message.audio?.mime_type?.includes("mp4") ? "audio.m4a" : "audio.ogg"
    });
    const trCost = estimateCost(tr.usage, tr.model);

    await appendMessage(conv._id, {
      role: "user",
      content: tr.text || "(audio sin transcribir)",
      type: "audio",
      meta: { msgId: message.id || null, mediaId, mediaUrl, duration: message.audio?.duration, mime: message.audio?.mime_type, usage: tr.usage, cost_estimate: trCost }
    });

    const system = await buildSystemPrompt();
    const chat = await chatWithOpenAI(tr.text || "", { system });
    const chatCost = estimateCost(chat.usage, chat.model);

    await sendText(from, chat.text);
    await appendMessage(conv._id, {
      role: "assistant",
      content: chat.text,
      type: "text",
      meta: { usage: chat.usage, cost_estimate: chatCost }
    });
    return;
  }

  if ((type === "image" && message.image?.id) || message.type === "image") {
    const mediaId = message.image.id;
    const mediaUrl = await getMediaUrl(mediaId);
    const o = await ocrImageFromUrl(mediaUrl);
    const oCost = estimateCost(o.usage, o.model);

    await appendMessage(conv._id, {
      role: "user",
      content: o.text || "(imagen recibida)",
      type: "image",
      meta: { msgId: message.id || null, mediaId, mediaUrl, caption: message.image?.caption || null, mime: message.image?.mime_type, usage: o.usage, cost_estimate: oCost }
    });

    const system = await buildSystemPrompt();
    const chat = await chatWithOpenAI(`Texto/Descripción extraído: ${o.text || "(vacío)"}`, { system });
    const chatCost = estimateCost(chat.usage, chat.model);

    await sendText(from, chat.text);
    await appendMessage(conv._id, {
      role: "assistant",
      content: chat.text,
      type: "text",
      meta: { usage: chat.usage, cost_estimate: chatCost }
    });
    return;
  }

  await appendMessage(conv._id, {
    role: "user",
    content: `(mensaje ${type} recibido)`,
    type,
    meta: { raw: message }
  });
  const fallback = "Recibí tu mensaje 👍. Si es audio o imagen intentaré procesarlo; si necesitás, escribime por texto.";
  await sendText(from, fallback);
  await appendMessage(conv._id, {
    role: "assistant",
    content: fallback,
    type: "text",
    meta: {}
  });
}

module.exports = { handleWebhookGet, handleWebhookPost };
