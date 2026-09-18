// Asisto | Version: 5.00.155 | Fecha: 2026-09-18
// Ejecutar solamente en el servidor productivo, tras verificar host y base.
if (!process.argv.includes('--apply-production')) {
  console.error('Falta --apply-production. Verificá el host y la base productiva antes de aplicar.');
  process.exit(2);
}
if (!process.env.MONGODB_URI) {
  console.error('Falta MONGODB_URI del entorno productivo. No se carga .env local.');
  process.exit(2);
}
const crypto = require('crypto');
const { getDb, closeDb } = require('../db');

const tenantId = 'RES';
// Precios y recetas de demostración: el restaurante debe revisarlos antes de usar la carta con clientes.
const dishes = [
  ['Entradas','Papas bravas',6800,'Papas fritas, salsa de tomate picante y alioli (contiene huevo y ajo). Vegetariano. Puede haber contaminación cruzada en freidora.'],
  ['Entradas','Empanadas de carne (2)',6200,'Masa de trigo, carne vacuna, cebolla, huevo duro y aceitunas. Contiene gluten y huevo.'],
  ['Entradas','Provoleta',8900,'Queso provolone, orégano, tomate y aceite de oliva. Contiene lácteos. Vegetariano.'],
  ['Ensaladas','Ensalada de quinoa',9900,'Quinoa, hojas verdes, tomate cherry, palta, pepino y vinagreta de limón. Vegano. Consultar contaminación cruzada.'],
  ['Ensaladas','Ensalada César',11500,'Lechuga, pollo grillado, croutones de trigo, queso parmesano y aderezo César con huevo y anchoas. Contiene gluten, lácteos, huevo y pescado.'],
  ['Principales','Milanesa napolitana con papas',16900,'Milanesa de carne vacuna rebozada con pan rallado, salsa de tomate, jamón, mozzarella y papas fritas. Contiene gluten, huevo y lácteos.'],
  ['Principales','Hamburguesa completa',15900,'Medallón de carne vacuna, pan de trigo, queso cheddar, lechuga, tomate, cebolla y mayonesa; se sirve con papas. Contiene gluten, lácteos y huevo.'],
  ['Principales','Risotto de hongos',17800,'Arroz arborio, hongos, caldo vegetal, cebolla, vino blanco, manteca y queso parmesano. Contiene lácteos. Vegetariano.'],
  ['Principales','Pasta con salsa fileto',13900,'Pasta de trigo con salsa de tomate, ajo, cebolla, albahaca y aceite de oliva. Contiene gluten. Vegano si se pide sin queso.'],
  ['Principales','Pollo grillado con vegetales',16500,'Pechuga de pollo a la plancha, zanahoria, zucchini, morrón y aceite de oliva. Sin ingredientes con gluten en la receta; confirmar contaminación cruzada.'],
  ['Pizzas','Pizza muzzarella',14500,'Masa de trigo, salsa de tomate, mozzarella y aceitunas. Contiene gluten y lácteos. Vegetariana.'],
  ['Pizzas','Pizza rúcula y parmesano',16900,'Masa de trigo, salsa de tomate, mozzarella, rúcula, queso parmesano y aceite de oliva. Contiene gluten y lácteos. Vegetariana.'],
  ['Postres','Flan casero',6900,'Leche, huevos, azúcar y caramelo. Contiene lácteos y huevo.'],
  ['Postres','Brownie con helado',8900,'Brownie de harina de trigo, chocolate, manteca, huevo y nueces; helado de crema. Contiene gluten, lácteos, huevo y frutos secos.'],
  ['Postres','Fruta de estación',5900,'Selección de fruta fresca de estación. Vegano. Variedad sujeta a disponibilidad.'],
  ['Bebidas','Agua mineral 500 ml',3500,'Agua mineral sin gas.'],
  ['Bebidas','Gaseosa 500 ml',3900,'Gaseosa individual; sabores sujetos a disponibilidad.'],
  ['Bebidas','Limonada casera',5400,'Limón exprimido, agua, azúcar y menta. Se puede pedir sin azúcar.'],
  ['Bebidas','Café espresso',3500,'Café espresso solo. Puede agregarse leche a pedido; consultar precio.'],
];

(async () => {
  const db = await getDb(), now = new Date();
  await db.collection('tenant_config').updateOne({ _id: tenantId }, { $set: { nom_emp: 'Restaurante RES · Demo', restaurant_enabled: true, restaurant_ai_model: 'gpt-4o-mini', updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
  await db.collection('products').createIndex({ tenantId: 1, restaurantMenu: 1, tag: 1 });
  await db.collection('restaurant_tables').createIndex({ tenantId: 1, label: 1 }, { unique: true });
  await db.collection('restaurant_tables').createIndex({ tenantId: 1, token: 1 }, { unique: true });
  await db.collection('restaurant_events').createIndex({ tenantId: 1, status: 1, createdAt: 1 });
  for (const [tag, descripcion, importe, observacion] of dishes) {
    await db.collection('products').updateOne({ tenantId, restaurantMenu: true, descripcion }, { $set: { tag, importe, observacion, active: true, updatedAt: now }, $setOnInsert: { tenantId, restaurantMenu: true, createdAt: now } }, { upsert: true });
  }
  for (let n = 1; n <= 10; n++) {
    await db.collection('restaurant_tables').updateOne({ tenantId, label: String(n) }, { $set: { active: true, updatedAt: now }, $setOnInsert: { tenantId, label: String(n), token: crypto.randomBytes(16).toString('hex'), createdAt: now } }, { upsert: true });
  }
  console.log(JSON.stringify({ tenantId, dishes: dishes.length, tables: 10, note: 'Carta y precios de demostración; revisar antes de publicar.' }));
})().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => closeDb());
