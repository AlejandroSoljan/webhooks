// Asisto | Version: 5.00.182 | Fecha: 2026-09-21
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { renderTokenControlPage } = require('../token_control_stats');

const tick = () => new Promise(resolve => setTimeout(resolve, 25));

test('control de consumos carga totales primero y detalles sólo al pedirlos', async () => {
  const dom = new JSDOM(renderTokenControlPage({ role: 'superadmin', tenantId: 'CARICO' }), { url: 'https://asistobot.com.ar/admin/token-control', runScripts: 'outside-only' });
  try {
    const calls = [];
    dom.window.fetch = async url => {
      calls.push(String(url));
      const body = String(url).includes('/summary')
        ? { ok: true, items: [], totals: {} }
        : String(url).includes('/conversations')
          ? { ok: true, items: [], totals: {} }
          : { ok: true, enabled: true, items: [], realItems: [], byTenant: [], totals: {} };
      return { ok: true, json: async () => body };
    };
    const script = [...dom.window.document.scripts].pop().textContent;
    dom.window.eval(script);
    await tick();
    assert.equal(calls.length, 3);
    assert.ok(calls.some(url => url.includes('/summary')));
    assert.ok(calls.some(url => url.includes('/api/monetization/summary')));
    assert.ok(calls.some(url => url.includes('/api-message-windows') && url.includes('details=0')));
    assert.ok(!calls.some(url => url.includes('/conversations')));
    assert.equal(dom.window.document.getElementById('conversationDetailCard').hidden, true);
    assert.equal(dom.window.document.getElementById('apiMessagesCard').hidden, true);

    dom.window.document.getElementById('btnLoadConversations').click();
    await tick();
    assert.equal(calls.filter(url => url.includes('/conversations')).length, 1);
    assert.equal(dom.window.document.getElementById('conversationDetailCard').hidden, false);

    dom.window.document.getElementById('btnLoadMessages').click();
    await tick();
    assert.equal(calls.filter(url => url.includes('/api-message-windows')).length, 2);
    assert.ok(calls.some(url => url.includes('/api-message-windows') && !url.includes('details=0')));
    assert.equal(dom.window.document.getElementById('apiMessagesCard').hidden, false);
  } finally { dom.window.close(); }
});
