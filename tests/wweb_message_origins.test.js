// Asisto | Version: 5.00.236 | Fecha: 2026-09-25
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../auth_ui'), 'utf8');

test('estadísticas separan salidas de Asisto, manuales y sin identificar', () => {
  for (const field of ['outgoingAsisto', 'outgoingManual', 'outgoingUnknown']) {
    assert.match(source, new RegExp(field));
  }
  assert.match(source, /Enviados por Asisto/);
  assert.match(source, /Enviados manualmente/);
  assert.match(source, /Sin identificar/);
  assert.match(source, /wa_api_message_windows/);
  assert.match(source, /wweb_phone_operator/);
});

test('detalle por contacto conserva columnas de origen independientes', () => {
  assert.match(source, /<th>Salida Asisto<\/th>/);
  assert.match(source, /<th>Salida manual<\/th>/);
  assert.match(source, /<th>Sin identificar<\/th>/);
});

test('la tabla visible lista sólo contactos con envíos confirmados por API sin alterar el total estadístico', () => {
  assert.match(source, /statsContactsRows = contacts\.filter\(function\(contact\)/);
  assert.match(source, /Number\(contact && contact\.outgoingAsisto \|\| 0\) > 0/);
  assert.match(source, /con envíos por API/);
  assert.match(source, /contacts: Array\.isArray\(summary\.contactsSet\) \? summary\.contactsSet\.filter\(Boolean\)\.length : 0/);
  assert.match(source, /contacts: \(contactRows \|\| \[\]\)\.map/);
});
