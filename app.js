import 'dotenv/config';  
import express from 'express';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import fetch from 'node-fetch';
import OpenAI from 'openai';

const app = express();

// Usamos raw body para poder verificar firma antes de parsear JSON
app.use(async (req, res, next) => {
  if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    try {
      req.rawBody = await getRawBody(req);
      req.body = JSON.parse(req.rawBody.toString('utf8'));
    } catch (e) {
      return res.sendStatus(400);
    }
  } else {
    next();
  }
});

// 1) Verificación del webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Recepción de mensajes (POST) + verificación de firma
function verifyMetaSignature(req) {
  const appSecret = process.env.META_APP_SECRET;
  const theirSig = req.headers['x-hub-signature-256']; // "sha256=..."
  if (!appSecret || !theirSig || !req.rawBody) return false;

  const hmac = crypto.createHmac('sha256', appSecret);
  hmac.update(req.rawBody);
  const expected = 'sha256=' + hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(theirSig));
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/webhook', async (req, res) => {
  if (!verifyMetaSignature(req)) {
    return res.sendStatus(401);
  }

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from; // número del usuario
  const type = message?.type;

  // Importante: responder rápido al webhook (200) para evitar reintentos
  res.sendStatus(200);

  if (!from || !type) return;

  // Extraer el texto recibido
  let userText = '';
  if (type === 'text') {
    userText = message.text?.body || '';
  } else {
    userText = 'Mensaje recibido.';
  }

  try {
    // 3) Llamar a OpenAI (Responses API)
    const systemPrompt = `Eres un asistente útil y breve para WhatsApp. Responde en español neutro y en 1-3 frases.`;
    const completion = await openai.responses.create({
      model: 'gpt-5.1-mini', // usa el modelo que prefieras
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      // opcional: limita longitud/costo
      max_output_tokens: 200
    });

    const aiText =
      completion.output_text?.trim() ||
      completion.output?.[0]?.content?.[0]?.text?.trim() ||
      '¡Listo!';

    // 4) Enviar mensaje de vuelta por WhatsApp
    const url = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;

    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: aiText }
      })
    });
  } catch (err) {
    console.error('Error procesando mensaje:', err);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Servidor escuchando en puerto', process.env.PORT || 3000);
});
