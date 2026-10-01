// Asisto | Version: 5.00.272 | Fecha: 2026-09-30
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require.resolve('../extensions/whatsapp-support/panel.html'), 'utf8').replace('<script src="panel.js"></script>', '');
const source = fs.readFileSync(require.resolve('../extensions/whatsapp-support/panel.js'), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 35));

test('the current task status takes precedence over the previously saved HubSpot stage', async () => {
  const dom = new JSDOM(html, { url: 'chrome-extension://test/panel.html', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = {
    tabs: { query: async () => [{ id: 7 }] },
    storage: { session: { get: async () => ({}) }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async message => {
      if (message.action === 'SESSION') return { data: { tenantId: 'ALSO', userId: 'also', choices: {} } };
      if (message.action === 'INDEX') return { data: { owner: 'ALSO:also', chats: [], knownChats: [] } };
      throw Error(message.action);
    } },
  };
  try {
    w.eval(source); await pause();
    const selected = w.eval(`preferredStage([
      { id: 'new', label: 'Nuevo' },
      { id: 'done', label: 'Cerrado RESUELTO' }
    ], 'Nuevo', 'done')`);
    assert.equal(selected, 'new');
  } finally { dom.window.close(); }
});

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

test('refreshing the same contact preserves unsaved ticket fields and the selected task', async () => {
  const dom = new JSDOM(html, { url: 'chrome-extension://test/panel.html', runScripts: 'outside-only' });
  const w = dom.window;
  let listener, selected = { jid: '111@lid', name: 'Cliente', refreshAt: 1 };
  let detailCalls = 0;
  w.chrome = {
    tabs: { query: async () => [{ id: 7 }] },
    storage: { session: { get: async () => ({ 'selection-7': selected }) }, onChanged: { addListener: fn => { listener = fn; } } },
    runtime: { sendMessage: async message => {
      if (message.action === 'SESSION') return { data: { tenantId: 'ALSO', userId: 'also', username: 'Alejandro', choices: {} } };
      if (message.action === 'INDEX') return { data: { owner: 'ALSO:also', chats: [{ jid: '111@lid', name: 'Cliente', count: 2 }], knownChats: [] } };
      if (message.action === 'DRAFTS') return { data: [{ id: 'first', subject: 'Primera', status: 'pending' }, { id: 'second', subject: 'Segunda', status: 'pending' }] };
      if (message.action === 'DETAIL') { detailCalls += 1; return { data: { id: message.id, revision: detailCalls + 1, fields: { subject: message.id === 'first' ? 'Primera del servidor' : 'Segunda del servidor' }, source: {}, state: 'pending' } }; }
      throw Error(message.action);
    } },
  };
  try {
    w.eval(source); await pause();
    const second = [...w.document.querySelectorAll('#tasks button')].find(button => button.dataset.id === 'second');
    second.click(); await pause();
    const subject = w.document.querySelector('#field-subject');
    subject.value = 'Cambio todavía no guardado';
    subject.dispatchEvent(new w.Event('input', { bubbles: true }));
    selected = { jid: '111@lid', name: 'Cliente', refreshAt: 2 };
    listener({ 'selection-7': { newValue: selected } }, 'session');
    assert.equal(w.document.querySelector('#editor').hidden, false, 'refresh keeps the current editor visible while loading');
    assert.equal(w.document.querySelector('#field-subject').value, 'Cambio todavía no guardado');
    await pause();
    assert.equal(w.document.querySelector('#field-subject').value, 'Cambio todavía no guardado');
    assert.equal(w.document.querySelector('#tasks button.selected').dataset.id, 'second');
    assert.equal(detailCalls, 2, 'a soft refresh does not reload the dirty editor from the server');
    assert.match(w.document.querySelector('#notice').textContent, /no reemplazó tu edición/);
  } finally { dom.window.close(); }
});
test('a revision conflict reloads only the revision and retries the users fields', async () => {
  const dom = new JSDOM(html, { url: 'chrome-extension://test/panel.html', runScripts: 'outside-only' });
  const w = dom.window; const saves = [];
  w.chrome = {
    tabs: { query: async () => [{ id: 7 }] },
    storage: { session: { get: async () => ({ 'selection-7': { jid: '111@lid', name: 'Cliente', refreshAt: 1 } }), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async message => {
      if (message.action === 'SESSION') return { data: { tenantId: 'ALSO', userId: 'also', username: 'Alejandro', choices: {} } };
      if (message.action === 'INDEX') return { data: { owner: 'ALSO:also', chats: [{ jid: '111@lid', name: 'Cliente', count: 1 }], knownChats: [] } };
      if (message.action === 'DRAFTS') return { data: [{ id: 'first', subject: 'Original', status: 'pending' }] };
      if (message.action === 'DETAIL') return { data: { id: 'first', revision: saves.length ? 2 : 1, fields: { subject: 'Original del servidor' }, source: {}, state: 'pending', sourceChanged: saves.length > 0 } };
      if (message.action === 'SAVE') { saves.push(message); return { error: 'revision_conflict' }; }
      if (message.action === 'RECONCILE') { saves.push(message); return { data: { revision: 3, fields: message.fields } }; }
      throw Error(message.action);
    } },
  };
  try {
    w.eval(source); await pause();
    const subject = w.document.querySelector('#field-subject');
    subject.value = 'Mi cambio'; subject.dispatchEvent(new w.Event('input', { bubbles: true }));
    await w.eval('save()');
    assert.equal(saves.length, 2);
    assert.equal(saves[0].fields.subject, 'Mi cambio');
    assert.equal(saves[1].action, 'RECONCILE');
    assert.equal(saves[1].revision, 2);
    assert.equal(saves[1].fields.subject, 'Mi cambio');
    assert.equal(subject.value, 'Mi cambio');
    assert.match(w.document.querySelector('#saveState').textContent, /Guardado/);
  } finally { dom.window.close(); }
});

test('editing while a slow save is in flight never loses the newer value', async () => {
  const dom = new JSDOM(html, { url: 'chrome-extension://test/panel.html', runScripts: 'outside-only' });
  const w = dom.window; let releaseSave;
  const heldSave = new Promise(resolve => { releaseSave = resolve; });
  w.chrome = {
    tabs: { query: async () => [{ id: 7 }] },
    storage: { session: { get: async () => ({ 'selection-7': { jid: '111@lid', name: 'Cliente', refreshAt: 1 } }) }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async message => {
      if (message.action === 'SESSION') return { data: { tenantId: 'ALSO', userId: 'also', username: 'Alejandro', choices: {} } };
      if (message.action === 'INDEX') return { data: { owner: 'ALSO:also', chats: [{ jid: '111@lid', name: 'Cliente', count: 1 }], knownChats: [] } };
      if (message.action === 'DRAFTS') return { data: [{ id: 'first', subject: 'Primera', status: 'pending' }] };
      if (message.action === 'DETAIL') return { data: { id: 'first', revision: 1, fields: { subject: 'Primera' }, source: {}, state: 'pending' } };
      if (message.action === 'SAVE') { await heldSave; return { data: { revision: 2, fields: message.fields } }; }
      throw Error(message.action);
    } },
  };
  try {
    w.eval(source); await pause();
    const subject = w.document.querySelector('#field-subject');
    subject.value = 'Primer cambio'; subject.dispatchEvent(new w.Event('input', { bubbles: true }));
    const savePromise = w.eval('save()');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(w.document.querySelector('#saveState').textContent, /Guardando/);
    subject.value = 'Cambio hecho mientras guardaba'; subject.dispatchEvent(new w.Event('input', { bubbles: true }));
    releaseSave(); await savePromise;
    assert.equal(subject.value, 'Cambio hecho mientras guardaba');
    assert.match(w.document.querySelector('#saveState').textContent, /sin guardar/i);
  } finally { dom.window.close(); }
});

test('the editor exposes one primary HubSpot action and no local-only save action', () => {
  const dom = new JSDOM(html);
  try {
    const primary = dom.window.document.querySelector('#save');
    assert.equal(primary.type, 'submit');
    assert.match(primary.textContent, /HubSpot/);
    assert.equal(dom.window.document.querySelector('#setup'), null);
    assert.doesNotMatch(dom.window.document.body.textContent, /Guardar cambios/);
  } finally { dom.window.close(); }
});

test('the primary action saves the edited short name and then publishes it to HubSpot', async () => {
  const dom = new JSDOM(html, { url: 'chrome-extension://test/panel.html', runScripts: 'outside-only' });
  const w = dom.window; const calls = [];
  const mapping = { ownerId: '12', pipelineId: 'support', stageId: 'new', fields: {
    category: { property: 'category', value: 'remote' }, errorType: { property: 'error_type', value: 'update' }, channel: { property: 'channel', value: 'whatsapp' },
  } };
  const enumeration = (name, label, value, optionLabel) => ({ name, label, type: 'enumeration', modificationMetadata: {}, options: [{ value, label: optionLabel }] });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.chrome = {
    tabs: { query: async () => [{ id: 7 }] },
    storage: {
      session: { get: async () => ({ 'selection-7': { jid: '111@lid', name: 'Cliente', refreshAt: 1 } }), set: async () => {}, remove: async () => {} },
      local: { get: async () => ({ 'mapping:ALSO:also:7009289': mapping }), set: async () => {} },
      onChanged: { addListener() {} },
    },
    runtime: { sendMessage: async message => {
      calls.push(message);
      if (message.action === 'SESSION') return { data: { tenantId: 'ALSO', userId: 'also', username: 'Alejandro', choices: {} } };
      if (message.action === 'INDEX') return { data: { owner: 'ALSO:also', chats: [{ jid: '111@lid', name: 'Cliente', count: 1 }], knownChats: [] } };
      if (message.action === 'DRAFTS') return { data: [{ id: 'first', subject: 'Original', status: 'pending' }] };
      if (message.action === 'DETAIL') return { data: { id: 'first', revision: 1, fields: { subject: 'Original', company: 'Empresa', companyId: '44', category: 'Soporte Remoto', errorType: 'Actualización', channel: 'WhatsApp' }, source: {}, state: 'pending', hubspot: {} } };
      if (message.action === 'SAVE') return { data: { revision: 2, fields: message.fields } };
      if (message.action === 'HUBSPOT') return { data: { configured: true, portalId: '7009289', preferredOwnerId: '12', metadata: { owners: [{ id: '12', firstName: 'Alejandro' }], pipelines: [{ id: 'support', label: 'Pipeline de asistencia', stages: [{ id: 'new', label: 'Nuevo' }] }], properties: [enumeration('category', 'Categoría', 'remote', 'Soporte Remoto'), enumeration('error_type', 'Error tipo', 'update', 'Actualización'), enumeration('channel', 'Vía de contacto', 'whatsapp', 'WhatsApp')] } } };
      if (message.action === 'PUBLISH') return { data: { revision: 3, ticketId: '99', portalId: '7009289' } };
      throw Error(message.action);
    } },
  };
  try {
    w.eval(source); await pause();
    const subject = w.document.querySelector('#field-subject');
    subject.value = 'Nombre breve corregido'; subject.dispatchEvent(new w.Event('input', { bubbles: true }));
    w.document.querySelector('#editor').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await pause();
    const saveCall = calls.find(call => call.action === 'SAVE');
    const publishCall = calls.find(call => call.action === 'PUBLISH');
    assert.equal(saveCall.fields.subject, 'Nombre breve corregido');
    assert.equal(publishCall.revision, 2);
    assert.match(w.document.querySelector('#saveState').textContent, /Guardado en HubSpot/);
  } finally { dom.window.close(); }
});
