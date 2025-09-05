require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { connect } = require('./services/db');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static('public'));

// Conectar DB
connect().then(()=> console.log('✅ Mongo conectado')).catch(e=>{
  console.error('❌ Error conectando a Mongo:', e);
  process.exit(1);
});

app.get('/', (_req,res)=> res.send('OK'));

// Routers
app.use('/', require('./routes/webhook'));
app.use('/', require('./routes/behavior'));
app.use('/', require('./routes/products'));
app.use('/', require('./routes/admin'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`🚀 Webhook en puerto ${PORT}`));
