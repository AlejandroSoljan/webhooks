// Asisto | Version: 5.00.232 | Fecha: 2026-09-24
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
