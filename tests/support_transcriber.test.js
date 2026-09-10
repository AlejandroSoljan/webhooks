// Asisto | Version: 5.00.078 | Fecha: 2026-09-10
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { asistoTranscriber } = require('../src/support/transcriber');

test('support uses the exclusive tareas WS key and the existing Asisto usage path', async () => {
  let call;
  const provider = asistoTranscriber({ OPENAI_API_KEY_TAREAS_WS: 'tasks-fixture' }, {
    runtimeFor: async tenant => { assert.equal(tenant, 'a'); return { openaiApiKey: 'tenant-fixture' }; },
    download: async () => Buffer.from('audio-fixture'),
    transcribe: async input => { call = input; return { text: 'Manager no abre', model: 'tenant-model' }; },
  });
  const result = await provider.run('raw-fixture', { mimetype: 'audio/ogg' }, { tenantId: 'a', userId: 'user', jid: '123', conversationId: 'job', messageId: 'scoped-message' });
  assert.equal(call.openaiApiKey, 'tasks-fixture');
  assert.equal(call.aiKeyKind, 'tareas_ws');
  assert.equal(call.tenantId, 'a'); assert.equal(call.usageTraceId, 'scoped-message');
  assert.equal(call.buffer.toString(), 'audio-fixture');
  assert.equal(call.transcriptionTimeoutMs, 60000);
  assert.equal(result.text, 'Manager no abre'); assert.equal(result.model, 'tenant-model');
  assert.equal(result.costUsd, null);
  await assert.rejects(() => provider.run('', {}, {}), /authentication_required/);
});

test('global key is rejected; a missing tasks key or empty transcription is not accepted as success', async () => {
  const options = { runtimeFor: async () => null, download: async () => Buffer.from('audio'), transcribe: async input => { assert.equal(input.openaiApiKey, 'tasks'); return { text: '' }; } };
  const scope = { tenantId: 'a', userId: 'u' };
  await assert.rejects(() => asistoTranscriber({ OPENAI_API_KEY_TAREAS_WS: 'tasks' }, options).run('', {}, scope), /transcription_failed/);
  await assert.rejects(() => asistoTranscriber({ OPENAI_API_KEY: 'global-no-usar' }, options).run('', {}, scope), /transcription_provider_required/);
  await assert.rejects(() => asistoTranscriber({}, options).run('', {}, scope), /transcription_provider_required/);
});
