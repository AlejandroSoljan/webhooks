// Asisto | Version: 5.00.186 | Fecha: 2026-09-22
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { JSDOM } = require('jsdom');
const { mountAuthRoutes, protectRoutes, appShell } = require('../auth_ui');
const { navigationGroups, configurationState } = require('../admin_navigation');

const superadmin = { uid: 'test', username: 'Prueba', tenantId: 'DEMO', role: 'superadmin', allowedPages: [] };
const existingKeys = ['admin', 'followup', 'bot_test', 'inbox', 'fleteros', 'productos', 'resto', 'horarios', 'comportamiento', 'notifications', 'queue_kiosk', 'queue_attention', 'queue_display', 'queue_stats', 'leads', 'wweb', 'canales', 'client_access', 'telegram', 'users', 'tenant_config', 'order_config', 'web_access', 'token_control'];

async function withPanel(user, fn) {
  const app = express();
  // Only test identities; no session, production data or Mongo connection.
  app.use((req, res, next) => { req.user = user; next(); });
  protectRoutes(app);
  mountAuthRoutes(app);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await fn(async path => {
    const response = await fetch(base + path, { redirect: 'manual' });
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), text, document: new JSDOM(text).window.document };
  }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('groups preserve every authorized screen exactly once, including future screens', () => {
  const items = ['home', ...existingKeys, 'future'].map(key => ({ key, href: '/ui/' + key, title: key }));
  const grouped = navigationGroups(items).flatMap(group => group.items.map(item => item.key));
  assert.deepEqual(grouped.sort(), [...existingKeys, 'future'].sort());
  assert.equal(navigationGroups([{ key: 'home' }]).length, 0);
});

test('superadmin home exposes all original screens and advanced APIs', async () => {
  await withPanel(superadmin, async get => {
    const { status, document } = await get('/app');
    assert.equal(status, 200);
    assert.equal(document.querySelectorAll('.workspaceCard a').length, existingKeys.length);
    assert.ok(document.querySelector('.workspaceTools a[href="/api/logs/messages"]'));
    const menu = document.querySelector('.sidebar .nav');
    assert.equal(menu.querySelectorAll('a[href^="/ui/configuracion"]').length, 1);
    assert.ok(menu.querySelector('a[href="/admin/wweb"]'));
    assert.ok(menu.querySelector('a[href="/admin/inbox"]'));
    assert.equal(document.querySelector('.sideBrand img').getAttribute('src').split('?')[0], '/static/logo-asisto-transparent.png');
    assert.match(document.querySelector('.opsSlogan').textContent, /siempre más cerca/);
    assert.ok(document.querySelector('body.asistoHome'));
    assert.ok(document.querySelector('link[href^="/static/admin_shell.css"]'));
  });
});

test('configuration tabs and legacy bookmarks embed the same original forms', async () => {
  await withPanel(superadmin, async get => {
    for (const [key, path] of Object.entries({ tenant_config: '/admin/tenant-config', canales: '/canales', comportamiento: '/comportamiento', horarios: '/horarios', order_config: '/admin/order-config', client_access: '/admin/client-phone-access' })) {
      for (const url of ['/ui/configuracion?seccion=' + key + '&tenant=RVL', '/ui/' + key + '?tenant=RVL']) {
        const { status, document } = await get(url);
        assert.equal(status, 200, url);
        assert.equal(document.querySelector('body.asistoHome'), null);
        assert.ok(document.querySelector('body.asistoShell.asistoSection'));
        assert.ok(document.querySelector('link[href^="/static/admin_shell.css"]'));
        const frame = new URL(document.querySelector('iframe').getAttribute('src'), 'http://test');
        assert.equal(frame.pathname, path);
        assert.equal(frame.searchParams.get('tenant'), 'RVL');
        assert.equal(document.querySelectorAll('.configTab').length, 6);
        assert.ok(document.querySelector('.configTab.active[aria-current="page"]'));
        assert.match(document.querySelector('.configTab.active').href, new RegExp('seccion=' + key));
      }
    }
  });
});

