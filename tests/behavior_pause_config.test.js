// Asisto | 2026-10-02 | Behavior timers must survive loading and caching.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../logic'), 'utf8');
const body = source.slice(source.indexOf('async function loadBehaviorConfigFromMongo('), source.indexOf('async function loadBehaviorTextFromMongo('));
test('configured pause and inactivity are returned on initial and cached reads, isolated by tenant', async () => {
  const context = { process: { env: {} }, DEFAULT_TENANT_ID: 'default', _behaviorCache: new Map(),
    normalizeBotMode: value => value, normalizeBehaviorBoolean: value => !!value,
    normalizeConversationalExternalActionsConfig: () => [],
    getDb: async () => ({ collection: () => ({ findOne: async ({_id}) => _id === 'behavior:A' ? {operator_pause_minutes:15, conversation_inactivity_minutes:20} : {} }) }) };
  const load = vm.runInNewContext(body + '\nloadBehaviorConfigFromMongo', context);
  const first = await load('A');
  assert.equal(first.operator_pause_minutes,15);
  assert.equal(first.conversation_inactivity_minutes,20);
  assert.equal((await load('A')).operator_pause_minutes,15);
  assert.equal((await load('B')).operator_pause_minutes,0);
});
