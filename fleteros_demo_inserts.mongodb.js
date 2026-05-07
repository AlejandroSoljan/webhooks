// fleteros_demo_inserts.mongodb.js
// Inserts/upserts de ejemplo para probar el panel de viajes de fleteros.
// Uso en mongosh:
//   const TENANT_ID = 'mi_tenant';
//   load('fleteros_demo_inserts.mongodb.js')

const TENANT = (typeof TENANT_ID !== 'undefined' && TENANT_ID) ? String(TENANT_ID) : 'default';
const at = new Date();

function upsertMany(collectionName, docs) {
  if (!docs.length) return;
  db.getCollection(collectionName).bulkWrite(docs.map((doc) => {
    const createdAt = doc.createdAt || at;
    const id = doc._id;
    const setDoc = Object.assign({}, doc, { updatedAt: at });
    delete setDoc._id;
    delete setDoc.createdAt;
    return {
      updateOne: {
        filter: { _id: id },
        update: { $set: setDoc, $setOnInsert: { _id: id, createdAt } },
        upsert: true
      }
    };
  }), { ordered: false });
}

upsertMany('fleteros_clientes', [
  {
    _id: 'cli_demo_acopio_sur',
    tenantId: TENANT,
    nombre: 'Acopio Sur SRL',
    cuit: '30-71234567-8',
    telefono: '+54 3462 555001',
    localidad: 'Venado Tuerto',
    activo: true,
    demo: true,
    createdAt: at,
  },
  {
    _id: 'cli_demo_agro_la_posta',
    tenantId: TENANT,
    nombre: 'Agro La Posta',
    cuit: '30-70999888-1',
    telefono: '+54 3462 555002',
    localidad: 'Murphy',
    activo: true,
    demo: true,
    createdAt: at,
  },
  {
    _id: 'cli_demo_transporte_centro',
    tenantId: TENANT,
    nombre: 'Transporte Centro SA',
    cuit: '30-71888777-4',
    telefono: '+54 3462 555003',
    localidad: 'Firmat',
    activo: true,
    demo: true,
    createdAt: at,
  }
]);

upsertMany('fleteros_lugares', [
  {
    _id: 'lug_demo_planta_vt',
    tenantId: TENANT,
    nombre: 'Planta Venado Tuerto',
    tipo: 'origen_destino',
    direccion: 'Ruta 8 km 365',
    localidad: 'Venado Tuerto',
    provincia: 'Santa Fe',
    activo: true,
    demo: true,
    createdAt: at,
  },
  {
    _id: 'lug_demo_puerto_rosario',
    tenantId: TENANT,
    nombre: 'Puerto Rosario',
    tipo: 'origen_destino',
    direccion: 'Av. Belgrano 900',
    localidad: 'Rosario',
    provincia: 'Santa Fe',
    activo: true,
    demo: true,
    createdAt: at,
  },
  {
    _id: 'lug_demo_campo_san_eduardo',
    tenantId: TENANT,
    nombre: 'Campo San Eduardo',
    tipo: 'origen_destino',
    direccion: 'Zona rural s/n',
    localidad: 'San Eduardo',
    provincia: 'Santa Fe',
    activo: true,
    demo: true,
    createdAt: at,
  },
  {
    _id: 'lug_demo_deposito_firmat',
    tenantId: TENANT,
    nombre: 'Depósito Firmat',
    tipo: 'origen_destino',
    direccion: 'Bv. Colón 1500',
    localidad: 'Firmat',
    provincia: 'Santa Fe',
    activo: true,
    demo: true,
    createdAt: at,
  }
]);

upsertMany('fleteros_tipos_carga', [
  {
    _id: 'tc_demo_soja_granel',
    tenantId: TENANT,
    nombre: 'Soja a granel',
    descripcion: 'Carga cerealera a granel',
    unidad: 'tn',
    activo: true,
    demo: true,
    createdAt: at,
  },
  {
    _id: 'tc_demo_maiz_granel',
    tenantId: TENANT,
    nombre: 'Maíz a granel',
    descripcion: 'Carga cerealera a granel',
    unidad: 'tn',
    activo: true,
    demo: true,
    createdAt: at,
  },
  {
    _id: 'tc_demo_pallets',
    tenantId: TENANT,
    nombre: 'Pallets mercadería seca',
    descripcion: 'Carga general palletizada',
    unidad: 'pallet',
    activo: true,
    demo: true,
    createdAt: at,
  }
]);

upsertMany('fleteros_chasis', [
  {
    _id: 'cha_demo_ab123cd',
    tenantId: TENANT,
    patenteChasis: 'AB123CD',
    patenteTractor: 'AA987BB',
    fletero: { id: 'fle_demo_juan_perez', nombre: 'Juan Pérez', telefono: '+54 3462 555111' },
    chofer: { id: 'cho_demo_mario_gomez', nombre: 'Mario Gómez', documento: '27888999', telefono: '+54 3462 555211' },
    marca: 'Helvética',
    modelo: 'Sider 14.50',
    activo: true,
    demo: true,
    createdAt: at,
  },
  {
    _id: 'cha_demo_af456gh',
    tenantId: TENANT,
    patenteChasis: 'AF456GH',
    patenteTractor: 'AC321DD',
    fletero: { id: 'fle_demo_roberto_sosa', nombre: 'Roberto Sosa', telefono: '+54 3462 555112' },
    chofer: { id: 'cho_demo_lucas_ruiz', nombre: 'Lucas Ruiz', documento: '30111222', telefono: '+54 3462 555212' },
    marca: 'Guerra',
    modelo: 'Cerealero',
    activo: true,
    demo: true,
    createdAt: at,
  },
  {
    _id: 'cha_demo_ae789ij',
    tenantId: TENANT,
    patenteChasis: 'AE789IJ',
    patenteTractor: 'AD654EE',
    fletero: { id: 'fle_demo_carlos_diaz', nombre: 'Carlos Díaz', telefono: '+54 3462 555113' },
    chofer: { id: 'cho_demo_nicolas_arias', nombre: 'Nicolás Arias', documento: '32555777', telefono: '+54 3462 555213' },
    marca: 'Random',
    modelo: 'Playo',
    activo: true,
    demo: true,
    createdAt: at,
  }
]);

// Índices recomendados.
db.getCollection('fleteros_clientes').createIndex({ tenantId: 1, activo: 1, nombre: 1 });
db.getCollection('fleteros_lugares').createIndex({ tenantId: 1, activo: 1, nombre: 1, localidad: 1 });
db.getCollection('fleteros_tipos_carga').createIndex({ tenantId: 1, activo: 1, nombre: 1 });
db.getCollection('fleteros_chasis').createIndex({ tenantId: 1, activo: 1, patenteChasis: 1 });
db.getCollection('fleteros_viajes').createIndex({ tenantId: 1, createdAt: -1 });
db.getCollection('fleteros_viajes').createIndex({ tenantId: 1, chasisId: 1, createdAt: -1 });

print('Datos demo de fleteros cargados para tenant=' + TENANT);
