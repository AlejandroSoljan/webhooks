const express = require('express');
const { getDb } = require('../services/db');
const { buildSystemPrompt } = require('../services/behaviorService');
const router = express.Router();

async function loadBehaviorTextFromMongo() {
  const db = await getDb();
  const doc = await db.collection('settings').findOne({ _id: 'behavior' });
  return (doc && doc.text) ? String(doc.text) : "Sos un asistente claro, amable y conciso. Respondé en español.";
}
async function saveBehaviorTextToMongo(newText) {
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'behavior' },
    { $set: { text: String(newText || '').trim(), updatedAt: new Date() } },
    { upsert: true }
  );
}

router.get('/comportamiento', async (_req,res)=>{
  const text = await loadBehaviorTextFromMongo();
  res.type('html').send('<h1>Comportamiento</h1><pre>'+text+'</pre>');
});

router.get('/api/behavior', async (_req,res)=>{
  const text = await loadBehaviorTextFromMongo();
  res.json({ source:'mongo', text });
});
router.post('/api/behavior', async (req,res)=>{
  await saveBehaviorTextToMongo(req.body?.text || '');
  await buildSystemPrompt({ force:true });
  res.json({ ok:true });
});

module.exports = router;
