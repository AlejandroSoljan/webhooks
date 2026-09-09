// Asisto | Version: 5.00.074 | Fecha: 2026-09-09
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startLocal } = require('../desktop/support/local.cjs');
const fs = require('node:fs'), vm = require('node:vm');

test('local discovery is loopback-only and exposes device authorization only to the fixed Asisto extension', async () => {
  let account = { code: 'ABCDEF123456', token: 'private-device-secret', expiresAt: new Date(Date.now() + 600000) };
  const server = await startLocal({ port: 0, readAccount: () => account });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: 'https://asistobot.com.ar', 'X-Asisto-Local': '1' };
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal((await fetch(base + '/pairing')).status, 403);
    assert.equal((await fetch(base + '/pairing', { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
    const reboundStatus = await new Promise((resolve, reject) => {
      require('node:http').get(base + '/pairing', { headers: { ...headers, Host: 'rebound.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(reboundStatus, 403);
    const preflight = await fetch(base + '/pairing', { method: 'OPTIONS', headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-asisto-local', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    const response = await fetch(base + '/pairing', { headers });
    assert.equal(response.headers.get('access-control-allow-origin'), headers.Origin);
    assert.deepEqual(await response.json(), { state: 'pending', code: account.code });
    account.expiresAt = new Date(0);
    assert.deepEqual(await (await fetch(base + '/pairing', { headers })).json(), { state: 'starting' });
    account = { ...account, token: 'A'.repeat(43), approved: true, userId: 'u1', tenantId: 't1' };
    assert.deepEqual(await (await fetch(base + '/pairing', { headers })).json(), { state: 'approved', userId: 'u1', tenantId: 't1' });
    assert.equal((await fetch(base + '/extension-session', { headers: { ...headers, Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })).status, 403);
    const extensionHeaders = { ...headers, Origin: 'chrome-extension://mhdkipfdcoobcghfoklghmpfgkcbbaop' };
    assert.deepEqual(await (await fetch(base + '/extension-session', { headers: extensionHeaders })).json(), { token: 'A'.repeat(43) });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('web connect detects this PC, approves under the logged-in account and blocks another account', async () => {
  const source = fs.readFileSync(require.resolve('../static/support.js'), 'utf8');
  for (const state of ['pending', 'approved', 'other', 'denied']) {
    const elements = new Map(), calls = [];
    const element = id => {
      if (!elements.has(id)) elements.set(id, { textContent: '', value: '', replaceChildren() {}, append() {}, removeAttribute() {}, classList: { add() {} } });
      return elements.get(id);
    };
    const context = { URLSearchParams, AbortSignal, setTimeout, clearTimeout, setInterval() {}, structuredClone,
      location: { search: '?view=connection' }, window: { addEventListener() {} },
      document: { getElementById: element, querySelector: () => element('header'), body: element('body'), createElement: () => element('temporary') },
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        let result = {};
        if (url.startsWith('http://127.0.0.1:')) {
          if (state === 'denied') throw new Error('permission denied');
          result = state === 'pending' ? { state, code: 'ABCDEF123456' } : { state: 'approved', userId: state === 'other' ? 'u2' : 'u1', tenantId: 't1' };
        } else if (url.endsWith('/status')) result = { ready: false, checks: [] };
        else if (url.endsWith('/capabilities')) result = { userId: 'u1', tenantId: 't1' };
        else if (url.endsWith('/session')) result = { state: 'queued' };
        return { ok: true, json: async () => result };
      },
    };
    vm.runInNewContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.some(c => c.url.startsWith('http://127.0.0.1:')), false, 'local access only on user click');
    await element('connect').onclick({ preventDefault() {} });
    const mutations = calls.filter(c => c.options.method === 'POST');
    if (state === 'pending') {
      assert.equal(mutations[0].url, '/api/support/device/approve');
      assert.deepEqual(JSON.parse(mutations[0].options.body), { code: 'ABCDEF123456' });
    }
    if (['other', 'denied'].includes(state)) assert.equal(mutations.length, 0);
    else assert.ok(mutations.some(c => c.url === '/api/support/session'));
    assert.equal(element('connect').disabled, false);
  }
});
