// Asisto | Version: 5.00.149 | Fecha: 2026-09-17
// Backfill seguro: solo transcripciones exitosas de ALSO con duración conocida.
// Sin --apply muestra el plan; con --apply guarda duración y costo estimado.
require('dotenv').config();
const { getDb } = require('../db');

async function main() {
  const db = await getDb();
  const rate = Number(process.env.TOKEN_COST_WHISPER_PER_MINUTE);
  const costPerMinute = Number.isFinite(rate) && rate > 0 ? rate : 0.006;
  const usages = await db.collection('support_usage').find(
    { tenantId: 'ALSO', kind: 'transcription', model: 'whisper-1', result: 'ok', audioSeconds: { $gt: 0 } },
    { projection: { _id: 1, messageId: 1, audioSeconds: 1 } }
  ).toArray();
  const logs = await db.collection('ai_token_usage_log').find(
    { tenantId: 'ALSO', kind: 'audio', provider: 'openai', model: 'whisper-1',
      channelType: { $in: ['whatsapp_tasks', 'whatsapp'] }, costUsd: { $exists: false } },
    { projection: { _id: 1, usageTraceId: 1 } }
  ).toArray();
  const byMessage = new Map();
  for (const usage of usages) {
    const key = String(usage.messageId || '');
    if (!key) continue;
    if (byMessage.has(key)) byMessage.set(key, null); // Ambigüedad: no actualizar.
    else byMessage.set(key, usage);
  }
  const matched = [];
  for (const log of logs) {
    const usage = byMessage.get(String(log.usageTraceId || ''));
    if (!usage) continue;
    const seconds = Number(usage.audioSeconds);
    const costUsd = Number(((seconds / 60) * costPerMinute).toFixed(6));
    matched.push({ log, usage, seconds, costUsd });
  }
  const totalUsd = matched.reduce((sum, row) => sum + row.costUsd, 0);
  console.log(JSON.stringify({ tenantId: 'ALSO', rateUsdPerMinute: costPerMinute,
    successfulTranscriptions: usages.length, logsWithoutCost: logs.length,
    matched: matched.length, unmatched: logs.length - matched.length,
    estimatedUsd: Number(totalUsd.toFixed(6)), apply: process.argv.includes('--apply') }));
  if (!process.argv.includes('--apply')) return;
  for (const row of matched) {
    const result = await db.collection('ai_token_usage_log').updateOne(
      { _id: row.log._id, tenantId: 'ALSO', costUsd: { $exists: false } },
      { $set: { audioSeconds: row.seconds, costUsd: row.costUsd,
        'meta.costBasis': 'audio_duration_estimate', 'meta.costPerMinute': costPerMinute } }
    );
    if (result.modifiedCount) await db.collection('support_usage').updateOne(
      { _id: row.usage._id, tenantId: 'ALSO', costUsd: null },
      { $set: { costUsd: row.costUsd } }
    );
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
