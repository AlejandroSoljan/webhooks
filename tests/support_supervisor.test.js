// Asisto | Version: 5.00.052 | Fecha: 2026-09-08
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { superviseSupport } = require('../src/support/supervisor');
const env = { SUPPORT_ENABLED: 'true', PUBLIC_BASE_URL: 'https://asisto.example', AUTH_COOKIE_SECRET: 'fixture-only-cookie-secret-1234567890', MONGODB_URI: 'mongodb://fixture' };
function fixture(overrides = {}) {
  const children = [], timers = new Map(), parent = new EventEmitter();
  let next = 0;
  const options = { env, parent, log: { error() {} },
    schedule(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    cancel(id) { timers.delete(id); },
    forkImpl(file, args, config) {
      const child = new EventEmitter();
      child.signals = []; child.config = config;
      child.kill = signal => { child.signals.push(signal); if (signal === 'SIGTERM') child.emit('exit', 0); };
      children.push(child); return child;
    }, ...overrides };
  const supervisor = superviseSupport(options);
  return { supervisor, children, timers, parent, fire() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); return timer.ms; } };
}
test('supervisor leaves disabled or incomplete configurations dormant', async () => {
  for (const changes of [{ SUPPORT_ENABLED: 'false' }, { AUTH_COOKIE_SECRET: '' }]) {
    const f = fixture({ env: { ...env, ...changes } });
    assert.equal(f.children.length, 0); assert.equal(f.parent.listenerCount('exit'), 0);
    await f.supervisor.stop();
  }
});
test('supervisor inherits environment, retries crashes with backoff and cancels retries at shutdown', async () => {
  const f = fixture();
  assert.deepEqual(f.children[0].config.env, env);
  f.children[0].emit('exit', 1);
  assert.equal(f.fire(), 5000);
  f.children[1].emit('exit', 1);
  assert.equal(f.fire(), 10000);
  f.children[2].emit('message', { type: 'support-ready' });
  f.children[2].emit('exit', 1);
  assert.equal([...f.timers.values()][0].ms, 5000);
  await f.supervisor.stop();
  assert.equal(f.timers.size, 0); assert.equal(f.parent.listenerCount('exit'), 0);
});
test('supervisor stops its child once and forces an unresponsive child to exit', async () => {
  const f = fixture(), child = f.children[0];
  child.kill = signal => child.signals.push(signal);
  const stopped = f.supervisor.stop();
  assert.equal(f.supervisor.stop(), stopped);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(f.fire(), 7000);
  await stopped;
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.timers.size, 0);
});
test('supervisor handles failed spawn and parent exit without duplicate children', async () => {
  const failed = fixture({ forkImpl() { throw new Error('spawn fixture'); } });
  assert.equal(failed.timers.size, 1);
  await failed.supervisor.stop(); assert.equal(failed.timers.size, 0);
  const f = fixture();
  f.parent.emit('exit');
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  await f.supervisor.stop();
});
