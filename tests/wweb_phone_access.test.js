// Asisto | Version: 5.00.077 | Fecha: 2026-09-09
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { effectiveSessionState } = require('../wweb_phone_access');

test('wa-session no muestra online con heartbeat vencido', () => {
  const now = Date.parse('2026-09-09T15:00:00Z');
  assert.equal(effectiveSessionState({ state: 'online', lastSeenAt: new Date(now - 31000) }, {}, now), 'inactive');
  assert.equal(effectiveSessionState({ state: 'online', lastSeenAt: new Date(now - 29000) }, {}, now), 'online');
});

test('estados administrativos prevalecen sobre heartbeat', () => {
  const now = Date.now();
  const lock = { state: 'online', lastSeenAt: new Date(now) };
  assert.equal(effectiveSessionState(lock, { paused: true }, now), 'paused');
  assert.equal(effectiveSessionState(lock, { mensajes_bloqueados: true }, now), 'paused');
  assert.equal(effectiveSessionState(lock, { disabled: true }, now), 'disabled');
});
