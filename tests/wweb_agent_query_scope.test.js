const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../endpoint'), 'utf8');
const scopeQuery = vm.runInNewContext(
  source.slice(source.indexOf('function wwebAgentAnd('), source.indexOf('function wwebAgentScopeDocument(')) +
  '; wwebAgentScopeQuery'
);

test('agent upsert query contains each enforced tenant and phone path once', () => {
  const cases = [
    ['wa_wweb_message_log', 'numero'],
    ['wa_api_mensajes_confirmaciones', 'numeroFrom'],
    ['wa_api_message_windows', 'numeroFrom'],
  ];

  for (const [collection, phoneField] of cases) {
    const query = scopeQuery(
      collection,
      { tenantId: 'WRONG', [phoneField]: '999', messageId: collection },
      'ALSO',
      '123'
    );
    assert.deepEqual(JSON.parse(JSON.stringify(query)), {
      $and: [
        { messageId: collection },
        { tenantId: 'ALSO', [phoneField]: '123' },
      ],
    });
  }
});

test('agent scope keeps non-session filters and logical operators', () => {
  const query = scopeQuery(
    'wa_wweb_message_log',
    { tenantId: 'ALSO', numero: '123', $or: [{ state: 'queued' }, { state: 'retry' }] },
    'ALSO',
    '123'
  );
  assert.deepEqual(JSON.parse(JSON.stringify(query)), {
    $and: [
      { $or: [{ state: 'queued' }, { state: 'retry' }] },
      { tenantId: 'ALSO', numero: '123' },
    ],
  });
});
