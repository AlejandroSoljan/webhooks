// Asisto | Version: 5.00.233 | Fecha: 2026-09-24
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalOpenAiModel, textModelPrice, audioModelPrice } = require('../openai_model_pricing');

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
