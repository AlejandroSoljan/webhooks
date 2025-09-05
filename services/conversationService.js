// services/conversationService.js
const { ObjectId } = require('mongodb');
const { getDb } = require('./db');
const { buildSystemPrompt } = require('./behaviorService');

async function ensureOpenConversation(waId, { contactName = null } = {}) {
  const db = await getDb();
  let conv = await db.collection("conversations").findOne({ waId, status: "OPEN" });
  if (!conv) {
    const behaviorText = await buildSystemPrompt({ force: true });
    const doc = {
      waId,
      status: "OPEN",
      finalized: false,
      contactName: contactName || null,
      openedAt: new Date(),
      closedAt: null,
      lastUserTs: null,
      lastAssistantTs: null,
      turns: 0,
      behaviorSnapshot: {
        text: behaviorText,
        source: (process.env.BEHAVIOR_SOURCE || "mongo").toLowerCase(),
        savedAt: new Date()
      }
    };
    const ins = await db.collection("conversations").insertOne(doc);
    conv = { _id: ins.insertedId, ...doc };
  } else if (contactName && !conv.contactName) {
    await db.collection("conversations").updateOne(
      { _id: conv._id },
      { $set: { contactName } }
    );
    conv.contactName = contactName;
  }
  return conv;
}

async function appendMessage(conversationId, {
  role,
  content,
  type = "text",
  meta = {},
  ttlDays = null
}) {
  const db = await getDb();
  const doc = {
    conversationId: new ObjectId(conversationId),
    role, content, type, meta,
    ts: new Date()
  };
  if (ttlDays && Number.isFinite(ttlDays)) {
    doc.expireAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  }
  await db.collection("messages").insertOne(doc);

  const upd = { $inc: { turns: 1 }, $set: {} };
  if (role === "user") upd.$set.lastUserTs = doc.ts;
  if (role === "assistant") upd.$set.lastAssistantTs = doc.ts;
  await db.collection("conversations").updateOne({ _id: new ObjectId(conversationId) }, upd);
}

module.exports = { ensureOpenConversation, appendMessage };
