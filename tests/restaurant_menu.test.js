// Asisto | Version: 5.00.166 | Fecha: 2026-09-19
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { renderRestaurantPage } = require('../restaurant_public_page');

test('Mi pedido suma artículos, conserva el borrador al recargar y muestra pendientes en la cuenta', async t => {
  const html = renderRestaurantPage({tenant:'RES',token:'draft',name:'Resto',table:'1'});
  const script = fs.readFileSync(path.join(__dirname,'../static/restaurant_menu.js'),'utf8');
  const key='asistoRestoDraft:/api/public/resto/RES/draft';
  async function start(saved) {
    const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://example.test'}),w=dom.window;
    t.after(()=>w.close());
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
    w.HTMLDialogElement.prototype.close=function(){this.open=false;};
    // Algunos navegadores bloquean localStorage; la carta debe seguir funcionando.
    Object.defineProperty(w,'localStorage',{get(){throw Error('Storage bloqueado');}});
    if(saved)w.sessionStorage.setItem(key,saved);
    w.fetch=async url=>({ok:true,json:async()=>url.endsWith('/menu')?{items:[{id:'a',nombre:'Agua',precio:100,disponible:true},{id:'b',nombre:'Pasta',precio:500,disponible:true}],features:{guestNotifications:false}}:{orders:[]}});
    w.eval(script);await new Promise(resolve=>setTimeout(resolve,0));return w;
  }
  const w=await start(),$=s=>w.document.querySelector(s);
  $('[data-add="a"]').click();$('[data-add="b"]').click();$('[data-increase="a"]').click();
  $('#openAccount').click();
  assert.equal($('#cartDialog').open,true);
  assert.match($('#cart').textContent,/Agua × 2/);assert.match($('#cart').textContent,/Pasta × 1/);
  assert.match($('#cartTotal').textContent,/700/);
  $('[data-increase="b"]').click();assert.match($('#cartTotal').textContent,/1.200/);
  assert.match($('#cart-count').textContent,/4 sin enviar/);assert.equal($('#accountDialog'),null);
  const w2=await start(w.sessionStorage.getItem(key)),d=w2.document;
  d.querySelector('#openAccount').click();
  assert.match(d.querySelector('#cart').textContent,/Agua × 2/);assert.match(d.querySelector('#cart').textContent,/Pasta × 2/);
  assert.match(d.querySelector('#cartTotal').textContent,/1.200/);
  assert.equal(d.querySelectorAll('.asisto-powered').length,4);
});

test('carta simple: lupa abre foto e ingredientes, carrito muestra total y conserva la categoría', async t => {
  const dom = new JSDOM(renderRestaurantPage({ tenant:'RES',token:'a'.repeat(32),name:'Resto',table:'1' }), {runScripts:'outside-only',url:'https://example.test'});
  const { window } = dom;
  t.after(() => window.close());
  // JSDOM no implementa la API nativa de dialog; el foco/modal se revisa en navegador.
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.fetch = async url => ({ok:true,json:async()=>url.endsWith('/menu') ? {items:[{id:'uno',nombre:'Pasta',categoria:'Principales',precio:1200,disponible:true,imagen:'/static/restaurant_demo/pasta.webp',observacion:'Trigo y tomate'}]} : {orders:[],notifications:[]}});
  window.eval(fs.readFileSync(path.join(__dirname,'../static/restaurant_menu.js'),'utf8'));
  await new Promise(resolve=>setTimeout(resolve,0));
  const $ = selector=>window.document.querySelector(selector);
  assert.equal($('dialog[open]'),null);
  assert.equal($('#cartBar').hidden,true);
  const category = $('#menu details'); category.open = true;
  $('.photo-button').click();
  assert.equal($('#dishDialog').open,true);
  assert.match($('#dishContent').textContent,/Trigo y tomate/);
  assert.equal($('#dishContent img').getAttribute('src'),'/static/restaurant_demo/pasta.webp');
  $('#dishDialog [data-close]').click();
  assert.equal($('#dishDialog').open,false);
  assert.equal(category.open,true);
  $('[data-add]').click();
  assert.equal($('#cartBar').hidden,false);
  assert.match($('#cartBarTotal').textContent,/1.200/);
  $('#openCart').click();
  assert.equal($('#cartDialog').open,true);
  $('[data-remove]').click();
  assert.equal($('#cartExtras').hidden,true);
  assert.equal($('#cartBar').hidden,true);
  await new Promise(resolve=>setTimeout(resolve,0));
  window.close();
});

test('Mercado Pago es informativo y reintentar el envío conserva la clave del pedido', async () => {
  const dom = new JSDOM(renderRestaurantPage({ tenant:'RES', token:'a'.repeat(32), name:'Resto', table:'1' }), { runScripts:'outside-only', url:'https://example.test/resto' });
  const { window } = dom, sent = [];
  window.fetch = async (url, options) => {
    if (url.endsWith('/events')) { sent.push(JSON.parse(options.body)); return { ok:sent.length > 1, json:async()=>({ error:'Reintentá' }) }; }
    return { ok:true, json:async()=>url.endsWith('/menu') ? { items:[{ id:'uno', nombre:'Pasta', precio:100, categoria:'Platos', disponible:true }], features:{ guestNotifications:false, guestAi:false, showImages:false } } : { orders:[], notifications:[] } };
  };
  window.eval(fs.readFileSync(path.join(__dirname,'../static/restaurant_menu.js'),'utf8'));
  await new Promise(resolve=>setTimeout(resolve,0));
  window.document.querySelector('#payMercadoPago').click();
  assert.match(window.document.querySelector('#paymentInfo').textContent,/No se realizó ningún cobro/);
  assert.equal(sent.length,0);
  assert.equal(window.document.querySelector('#guestAiSection').hidden,true);
  window.document.querySelector('[data-add]').click();
  await window.document.querySelector('#order').onclick();
  assert.match(window.document.querySelector('#cart').textContent,/Pasta × 1/);
  await window.document.querySelector('#order').onclick();
  assert.equal(sent.length,2); assert.ok(sent[0].requestId); assert.equal(sent[0].requestId,sent[1].requestId);
  assert.equal(window.document.querySelector('#cart-count').textContent,'');
  window.close();
});

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
  assert.equal(window.document.querySelector('#cart-count').textContent, '(1 sin enviar)');
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

