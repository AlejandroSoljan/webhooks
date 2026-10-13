// Asisto | Version: 5.00.288 | Fecha: 2026-10-13
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { JSDOM } = require('jsdom');

test('user dialog escapes layout, closes the drawer, accepts input and closes/reopens', () => {
  const filename = require.resolve('../auth_ui');
  const fixture = new Module(filename, module);
  fixture.filename = filename;
  fixture.paths = module.paths;
  fixture._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.renderUsers = usersAdminPage;', filename);
  const html = fixture.exports.renderUsers({ user: { uid: 'test', username: 'test', role: 'superadmin', tenantId: 'TEST' }, users: [] });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost' });
  const { document, KeyboardEvent } = dom.window;
  const modal = document.getElementById('userCreateModal');
  document.body.classList.add('drawerOpen');
  document.getElementById('usersBtnCreate').click();
  assert.equal(modal.parentElement, document.body);
  assert.equal(modal.hidden, false);
  assert.equal(document.body.classList.contains('drawerOpen'), false);
  assert.equal(document.activeElement.name, 'username');
  for (const role of ['admin', 'superadmin', 'user']) {
    modal.querySelector('input[name="role"][value="' + role + '"]').click();
    assert.equal(new dom.window.FormData(document.getElementById('userCreateForm')).get('role'), role);
  }
  const permission = modal.querySelector('input[name="allowedPages"][value="users"]');
  permission.click();
  assert.ok(modal.querySelector('option[value="/admin/users"]'));
  permission.click();
  assert.equal(modal.querySelector('option[value="/admin/users"]'), null);
  document.activeElement.value = 'nuevo_usuario';
  assert.equal(modal.querySelector('[name="username"]').value, 'nuevo_usuario');
  assert.equal(dom.window.getComputedStyle(modal).zIndex, '3000');
  modal.querySelector('button[data-users-close]').click();
  assert.equal(modal.hidden, true);
  assert.equal(document.body.classList.contains('usersModalOpen'), false);
  document.getElementById('usersBtnCreate').click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(modal.hidden, true);
  dom.window.close();
});

test('isolated create endpoint saves every role and rejects duplicates/invalid data; admin cannot elevate', async () => {
  const express = require('express');
  const records = [];
  const updates = [];
  const filename = require.resolve('../auth_ui');
  const fixture = new Module(filename, module);
  fixture.filename = filename;
  fixture.paths = module.paths;
  const originalRequire = fixture.require.bind(fixture);
  fixture.require = id => id === './db' ? { getDb: async () => ({ collection: () => ({
    findOne: async query => records.find(r => r.username === query.username),
    insertOne: async record => records.push(record),
    updateOne: async (filter, update) => { updates.push({filter, update}); return {matchedCount:1}; }
  }) }) } : originalRequire(id);
  fixture._compile(fs.readFileSync(filename, 'utf8'), filename);
  const app = express();
  let actorRole = 'superadmin';
  app.use((req, res, next) => { req.user = { uid: '000000000000000000000001', role: actorRole, tenantId: 'TEST' }; next(); });
  fixture.exports.mountAuthRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const post = async (data, action = 'create') => {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/admin/users/' + action, {
      method: 'POST', redirect: 'manual', body: new URLSearchParams(data)
    });
    assert.equal(res.status, 302);
    return decodeURIComponent(res.headers.get('location'));
  };
  try {
    for (const role of ['user', 'admin', 'superadmin']) {
      assert.match(await post({ username: 'fixture_' + role, password: 'test-only-password', tenantId: 'TEST', role, allowedPages: 'wweb', defaultPage: '/app' }), /Usuario creado/);
      assert.equal(records.at(-1).role, role);
      assert.equal(records.at(-1).isLocked, false);
      assert.deepEqual(records.at(-1).allowedPages, ['wweb']);
      assert.equal(fixture.exports.verifyPassword('test-only-password', records.at(-1).password), true);
    }
    assert.match(await post({ username: 'fixture_user', password: 'test-only-password' }), /ya existe/);
    assert.match(await post({ username: 'bad name', password: 'test-only-password' }), /inválido/);
    assert.match(await post({ username: 'validname', password: '1' }), /muy corta/);
    assert.equal(records.length, 3);
    assert.match(await post({userId:'000000000000000000000001', role:'user', tenantId:'OTHER', isLocked:'1', allowedPages:'comportamiento', defaultPage:'/app'}, 'update'), /Pantallas visibles/);
    assert.deepEqual(Object.keys(updates[0].update.$set).sort(), ['allowedPages','defaultPage','updatedAt']);
    assert.deepEqual(updates[0].update.$set.allowedPages, ['comportamiento']);
    actorRole = 'admin';
    assert.match(await post({userId:'000000000000000000000001',allowedPages:'users'},'update'), /No se permite/);
    assert.equal(updates.length, 1);
    assert.match(await post({ username: 'fixture_admin_scope', password: 'test-only-password', tenantId: 'OTHER', role: 'superadmin' }), /Usuario creado/);
    assert.equal(records.at(-1).role, 'admin');
    assert.equal(records.at(-1).tenantId, 'TEST');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
