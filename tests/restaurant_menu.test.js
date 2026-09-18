// Asisto | Version: 5.00.159 | Fecha: 2026-09-18
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { renderRestaurantPage } = require('../restaurant_public_page');

test('carta agrupa por categoría y confirma cada artículo agregado', async () => {
  const html = renderRestaurantPage({ tenant: 'RES', token: 'a'.repeat(32), name: 'Restaurante', table: '1' });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://asistobot.com.ar/resto/RES/' + 'a'.repeat(32) });
  const { window } = dom;
  window.fetch = async url => ({ ok: true, json: async () => String(url).includes('/menu') ? ({ items: [
    { id: 'uno', nombre: 'Milanesa', categoria: 'Platos principales', precio: 12000, observacion: 'Carne y pan rallado', disponible: true },
    { id: 'dos', nombre: 'Agua', categoria: 'Bebidas', precio: 3000, observacion: 'Sin gas', disponible: true },
  ], ordersEnabled:true }) : ({ notifications:[] }) });
  window.eval(fs.readFileSync(path.join(__dirname, '../static/restaurant_menu.js'), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const groups = [...window.document.querySelectorAll('#menu details')];
  assert.equal(groups.length, 2);
  assert.equal(groups[0].open, false);
  assert.match(groups[0].textContent, /Platos principales/);
  groups[0].open = true;
  groups[0].querySelector('[data-add="uno"]').click();
  assert.equal(groups[0].open, true);
  assert.match(groups[0].querySelector('[data-feedback="uno"]').textContent, /Agregado ✓ \(1\)/);
  assert.match(window.document.querySelector('#cart').textContent, /Milanesa × 1/);
  assert.equal(window.document.querySelector('#cart-count').textContent, '(1)');
  assert.match(window.document.querySelector('#toast').textContent, /Milanesa agregado/);
  window.close();
});

test('si el dominio deshabilita pedidos la carta muestra imágenes sin botón de agregar', async () => {
  const html = renderRestaurantPage({ tenant: 'RES', token: 'b'.repeat(32), name: 'Restaurante', table: '2' });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://asistobot.com.ar/resto/RES/' + 'b'.repeat(32) });
  const { window } = dom;
  window.fetch = async url => ({ ok: true, json: async () => String(url).includes('/menu') ? ({ ordersEnabled:false, items:[{ id:'uno', nombre:'Pasta', categoria:'Principales', precio:12000, observacion:'Tomate', imagen:'/static/restaurant_demo/pasta.webp', disponible:true }] }) : ({ notifications:[] }) });
  window.eval(fs.readFileSync(path.join(__dirname, '../static/restaurant_menu.js'), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(window.document.querySelector('#pedido').hidden, true);
  assert.equal(window.document.querySelector('[data-add]'), null);
  assert.equal(window.document.querySelector('.item-image').getAttribute('src'), '/static/restaurant_demo/pasta.webp');
  window.close();
});
