const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultConfig } = require('../monetization_config');
const { calculateEvent } = require('../monetization_engine');

test('calcula precio fijo por cantidad', () => {
  const config = defaultConfig('RVL');
  config.items['whatsapp.api_sent'] = { enabled: true, mode: 'fixed', credits: 0, unitPrice: 20 };
  const result = calculateEvent(config, 'whatsapp.api_sent', 3);
  assert.equal(result.potentialAmount, 60);
  assert.equal(result.credits, 0);
});

test('calcula créditos según el valor configurado', () => {
  const config = defaultConfig('MCN');
  config.creditValue = 12.5;
  config.items['catalog.qr_read'] = { enabled: true, mode: 'credits', credits: 2, unitPrice: 0 };
  const result = calculateEvent(config, 'catalog.qr_read', 4);
  assert.equal(result.credits, 8);
  assert.equal(result.potentialAmount, 100);
});

test('no calcula funcionalidades desactivadas', () => {
  const result = calculateEvent(defaultConfig('MCN'), 'queue.ticket', 1);
  assert.equal(result.enabled, false);
  assert.equal(result.potentialAmount, 0);
});
