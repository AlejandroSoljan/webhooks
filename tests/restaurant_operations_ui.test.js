// Asisto | Version: 5.00.160 | Fecha: 2026-09-18
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

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
