const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCover,
  matrixToHelpRows,
  hasUsableVimeoId,
  hasUsefulHelpDescription,
  behaviorRequiresUsefulDescription,
  importanceOrderFromBehavior,
  videoOrderModeFromBehavior,
  orderRowsByVimeoIds,
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

const productionBehavior = `
3. Tené en cuenta SOLO los videos que tengan ID de Vimeo Y descripción completa. Ignorá los videos cuyo ID de Vimeo esté vacío o sea 0, y los que tengan el campo "Descripcion" vacío o sin texto útil.
5. Ordená los IDs según tu criterio, del video más útil al menos útil para alguien que está trabajando en esa ventana. Usá como guía el título, la descripción, los tags y qué tan específico es el video para esa ventana: primero el tutorial principal de la ventana, después los casos puntuales o variantes, y al final los videos generales que aplican a muchas ventanas. No uses el campo "Importancia" para decidir el orden.
`;

test('punto 3 exige una descripcion con texto util', () => {
  assert.equal(behaviorRequiresUsefulDescription(productionBehavior), true);
  assert.equal(hasUsefulHelpDescription(''), false);
  assert.equal(hasUsefulHelpDescription('Pendiente'), false);
  assert.equal(hasUsefulHelpDescription('Tutorial completo para dar de alta un producto.'), true);
});

test('punto 5 conserva el ranking de utilidad de la IA e ignora Importancia', () => {
  const rows = [
    { vimeoId: 'general', title: 'General', importance: 1 },
    { vimeoId: 'principal', title: 'Principal', importance: 3 },
    { vimeoId: 'variante', title: 'Variante', importance: 2 }
  ];
  assert.equal(videoOrderModeFromBehavior(productionBehavior), 'ai');
  assert.deepEqual(
    orderRowsByVimeoIds(rows, ['principal', 'variante', 'general'], productionBehavior).map(row => row.vimeoId),
    ['principal', 'variante', 'general']
  );
  assert.deepEqual(sortVideos(rows, productionBehavior), rows);
});
