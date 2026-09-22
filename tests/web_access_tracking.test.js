// Asisto | Version: 5.00.183 | Fecha: 2026-09-22
const test = require('node:test');
const assert = require('node:assert/strict');

test('redirección pública registra origen, pantalla y dominio sin exponer identidad', async () => {
  const inserted = [];
  const db = require('../db');
  const originalGetDb = db.getDb;
  db.getDb = async () => ({ collection: () => ({ insertOne: async doc => inserted.push(doc) }) });
  delete require.cache[require.resolve('../web_access_stats')];
  const { mountWebAccessRoutes } = require('../web_access_stats');
  const routes = new Map();
  const app = { get(path, ...handlers) { routes.set(path, handlers); } };
  const pass = (_req, _res, next) => next?.();
  mountWebAccessRoutes(app, { requireAuth: pass, requireAdmin: pass });
  const handler = routes.get('/r')[0];
  const cookies = [];
  const req = {
    query: { source: 'instagram', campaign: 'bio', app: 'supermercado_digital', placement: 'pie_inicio', tenant: 'SDG', to: '/login' },
    headers: { referer: 'https://l.instagram.com/', 'user-agent': 'test-agent', 'x-forwarded-for': '203.0.113.7' },
    path: '/r', socket: {},
  };
  const res = {
    cookie: (...args) => cookies.push(args),
    redirect: (status, destination) => ({ status, destination }),
  };
  const result = await handler(req, res);
  assert.deepEqual(result, { status: 302, destination: '/login' });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].source, 'instagram');
  assert.equal(inserted[0].campaign, 'bio');
  assert.equal(inserted[0].app, 'supermercado_digital');
  assert.equal(inserted[0].placement, 'pie_inicio');
  assert.equal(inserted[0].tenantId, 'SDG');
  assert.equal(inserted[0].ip, '203.0.113.7');
  assert.equal(Object.hasOwn(inserted[0], 'username'), false);
  assert.equal(cookies[0][0], 'asisto_vid');
  assert.equal(cookies[0][2].httpOnly, true);
  db.getDb = originalGetDb;
});

test('enlace medido Powered by Asisto contiene aplicación, ubicación y dominio', () => {
  const { poweredLink } = require('../web_access_stats');
  assert.equal(
    poweredLink({ app: 'consulta_producto_qr', placement: 'pie_producto', tenant: 'RVL' }),
    '/r?source=powered_asisto&app=consulta_producto_qr&placement=pie_producto&tenant=RVL'
  );
});
