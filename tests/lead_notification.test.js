// Asisto | Version: 5.00.141 | Fecha: 2026-09-16
const test = require('node:test');
const assert = require('node:assert/strict');
const { leadAlertConfig, leadAlertText, queueLeadWhatsAppAlert } = require('../lead_notification');

test('el aviso requiere sesión y destino configurados', () => {
  assert.equal(leadAlertConfig({}), null);
  assert.deepEqual(leadAlertConfig({
    LEAD_NOTIFY_WWEB_TENANT: 'asisto',
    LEAD_NOTIFY_WWEB_FROM: '+54 9 3462 123456',
    LEAD_NOTIFY_WWEB_TO: '+54 9 3462 654321'
  }), { tenantId: 'ASISTO', numero: '5493462123456', to: '5493462654321' });
});

test('el texto resume el lead y limita el contenido', () => {
  const text = leadAlertText({ _id: 'abc', name: 'Ana', email: 'a@b.com', message: 'x'.repeat(2000) });
  assert.match(text, /Nuevo contacto desde la web de Asisto/);
  assert.match(text, /Lead: abc/);
  assert.ok(text.length < 1600);
});

test('encola una única acción sólo cuando existe la sesión emisora', async () => {
  const writes = [];
  const db = { collection(name) {
    if (name === 'wa_locks') return { findOne: async query => query._id === 'ASISTO:5493462123456' ? { _id: query._id } : null };
    if (name === 'wa_wweb_actions') return { insertOne: async doc => { writes.push(doc); } };
    throw new Error('unexpected collection');
  } };
  const lead = { _id: 'abc', name: 'Ana', email: 'a@b.com', message: 'Necesito automatizar procesos' };
  const config = { tenantId: 'ASISTO', numero: '5493462123456', to: '5493462654321' };
  assert.deepEqual(await queueLeadWhatsAppAlert(db, lead, config), { status: 'queued' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].action, 'send_message');
  assert.equal(writes[0].lockId, 'ASISTO:5493462123456');
  assert.equal(writes[0].to, '5493462654321');
});
