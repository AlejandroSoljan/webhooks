// Provider cost is calculated per event, never with tenant selling rates.
const { TEXT_MODEL_PRICES_PER_1K, AUDIO_MODEL_PRICES } = require('./openai_model_pricing');
function costExpression() {
  const model = { $ifNull: ['$model', ''] };
  const matches = name => ({ $regexMatch: { input: model, regex: '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:-\\d{4}-\\d{2}-\\d{2})?$' } });
  const text = { $switch: { branches: Object.entries(TEXT_MODEL_PRICES_PER_1K).map(([name, rate]) => ({ case: matches(name), then: { $add: [{ $multiply: [{ $ifNull: ['$inputTokens', 0] }, rate.input / 1000] }, { $multiply: [{ $ifNull: ['$outputTokens', 0] }, rate.output / 1000] }] } })), default: null } };
  const audio = { $switch: { branches: Object.entries(AUDIO_MODEL_PRICES).map(([name, rate]) => ({ case: { $and: [matches(name), { $isNumber: '$audioSeconds' }, { $gte: ['$audioSeconds', 0] }] }, then: { $multiply: ['$audioSeconds', rate.usd / 60] } })), default: null } };
  return { $cond: [{ $and: [{ $isNumber: '$costUsd' }, { $gte: ['$costUsd', 0] }] }, '$costUsd', { $cond: [{ $eq: [{ $ifNull: ['$provider', 'openai'] }, 'openai'] }, { $switch: { branches: [{ case: { $eq: ['$kind', 'message'] }, then: text }, { case: { $eq: ['$kind', 'audio'] }, then: audio }], default: null } }, null] }] };
}
function costGroupFields() {
  return { provider_cost_usd: { $sum: { $ifNull: [costExpression(), 0] } }, unpriced_events: { $sum: { $cond: [{ $eq: [costExpression(), null] }, 1, 0] } } };
}
module.exports = { costExpression, costGroupFields };
