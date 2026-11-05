// Asisto | Registro aislado del piloto web, sin actividad en canales reales.
'use strict';

async function beginTestRecord(db, { tenant, sessionId, message, userId, model }) {
  // Alcance explícito del piloto autorizado; no altera los simuladores reales.
  if (tenant !== 'NEA_PRUEBAS') return null;
  const collection = db.collection('bot_test_history');
  const result = await collection.insertOne({
    tenant, sessionId, message, userId: String(userId || '').slice(0, 100),
    model: String(model || ''), channel: 'bot_test', status: 'pending',
    createdAt: new Date(),
  });
  return { collection, id: result.insertedId, tenant };
}

async function finishTestRecord(record, { reply, error = false, durationMs }) {
  if (!record) return;
  await record.collection.updateOne({ _id: record.id, tenant: record.tenant }, {
    $set: { status: error ? 'failed' : 'completed',
      ...(error ? { errorCode: 'bot_test_failed' } : { reply }),
      durationMs, completedAt: new Date() },
  });
}

module.exports = { beginTestRecord, finishTestRecord };
