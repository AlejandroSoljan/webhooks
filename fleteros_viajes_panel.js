// fleteros_viajes_panel.js
// Panel móvil para carga de viajes de fleteros.
// Script nuevo y aislado: no modifica endpoint.js, auth_ui.js, logic.js ni db.js.
//
// Uso en endpoint.js:
//   const { mountFleterosViajesPanel } = require('./fleteros_viajes_panel');
//   mountFleterosViajesPanel(app, { auth });
//
// URL panel:
//   /admin/fleteros/viajes
//
// Seed demo por navegador / fetch:
//   POST /api/fleteros/seed-demo
//
// Seed demo por consola:
//   node fleteros_viajes_panel.js seed mi_tenant

const { ObjectId } = require('mongodb');
const { getDb, closeDb } = require('./db');

const DEFAULT_TENANT_ID = String(process.env.TENANT_ID || 'default').trim() || 'default';

const COLLECTIONS = {
  clientes: 'fleteros_clientes',
  lugares: 'fleteros_lugares',
  tiposCarga: 'fleteros_tipos_carga',
  chasis: 'fleteros_chasis',
  viajes: 'fleteros_viajes',
};

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function resolveTenantId(req, auth) {
  if (auth && typeof auth.resolveTenantId === 'function') {
    return auth.resolveTenantId(req, {
      defaultTenantId: DEFAULT_TENANT_ID,
      envTenantId: process.env.TENANT_ID,
    });
  }

  const role = String(req?.user?.role || '').toLowerCase();
  const userTenant = String(req?.user?.tenantId || '').trim();
  if (role !== 'superadmin' && userTenant) return userTenant;
  return String(req?.query?.tenant || req?.headers?.['x-tenant-id'] || userTenant || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
}

function requireAuthMiddleware(auth) {
  if (auth && typeof auth.requireAuth === 'function') return auth.requireAuth;
  return (req, res, next) => {
    if (req.user?.uid) return next();
    return res.redirect('/login?to=' + encodeURIComponent(req.originalUrl || '/admin/fleteros/viajes'));
  };
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s._-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function regexFromQuery(q) {
  const clean = normalizeSearchText(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!clean) return null;
  return new RegExp(clean.split(/\s+/).filter(Boolean).join('.*'), 'i');
}

function publicDoc(doc, extra = {}) {
  if (!doc) return null;
  return {
    id: String(doc._id || doc.id || ''),
    _id: String(doc._id || doc.id || ''),
    ...extra,
  };
}

function cleanString(value, max = 220) {
  return String(value ?? '').trim().slice(0, max);
}

function now() {
  return new Date();
}

function buildDemoDocs(tenantId = DEFAULT_TENANT_ID) {
  const tenant = String(tenantId || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
  const at = now();

  const clientes = [
    {
      _id: 'cli_demo_acopio_sur',
      tenantId: tenant,
      nombre: 'Acopio Sur SRL',
      cuit: '30-71234567-8',
      telefono: '+54 3462 555001',
      localidad: 'Venado Tuerto',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      _id: 'cli_demo_agro_la_posta',
      tenantId: tenant,
      nombre: 'Agro La Posta',
      cuit: '30-70999888-1',
      telefono: '+54 3462 555002',
      localidad: 'Murphy',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      _id: 'cli_demo_transporte_centro',
      tenantId: tenant,
      nombre: 'Transporte Centro SA',
      cuit: '30-71888777-4',
      telefono: '+54 3462 555003',
      localidad: 'Firmat',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
  ];

  const lugares = [
    {
      _id: 'lug_demo_planta_vt',
      tenantId: tenant,
      nombre: 'Planta Venado Tuerto',
      tipo: 'origen_destino',
      direccion: 'Ruta 8 km 365',
      localidad: 'Venado Tuerto',
      provincia: 'Santa Fe',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      _id: 'lug_demo_puerto_rosario',
      tenantId: tenant,
      nombre: 'Puerto Rosario',
      tipo: 'origen_destino',
      direccion: 'Av. Belgrano 900',
      localidad: 'Rosario',
      provincia: 'Santa Fe',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      _id: 'lug_demo_campo_san_eduardo',
      tenantId: tenant,
      nombre: 'Campo San Eduardo',
      tipo: 'origen_destino',
      direccion: 'Zona rural s/n',
      localidad: 'San Eduardo',
      provincia: 'Santa Fe',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      _id: 'lug_demo_deposito_firmat',
      tenantId: tenant,
      nombre: 'Depósito Firmat',
      tipo: 'origen_destino',
      direccion: 'Bv. Colón 1500',
      localidad: 'Firmat',
      provincia: 'Santa Fe',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
  ];

  const tiposCarga = [
    {
      _id: 'tc_demo_soja_granel',
      tenantId: tenant,
      nombre: 'Soja a granel',
      descripcion: 'Carga cerealera a granel',
      unidad: 'tn',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      _id: 'tc_demo_maiz_granel',
      tenantId: tenant,
      nombre: 'Maíz a granel',
      descripcion: 'Carga cerealera a granel',
      unidad: 'tn',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      _id: 'tc_demo_pallets',
      tenantId: tenant,
      nombre: 'Pallets mercadería seca',
      descripcion: 'Carga general palletizada',
      unidad: 'pallet',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
  ];

  const chasis = [
    {
      _id: 'cha_demo_ab123cd',
      tenantId: tenant,
      patenteChasis: 'AB123CD',
      patenteTractor: 'AA987BB',
      fletero: {
        id: 'fle_demo_juan_perez',
        nombre: 'Juan Pérez',
        telefono: '+54 3462 555111',
      },
      chofer: {
        id: 'cho_demo_mario_gomez',
        nombre: 'Mario Gómez',
        documento: '27888999',
        telefono: '+54 3462 555211',
      },
      marca: 'Helvética',
      modelo: 'Sider 14.50',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      _id: 'cha_demo_af456gh',
      tenantId: tenant,
      patenteChasis: 'AF456GH',
      patenteTractor: 'AC321DD',
      fletero: {
        id: 'fle_demo_roberto_sosa',
        nombre: 'Roberto Sosa',
        telefono: '+54 3462 555112',
      },
      chofer: {
        id: 'cho_demo_lucas_ruiz',
        nombre: 'Lucas Ruiz',
        documento: '30111222',
        telefono: '+54 3462 555212',
      },
      marca: 'Guerra',
      modelo: 'Cerealero',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      _id: 'cha_demo_ae789ij',
      tenantId: tenant,
      patenteChasis: 'AE789IJ',
      patenteTractor: 'AD654EE',
      fletero: {
        id: 'fle_demo_carlos_diaz',
        nombre: 'Carlos Díaz',
        telefono: '+54 3462 555113',
      },
      chofer: {
        id: 'cho_demo_nicolas_arias',
        nombre: 'Nicolás Arias',
        documento: '32555777',
        telefono: '+54 3462 555213',
      },
      marca: 'Random',
      modelo: 'Playo',
      activo: true,
      demo: true,
      createdAt: at,
      updatedAt: at,
    },
  ];

  return { clientes, lugares, tiposCarga, chasis };
}

async function upsertManyById(collection, docs) {
  if (!Array.isArray(docs) || !docs.length) return { matched: 0, modified: 0, upserted: 0 };
  const ops = docs.map((doc) => {
    const { _id, createdAt, ...rest } = doc;
    return {
      updateOne: {
        filter: { _id },
        update: {
          $set: { ...rest, updatedAt: now() },
          $setOnInsert: { _id, createdAt: createdAt || now() },
        },
        upsert: true,
      },
    };
  });
  const r = await collection.bulkWrite(ops, { ordered: false });
  return {
    matched: r.matchedCount || 0,
    modified: r.modifiedCount || 0,
    upserted: r.upsertedCount || 0,
  };
}

async function ensureFleterosIndexes(db) {
  await Promise.all([
    db.collection(COLLECTIONS.clientes).createIndex({ tenantId: 1, activo: 1, nombre: 1 }),
    db.collection(COLLECTIONS.lugares).createIndex({ tenantId: 1, activo: 1, nombre: 1, localidad: 1 }),
    db.collection(COLLECTIONS.tiposCarga).createIndex({ tenantId: 1, activo: 1, nombre: 1 }),
    db.collection(COLLECTIONS.chasis).createIndex({ tenantId: 1, activo: 1, patenteChasis: 1 }),
    db.collection(COLLECTIONS.viajes).createIndex({ tenantId: 1, createdAt: -1 }),
    db.collection(COLLECTIONS.viajes).createIndex({ tenantId: 1, fechaViaje: -1, createdAt: -1 }),
    db.collection(COLLECTIONS.viajes).createIndex({ tenantId: 1, chasisId: 1, createdAt: -1 }),
  ]);
}

async function getFleterosBaseDataStatus(db, tenantId) {
  const tenant = String(tenantId || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
  const active = { tenantId: tenant, activo: { $ne: false } };
  const [clientes, lugares, tiposCarga, chasis, viajes] = await Promise.all([
    db.collection(COLLECTIONS.clientes).countDocuments(active),
    db.collection(COLLECTIONS.lugares).countDocuments(active),
    db.collection(COLLECTIONS.tiposCarga).countDocuments(active),
    db.collection(COLLECTIONS.chasis).countDocuments(active),
    db.collection(COLLECTIONS.viajes).countDocuments({ tenantId: tenant }),
  ]);
  const counts = { clientes, lugares, tiposCarga, chasis, viajes };
  const total = clientes + lugares + tiposCarga + chasis + viajes;
  return {
    tenantId: tenant,
    counts,
    total,
    hasData: total > 0,
    showSeedDemo: total === 0,
  };
}

async function seedFleterosDemoData(tenantId = DEFAULT_TENANT_ID) {
  const tenant = String(tenantId || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
  const db = await getDb();
  await ensureFleterosIndexes(db);
  const demo = buildDemoDocs(tenant);
  const result = {
    tenantId: tenant,
    clientes: await upsertManyById(db.collection(COLLECTIONS.clientes), demo.clientes),
    lugares: await upsertManyById(db.collection(COLLECTIONS.lugares), demo.lugares),
    tiposCarga: await upsertManyById(db.collection(COLLECTIONS.tiposCarga), demo.tiposCarga),
    chasis: await upsertManyById(db.collection(COLLECTIONS.chasis), demo.chasis),
  };
  return { ok: true, ...result };
}

function mapCliente(doc) {
  return publicDoc(doc, {
    label: String(doc.nombre || ''),
    sublabel: [doc.cuit, doc.localidad, doc.telefono].filter(Boolean).join(' · '),
    nombre: doc.nombre || '',
    cuit: doc.cuit || '',
    telefono: doc.telefono || '',
    localidad: doc.localidad || '',
  });
}

function mapLugar(doc) {
  return publicDoc(doc, {
    label: String(doc.nombre || ''),
    sublabel: [doc.direccion, doc.localidad, doc.provincia].filter(Boolean).join(' · '),
    nombre: doc.nombre || '',
    direccion: doc.direccion || '',
    localidad: doc.localidad || '',
    provincia: doc.provincia || '',
    tipo: doc.tipo || 'origen_destino',
  });
}

function mapTipoCarga(doc) {
  return publicDoc(doc, {
    label: String(doc.nombre || ''),
    sublabel: [doc.descripcion, doc.unidad].filter(Boolean).join(' · '),
    nombre: doc.nombre || '',
    descripcion: doc.descripcion || '',
    unidad: doc.unidad || '',
  });
}

function mapChasis(doc) {
  return publicDoc(doc, {
    label: String(doc.patenteChasis || ''),
    sublabel: [doc.patenteTractor ? ('Tractor ' + doc.patenteTractor) : '', doc.fletero?.nombre, doc.chofer?.nombre].filter(Boolean).join(' · '),
    patenteChasis: doc.patenteChasis || '',
    patenteTractor: doc.patenteTractor || '',
    fletero: {
      id: String(doc.fletero?.id || ''),
      nombre: String(doc.fletero?.nombre || ''),
      telefono: String(doc.fletero?.telefono || ''),
    },
    chofer: {
      id: String(doc.chofer?.id || ''),
      nombre: String(doc.chofer?.nombre || ''),
      documento: String(doc.chofer?.documento || ''),
      telefono: String(doc.chofer?.telefono || ''),
    },
    marca: doc.marca || '',
    modelo: doc.modelo || '',
  });
}

function dateToPublic(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function mapViaje(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id || ''),
    _id: String(doc._id || ''),
    tenantId: doc.tenantId || '',
    clienteId: doc.clienteId || '',
    clienteNombre: doc.clienteNombre || '',
    origenId: doc.origenId || '',
    origenNombre: doc.origenNombre || '',
    destinoId: doc.destinoId || '',
    destinoNombre: doc.destinoNombre || '',
    tipoCargaId: doc.tipoCargaId || '',
    tipoCargaNombre: doc.tipoCargaNombre || '',
    chasisId: doc.chasisId || '',
    patenteChasis: doc.patenteChasis || '',
    patenteTractor: doc.patenteTractor || '',
    fleteroId: doc.fleteroId || '',
    fleteroNombre: doc.fleteroNombre || '',
    choferId: doc.choferId || '',
    choferNombre: doc.choferNombre || '',
    fechaViaje: doc.fechaViaje || '',
    observaciones: doc.observaciones || '',
    estado: doc.estado || 'REGISTRADO',
    snapshot: doc.snapshot || null,
    createdAt: dateToPublic(doc.createdAt),
    updatedAt: dateToPublic(doc.updatedAt),
  };
}

function buildSearchFilter(type, tenantId, q) {
  const filter = { tenantId, activo: { $ne: false } };
  const rx = regexFromQuery(q);
  if (!rx) return filter;

  if (type === 'clientes') {
    filter.$or = [{ nombre: rx }, { cuit: rx }, { telefono: rx }, { localidad: rx }];
  } else if (type === 'lugares') {
    filter.$or = [{ nombre: rx }, { direccion: rx }, { localidad: rx }, { provincia: rx }];
  } else if (type === 'tipos-carga') {
    filter.$or = [{ nombre: rx }, { descripcion: rx }, { unidad: rx }];
  } else if (type === 'chasis') {
    filter.$or = [
      { patenteChasis: rx },
      { patenteTractor: rx },
      { 'fletero.nombre': rx },
      { 'chofer.nombre': rx },
      { marca: rx },
      { modelo: rx },
    ];
  }
  return filter;
}

async function findRefById(db, collectionName, tenantId, id) {
  const safeId = cleanString(id, 120);
  if (!safeId) return null;
  return db.collection(collectionName).findOne({ _id: safeId, tenantId, activo: { $ne: false } });
}

function buildViajeSearchFilter(tenantId, q) {
  const filter = { tenantId };
  const rx = regexFromQuery(q);
  if (!rx) return filter;
  filter.$or = [
    { clienteNombre: rx },
    { origenNombre: rx },
    { destinoNombre: rx },
    { tipoCargaNombre: rx },
    { patenteChasis: rx },
    { patenteTractor: rx },
    { fleteroNombre: rx },
    { choferNombre: rx },
    { estado: rx },
  ];
  return filter;
}

function buildViajeDoc({ tenantId, body, cliente, origen, destino, tipoCarga, chasis, user }) {
  const at = now();
  return {
    tenantId,
    clienteId: String(cliente._id),
    clienteNombre: String(cliente.nombre || ''),
    origenId: String(origen._id),
    origenNombre: String(origen.nombre || ''),
    destinoId: String(destino._id),
    destinoNombre: String(destino.nombre || ''),
    tipoCargaId: String(tipoCarga._id),
    tipoCargaNombre: String(tipoCarga.nombre || ''),
    chasisId: String(chasis._id),
    patenteChasis: String(chasis.patenteChasis || ''),
    patenteTractor: String(chasis.patenteTractor || ''),
    fleteroId: String(chasis.fletero?.id || ''),
    fleteroNombre: String(chasis.fletero?.nombre || ''),
    choferId: String(chasis.chofer?.id || ''),
    choferNombre: String(chasis.chofer?.nombre || ''),
    fechaViaje: cleanString(body.fechaViaje, 20) || null,
    observaciones: cleanString(body.observaciones, 1000),
    estado: 'REGISTRADO',
    source: 'panel_fleteros_mobile',
    payloadApiPendiente: {
      clienteId: String(cliente._id),
      origenId: String(origen._id),
      destinoId: String(destino._id),
      tipoCargaId: String(tipoCarga._id),
      chasisId: String(chasis._id),
      patenteChasis: String(chasis.patenteChasis || ''),
      fleteroId: String(chasis.fletero?.id || ''),
      choferId: String(chasis.chofer?.id || ''),
      fechaViaje: cleanString(body.fechaViaje, 20) || null,
      observaciones: cleanString(body.observaciones, 1000),
      tenantId,
    },
    snapshot: {
      cliente: mapCliente(cliente),
      origen: mapLugar(origen),
      destino: mapLugar(destino),
      tipoCarga: mapTipoCarga(tipoCarga),
      chasis: mapChasis(chasis),
    },
    createdBy: {
      uid: String(user?.uid || ''),
      username: String(user?.username || ''),
      role: String(user?.role || ''),
    },
    createdAt: at,
    updatedAt: at,
  };
}


function buildViajeUpdateDoc({ tenantId, body, cliente, origen, destino, tipoCarga, chasis, user }) {
  const viaje = buildViajeDoc({ tenantId, body, cliente, origen, destino, tipoCarga, chasis, user });
  delete viaje.createdAt;
  delete viaje.createdBy;
  viaje.updatedAt = now();
  viaje.updatedBy = {
    uid: String(user?.uid || ''),
    username: String(user?.username || ''),
    role: String(user?.role || ''),
  };
  return viaje;
}

function panelHtml({ tenantId, user }) {
  const safeTenant = htmlEscape(tenantId);
  const safeUser = htmlEscape(user?.username || '');
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <meta name="robots" content="noindex,nofollow"/>
  <title>Carga de viajes · Fleteros</title>
  <style>
    :root{
      --bg:#f3f7fb;
      --card:#ffffff;
      --text:#101828;
      --muted:#667085;
      --primary:#0e6b66;
      --primary2:#095550;
      --danger:#b42318;
      --ok:#027a48;
      --border:#d9e2ec;
      --shadow:0 14px 34px rgba(16,24,40,.10);
      --radius:18px;
    }
    *{box-sizing:border-box}
    html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text)}
    body{padding:0 0 env(safe-area-inset-bottom)}
    .top{
      position:sticky;top:0;z-index:20;
      background:linear-gradient(135deg,#0f2741,#0e6b66);
      color:#fff;padding:16px 14px 14px;
      box-shadow:0 10px 24px rgba(15,39,65,.18);
    }
    .top h1{font-size:20px;line-height:1.1;margin:0 0 6px;font-weight:800}
    .top p{margin:0;color:rgba(255,255,255,.78);font-size:13px}
    .tenant{display:inline-flex;margin-top:10px;padding:6px 9px;border-radius:999px;background:rgba(255,255,255,.12);font-size:12px;gap:6px;align-items:center}
    .wrap{width:min(760px,100%);margin:0 auto;padding:14px 12px 28px}
    .card{background:var(--card);border:1px solid rgba(16,24,40,.08);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px;margin:12px 0}
    .sectionTitle{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
    .sectionTitle h2{font-size:15px;margin:0;color:#0f172a}
    .step{width:26px;height:26px;border-radius:999px;background:rgba(14,107,102,.10);color:var(--primary);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex:0 0 auto}
    label{display:block;font-size:12px;color:#475467;margin:0 0 6px;font-weight:700}
    .inputWrap{position:relative}
    input,textarea{
      width:100%;border:1px solid var(--border);background:#fff;color:var(--text);
      border-radius:14px;padding:13px 12px;font-size:16px;outline:none;
    }
    input:focus,textarea:focus{border-color:rgba(14,107,102,.6);box-shadow:0 0 0 4px rgba(14,107,102,.12)}
    textarea{resize:vertical;min-height:88px}
    .results{margin-top:8px;border:1px solid rgba(148,163,184,.30);border-radius:14px;overflow:hidden;background:#fff;display:none}
    .results.show{display:block}
    .item{width:100%;border:0;background:#fff;text-align:left;padding:11px 12px;border-bottom:1px solid rgba(148,163,184,.22);cursor:pointer;display:block}
    .item:last-child{border-bottom:0}
    .item strong{display:block;font-size:14px;color:#111827}
    .item span{display:block;font-size:12px;color:var(--muted);margin-top:2px}
    .selected{display:none;margin-top:9px;padding:10px;border-radius:14px;background:#ecfdf3;border:1px solid rgba(2,122,72,.20);color:#064e3b;font-size:13px}
    .selected.show{display:block}
    .selected b{display:block;margin-bottom:2px}
    .chasisCard{display:none;margin-top:10px;border-radius:16px;background:#f8fafc;border:1px solid rgba(148,163,184,.28);padding:12px}
    .chasisCard.show{display:block}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .kv{background:#fff;border:1px solid rgba(148,163,184,.22);border-radius:12px;padding:10px}
    .kv small{display:block;color:var(--muted);font-size:11px;margin-bottom:3px}
    .kv b{font-size:14px;color:#0f172a;word-break:break-word}
    .row{display:grid;grid-template-columns:1fr;gap:12px}
    .actions{position:sticky;bottom:0;z-index:15;background:linear-gradient(180deg,rgba(243,247,251,0),var(--bg) 22%);padding:18px 0 6px;margin-top:6px}
    .btn{width:100%;border:0;border-radius:16px;padding:15px 14px;font-size:16px;font-weight:800;cursor:pointer;background:var(--primary);color:#fff;box-shadow:0 10px 24px rgba(14,107,102,.20)}
    .btn:hover{background:var(--primary2)}
    .btn:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}
    .btn2{border:1px solid rgba(148,163,184,.35);background:#fff;color:#0f172a;border-radius:14px;padding:10px 12px;font-weight:750;cursor:pointer}
    .hint{color:var(--muted);font-size:12px;line-height:1.35;margin-top:8px}
    .toast{position:fixed;left:12px;right:12px;bottom:12px;z-index:50;padding:13px 14px;border-radius:16px;box-shadow:0 18px 48px rgba(16,24,40,.22);font-weight:750;display:none}
    .toast.show{display:block}
    .toast.ok{background:#ecfdf3;color:#027a48;border:1px solid rgba(2,122,72,.22)}
    .toast.err{background:#fef3f2;color:#b42318;border:1px solid rgba(180,35,24,.22)}
    .lastTrip{font-size:13px;line-height:1.4;background:#f8fafc;border:1px solid rgba(148,163,184,.25);border-radius:14px;padding:10px;margin-top:10px;display:none}
    .lastTrip.show{display:block}
    .editBanner{display:none;font-size:13px;line-height:1.4;background:#fff7ed;border:1px solid rgba(194,65,12,.24);color:#9a3412;border-radius:14px;padding:10px;margin:12px 0}
    .editBanner.show{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .editBanner button{white-space:nowrap}
    .tripsPanel{display:none;margin-top:12px;border-top:1px solid rgba(148,163,184,.22);padding-top:12px}
    .tripsPanel.show{display:block}
    .tripResults{margin-top:10px;display:grid;gap:8px}
    .tripItem{width:100%;border:1px solid rgba(148,163,184,.28);background:#fff;text-align:left;border-radius:14px;padding:11px 12px;cursor:pointer}
    .tripItem strong{display:block;font-size:14px;color:#111827}
    .tripItem span{display:block;font-size:12px;color:var(--muted);margin-top:3px;line-height:1.35}
    .miniActions{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px}
    .seedHidden{display:none !important}
    .toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:10px}
    .toolbar a{color:#fff;text-decoration:none;font-size:12px;opacity:.9}
    @media (min-width:680px){
      .wrap{padding-top:18px}.row{grid-template-columns:1fr 1fr}.top h1{font-size:24px}.card{padding:18px}.grid2{grid-template-columns:repeat(4,1fr)}.miniActions{grid-template-columns:1fr 1fr}
    }
  </style>
</head>
<body>
  <header class="top">
    <h1>Carga de viaje</h1>
     <div class="toolbar">
      <span class="tenant">Dominio: <b id="tenantLabel">${safeTenant}</b>${safeUser ? ' · ' + safeUser : ''}</span>
      <a href="/app">Volver</a>
    </div>
  </header>

  <main class="wrap">
    <div id="editBanner" class="editBanner">
      <span id="editBannerText">Editando viaje cargado.</span>
      <button id="btnCancelEdit" class="btn2" type="button">Nuevo viaje</button>
    </div>

    <section class="card">
      <div class="sectionTitle"><h2>Viajes cargados</h2><span class="step">↺</span></div>
      <button id="btnToggleTrips" class="btn2" style="width:100%" type="button">Buscar viajes ya cargados</button>
      <div id="tripsPanel" class="tripsPanel">
        <label>Buscar por cliente, origen, destino, patente, fletero o chofer</label>
        <input id="tripSearchInput" autocomplete="off" placeholder="Ej: Acopio, Rosario, AB123CD..."/>
        <div id="tripResults" class="tripResults"></div>
      </div>
    </section>

    <section class="card">
      <div class="sectionTitle"><h2>Datos principales</h2><span class="step">1</span></div>
      <div class="row">
        <div data-autocomplete="clientes">
          <label>Cliente</label>
          <div class="inputWrap"><input id="clientesInput" autocomplete="off" placeholder="Buscar cliente..."/></div>
          <div id="clientesResults" class="results"></div>
          <div id="clientesSelected" class="selected"></div>
        </div>
        <div data-autocomplete="tipos-carga">
          <label>Tipo de carga</label>
          <div class="inputWrap"><input id="tipos-cargaInput" autocomplete="off" placeholder="Buscar tipo de carga..."/></div>
          <div id="tipos-cargaResults" class="results"></div>
          <div id="tipos-cargaSelected" class="selected"></div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="sectionTitle"><h2>Origen y destino</h2><span class="step">2</span></div>
      <div class="row">
        <div data-autocomplete="origen">
          <label>Origen</label>
          <div class="inputWrap"><input id="origenInput" autocomplete="off" placeholder="Buscar origen..."/></div>
          <div id="origenResults" class="results"></div>
          <div id="origenSelected" class="selected"></div>
        </div>
        <div data-autocomplete="destino">
          <label>Destino</label>
          <div class="inputWrap"><input id="destinoInput" autocomplete="off" placeholder="Buscar destino..."/></div>
          <div id="destinoResults" class="results"></div>
          <div id="destinoSelected" class="selected"></div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="sectionTitle"><h2>Chasis / camión</h2><span class="step">3</span></div>
      <div data-autocomplete="chasis">
        <label>Patente del chasis</label>
        <div class="inputWrap"><input id="chasisInput" autocomplete="off" placeholder="Buscar patente, fletero o chofer..."/></div>
        <div id="chasisResults" class="results"></div>
        <div id="chasisSelected" class="selected"></div>
      </div>
      <div id="chasisCard" class="chasisCard">
        <div class="grid2">
          <div class="kv"><small>Patente chasis</small><b id="vPatenteChasis">-</b></div>
          <div class="kv"><small>Patente tractor</small><b id="vPatenteTractor">-</b></div>
          <div class="kv"><small>Fletero</small><b id="vFletero">-</b></div>
          <div class="kv"><small>Chofer</small><b id="vChofer">-</b></div>
        </div>
      </div>
     
    </section>

    <section class="card">
      <div class="sectionTitle"><h2>Observaciones</h2><span class="step">4</span></div>
      <label>Fecha del viaje</label>
      <input id="fechaViaje" type="date"/>
      <div style="height:10px"></div>
      <label>Observaciones opcionales</label>
      <textarea id="observaciones" placeholder="Ej: presentarse 8:00, carga con turno, llamar antes de ingresar..."></textarea>
    </section>

    <div class="actions">
      <button id="btnSubmit" class="btn" disabled>Registrar viaje</button>
      <div class="miniActions">
        <button id="btnSeed" class="btn2 seedHidden" type="button">Cargar datos demo</button>
        <button id="btnReset" class="btn2" type="button">Limpiar formulario</button>
      </div>
      <div id="lastTrip" class="lastTrip"></div>
    </div>
  </main>

  <div id="toast" class="toast"></div>

  <script>
  (function(){
    const state = { cliente:null, origen:null, destino:null, tipoCarga:null, chasis:null, editingId:null };
    const typeToState = { 'clientes':'cliente', 'origen':'origen', 'destino':'destino', 'tipos-carga':'tipoCarga', 'chasis':'chasis' };
    const typeToApi = { 'clientes':'clientes', 'origen':'lugares', 'destino':'lugares', 'tipos-carga':'tipos-carga', 'chasis':'chasis' };
    const debounceTimers = {};

    function esc(s){ return String(s || '').replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]; }); }
    function el(id){ return document.getElementById(id); }
    function todayIso(){ const d = new Date(); const off = d.getTimezoneOffset(); const local = new Date(d.getTime() - off * 60000); return local.toISOString().slice(0,10); }
    function trim(s){ return String(s || '').trim(); }

    function toast(msg, ok){
      const t = el('toast');
      t.textContent = msg;
      t.className = 'toast show ' + (ok ? 'ok' : 'err');
      clearTimeout(window.__fleterosToastTimer);
      window.__fleterosToastTimer = setTimeout(function(){ t.className = 'toast'; }, 3600);
    }

    function hideResults(type){
      const box = el(type + 'Results');
      if (box) { box.className = 'results'; box.innerHTML = ''; }
    }

    function selectedBox(type, item){
      const box = el(type + 'Selected');
      if (!box) return;
      if (!item) { box.className = 'selected'; box.innerHTML = ''; return; }
      box.className = 'selected show';
      box.innerHTML = '<b>' + esc(item.label) + '</b><span>' + esc(item.sublabel || '') + '</span>';
    }

    function renderChasis(item){
      const card = el('chasisCard');
      if (!item) {
        card.className = 'chasisCard';
        el('vPatenteChasis').textContent = '-';
        el('vPatenteTractor').textContent = '-';
        el('vFletero').textContent = '-';
        el('vChofer').textContent = '-';
        return;
      }
      card.className = 'chasisCard show';
      el('vPatenteChasis').textContent = item.patenteChasis || '-';
      el('vPatenteTractor').textContent = item.patenteTractor || '-';
      el('vFletero').textContent = (item.fletero && item.fletero.nombre) || '-';
      el('vChofer').textContent = (item.chofer && item.chofer.nombre) || '-';
    }

    function updateEditUi(){
      const banner = el('editBanner');
      const text = el('editBannerText');
      const submit = el('btnSubmit');
      if (state.editingId) {
        banner.className = 'editBanner show';
        text.textContent = 'Editando viaje ID ' + state.editingId;
        submit.textContent = 'Guardar cambios';
      } else {
        banner.className = 'editBanner';
        text.textContent = 'Editando viaje cargado.';
        submit.textContent = 'Registrar viaje';
      }
    }

    function validate(){
      const ok = !!(state.cliente && state.origen && state.destino && state.tipoCarga && state.chasis);
      el('btnSubmit').disabled = !ok;
      return ok;
    }

    function setSelected(type, item){
      const key = typeToState[type];
      state[key] = item;
      const input = el(type + 'Input');
      const results = el(type + 'Results');
      if (input) input.value = item ? item.label : '';
      if (results) { results.className = 'results'; results.innerHTML = ''; }
      selectedBox(type, item);
      if (type === 'chasis') renderChasis(item);
      validate();
    }

    function renderResults(type, items){
      const box = el(type + 'Results');
      if (!box) return;
      if (!items || !items.length) {
        box.className = 'results show';
        box.innerHTML = '<button type="button" class="item"><strong>Sin resultados</strong><span>No hay coincidencias con lo escrito.</span></button>';
        return;
      }
      box.className = 'results show';
      box.innerHTML = items.map(function(it, idx){
        return '<button type="button" class="item" data-idx="' + idx + '"><strong>' + esc(it.label) + '</strong><span>' + esc(it.sublabel || '') + '</span></button>';
      }).join('');
      Array.from(box.querySelectorAll('[data-idx]')).forEach(function(btn){
        btn.addEventListener('click', function(){ setSelected(type, items[Number(btn.getAttribute('data-idx'))]); });
      });
    }

    async function search(type, q){
      q = trim(q);
      if (!q) { hideResults(type); return; }
      const apiType = typeToApi[type] || type;
      const url = '/api/fleteros/search?type=' + encodeURIComponent(apiType) + '&q=' + encodeURIComponent(q);
      const r = await fetch(url, { headers: { 'Accept':'application/json' } });
      if (!r.ok) throw new Error('search_failed');
      const j = await r.json();
      renderResults(type, j.items || []);
    }

    function bindAutocomplete(type){
      const input = el(type + 'Input');
      if (!input) return;
      input.addEventListener('input', function(){
        const key = typeToState[type];
        state[key] = null;
        selectedBox(type, null);
        if (type === 'chasis') renderChasis(null);
        validate();
        clearTimeout(debounceTimers[type]);
        if (!trim(input.value)) { hideResults(type); return; }
        debounceTimers[type] = setTimeout(function(){
          search(type, input.value).catch(function(){ toast('Error buscando datos', false); });
        }, 220);
      });
      input.addEventListener('focus', function(){ if (trim(input.value)) search(type, input.value).catch(function(){}); });
    }

    function tripRefFromSnapshot(trip, key, fallback){
      if (trip && trip.snapshot && trip.snapshot[key]) return trip.snapshot[key];
      return fallback;
    }

    function loadTripIntoForm(trip){
      if (!trip) return;
      const cliente = tripRefFromSnapshot(trip, 'cliente', {
        id: trip.clienteId, _id: trip.clienteId, label: trip.clienteNombre, sublabel: ''
      });
      const origen = tripRefFromSnapshot(trip, 'origen', {
        id: trip.origenId, _id: trip.origenId, label: trip.origenNombre, sublabel: ''
      });
      const destino = tripRefFromSnapshot(trip, 'destino', {
        id: trip.destinoId, _id: trip.destinoId, label: trip.destinoNombre, sublabel: ''
      });
      const tipoCarga = tripRefFromSnapshot(trip, 'tipoCarga', {
        id: trip.tipoCargaId, _id: trip.tipoCargaId, label: trip.tipoCargaNombre, sublabel: ''
      });
      const chasis = tripRefFromSnapshot(trip, 'chasis', {
        id: trip.chasisId,
        _id: trip.chasisId,
        label: trip.patenteChasis,
        sublabel: ['Tractor ' + (trip.patenteTractor || ''), trip.fleteroNombre, trip.choferNombre].filter(Boolean).join(' · '),
        patenteChasis: trip.patenteChasis,
        patenteTractor: trip.patenteTractor,
        fletero: { id: trip.fleteroId || '', nombre: trip.fleteroNombre || '' },
        chofer: { id: trip.choferId || '', nombre: trip.choferNombre || '' }
      });

      state.editingId = trip.id || trip._id || null;
      setSelected('clientes', cliente);
      setSelected('origen', origen);
      setSelected('destino', destino);
      setSelected('tipos-carga', tipoCarga);
      setSelected('chasis', chasis);
      el('fechaViaje').value = trip.fechaViaje || todayIso();
      el('observaciones').value = trip.observaciones || '';
      el('tripsPanel').className = 'tripsPanel';
      updateEditUi();
      validate();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('Viaje cargado para modificar', true);
    }

    function renderTrips(items){
      const box = el('tripResults');
      if (!items || !items.length) {
        box.innerHTML = '<div class="hint">No se encontraron viajes cargados.</div>';
        return;
      }
      box.innerHTML = items.map(function(v, idx){
        const main = (v.clienteNombre || 'Sin cliente') + ' · ' + (v.origenNombre || '-') + ' → ' + (v.destinoNombre || '-');
        const sub = [v.fechaViaje || 'Sin fecha', v.tipoCargaNombre || '', v.patenteChasis ? ('Chasis ' + v.patenteChasis) : '', v.choferNombre || ''].filter(Boolean).join(' · ');
        return '<button type="button" class="tripItem" data-trip-idx="' + idx + '"><strong>' + esc(main) + '</strong><span>' + esc(sub) + '</span></button>';
      }).join('');
      Array.from(box.querySelectorAll('[data-trip-idx]')).forEach(function(btn){
        btn.addEventListener('click', function(){ loadTripIntoForm(items[Number(btn.getAttribute('data-trip-idx'))]); });
      });
    }

    async function searchTrips(q){
      q = trim(q || '');
      const url = '/api/fleteros/viajes?limit=50' + (q ? '&q=' + encodeURIComponent(q) : '');
      const r = await fetch(url, { headers: { 'Accept':'application/json' } });
      if (!r.ok) throw new Error('trips_search_failed');
      const j = await r.json();
      renderTrips(j.items || []);
    }

    function toggleTrips(){
      const panel = el('tripsPanel');
      const open = !panel.className.includes('show');
      panel.className = open ? 'tripsPanel show' : 'tripsPanel';
      if (open) {
        el('tripSearchInput').focus();
        searchTrips(el('tripSearchInput').value).catch(function(){ toast('Error buscando viajes', false); });
      }
    }

    async function loadStatus(){
      const r = await fetch('/api/fleteros/status', { headers: { 'Accept':'application/json' } });
      if (!r.ok) return;
      const j = await r.json().catch(function(){ return {}; });
      const btn = el('btnSeed');
      if (btn) btn.className = j.showSeedDemo ? 'btn2' : 'btn2 seedHidden';
    }

    async function seedDemo(){
      const r = await fetch('/api/fleteros/seed-demo', { method:'POST', headers:{ 'Content-Type':'application/json', 'Accept':'application/json' }, body:'{}' });
      const j = await r.json().catch(function(){ return {}; });
      if (!r.ok || !j.ok) throw new Error(j.error || 'seed_failed');
      toast('Datos demo cargados para este dominio. Ahora escribí para buscar.', true);
      await loadStatus();
    }

    function clearForm(){
      state.cliente = null;
      state.origen = null;
      state.destino = null;
      state.tipoCarga = null;
      state.chasis = null;
      state.editingId = null;
      ['clientes','origen','destino','tipos-carga','chasis'].forEach(function(type){
        const input = el(type + 'Input');
        if (input) input.value = '';
        selectedBox(type, null);
        hideResults(type);
      });
      renderChasis(null);
      el('fechaViaje').value = todayIso();
      el('observaciones').value = '';
      updateEditUi();
      validate();
    }

    async function submit(){
      if (!validate()) { toast('Completá todos los datos obligatorios', false); return; }
      const btn = el('btnSubmit');
      btn.disabled = true;
      btn.textContent = state.editingId ? 'Guardando...' : 'Registrando...';
      try {
        const payload = {
          clienteId: state.cliente.id,
          origenId: state.origen.id,
          destinoId: state.destino.id,
          tipoCargaId: state.tipoCarga.id,
          chasisId: state.chasis.id,
          fechaViaje: el('fechaViaje').value || '',
          observaciones: el('observaciones').value || ''
        };
        const isEdit = !!state.editingId;
        const r = await fetch(isEdit ? ('/api/fleteros/viajes/' + encodeURIComponent(state.editingId)) : '/api/fleteros/viajes', {
          method: isEdit ? 'PUT' : 'POST',
          headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
          body: JSON.stringify(payload)
        });
        const j = await r.json().catch(function(){ return {}; });
        if (!r.ok || !j.ok) throw new Error(j.error || 'save_failed');
        toast(isEdit ? 'Viaje actualizado correctamente' : 'Viaje registrado correctamente', true);
        const box = el('lastTrip');
        box.className = 'lastTrip show';
        box.innerHTML = '<b>' + (isEdit ? 'Viaje actualizado:' : 'Último viaje:') + '</b><br>' +
          esc(j.item.clienteNombre) + ' · ' + esc(j.item.origenNombre) + ' → ' + esc(j.item.destinoNombre) + '<br>' +
          esc(j.item.tipoCargaNombre) + ' · Chasis ' + esc(j.item.patenteChasis) + '<br>' +
          '<small>ID: ' + esc(j.item.id) + '</small>';
        state.editingId = j.item.id || state.editingId;
        updateEditUi();
        if (el('tripsPanel').className.includes('show')) searchTrips(el('tripSearchInput').value).catch(function(){});
      } catch(e) {
        toast('No se pudo guardar el viaje: ' + (e.message || 'error'), false);
      } finally {
        updateEditUi();
        validate();
      }
    }

    ['clientes','origen','destino','tipos-carga','chasis'].forEach(bindAutocomplete);
    el('btnToggleTrips').addEventListener('click', toggleTrips);
    el('tripSearchInput').addEventListener('input', function(){
      clearTimeout(debounceTimers.__trips);
      debounceTimers.__trips = setTimeout(function(){ searchTrips(el('tripSearchInput').value).catch(function(){ toast('Error buscando viajes', false); }); }, 250);
    });
    el('btnSeed').addEventListener('click', function(){ seedDemo().catch(function(e){ toast('No se pudieron cargar los demo: ' + (e.message || 'error'), false); }); });
    el('btnSubmit').addEventListener('click', submit);
    el('btnReset').addEventListener('click', clearForm);
    el('btnCancelEdit').addEventListener('click', clearForm);
    el('fechaViaje').value = todayIso();
    updateEditUi();
    loadStatus().catch(function(){});
  })();
  </script>
</body>
</html>`;
}

function mountFleterosViajesPanel(app, { auth } = {}) {
  if (!app) throw new Error('express_app_required');
  const requireAuth = requireAuthMiddleware(auth);

  app.get('/admin/fleteros/viajes', requireAuth, async (req, res) => {
    try {
      const tenantId = resolveTenantId(req, auth);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(panelHtml({ tenantId, user: req.user }));
    } catch (e) {
      console.error('GET /admin/fleteros/viajes error:', e);
      res.status(500).send('Error interno');
    }
  });

  app.get('/api/fleteros/search', requireAuth, async (req, res) => {
    try {
      const tenantId = resolveTenantId(req, auth);
      const type = cleanString(req.query?.type, 40);
      const q = cleanString(req.query?.q, 120);
      const limit = Math.max(1, Math.min(Number(req.query?.limit || 12), 30));
      const db = await getDb();
      await ensureFleterosIndexes(db).catch(() => {});

      let collectionName = '';
      let mapper = null;
      let sort = { nombre: 1 };

      if (type === 'clientes') {
        collectionName = COLLECTIONS.clientes;
        mapper = mapCliente;
      } else if (type === 'lugares') {
        collectionName = COLLECTIONS.lugares;
        mapper = mapLugar;
      } else if (type === 'tipos-carga') {
        collectionName = COLLECTIONS.tiposCarga;
        mapper = mapTipoCarga;
      } else if (type === 'chasis') {
        collectionName = COLLECTIONS.chasis;
        mapper = mapChasis;
        sort = { patenteChasis: 1 };
      } else {
        return res.status(400).json({ ok: false, error: 'invalid_type' });
      }

      if (!normalizeSearchText(q)) {
        return res.json({ ok: true, tenantId, type, items: [] });
      }

      const filter = buildSearchFilter(type, tenantId, q);
      const rows = await db.collection(collectionName).find(filter).sort(sort).limit(limit).toArray();
      res.json({ ok: true, tenantId, type, items: rows.map(mapper).filter(Boolean) });
    } catch (e) {
      console.error('GET /api/fleteros/search error:', e);
      res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.get('/api/fleteros/status', requireAuth, async (req, res) => {
    try {
      const tenantId = resolveTenantId(req, auth);
      const db = await getDb();
      await ensureFleterosIndexes(db).catch(() => {});
      const status = await getFleterosBaseDataStatus(db, tenantId);
      res.json({ ok: true, ...status });
    } catch (e) {
      console.error('GET /api/fleteros/status error:', e);
      res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.post('/api/fleteros/seed-demo', requireAuth, async (req, res) => {
    try {
      const tenantId = resolveTenantId(req, auth);
      const db = await getDb();
      const status = await getFleterosBaseDataStatus(db, tenantId);
      if (!status.showSeedDemo) {
        return res.status(409).json({ ok: false, error: 'tenant_already_has_data', ...status });
      }
      const result = await seedFleterosDemoData(tenantId);
      res.json(result);
    } catch (e) {
      console.error('POST /api/fleteros/seed-demo error:', e);
      res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.post('/api/fleteros/viajes', requireAuth, async (req, res) => {
    try {
      const tenantId = resolveTenantId(req, auth);
      const body = req.body || {};
      const db = await getDb();

      const [cliente, origen, destino, tipoCarga, chasis] = await Promise.all([
        findRefById(db, COLLECTIONS.clientes, tenantId, body.clienteId),
        findRefById(db, COLLECTIONS.lugares, tenantId, body.origenId),
        findRefById(db, COLLECTIONS.lugares, tenantId, body.destinoId),
        findRefById(db, COLLECTIONS.tiposCarga, tenantId, body.tipoCargaId),
        findRefById(db, COLLECTIONS.chasis, tenantId, body.chasisId),
      ]);

      const missing = [];
      if (!cliente) missing.push('cliente');
      if (!origen) missing.push('origen');
      if (!destino) missing.push('destino');
      if (!tipoCarga) missing.push('tipoCarga');
      if (!chasis) missing.push('chasis');
      if (missing.length) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_refs', missing });
      }

      const viaje = buildViajeDoc({ tenantId, body, cliente, origen, destino, tipoCarga, chasis, user: req.user });
      const r = await db.collection(COLLECTIONS.viajes).insertOne(viaje);
      const id = String(r.insertedId || '');

      res.status(201).json({
        ok: true,
        item: {
          id,
          ...viaje,
          _id: id,
        },
      });
    } catch (e) {
      console.error('POST /api/fleteros/viajes error:', e);
      res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.get('/api/fleteros/viajes', requireAuth, async (req, res) => {
    try {
      const tenantId = resolveTenantId(req, auth);
      const limit = Math.max(1, Math.min(Number(req.query?.limit || 50), 200));
      const q = cleanString(req.query?.q, 120);
      const db = await getDb();
      const rows = await db.collection(COLLECTIONS.viajes)
        .find(buildViajeSearchFilter(tenantId, q))
        .sort({ fechaViaje: -1, createdAt: -1 })
        .limit(limit)
        .toArray();
      res.json({
        ok: true,
        tenantId,
        items: rows.map(mapViaje).filter(Boolean),
      });
    } catch (e) {
      console.error('GET /api/fleteros/viajes error:', e);
      res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.get('/api/fleteros/viajes/:id', requireAuth, async (req, res) => {
    try {
      const tenantId = resolveTenantId(req, auth);
      const id = cleanString(req.params?.id, 80);
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const db = await getDb();
      const item = await db.collection(COLLECTIONS.viajes).findOne({ _id: new ObjectId(id), tenantId });
      if (!item) return res.status(404).json({ ok: false, error: 'not_found' });
      res.json({ ok: true, tenantId, item: mapViaje(item) });
    } catch (e) {
      console.error('GET /api/fleteros/viajes/:id error:', e);
      res.status(500).json({ ok: false, error: 'internal' });
    }
  });

  app.put('/api/fleteros/viajes/:id', requireAuth, async (req, res) => {
    try {
      const tenantId = resolveTenantId(req, auth);
      const id = cleanString(req.params?.id, 80);
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });

      const body = req.body || {};
      const db = await getDb();
      const existing = await db.collection(COLLECTIONS.viajes).findOne({ _id: new ObjectId(id), tenantId });
      if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });

      const [cliente, origen, destino, tipoCarga, chasis] = await Promise.all([
        findRefById(db, COLLECTIONS.clientes, tenantId, body.clienteId),
        findRefById(db, COLLECTIONS.lugares, tenantId, body.origenId),
        findRefById(db, COLLECTIONS.lugares, tenantId, body.destinoId),
        findRefById(db, COLLECTIONS.tiposCarga, tenantId, body.tipoCargaId),
        findRefById(db, COLLECTIONS.chasis, tenantId, body.chasisId),
      ]);

      const missing = [];
      if (!cliente) missing.push('cliente');
      if (!origen) missing.push('origen');
      if (!destino) missing.push('destino');
      if (!tipoCarga) missing.push('tipoCarga');
      if (!chasis) missing.push('chasis');
      if (missing.length) {
        return res.status(400).json({ ok: false, error: 'missing_or_invalid_refs', missing });
      }

      const update = buildViajeUpdateDoc({ tenantId, body, cliente, origen, destino, tipoCarga, chasis, user: req.user });
      await db.collection(COLLECTIONS.viajes).updateOne(
        { _id: new ObjectId(id), tenantId },
        { $set: update }
      );
      const saved = await db.collection(COLLECTIONS.viajes).findOne({ _id: new ObjectId(id), tenantId });
      res.json({ ok: true, tenantId, item: mapViaje(saved) });
    } catch (e) {
      console.error('PUT /api/fleteros/viajes/:id error:', e);
      res.status(500).json({ ok: false, error: 'internal' });
    }
  });
}

module.exports = {
  COLLECTIONS,
  buildDemoDocs,
  seedFleterosDemoData,
  getFleterosBaseDataStatus,
  mountFleterosViajesPanel,
};

if (require.main === module) {
  (async () => {
    const cmd = String(process.argv[2] || '').trim().toLowerCase();
    const tenant = String(process.argv[3] || process.env.TENANT_ID || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
    if (cmd !== 'seed') {
      console.log('Uso: node fleteros_viajes_panel.js seed <tenantId>');
      process.exitCode = 1;
      return;
    }
    const result = await seedFleterosDemoData(tenant);
    console.log(JSON.stringify(result, null, 2));
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb().catch(() => {});
    });
}
