const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const mobile = require('../queue_mobile');

test('customer web ticket notices hide the unpublished app and expose browser alerts', () => {
  const source = [
    "let ticketAudioContext=null;let ticketAlertsEnabled=false;",
    mobile.linkReservedTicket,
    mobile.setupTicketNotices,
    mobile.enableTicketAlerts,
    mobile.ticketAlert,
    mobile.armDefaultTicketAlerts,
  ].map(String).join('\n');
  assert.doesNotThrow(() => new vm.Script(source));
  assert.doesNotMatch(source, /Abrir mi turno en Asisto|Instalar o actualizar Asisto/);
  assert.match(source, /Activar sonido y vibración/);
  assert.match(source, /peopleAhead === 0/);
  assert.match(source, /navigator\.vibrate/);
  assert.match(source, /addEventListener\('pointerdown', unlock/);
  assert.ok(source.indexOf('oscillator.start(start)') < source.indexOf("toast(title + ' ' + detail"));
});
