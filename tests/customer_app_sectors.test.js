const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizedSectors } = require('../customer_app_web');

test('MCN reemplaza la configuración antigua por cuatro colas y Autoservicio presencial', () => {
  const sectors = normalizedSectors({ sectors: [
    { id: 'ferreteria', name: 'Ferretería', prefix: 'F' },
    { id: 'caja', name: 'Caja', prefix: 'C' },
    { id: 'retiro', name: 'Retiro de pedidos', prefix: 'R' }
  ] }, 'MCN');
  assert.deepEqual(sectors.map(item => item.id), ['ferreteria', 'herrajes', 'buloneria', 'servicio_tecnico', 'autoservicio']);
  assert.equal(sectors.at(-1).kind, 'presence');
});
