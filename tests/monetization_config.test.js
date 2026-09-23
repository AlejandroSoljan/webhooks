const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { CATALOG, defaultConfig, normalizeConfig, listMonetizationTenants, renderPage } = require('../monetization_config');

test('el catálogo inicial activa únicamente QR y código de barras o SKU', () => {
  const config = defaultConfig('mcn');
  const enabled = Object.entries(config.items).filter(([, value]) => value.enabled).map(([key]) => key).sort();
  assert.deepEqual(enabled, ['catalog.code_lookup', 'catalog.qr_read']);
  assert.equal(config.tenantId, 'MCN');
  assert.equal(config.billingEnabled, false);
  assert.ok(CATALOG.length >= 40);
});

test('normaliza tarifas y descarta funcionalidades inventadas', () => {
  const config = normalizeConfig({ billingEnabled: true, currency: 'usd', creditValue: -2, items: { 'catalog.qr_read': { enabled: true, mode: 'fixed', unitPrice: 25 }, invented: { enabled: true } } }, 'rvl');
  assert.equal(config.currency, 'USD');
  assert.equal(config.creditValue, 0);
  assert.equal(config.items['catalog.qr_read'].unitPrice, 25);
  assert.equal(config.items.invented, undefined);
});

test('el panel contiene el catálogo completo y JavaScript válido', () => {
  const html = renderPage();
  assert.match(html, /Lectura de QR/);
  assert.match(html, /Lectura por código de barras o SKU/);
  assert.match(html, /Configuración guardada/);
  new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
});

test('el selector incluye dominios del turnero aunque no estén en tenant_config', async () => {
  const rows={tenant_config:[{_id:'RVL'}],customer_app_config:[{tenantId:'MCN'}],queue_tickets:[{_id:'DEMO_FERRETERIA'}],monetization_config:[]};
  const db={collection:name=>({find:()=>({limit:()=>({toArray:async()=>rows[name]})}),aggregate:()=>({toArray:async()=>rows[name]})})};
  assert.deepEqual(await listMonetizationTenants(db,'CARICO'),['CARICO','DEMO_FERRETERIA','MCN','RVL']);
});
