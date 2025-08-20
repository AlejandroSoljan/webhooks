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

  console.log("get");

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

app.post('/webhook', (req, res) => {
  try {
    console.log('POST recibido:', JSON.stringify(req.body));
    res.sendStatus(200);           // ✅ responder ya mismo

    // ⬇️ procesar asíncrono después (OpenAI, etc.)
    //procesarMensaje(req.body).catch(console.error);

  } catch (e) {
    console.error(e);
    // ¡No mandes otra respuesta acá, ya enviaste 200!
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Servidor escuchando en puerto', process.env.PORT || 3000);
});
