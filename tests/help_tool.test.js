const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCover,
  matrixToHelpRows,
  hasUsableVimeoId,
  importanceOrderFromBehavior,
  sortVideos
} = require('../help_tool');

test('normalizeCover corrige una coma usada como separador de extension', () => {
  assert.equal(
    normalizeCover('mng5_inst_cont_plan_cuentas_Alta_Cuenta,jpg'),
    'mng5_inst_cont_plan_cuentas_Alta_Cuenta.jpg'
  );
});

test('normalizeCover conserva nombres y URLs que ya son validos', () => {
  assert.equal(normalizeCover('caratula.png'), 'caratula.png');
  assert.equal(
    normalizeCover('https://cdn.example.com/a,b/caratula.webp?version=2'),
    'https://cdn.example.com/a,b/caratula.webp?version=2'
  );
});

test('matrixToHelpRows devuelve la caratula normalizada', () => {
  const rows = matrixToHelpRows([
    ['Titulo', 'Caratula', 'ID Vimeo', 'Ventana que aplica', 'Version Desde', 'Version Hasta', 'Importancia', 'Tags', 'Descripcion'],
    ['Alta de cuenta contable', 'alta_cuenta,jpg', '1166096940', 'w_cont_cuentas', '500', '599', '1', '', 'Tutorial']
  ]);

  assert.equal(rows[0].cover, 'alta_cuenta.jpg');
});

test('el comportamiento puede ordenar importancia de mayor a menor', () => {
  const behavior = 'Ordená los IDs por el campo Importancia de MAYOR a MENOR (primero el 3, último el 1).';
  const rows = [
    { title: 'Uno', importance: 1 },
    { title: 'Tres', importance: 3 },
    { title: 'Dos', importance: 2 },
    { title: 'Sin prioridad', importance: 0 }
  ];

  assert.equal(importanceOrderFromBehavior(behavior), 'desc');
  assert.deepEqual(sortVideos(rows, behavior).map(row => row.importance), [3, 2, 1, 0]);
});

test('sin regla de orden conserva compatibilidad: menor a mayor', () => {
  const rows = [
    { title: 'Tres', importance: 3 },
    { title: 'Uno', importance: 1 },
    { title: 'Dos', importance: 2 }
  ];

  assert.equal(importanceOrderFromBehavior('Reglas de selección de videos'), 'asc');
  assert.deepEqual(sortVideos(rows, '').map(row => row.importance), [1, 2, 3]);
});

test('la regla de Vimeo descarta IDs vacios y cero', () => {
  assert.equal(hasUsableVimeoId(''), false);
  assert.equal(hasUsableVimeoId('0'), false);
  assert.equal(hasUsableVimeoId('1166096940'), true);
});
