// Asisto | Version: 5.00.148 | Fecha: 2026-09-16
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require.resolve('../extensions/whatsapp-support/panel.html'), 'utf8').replace('<script src="panel.js"></script>', '');
const source = fs.readFileSync(require.resolve('../extensions/whatsapp-support/panel.js'), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 35));

test('switching chats clears the old task even when the new contact has no resolved jid', async () => {
  const dom = new JSDOM(html, { url: 'chrome-extension://test/panel.html', runScripts: 'outside-only' });
  const w = dom.window;
  let listener, selected = { jid: '111@lid', name: 'Tra Fiordano', refreshAt: 1 };
  const calls = [];
  w.chrome = {
    tabs: { query: async () => [{ id: 7 }] },
    storage: { session: { get: async () => ({ 'selection-7': selected }) }, onChanged: { addListener: fn => { listener = fn; } } },
    runtime: { sendMessage: async message => {
      calls.push(message);
      if (message.action === 'SESSION') return { data: { tenantId: 'ALSO', userId: 'also', username: 'Alejandro', choices: {} } };
      if (message.action === 'INDEX') return { data: { owner: 'ALSO:also', chats: [{ jid: '111@lid', name: 'Tra Fiordano', count: 1 }], knownChats: [] } };
      if (message.action === 'DRAFTS') return { data: [{ id: 'old', subject: 'Tarea anterior', status: 'pending' }] };
      if (message.action === 'DETAIL') return { data: { id: 'old', fields: { subject: 'Tarea anterior' }, source: {}, state: 'pending' } };
      throw Error(message.action);
    } },
  };
  try {
    w.eval(source); await pause();
    assert.equal(w.document.querySelector('#field-subject').value, 'Tarea anterior');
    selected = { jid: '', name: 'CONFORMA SRL Romina', refreshAt: 2 };
    listener({ 'selection-7': { newValue: selected } }, 'session');
    await pause();
    assert.equal(w.document.querySelector('#contacts').value, '');
    assert.equal(w.document.querySelector('#tasks').children.length, 0);
    assert.equal(w.document.querySelector('#editor').hidden, true);
    assert.match(w.document.querySelector('#notice').textContent, /CONFORMA SRL Romina/);
    assert.equal(calls.filter(call => call.action === 'DRAFTS').length, 1);
  } finally { dom.window.close(); }
});
