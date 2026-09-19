// Asisto | Version: 5.00.167 | Fecha: 2026-09-19
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('cerrar mesa pagada permite confirmar entregas, libera la mesa y muestra resultado', async t => {
  const dom=new JSDOM('<select id="domain"><option>RES</option></select><div class="metrics"></div>',{runScripts:'outside-only',url:'https://example.test'});t.after(()=>dom.window.close());
  const w=dom.window, sent=[];
  const service={id:'s1',status:'occupied',guests:2,waiter:'',note:'',openedAt:new Date(),orders:[{id:'o1',status:'received',totalCents:10000,items:[{nombre:'Pasta',quantity:1}],createdAt:new Date()}],payments:[],audit:[]};
  w.setInterval=()=>{};w.confirm=()=>{throw Error('No debe depender de confirmaciones nativas');};
  w.fetch=async(url,options)=>{if(options?.body){sent.push(JSON.parse(options.body));service.status='closed';return{ok:true,json:async()=>({ok:true})};}return{ok:true,json:async()=>({features:{manualPayments:true},history:[],catalog:[],tables:[{id:'table',label:'1',revision:7,service,totalCents:10000,paidCents:10000,balanceCents:0,pending:[],legacyOrders:[]}]})};};
  w.eval(fs.readFileSync(path.join(__dirname,'../static/restaurant_operations.js'),'utf8'));
  const tick=()=>new Promise(r=>setTimeout(r,0));await tick();
  const $=s=>w.document.querySelector(s);
  $('[data-select-table]').click();$('#opsClose').click();
  assert.equal($('#opsCloseReview').hidden,false);assert.equal(sent.length,0);
  assert.match($('#opsCloseReview').textContent,/todavía no figuran entregados/);
  $('#opsConfirmDelivered').checked=true;
  $('#opsCloseForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.deepEqual(sent[0],{action:'close',revision:7,confirmDelivered:true});
  assert.match($('#opsBoard').textContent,/Libre/);
  assert.match($('#opsMessage').textContent,/Cuenta cerrada. Mesa libre/);
});

test('panel de mesas conserva borradores y envía la revisión mostrada al operario', async () => {
  const dom = new JSDOM('<select id="domain"><option>RES</option></select><input id="ordersEnabled" type="checkbox"><div class="metrics"></div>', { runScripts:'outside-only',url:'https://example.test' });
  const { window } = dom;
  const service = { id:'service',status:'occupied',guests:2,waiter:'Ana',note:'',openedAt:new Date(),orders:[],payments:[],audit:[] };
  let revision = 1, interval;
  const requests = [];
  window.setInterval = callback => { interval = callback; };
  window.confirm = () => true;
  window.fetch = async (url,options) => {
    if (options?.body) { requests.push({ url, body:JSON.parse(options.body) }); return { ok:false,json:async()=>({ error:'La mesa cambió. Actualizá antes de guardar.' }) }; }
    return { ok:true,json:async()=>({ features:{ manualPayments:true,kitchenBoard:true,operatorAi:true },history:[],catalog:[{id:'product',nombre:'Pasta',precio:100,disponible:true}],tables:[{ id:'table1',label:'1',revision,service,totalCents:0,paidCents:0,balanceCents:0,pending:[],legacyOrders:[] }] }) };
  };
  window.eval(fs.readFileSync(path.join(__dirname,'../static/restaurant_operations.js'),'utf8'));
  const tick = ()=>new Promise(resolve=>setTimeout(resolve,0));
  await tick();
  window.document.querySelector('[data-select-table]').click();
  const input = window.document.querySelector('[name=waiter]'); input.value='Pedro'; input.dispatchEvent(new window.Event('input',{ bubbles:true }));
  revision = 2; interval(); await tick();
  assert.equal(window.document.querySelector('[name=waiter]').value,'Pedro');
  const form = window.document.querySelector('#opsDetailsForm'); form.dispatchEvent(new window.Event('submit',{ bubbles:true,cancelable:true })); await tick();
  assert.equal(requests[0].url,'/api/resto/operations/table1?tenant=RES');
  assert.equal(requests[0].body.revision,1);
  assert.equal(requests[0].body.waiter,'Pedro');
  assert.match(window.document.querySelector('#opsMessage').textContent,/Actualizá/);
  window.document.querySelector('#opsReloadDetail').click(); await tick();
  assert.equal(window.document.querySelector('#opsDetail').dataset.revision,'2');
  window.close();
});

test('pestañas y filtros conservan borradores y abren mesas desde cocina',async t=>{
 const w=new JSDOM('<select id="domain"><option>RES</option></select><div class="metrics"></div><section data-workspace-view="qr" hidden></section>',{runScripts:'outside-only',url:'https://example.test'}).window;t.after(()=>w.close());w.setInterval=()=>{};
 w.fetch=async()=>({ok:true,json:async()=>({features:{kitchenBoard:true,operatorAi:true,manualPayments:true},history:[],catalog:[],tables:[{id:'t',label:'1',revision:1,pending:[],legacyOrders:[],totalCents:100,paidCents:0,balanceCents:100,service:{status:'occupied',guests:2,waiter:'Ana',openedAt:new Date(),orders:[{id:'o',status:'ready',items:[],totalCents:100,createdAt:new Date()}],payments:[],audit:[]}}]})});
 w.eval(fs.readFileSync(path.join(__dirname,'../static/restaurant_operations.js'),'utf8'));await new Promise(r=>setTimeout(r,0));const d=w.document;
 d.querySelector('[data-select-table]').click();const input=d.querySelector('[name=waiter]');input.value='Pedro';input.dispatchEvent(new w.Event('input',{bubbles:true}));d.querySelector('[data-view="qr"]').click();assert.equal(d.querySelector('[data-workspace-view="qr"]').hidden,false);d.querySelector('[data-view="salon"]').click();assert.equal(d.querySelector('[name=waiter]').value,'Pedro');
 d.querySelector('[data-filter="free"]').click();assert.equal(d.querySelector('#opsBoard [data-select-table]'),null);d.querySelector('[data-filter="all"]').click();d.querySelector('[data-view="kitchen"]').click();assert.equal(d.getElementById('kitchenSection').open,true);w.confirm=()=>true;d.querySelector('#opsKitchen [data-select-table]').click();assert.equal(d.getElementById('restaurantOps').dataset.view,'salon');assert.match(d.getElementById('opsDetail').textContent,/Mesa 1/);
});
