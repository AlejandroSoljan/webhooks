const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizedSectors } = require('../customer_app_web');

test('MCN reemplaza la configuración antigua por cuatro colas sin Autoservicio', () => {
  const sectors = normalizedSectors({ sectors: [
    { id: 'ferreteria', name: 'Ferretería', prefix: 'F' },
    { id: 'caja', name: 'Caja', prefix: 'C' },
    { id: 'retiro', name: 'Retiro de pedidos', prefix: 'R' }
  ] }, 'MCN');
  assert.deepEqual(sectors.map(item => item.id), ['ferreteria', 'herrajes', 'buloneria', 'servicio_tecnico']);
});

test('MCN filtra defaults y sectores guardados sin mutarlos, demo y otros tenants no cambian',()=>{
  const expected=['ferreteria','herrajes','buloneria','servicio_tecnico'];
  assert.deepEqual(normalizedSectors(null,'MCN').map(x=>x.id),expected);
  const saved={sectors:[...normalizedSectors(null,'DEMO_FERRETERIA')]};
  const before=JSON.stringify(saved);
  assert.deepEqual(normalizedSectors(saved,'mcn').map(x=>x.id),expected);
  assert.equal(JSON.stringify(saved),before);
  assert.equal(normalizedSectors(saved,'DEMO_FERRETERIA').at(-1).id,'autoservicio');
  assert.equal(normalizedSectors(saved,'OTHER'),saved.sectors);
  assert.deepEqual(normalizedSectors({sectors:saved.sectors.filter(x=>x.id!=='autoservicio')},'MCN').map(x=>x.id),expected);
});
