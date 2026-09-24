// Asisto | Version: 5.00.233 | Fecha: 2026-09-24

const OPENAI_PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing';
const OPENAI_PRICING_VERIFIED_AT = '2026-09-24';

// Valores oficiales Standard de OpenAI convertidos de USD por 1M a USD por 1K.
const TEXT_MODEL_PRICES_PER_1K = Object.freeze({
  'gpt-6-astra': { input: 0.005, output: 0.025 },
  'gpt-6-sol': { input: 0.001, output: 0.005 },
  'gpt-6-luna': { input: 0.00005, output: 0.00025 },
  'gpt-5.6-sol': { input: 0.004, output: 0.020 },
  'gpt-5.6-terra': { input: 0.002, output: 0.012 },
  'gpt-5.6-luna': { input: 0.0002, output: 0.0012 },
  'gpt-5.4': { input: 0.0025, output: 0.015 },
  'gpt-5.4-mini': { input: 0.00075, output: 0.0045 },
  'gpt-5.4-nano': { input: 0.0002, output: 0.00125 }
});

const AUDIO_MODEL_PRICES = Object.freeze({
  'whisper-1': { unit: 'minute', usd: 0.006 },
  'gpt-transcribe': { unit: 'minute', usd: 0.0045 },
  'gpt-4o-transcribe': { unit: 'minute', usd: 0.006 },
  'gpt-4o-mini-transcribe': { unit: 'minute', usd: 0.003 }
});

function canonicalOpenAiModel(model) {
  const value = String(model || '').trim().toLowerCase();
  if (!value) return '';
  const textModels = Object.keys(TEXT_MODEL_PRICES_PER_1K).sort((a, b) => b.length - a.length);
  if (textModels.includes(value)) return value;
  for (const known of textModels) {
    if (new RegExp(`^${known.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}$`).test(value)) return known;
  }
  for (const known of Object.keys(AUDIO_MODEL_PRICES)) {
    if (value === known || value.startsWith(known + '-')) return known;
  }
  return value;
}

function textModelPrice(model) {
  return TEXT_MODEL_PRICES_PER_1K[canonicalOpenAiModel(model)] || null;
}

function audioModelPrice(model) {
  return AUDIO_MODEL_PRICES[canonicalOpenAiModel(model)] || null;
}

module.exports = {
  OPENAI_PRICING_SOURCE,
  OPENAI_PRICING_VERIFIED_AT,
  TEXT_MODEL_PRICES_PER_1K,
  AUDIO_MODEL_PRICES,
  canonicalOpenAiModel,
  textModelPrice,
  audioModelPrice
};
