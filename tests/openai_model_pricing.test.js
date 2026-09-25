// Asisto | Version: 5.00.241 | Fecha: 2026-09-25
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalOpenAiModel, textModelPrice, audioModelPrice } = require('../openai_model_pricing');
const { calculateEstimatedCost, calculateBillableCost } = require('../token_control_stats');

test('precios oficiales se guardan por 1K tokens', () => {
  assert.deepEqual(textModelPrice('gpt-5.6-luna'), { input: 0.0002, output: 0.0012 });
  assert.deepEqual(textModelPrice('gpt-5.6-terra'), { input: 0.002, output: 0.012 });
  assert.deepEqual(textModelPrice('gpt-5.4'), { input: 0.0025, output: 0.015 });
  assert.deepEqual(textModelPrice('gpt-5.4-mini'), { input: 0.00075, output: 0.0045 });
});

test('snapshots usan el precio de su modelo y audio conserva unidad por minuto', () => {
  assert.equal(canonicalOpenAiModel('gpt-5.4-2026-03-05'), 'gpt-5.4');
  assert.deepEqual(audioModelPrice('whisper-1'), { unit: 'minute', usd: 0.006 });
});

test('todo dominio con tokens calcula costo real desde el modelo registrado', () => {
  const usage = {
    message_input_tokens: 1000,
    message_output_tokens: 1000,
    models: ['gpt-5.6-terra']
  };

  assert.equal(calculateEstimatedCost(usage, {}), 0.014);
  assert.equal(calculateBillableCost(usage, {}), 0);
});

test('la tarifa configurada prevalece y un modelo ausente usa el costo base vigente', () => {
  const usage = { message_input_tokens: 1000, message_output_tokens: 1000 };
  assert.equal(calculateEstimatedCost(usage, {}), 0.0014);
  assert.equal(calculateEstimatedCost(usage, {
    token_cost_chat_input_per_1k: 0.01,
    token_cost_chat_output_per_1k: 0.02
  }), 0.03);
});

test('el margen IA recalcula también el histórico desde el costo real', () => {
  const usage = {
    message_input_tokens: 1000,
    message_output_tokens: 1000,
    models: ['gpt-5.6-terra']
  };
  const tenant = {
    monetizationConfigured: true,
    billingEnabled: true,
    aiMarkupPercent: 100
  };

  assert.equal(calculateEstimatedCost(usage, tenant), 0.014);
  assert.equal(calculateBillableCost(usage, tenant), 0.028);
});
