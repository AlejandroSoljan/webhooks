const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const oid = value => new ObjectId(crypto.createHash('sha256').update(value).digest('hex').slice(0, 24));

async function syncPilotRecord(db, record) {
  if (!record?.tenant || !record.sessionId || !record._id) return;
  const tenantId = record.tenant;
  const key = tenantId === 'NEA_PRUEBAS'
    ? 'pilot:' + record.sessionId + ':' + record.userId
    : JSON.stringify(['bot-test', tenantId, record.sessionId, record.userId]);
  const conversationId = oid(key);
  const filter = { _id: conversationId, tenantId };
  const col = db.collection('conversations');
  const ts = record.createdAt;
  await col.updateOne(filter, {
    $set: { isTest: true, channelType: 'bot_test', sourceTenant: tenantId, botMode: 'conversacional',
      contactName: 'Prueba ' + tenantId + ' · ' + record.sessionId.slice(0, 12) },
    $setOnInsert: { waId: 'BOT_TEST:' + conversationId, openedAt: ts, createdAt: ts,
      finalized: false, status: 'OPEN', manualOpen: false },
    $max: { updatedAt: ts },
  }, { upsert: true });
  await col.updateOne({ ...filter, $or: [{ lastUserTs: { $lt: ts } }, { lastUserTs: { $exists: false } }] },
    { $set: { lastUserTs: ts, finalized: false, status: 'OPEN', manualOpen: false } });
  const entries = [['user', record.message, ts]];
  if (record.status === 'completed' && typeof record.reply === 'string') entries.push(['assistant', record.reply, record.completedAt || ts]);
  for (const [role, content, at] of entries) {
    await db.collection('messages').updateOne({ _id: oid('pilot-message:' + record._id + ':' + role), tenantId, conversationId },
      { $set: { isTest: true, role, type: 'text', content, ts: at, createdAt: at } }, { upsert: true });
  }
  return conversationId;
}
module.exports = { syncPilotRecord };
