// Asisto | Version: 5.00.242 | Fecha: 2026-09-25
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalOpenAiModel, textModelPrice, audioModelPrice } = require('../openai_model_pricing');
const { calculateEstimatedCost, calculateBillableCost, loadTenantCosts } = require('../token_control_stats');

test('precios oficiales se guardan por 1K tokens', () => {
  assert.deepEqual(textModelPrice('gpt-6-astra'), { input: 0.010, output: 0.050 });
  assert.deepEqual(textModelPrice('gpt-6-luna'), { input: 0.0001, output: 0.0005 });
  assert.deepEqual(textModelPrice('gpt-5.6-luna'), { input: 0.0002, output: 0.0012 });
  assert.deepEqual(textModelPrice('gpt-5.6-terra'), { input: 0.002, output: 0.012 });
  assert.deepEqual(textModelPrice('gpt-5.4'), { input: 0.0025, output: 0.015 });
  assert.deepEqual(textModelPrice('gpt-5.4-mini'), { input: 0.00075, output: 0.0045 });
  assert.deepEqual(textModelPrice('gpt-4o-mini'), { input: 0.00015, output: 0.0006 });
  assert.deepEqual(textModelPrice('gpt-4o-mini-2024-07-18'), { input: 0.00015, output: 0.0006 });
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

test('un modelo ausente no inventa costos a partir de tarifas del dominio', () => {
  const usage = { message_input_tokens: 1000, message_output_tokens: 1000 };
  assert.equal(calculateEstimatedCost(usage, {}), null);
  assert.equal(calculateEstimatedCost(usage, {
    token_cost_chat_input_per_1k: 0.01,
    token_cost_chat_output_per_1k: 0.02
  }), null);
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

test('un dominio con consumos y monetización funciona aunque todavía no tenga tenant_config', async () => {
  const db = {
    collection(name) {
      return {
        find() {
          return {
            async toArray() {
              return name === 'monetization_config'
                ? [{ _id: 'NUEVO', billingEnabled: true, aiMarkupPercent: 100 }]
                : [];
            },
          };
        },
      };
    },
  };
  const costs = await loadTenantCosts(db, ['NUEVO']);
  assert.deepEqual(costs.get('NUEVO'), {
    _id: 'NUEVO',
    monetizationConfigured: true,
    billingEnabled: true,
    aiMarkupPercent: 100,
  });
});
