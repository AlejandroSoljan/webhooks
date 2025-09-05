require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { connect } = require('./services/db');
const { handleWebhookGet, handleWebhookPost } = require('./services/webhookService');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// Conectar DB al inicio
connect().then(()=> console.log('✅ Mongo conectado')).catch(e=>{
  console.error('❌ Error conectando a Mongo:', e);
  process.exit(1);
});

app.get('/', (_req,res)=> res.send('OK'));
app.get('/webhook', handleWebhookGet);
app.post('/webhook', handleWebhookPost);

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`🚀 Webhook en puerto ${PORT}`));
