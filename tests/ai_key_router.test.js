// Asisto | Version: 5.00.078 | Fecha: 2026-09-10
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveOpenAiApiKey } = require('../ai_key_router');

test('cada tipo de IA usa exclusivamente su clave', () => {
  const env = {
    OPENAI_API_KEY: 'global-no-usar', OPENAI_API_KEY_SUPERMERCADO_DIGITAL: 'sd',
    OPENAI_API_KEY_PEDIDOS: 'ped', OPENAI_API_KEY_CONVERSACIONAL: 'conv',
    OPENAI_API_KEY_AYUDA: 'help', OPENAI_API_KEY_TAREAS_WS: 'tasks',
  };
  assert.equal(resolveOpenAiApiKey('qr_web', env), 'sd');
  assert.equal(resolveOpenAiApiKey('pedidos', env), 'ped');
  assert.equal(resolveOpenAiApiKey('conversacional', env), 'conv');
  assert.equal(resolveOpenAiApiKey('help_api', env), 'help');
  assert.equal(resolveOpenAiApiKey('whatsapp_tasks', env), 'tasks');
});

test('no cae en la clave global ni en una clave de tenant', () => {
  assert.equal(resolveOpenAiApiKey('pedidos', { OPENAI_API_KEY: 'global' }), '');
});
