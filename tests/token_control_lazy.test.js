// Asisto | Version: 5.00.245 | Fecha: 2026-09-25
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { renderTokenControlPage } = require('../token_control_stats');

const tick = () => new Promise(resolve => setTimeout(resolve, 25));

test('control de consumos carga totales primero y detalles sólo al pedirlos', async () => {
  const dom = new JSDOM(renderTokenControlPage({ role: 'superadmin', tenantId: 'CARICO' }, ['RVL', 'MCN', 'CARICO']), { url: 'https://asistobot.com.ar/admin/token-control', runScripts: 'outside-only' });
  try {
    const calls = [];
    dom.window.fetch = async url => {
      calls.push(String(url));
      const body = String(url).includes('/api/token-control/summary')
        ? { ok: true, items: [{ tenantId:'MSM',company:'Asisto Manager',total_tokens:100,events:2,billed_cost:2,real_cost:1,gross_margin:1,billing_configured:true,channels:['help_api'],usage_types:['ayuda_consulta'] }], totals: { total_tokens:100,billed_cost:2,real_cost:1,gross_margin:1 } }
        : String(url).includes('/api/monetization/summary')
          ? { ok:true,items:[{tenantId:'MSM',eventKey:'catalog.code_lookup',name:'Lectura por código',group:'catalog',unit:'consulta',quantity:3,currency:'ARS',billedAmount:60},{tenantId:'MSM',eventKey:'whatsapp.api_sent',name:'Mensaje enviado por API',group:'whatsapp',unit:'mensaje',quantity:1,currency:'ARS',potentialAmount:20,billedAmount:20}],byDomain:[{tenantId:'MSM',operations:4,billedAmount:{ARS:80}}],byType:[],totals:{byCurrency:{ARS:{billedAmount:80}}} }
        : String(url).includes('/conversations')
          ? { ok: true, items: [], totals: {} }
          : { ok: true, enabled: true, items: [], realItems: [], byTenant: [{tenantId:'MSM',windows:1,messages:2,realMessages:2,byCurrency:{ARS:20}}], totals: {byCurrency:{ARS:20}} };
      return { ok: true, json: async () => body };
    };
    const script = [...dom.window.document.scripts].pop().textContent;
    dom.window.eval(script);
    await tick();
    assert.equal(calls.length, 3);
    assert.ok(calls.some(url => url.includes('/summary')));
    assert.ok(calls.some(url => url.includes('/api/monetization/summary')));
    assert.ok(calls.some(url => url.includes('/api-message-windows') && url.includes('details=0')));
    assert.ok(!calls.some(url => url.includes('/api-message-windows') && !url.includes('details=0')));
    assert.ok(!calls.some(url => url.includes('/conversations')));
    assert.deepEqual([...dom.window.document.getElementById('fTenant').options].map(option => option.value), ['', 'CARICO', 'MCN', 'RVL']);
    assert.equal(dom.window.document.getElementById('conversationDetailCard').hidden, true);
    assert.equal(dom.window.document.getElementById('apiMessagesCard').hidden, true);
    assert.match(dom.window.document.body.textContent, /Qué se cobrará por dominio/);
    assert.match(dom.window.document.body.textContent, /Detalle técnico/);
    assert.match(dom.window.document.getElementById('rows').textContent, /Ayuda de Manager/);
    assert.match(dom.window.document.getElementById('rows').textContent, /Lectura por código/);
    assert.match(dom.window.document.getElementById('rows').textContent, /Mensajes enviados por API/);
    assert.doesNotMatch(dom.window.document.getElementById('rows').textContent, /ventanas facturables/);
    const technicalButton=dom.window.document.querySelector('.technicalToggle');
    const technicalRow=dom.window.document.getElementById(technicalButton.dataset.target);
    assert.equal(technicalRow.hidden,true);
    technicalButton.click();
    assert.equal(technicalRow.hidden,false);

    dom.window.document.getElementById('btnLoadConversations').click();
    await tick();
    assert.equal(calls.filter(url => url.includes('/conversations')).length, 1);
    assert.equal(dom.window.document.getElementById('conversationDetailCard').hidden, false);

    dom.window.document.getElementById('btnLoadMessages').click();
    await tick();
    assert.equal(calls.filter(url => url.includes('/api-message-windows')).length, 2);
    assert.ok(calls.some(url => url.includes('/api-message-windows') && !url.includes('details=0')));
    assert.equal(dom.window.document.getElementById('apiMessagesCard').hidden, false);
  } finally { dom.window.close(); }
});