test('limited users see only permitted tabs; foreign domain query is not forwarded', async () => {
  await withPanel({ ...superadmin, role: 'user', tenantId: 'NEA', allowedPages: ['horarios'] }, async get => {
    const result = await get('/ui/configuracion?tenant=RVL&tenantId=RVL');
    assert.equal(result.status, 200);
    assert.equal(result.document.querySelectorAll('.configTab').length, 1);
    const src = new URL(result.document.querySelector('iframe').getAttribute('src'), 'http://test');
    assert.equal(src.searchParams.get('tenant'), 'NEA');
    assert.equal(src.searchParams.get('tenantId'), 'NEA');
    assert.equal((await get('/ui/configuracion?seccion=tenant_config')).status, 403);
    assert.equal((await get('/ui/tenant_config')).status, 403);
    const home = await get('/app');
    assert.equal(home.document.querySelectorAll('.workspaceCard a').length, 1);
  });
});

test('empty permissions deny configuration; support retains sessions access', async () => {
  await withPanel({ ...superadmin, role: 'user', allowedPages: [] }, async get => {
    assert.equal((await get('/ui/configuracion')).status, 403);
    assert.equal((await get('/app')).document.querySelectorAll('.workspaceCard a').length, 0);
  });
  await withPanel({ ...superadmin, role: 'user', allowedPages: ['support'] }, async get => {
    assert.ok((await get('/app')).document.querySelector('a[href="/admin/wweb"]'));
    assert.equal((await get('/ui/support')).location, '/admin/wweb');
  });
});

test('turnero menu and private screens follow each independent user permission', async () => {
  const user = { ...superadmin, role: 'user', tenantId: 'MCN', allowedPages: ['queue_kiosk', 'queue_stats'] };
  await withPanel(user, async get => {
    const home = await get('/app');
    const menu = home.document.querySelector('.sidebar .nav');
    assert.ok(menu.querySelector('a[href="/customer-app/MCN/kiosk"]'));
    assert.ok(menu.querySelector('a[href="/ui/turnero/MCN/estadisticas"]'));
    assert.equal(menu.querySelector('a[href="/ui/turnero/MCN"]'), null);
    assert.equal(menu.querySelector('a[href="/customer-app/MCN/display"]'), null);
    assert.equal((await get('/ui/turnero/MCN')).status, 403);
    assert.notEqual((await get('/ui/turnero/MCN/estadisticas')).status, 403);
  });
});

test('unauthenticated requests still require login', async () => {
  await withPanel(null, async get => { assert.equal((await get('/ui/configuracion')).status, 302); });
});
test('every administrative section shares the approved shell and current menu state', async () => {
  for (const active of ['home', ...existingKeys]) {
    const document = new JSDOM(appShell({title:'Sección · Asisto',user:superadmin,active,main:'<button id="keptAction">Acción existente</button>'})).window.document;
    assert.ok(document.querySelector('body.asistoShell'), active);
    assert.ok(document.querySelector('link[href^="/static/admin_shell.css"]'), active);
    assert.ok(document.querySelector('.sidebar a[aria-current]'), active);
    assert.match(document.querySelector('.opsSlogan').textContent, /siempre más cerca/);
    assert.ok(document.querySelector('#keptAction'));
    assert.ok(document.querySelector('form[action="/logout"]'));
  }
  await withPanel(superadmin, async get => {
    const { status, document } = await get('/admin/wweb');
    assert.equal(status, 200);
    assert.ok(document.querySelector('body.asistoShell.asistoSection'));
    assert.ok(document.querySelector('#wwebSearch'));
    assert.ok(document.querySelector('#wwebStateFilter'));
    assert.equal(document.querySelector('.sidebar a[aria-current="page"]').getAttribute('href'), '/admin/wweb');
  });
});

test('configuration URLs reject arbitrary sections and cannot override embedding', () => {
  const items = [{ key: 'canales', title: 'Canales' }];
  assert.equal(configurationState(items, superadmin, '__proto__'), null);
  const result = configurationState(items, superadmin, 'canales', 'embed=0&seccion=other&tenant=NEA');
  assert.equal(result.src, '/canales?embed=1&tenant=NEA');
});

test('active submenu is expanded and user-supplied labels are escaped', async () => {
  await withPanel({ ...superadmin, username: '<script>alert(1)</script>' }, async get => {
    const home = await get('/app');
    assert.match(home.document.querySelector('.opsUser strong').textContent, /<script>/);
    assert.equal(home.document.querySelector('.opsUser script'), null);
    const page = await get('/ui/token_control');
    assert.ok(page.document.querySelector('.sidebar details[open] a[aria-current="page"][href="/ui/token_control"]'));
  });
});
