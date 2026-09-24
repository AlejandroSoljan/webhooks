// Asisto | Version: 5.00.233 | Fecha: 2026-09-24
// Actualiza solamente costos internos. Nunca modifica tarifas de venta.
require('dotenv').config();
const { getDb, closeDb } = require('../db');
const {
  OPENAI_PRICING_SOURCE,
  OPENAI_PRICING_VERIFIED_AT,
  canonicalOpenAiModel,
  textModelPrice,
  audioModelPrice
} = require('../openai_model_pricing');

const APPLY = process.argv.includes('--apply');
const FALLBACK_CHAT_MODEL = canonicalOpenAiModel(process.env.CHAT_MODEL || 'gpt-5.6-luna');
const HELP_MODEL = 'gpt-5.6-luna';
const TRANSCRIBE_MODEL = canonicalOpenAiModel(process.env.OPENAI_TRANSCRIBE_MODEL || process.env.WHISPER_MODEL || 'whisper-1');

async function resolveModels(db, tenantIds) {
  const behaviorDocs = await db.collection('settings').find(
    { _id: { $in: tenantIds.map(id => `behavior:${id}`) } },
    { projection: { _id: 1, chat_model: 1 } }
  ).toArray();
  const behaviorByTenant = new Map(behaviorDocs.map(doc => [String(doc._id).replace(/^behavior:/, ''), canonicalOpenAiModel(doc.chat_model)]));

  const usage = await db.collection('ai_token_usage_log').aggregate([
    { $match: {
      tenantId: { $in: tenantIds }, kind: 'message', model: { $type: 'string', $ne: '' },
      $expr: { $not: [{ $in: [{ $ifNull: ['$channelType', '$meta.channelType'] }, ['help_api', 'whatsapp_tasks']] }] }
    } },
    { $group: { _id: { tenantId: '$tenantId', model: '$model' }, tokens: { $sum: { $ifNull: ['$totalTokens', 0] } }, lastAt: { $max: '$createdAt' } } },
    { $sort: { tokens: -1, lastAt: -1 } }
  ], { allowDiskUse: true }).toArray();
  const usageByTenant = new Map();
  for (const row of usage) {
    const tenantId = String(row?._id?.tenantId || '');
    if (!usageByTenant.has(tenantId)) usageByTenant.set(tenantId, canonicalOpenAiModel(row?._id?.model));
  }

  return new Map(tenantIds.map(tenantId => [
    tenantId,
    behaviorByTenant.get(tenantId) || usageByTenant.get(tenantId) || FALLBACK_CHAT_MODEL
  ]));
}

async function main() {
  const db = await getDb();
  const tenantDocs = await db.collection('tenant_config').find(
    { _id: { $type: 'string', $ne: 'default' } },
    { projection: { _id: 1 } }
  ).sort({ _id: 1 }).toArray();
  const tenantIds = tenantDocs.map(doc => String(doc._id || '').trim()).filter(Boolean);
  const modelByTenant = await resolveModels(db, tenantIds);
  const helpPrice = textModelPrice(HELP_MODEL);
  const audioPrice = audioModelPrice(TRANSCRIBE_MODEL);
  const changes = [];

  for (const tenantId of tenantIds) {
    const model = modelByTenant.get(tenantId) || FALLBACK_CHAT_MODEL;
    const chatPrice = textModelPrice(model);
    if (!chatPrice) throw new Error(`Precio oficial no definido para ${model} (${tenantId})`);
    const set = {
      token_cost_chat_input_per_1k: chatPrice.input,
      token_cost_chat_output_per_1k: chatPrice.output,
      token_cost_help_input_per_1k: helpPrice.input,
      token_cost_help_output_per_1k: helpPrice.output,
      token_cost_model: model,
      token_cost_help_model: HELP_MODEL,
      token_cost_audio_model: TRANSCRIBE_MODEL,
      token_cost_audio_usd_per_minute: Number(audioPrice?.usd || 0),
      token_cost_pricing_source: OPENAI_PRICING_SOURCE,
      token_cost_pricing_verified_at: new Date(`${OPENAI_PRICING_VERIFIED_AT}T12:00:00.000Z`),
      token_cost_updated_at: new Date()
    };
    changes.push({ tenantId, model, inputPer1K: chatPrice.input, outputPer1K: chatPrice.output });
    if (APPLY) await db.collection('tenant_config').updateOne({ _id: tenantId }, { $set: set });
  }

  console.log(JSON.stringify({ ok: true, applied: APPLY, source: OPENAI_PRICING_SOURCE, verifiedAt: OPENAI_PRICING_VERIFIED_AT, changes }, null, 2));
  if (typeof closeDb === 'function') await closeDb();
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { resolveModels };
