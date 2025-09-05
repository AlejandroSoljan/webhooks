const { buildSystemPrompt } = require('./behaviorService');
const { getDb } = require('./db');
const { sendText } = require('./whatsappService');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function extractWaTextEntry(body){
  try{
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const msg = value?.messages?.[0];
    const waId = msg?.from || value?.contacts?.[0]?.wa_id;
    const text = msg?.text?.body;
    return { waId, text, raw: msg };
  }catch(_){ return { waId:null, text:null, raw:null };}
}

async function handleWebhookGet(req, res){
  // Verify token (WhatsApp webhook)
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'token';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
}

async function processMessage(waId, userText){
  const db = await getDb();
  // Snapshot del prompt (caché interna)
  const systemText = await buildSystemPrompt();

  // Conversación corta (no almacenamos todo aquí para simplificar)
  const messages = [
    { role: 'system', content: systemText },
    { role: 'user', content: String(userText || '') }
  ];

  // Pedimos SOLO JSON
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.2
  });

  const raw = resp.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}$/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch (e) {
    parsed = { response: raw, estado: "IN_PROGRESS" };
  }

  // Guardar order si vino completa
  if (parsed?.Pedido) {
    const doc = {
      waId,
      pedido: parsed.Pedido,
      estado: parsed.estado || 'IN_PROGRESS',
      createdAt: new Date()
    };
    await db.collection('orders').insertOne(doc);
  }

  // Responder al cliente
  const reply = parsed?.response || raw || "Gracias, enseguida te respondo.";
  await sendText(waId, reply);
}

async function handleWebhookPost(req, res){
  try {
    const { waId, text } = extractWaTextEntry(req.body || {});
    if (!waId) return res.sendStatus(200);
    await processMessage(waId, text || '');
    res.sendStatus(200);
  } catch (e) {
    console.error("Error en POST /webhook:", e);
    res.sendStatus(200); // evitar reintentos excesivos
  }
}

module.exports = { handleWebhookGet, handleWebhookPost };
