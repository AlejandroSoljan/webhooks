// Asisto | Version: 5.00.157 | Fecha: 2026-09-18
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('el panel superadmin elige RES y cambia todas sus consultas de dominio', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'restaurant_panel.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'static', 'restaurant_panel.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://asistobot.com.ar/admin/resto', runScripts: 'outside-only' });
  const calls = [];
  dom.window.fetch = async url => {
    calls.push(url);
    let body;
    if (url === '/api/resto/domains') body = { isSuper: true, domains: [{ id:'OTRO', enabled:false }, { id:'RES', enabled:true }] };
    else if (url.startsWith('/api/resto/summary')) body = { enabled:true, menuCount:19, tableCount:10 };
    else if (url.startsWith('/api/resto/events')) body = { events:[] };
    else if (url.startsWith('/api/resto/tables')) body = { tables:url.includes('tenant=RES') ? [{ id:'507f1f77bcf86cd799439011', label:'1', active:true, url:'https://asistobot.com.ar/resto/RES/token' }] : [] };
    else throw new Error(url);
    return { ok:true, json:async()=>body };
  };
  try {
    dom.window.eval(script);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(dom.window.document.getElementById('domain').value, 'RES');
    assert.equal(dom.window.document.getElementById('menuCount').textContent, '19');
    assert.equal(dom.window.document.querySelectorAll('.table').length, 1);
    const selector = dom.window.document.getElementById('domain');
    selector.value = 'OTRO';
    selector.dispatchEvent(new dom.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(calls.includes('/api/resto/summary?tenant=OTRO'));
    assert.equal(dom.window.document.querySelectorAll('.table').length, 0);
  } finally { dom.window.close(); }
});
