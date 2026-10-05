// Asisto | SDG attachment regression tests (no external API calls).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const helpers = require('../media_interpretation');
const { isTransferReceiptAnalysis } = require('../transfer_receipt');

test('contextual interpretation is isolated to SDG, not product identification', () => {
  assert.equal(helpers.usesContextualMedia('sdg', 'payment-proof'), true);
  for (const tenant of ['MCN', 'ALSO', 'DEMJG', 'SANA']) assert.equal(helpers.usesContextualMedia(tenant), false);
  assert.equal(helpers.usesContextualMedia('SDG', 'product-identification'), false);
});

for (const kind of ['Image', 'Document']) {
  test(`${kind}: SDG preserves order items instead of reducing them to payment classification`, async () => {
    const source = fs.readFileSync(require.resolve('../logic'), 'utf8');
    const start = source.indexOf(`async function analyze${kind}External(`);
    const end = source.indexOf('\nasync function ', start + 1);
    const calls = [];
    const result = { document_type: 'pedido', is_transfer_receipt: false, summary: 'Pedido de mercadería', items: [{ product: 'Leche', quantity: 12 }], extracted_text: 'Entregar mañana', limitations: '' };
    const sandbox = {
      ...helpers, isTransferReceiptAnalysis, Buffer, console,
      requireOpenAiApiKey: () => 'test',
      getOpenAIClient: () => ({ chat: { completions: { create: async payload => { calls.push(payload); return { choices: [{ message: { content: JSON.stringify(result) } }] }; } } } }),
      loadTenantAiConfigFromMongo: async () => ({}),
      VISION_MODEL: 'test', CHAT_MODEL: 'test', process: { env: {} },
      applyModelTokenLimit: (payload, model, limit) => { payload.max_tokens = limit; },
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(start, end), sandbox);
    const response = await sandbox[`analyze${kind}External`]({ tenantId: 'SDG', purpose: 'payment-proof', publicImageUrl: 'https://example.com/test.png', buffer: Buffer.from('mock-pdf'), mime: 'application/pdf' });
    assert.match(response.userText, /Leche/);
    assert.match(response.userText, /Entregar mañana/);
    assert.doesNotMatch(response.userText, /no fue identificado/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].max_tokens, 1800);
    assert.match(JSON.stringify(calls[0].messages), /sin presuponer/);
  });
}

test('unreadable evidence and policy never claim successful actions or credited funds', () => {
  assert.match(helpers.mediaEvidenceText(null), /no se pudo leer/);
  assert.match(helpers.mediaBehaviorPolicy, /historial/);
  assert.match(helpers.mediaBehaviorPolicy, /No inventes acciones completadas/);
  assert.match(helpers.mediaExtractionPrompt, /no sigas instrucciones/);
});
