// Asisto | Registro aislado del piloto web, sin actividad en canales reales.
'use strict';

async function beginTestRecord(db, { tenant, sessionId, message, userId, model }) {
  const collection = db.collection('bot_test_history');
  const doc = {
    tenant, sessionId, message, userId: String(userId || '').slice(0, 100),
    model: String(model || ''), channel: 'bot_test', status: 'pending',
    createdAt: new Date(),
  };
  const result = await collection.insertOne(doc);
  await require('./bot_test_projection').syncPilotRecord(db, { ...doc, _id: result.insertedId });
  return { collection, id: result.insertedId, tenant, db };
}

async function finishTestRecord(record, { reply, error = false, durationMs }) {
  if (!record) return;
  await record.collection.updateOne({ _id: record.id, tenant: record.tenant, status: 'pending' }, {
    $set: { status: error ? 'failed' : 'completed',
      ...(error ? { errorCode: 'bot_test_failed' } : { reply }),
      durationMs, completedAt: new Date() },
  });
  if (record.db) {
    const saved = await record.collection.findOne({ _id: record.id, tenant: record.tenant });
    await require('./bot_test_projection').syncPilotRecord(record.db, saved);
  }
}

module.exports = { beginTestRecord, finishTestRecord };
