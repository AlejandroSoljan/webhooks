// Asisto | Version: 5.00.061 | Fecha: 2026-09-08
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { storage } = require('../desktop/support/storage.cjs');
const { EventEmitter } = require('node:events');
const { run } = require('../desktop/support/agent.cjs');

test('pending pairing and subsequent retries never open the browser', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-agent-test-'));
  const childProcess = require('node:child_process'), originalSpawn = childProcess.spawn;
  const agentPath = require.resolve('../desktop/support/agent.cjs');
  const data = new Map(); let launches = 0, starts = 0;
  const listeners = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
  try {
    childProcess.spawn = () => { launches++; return { unref() {} }; };
    delete require.cache[agentPath];
    const { run: pendingRun } = require(agentPath);
    for (let retry = 0; retry < 2; retry++) {
      await pendingRun({ profile, store: { read: key => data.get(key), write: (key, value) => data.set(key, value) }, loadBaileys: async () => ({}),
        fetchImpl: async url => {
          if (url.endsWith('/start')) { starts++; return { ok: true, json: async () => ({ token: 'fixture', expiresAt: new Date(Date.now() + 600000), verificationUrl: 'https://asistobot.com.ar/admin/wweb?device=ABCDEF123456' }) }; }
          return { ok: false, status: 401 };
        },
      });
    }
    assert.equal(starts, 2); assert.equal(launches, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'status.json'))).verificationUrl, 'https://asistobot.com.ar/admin/wweb?device=ABCDEF123456');
  } finally {
    childProcess.spawn = originalSpawn; delete require.cache[agentPath];
    for (const [signal, old] of listeners) for (const listener of process.listeners(signal)) if (!old.has(listener)) process.removeListener(signal, listener);
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('asisto-agent-test-'));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
test('desktop credentials survive restart protected by the Windows user account', { skip: process.platform !== 'win32' }, () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-storage-test-'));
  try {
    const first = storage(profile);
    first.write('account', { token: 'private-fixture-token' });
    first.write('auth:creds', 'private-fixture-creds');
    assert.deepEqual(storage(profile).read('account'), { token: 'private-fixture-token' });
    assert.equal(storage(profile).read('auth:creds'), 'private-fixture-creds');
    for (const file of fs.readdirSync(profile)) assert.equal(fs.readFileSync(path.join(profile, file)).includes(Buffer.from('private-fixture')), false);
    first.write('account', null); assert.equal(first.read('account'), null);
  } finally {
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('asisto-storage-test-'));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
test('a previously approved desktop automatically starts Baileys, sends QR/messages and stops on revocation', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-agent-test-'));
  const data = new Map([['account', { approved: true, token: 'fixture-device-token' }]]), calls = [];
  let heartbeats = 0, connections = 0, ends = 0;
  const previousExitCode = process.exitCode;
  const listeners = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
  try {
    await run({ profile, store: { read: key => data.get(key), write: (key, value) => data.set(key, value) }, sleep: () => new Promise(resolve => setTimeout(resolve, 20)),
      loadBaileys: async () => ({ initAuthCreds: () => ({}), BufferJSON: {}, normalizeMessageContent: value => value,
        default() {
          connections++; const ev = new EventEmitter();
          setImmediate(() => {
            ev.emit('connection.update', { qr: 'fixture-qr' });
            ev.emit('messages.upsert', { messages: Array.from({ length: 60 }, (_, i) => ({ key: { id: 'fixture-message-' + i, remoteJid: '123@s.whatsapp.net' }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'Manager no imprime' } })) });
          });
          return { ev, end() { ends++; } };
        },
      }),
      fetchImpl: async (url, options) => {
        const route = url.split('/').at(-1), body = JSON.parse(options.body); calls.push({ route, body });
        const revoked = route === 'heartbeat' && ++heartbeats >= 12;
        return { ok: !revoked, status: revoked ? 401 : 200, json: async () => route === 'heartbeat' ? { desired: 'connected' } : { ok: true } };
      },
    });
    assert.equal(connections, 1); assert.equal(ends, 1);
    assert.ok(calls.some(call => call.route === 'session' && call.body.qr === 'fixture-qr'));
    assert.equal(calls.find(call => call.route === 'messages').body.messages[0].text, 'Manager no imprime');
    const uploads = calls.filter(call => call.route === 'messages');
    assert.equal(uploads.reduce((n, call) => n + call.body.messages.length, 0), 60);
    assert.ok(uploads.some(call => call.body.messages.length === 25));
    assert.ok(uploads.every(call => call.body.messages.length <= 25 && Buffer.byteLength(JSON.stringify(call.body)) <= 110000));
    assert.deepEqual(data.get('outbox-index'), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'status.json'))).state, 'access_revoked');
  } finally {
    process.exitCode = previousExitCode;
    for (const [signal, old] of listeners) for (const listener of process.listeners(signal)) if (!old.has(listener)) process.removeListener(signal, listener);
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('asisto-agent-test-'));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