test('enviar, reabrir y recargar conserva pedidos; nuevos artículos quedan separados y una falla de red conserva el comprobante', async t => {
  let orders=[],offline=false; const html=renderRestaurantPage({tenant:'RES',token:'flow',name:'Resto',table:'1'});
  async function start(storage={}) {
    const w=new JSDOM(html,{runScripts:'outside-only',url:'https://example.test'}).window;t.after(()=>w.close());
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
    for(const [key,value] of Object.entries(storage))w.sessionStorage.setItem(key,value);
    w.fetch=async(url,options)=> {
      if(url.endsWith('/menu'))return {ok:true,json:async()=>({items:[{id:'a',nombre:'Agua',precio:100,disponible:true}],features:{guestNotifications:false}})};
      if(url.endsWith('/events')){const p=JSON.parse(options.body);orders.push({id:p.requestId,status:'received',items:[{nombre:'Agua',quantity:p.items[0].quantity}],totalCents:10000});return {ok:true,json:async()=>({id:p.requestId})};}
      if(offline)throw Error('offline');return {ok:true,json:async()=>({orders,totalCents:10000,paidCents:0,balanceCents:10000})};
    };
    w.eval(fs.readFileSync(path.join(__dirname,'../static/restaurant_menu.js'),'utf8'));await new Promise(r=>setTimeout(r,0));return w;
  }
  const w=await start(),$=id=>w.document.getElementById(id);
  w.document.querySelector('[data-add]').click();$('openAccount').click();await $('order').onclick();
  assert.equal($('cartDialog').open,true);assert.match($('sentOrders').textContent,/Recibido.*1 × Agua/s);assert.equal($('cartExtras').hidden,true);
  $('cartDialog').close();$('openAccount').click();await new Promise(r=>setTimeout(r,0));assert.equal($('sentSection').hidden,false);
  w.document.querySelector('[data-add]').click();assert.match($('cart').textContent,/Agua × 1/);assert.match($('sentOrders').textContent,/1 × Agua/);
  const saved=Object.fromEntries(Object.keys(w.sessionStorage).map(key=>[key,w.sessionStorage.getItem(key)]));offline=true;
  const w2=await start(saved);w2.document.getElementById("openAccount").click();await new Promise(r=>setTimeout(r,0));assert.match(w2.document.getElementById('sentOrders').textContent,/1 × Agua/);assert.match(w2.document.getElementById('syncStatus').textContent,/No pudimos actualizar/);assert.match(w2.document.getElementById('cart').textContent,/Agua × 1/);
  offline=false;orders[0].status='preparing';w2.document.getElementById('openAccount').click();await new Promise(r=>setTimeout(r,0));assert.match(w2.document.getElementById('sentOrders').textContent,/En preparación/);
});

test('búsqueda y controles del menú conservan el pedido; navegación respeta funciones del dominio',async t=>{
  const w=new JSDOM(renderRestaurantPage({tenant:'RES',token:'search',name:'BRASA',table:'8'}),{runScripts:'outside-only',url:'https://example.test'}).window;t.after(()=>w.close());
  w.fetch=async()=>({ok:true,json:async()=>({items:[{id:'a',nombre:'Agua',categoria:'Bebidas',precio:100,disponible:true},{id:'p',nombre:'Pasta',categoria:'Principales',precio:500,disponible:true}],features:{guestAi:false,guestNotifications:false,callWaiter:false,requestBill:false}})});
  w.eval(fs.readFileSync(path.join(__dirname,'../static/restaurant_menu.js'),'utf8'));await new Promise(r=>setTimeout(r,0));
  const d=w.document;d.querySelector('[data-add="p"]').click();assert.equal(d.querySelector('[data-increase="p"]')!==null,true);
  const search=d.getElementById('menuSearch');search.value='agua';search.dispatchEvent(new w.Event('input'));assert.match(d.getElementById('menu').textContent,/Agua/);assert.doesNotMatch(d.getElementById('menu').textContent,/Pasta/);assert.match(d.getElementById('cart').textContent,/Pasta/);
  search.value='';search.dispatchEvent(new w.Event('input'));assert.match(d.querySelector('[data-feedback="p"]').textContent,/Agregado/);
  assert.equal(d.getElementById('aiShortcut').hidden,true);assert.equal(d.getElementById('orderCall').hidden,true);assert.equal(d.getElementById('orderBill').hidden,true);assert.equal([...d.querySelectorAll('[data-help-nav]')].every(el=>el.hidden),true);
  d.querySelector('[data-delete="p"]').click();assert.equal(d.getElementById('cartExtras').hidden,true);
});
