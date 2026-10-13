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
