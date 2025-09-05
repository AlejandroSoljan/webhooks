const { getDb } = require('./db');
let cache = { at:0, text:null };
const TTL = 5*60*1000;

async function loadBehaviorTextFromMongo(){
  const db = await getDb();
  const doc = await db.collection('settings').findOne({ _id:'behavior' });
  if (doc?.text) return String(doc.text);
  const fallback = "Sos un asistente claro, amable y conciso. Respondé en español.";
  await db.collection('settings').updateOne({ _id:'behavior' }, { $setOnInsert: { text: fallback, updatedAt: new Date() } }, { upsert:true });
  return fallback;
}

async function buildSystemPrompt({ force=false } = {}){
  const now = Date.now();
  if (!force && cache.text && now - cache.at < TTL) return cache.text;
  const base = await loadBehaviorTextFromMongo();
  cache = { at: now, text: base };
  return base;
}
module.exports = { buildSystemPrompt };
