// Asisto | Version: 5.00.269 | Fecha: 2026-09-29
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(require.resolve('../extensions/whatsapp-support/content.js'), 'utf8');
const matcher = fs.readFileSync(require.resolve('../extensions/whatsapp-support/matcher.js'), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
async function mount(serverMessages = []) {
  const dom = new JSDOM(`<div id="main"><header><span dir="auto">Tecnoaplicaciones Magali</span></header><div data-id="unrelated"></div><section id="messages">
    <div role="row" data-id="false_123@lid_AUDIO000001"><div class="message-in"><span data-icon="audio-play"></span></div></div>
    <div role="row" data-id="true_123@lid_AUDIO000002"><div class="message-out"><span data-icon="audio-play"></span></div></div>
    <div role="row" data-id="false_123@lid_TEXT0000001"><div class="message-in"><div data-pre-plain-text="[15:33, 14/9/2026] Magali: "><span class="selectable-text">Ahora sí</span></div></div></div>
    </section><div id="composer"><footer><input></footer></div></div>`, { url: 'https://web.whatsapp.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const calls = [], w = dom.window;
  w.chrome = { runtime: { id: 'test', sendMessage: async message => {
    calls.push(message);
    if (message.action === 'INDEX') return { data: { owner: 'ALSO:also', chats: [], knownChats: [] } };
    if (message.action === 'ACTIVE_CONTEXT') return { data: { jid: '999@lid', name: 'Otro contacto' } };
    if (message.action === 'MESSAGES') return { data: { tasks: [], messages: serverMessages } };
    return { ok: true };
  } }, storage: { onChanged: { addListener() {} } } };
  w.alert = text => { throw new Error(text); };
  w.eval(matcher); w.eval(source); await pause();
  return { dom, w, calls };
}

test('slow assignment blocks duplicate sends and preserves newly selected messages', async () => {
  const { dom, w, calls } = await mount();
  try {
    const original = w.chrome.runtime.sendMessage;
    let finish;
    w.chrome.runtime.sendMessage = message => message.action === 'ASSIGN_MESSAGES'
      ? (calls.push(message), new Promise(resolve => { finish = resolve; })) : original(message);
    const checks = w.document.querySelectorAll('.asisto-message-control input');
    checks[0].click();
    w.document.querySelector('.asisto-message-toolbar .primary').click();
    checks[1].click();
    const submit = w.document.querySelector('.asisto-message-toolbar .primary');
    assert.equal(submit.disabled, true);
    submit.click();
    assert.equal(calls.filter(call => call.action === 'ASSIGN_MESSAGES').length, 1);
    finish({ data: { draftId: 'created' } }); await pause();
    assert.equal(checks[1].checked, true);
    assert.equal(checks[0].checked, false);
    assert.match(w.document.querySelector('.asisto-message-toolbar strong').textContent, /1 seleccionados/);
    assert.equal(w.document.querySelector('.asisto-message-toolbar .primary').disabled, false);
  } finally { dom.window.close(); }
});
test('nested composer shows selection actions and every message type has one aligned control', async () => {
  const { dom, w, calls } = await mount();
  try {
    assert.equal(w.document.querySelectorAll('.asisto-message-control').length, 3);
    assert.equal(w.document.querySelectorAll('.asisto-message-control input:disabled').length, 0);
    assert.equal(w.document.querySelector('.asisto-message-toolbar'), null);
    const check = w.document.querySelectorAll('.asisto-message-control input')[2]; check.click(); await pause();
    const bar = w.document.querySelector('.asisto-message-toolbar'); assert.ok(bar);
    assert.equal(bar.parentElement.id, 'composer');
    assert.equal(bar.nextElementSibling.tagName, 'FOOTER');
    assert.ok(calls.some(call => call.action === 'SET_CONTEXT' && call.jid === '123@lid'));
    bar.querySelector('.primary').click(); await pause();
    const request = calls.find(call => call.action === 'ASSIGN_MESSAGES');
    assert.equal(request.jid, '123@lid'); assert.equal(request.selectedMessages[0].text, 'Ahora sí');
    assert.ok(calls.findIndex(call => call.action === 'OPEN') < calls.findIndex(call => call.action === 'ASSIGN_MESSAGES'));
    assert.equal(w.document.querySelector('.asisto-message-toolbar'), null);
  } finally { dom.window.close(); }
});
test('changing the visible chat clears the previous selection and publishes its new identity', async () => {
  const { dom, w, calls } = await mount();
  try {
    w.document.querySelector('.asisto-message-control input').click();
    w.document.querySelector('header span').textContent = 'Nuevo contacto';
    w.document.querySelector('#messages').innerHTML = '<div data-id="false_456@lid_OTHER000001" class="message-in">Nuevo mensaje</div>';
    await pause();
    assert.equal(w.document.querySelector('.asisto-message-toolbar'), null);
    assert.equal(calls.filter(call => call.action === 'SET_CONTEXT').at(-1).jid, '456@lid');
    assert.equal(calls.some(call => call.action === 'ACTIVE_CONTEXT'), false);
  } finally { dom.window.close(); }
});

test('contact help tooltip never replaces the visible chat name', async () => {
  const { dom, w, calls } = await mount();
  try {
    const header = w.document.querySelector('header');
    header.innerHTML = '<span title="haz clic aquí para ver la información de contacto"></span><span dir="auto" title="haz clic aquí para ver la información de contacto">Cliente nuevo</span>';
    await pause();
    assert.equal(calls.filter(call => call.action === 'SET_CONTEXT').at(-1).name, 'Cliente nuevo');
  } finally { dom.window.close(); }
});
test('a new header appearing before its messages does not retain the former contact', async () => {
  const { dom, w, calls } = await mount();
  try {
    w.document.querySelector('header span').textContent = 'CONFORMA SRL Romina';
    await pause();
    assert.equal(calls.filter(call => call.action === 'SET_CONTEXT').at(-1).jid, '');
    assert.equal(calls.filter(call => call.action === 'SET_CONTEXT').at(-1).name, 'CONFORMA SRL Romina');
    w.document.querySelector('#messages').innerHTML = '<div data-id="false_456@lid_OTHER000001" class="message-in">Nueva conversación</div>';
    await pause();
    assert.equal(calls.filter(call => call.action === 'SET_CONTEXT').at(-1).jid, '456@lid');
  } finally { dom.window.close(); }
});
test('a visible message without a WhatsApp DOM id is selectable and sends readable evidence', async () => {
  const { dom, w, calls } = await mount();
  try {
    const row = w.document.querySelector('[data-id="false_123@lid_TEXT0000001"]');
    row.removeAttribute('data-id');
    await pause();
    const controls = [...w.document.querySelectorAll('.asisto-message-control input')];
    assert.equal(controls.length, 3);
    assert.equal(controls[2].disabled, false);
    controls[2].click();
    w.document.querySelector('.asisto-message-toolbar .primary').click(); await pause();
    const request = calls.find(call => call.action === 'ASSIGN_MESSAGES');
    assert.match(request.messageIds[0], /^asisto-local-/);
    assert.equal(request.selectedMessages[0].text, 'Ahora sí');
    assert.equal(request.selectedMessages[0].at, new Date('2026-09-14T15:33:00').toISOString());
  } finally { dom.window.close(); }
});
test('selection and its evidence survive scrolling, remounting and refreshes', async () => {
  const { dom, w, calls } = await mount();
  try {
    const section = w.document.querySelector('#messages');
    const row = section.lastElementChild;
    row.removeAttribute('data-id'); await pause();
    let check = [...w.document.querySelectorAll('.asisto-message-control input')].at(-1);
    check.click(); const id = section.lastElementChild.dataset.asistoMessageId;
    const sameCheck = [...w.document.querySelectorAll('.asisto-message-control input')].at(-1);
    w.document.dispatchEvent(new w.Event('scroll', { bubbles: true })); await pause();
    assert.equal([...w.document.querySelectorAll('.asisto-message-control input')].at(-1), sameCheck);
    assert.equal(sameCheck.checked, true);
    section.lastElementChild.remove(); await pause();
    assert.match(w.document.querySelector('.asisto-message-toolbar strong').textContent, /1 seleccionados/);
    section.append(row); await pause();
    check = [...w.document.querySelectorAll('.asisto-message-control input')].at(-1);
    assert.equal(section.lastElementChild.dataset.asistoMessageId, id);
    assert.equal(check.checked, true);
    section.lastElementChild.remove(); await pause();
    w.document.querySelector('.asisto-message-toolbar .primary').click(); await pause();
    const request = calls.find(call => call.action === 'ASSIGN_MESSAGES');
    assert.deepEqual([...request.messageIds], [id]);
    assert.equal(request.selectedMessages[0].text, 'Ahora sí');
  } finally { dom.window.close(); }
});
test('selecting media without text or an exposed date includes honest evidence without waiting for Baileys', async () => {
  const { dom, w, calls } = await mount();
  try {
    const row = w.document.querySelector('[data-id="false_123@lid_AUDIO000001"]');
    row.removeAttribute('data-id'); await pause();
    w.document.querySelector('.asisto-message-control input').click();
    w.document.querySelector('.asisto-message-toolbar .primary').click(); await pause();
    const request = calls.find(call => call.action === 'ASSIGN_MESSAGES');
    assert.match(request.selectedMessages[0].text, /Fecha original no visible/);
    assert.match(request.selectedMessages[0].text, /Audio seleccionado sin texto visible/);
    assert.ok(Number.isFinite(Date.parse(request.selectedMessages[0].at)));
  } finally { dom.window.close(); }
});
test('an audio stays selected when its transcription appears after the click', async () => {
  const { dom, w, calls } = await mount();
  try {
    const section = w.document.querySelector('#messages'), row = section.firstElementChild;
    row.removeAttribute('data-id'); row.querySelector('.message-in').append(w.document.createTextNode(' 0:34 15:29'));
    await pause();
    w.document.querySelector(`.asisto-message-control[data-asisto-message-id="${row.dataset.asistoMessageId}"] input`).click();
    const id = row.dataset.asistoMessageId;
    const transcript = w.document.createElement('span'); transcript.className = 'selectable-text'; transcript.textContent = 'Falta agregar el período contable';
    row.querySelector('.message-in').append(transcript); await pause();
    assert.equal(row.dataset.asistoMessageId, id);
    assert.equal(w.document.querySelector(`.asisto-message-control[data-asisto-message-id="${id}"] input`).checked, true);
    row.remove(); await pause(); section.insertBefore(row, section.firstElementChild); await pause();
    assert.equal(row.dataset.asistoMessageId, id);
    assert.equal(w.document.querySelector(`.asisto-message-control[data-asisto-message-id="${id}"] input`).checked, true);
    w.document.querySelector('.asisto-message-toolbar .primary').click(); await pause();
    assert.match(calls.find(call => call.action === 'ASSIGN_MESSAGES').selectedMessages[0].text, /período contable/);
  } finally { dom.window.close(); }
});
test('an audio without a DOM id uses the Baileys id by duration and direction', async () => {
  const { dom, w, calls } = await mount([{ waId: 'SERVER_AUDIO_ID', at: '2026-09-14T18:29:00.000Z', fromMe: false, audio: true, seconds: 34, assignments: [] }]);
  try {
    const row = w.document.querySelector('[data-id="false_123@lid_AUDIO000001"]');
    row.removeAttribute('data-id'); row.querySelector('.message-in').append(w.document.createTextNode(' 0:34 15:29'));
    await pause();
    assert.equal(row.dataset.asistoMessageId, 'SERVER_AUDIO_ID');
    w.document.querySelector('.asisto-message-control[data-asisto-message-id="SERVER_AUDIO_ID"] input').click();
    w.document.querySelector('.asisto-message-toolbar .primary').click(); await pause();
    assert.deepEqual([...calls.find(call => call.action === 'ASSIGN_MESSAGES').messageIds], ['SERVER_AUDIO_ID']);
  } finally { dom.window.close(); }
});
test('an assigned message is visually distinct and can still be selected and deselected', async () => {
  const assigned = [{ waId: 'TEXT0000001', at: '2026-09-14T15:33:00.000Z', fromMe: false, audio: false, assignments: [{ draftId: 'draft-1', shortId: '1', subject: 'Revisar factura', status: 'pending' }] }];
  const { dom, w } = await mount(assigned);
  try {
    const check = w.document.querySelector('.asisto-message-control[data-asisto-message-id="TEXT0000001"] input');
    assert.equal(check.checked, false);
    assert.equal(check.indeterminate, true);
    check.click(); await pause();
    assert.equal(check.checked, true);
    assert.equal(check.indeterminate, false);
    assert.match(w.document.querySelector('.asisto-message-toolbar strong').textContent, /1 seleccionados/);
    check.click(); await pause();
    assert.equal(check.checked, false);
    assert.equal(check.indeterminate, true);
    assert.equal(w.document.querySelector('.asisto-message-toolbar'), null);
  } finally { dom.window.close(); }
});

test('successful assignment requests one explicit panel refresh for the saved draft', async () => {
  const { dom, w, calls } = await mount();
  try {
    w.document.querySelectorAll('.asisto-message-control input')[2].click();
    w.document.querySelector('.asisto-message-toolbar .primary').click(); await pause();
    const refresh = calls.find(call => call.action === 'SET_CONTEXT' && call.refresh === true);
    assert.ok(refresh);
    assert.equal(refresh.jid, '123@lid');
  } finally { dom.window.close(); }
});
