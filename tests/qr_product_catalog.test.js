// Asisto | Version: 5.00.080 | Fecha: 2026-09-10
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('module');
const path = require('path');
const { fixture } = require('./catalog_fixture');
const { managerDirectLookupUrl, managerCatalogSearchUrl, generalCatalogSearchQuery, isGeneralCatalogQuery, pageHtml } = require('../qr_product_web');

test('la consulta general abre un chat sin mencionar la marca en el título', () => {
  const html = pageHtml({ tenant: 'MCN', code: 'CONSULTA_GENERAL', branding: { companyName: 'Mecan' } });
  assert.match(html, /Encontralo al instante/);
  assert.doesNotMatch(html, />Consultas<\/a>/);
  assert.match(html, /GENERAL_CHAT=true/);
  new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
});

test('un producto escaneado conserva su chat contextual sin mostrar el acceso al chat general', () => {
  const html = pageHtml({ tenant: 'MCN', code: 'SKU-1', branding: { companyName: 'Mecan' }, aiEnabled: true });
  assert.match(html, /id="moreBtn"/);
  assert.match(html, /Mostrar más info/);
  assert.doesNotMatch(html, />Consultas<\/a>/);
  assert.match(html, />Mi turno<\/a>/);
  assert.doesNotMatch(html, /\.appNav a:last-child\{display:none\}/);
});
test('Mostrar más info oculta errores técnicos, libera controles y no repite llamadas de IA',async()=>{
 const script=pageHtml({tenant:'MCN',code:'SKU'}).match(/<script>([\s\S]*)<\/script>/)[1];
 const fn=script.slice(script.indexOf('async function callAi('),script.indexOf('async function startAi('));
 let calls=0;const messages=[],button={disabled:false};
 const box={sending:false,started:false,TENANT:'MCN',PRODUCT:null,CODE:'SKU',sessionId:()=> 'test',el:()=>button,addMsg:(role,text)=>messages.push(text),removeTyping(){},jsonFetch:async()=>{calls++;throw Error('The origin web server returned an invalid response to Cloudflare')}};
 vm.runInNewContext(fn+'\nthis.call=callAi;',box);await box.call('',true);
 assert.equal(calls,1);assert.equal(box.sending,false);assert.equal(box.started,false);assert.equal(button.disabled,false);assert.match(messages.at(-1),/volvé a tocar/);assert.doesNotMatch(messages.at(-1),/Cloudflare|origin|HTTP/);
});

test('la ficha de Mecan muestra las acciones rediseñadas y evita mostrar datos de ejemplo', () => {
  const html = pageHtml({ tenant: 'MCN', code: 'SKU-1', branding: { companyName: 'Mecan' }, aiEnabled: true });
  assert.match(html, /Más info/);
  assert.match(html, /Opciones alternativas/);
  assert.match(html, /Escanear otro producto/);
  assert.match(html, /\.mcnTileIcon svg\{[^}]*stroke:#e00000!important/);
  assert.match(html, /\.mcnTile\{min-height:94px/);
  assert.match(html, /\.mcnScan\{min-height:50px/);
  assert.match(html, /mcnAltWrap/);
  assert.match(html, /#e00000/);
  assert.doesNotMatch(html, /DEMO-100245|\$ 32\.490/);
  const otherTenant = pageHtml({ tenant: 'A', code: 'SKU-1', branding: {} });
  assert.doesNotMatch(otherTenant, /<body class="mcnPage">|<section class="mcnAltWrap"/);
});

test('iPhone y navegadores internos usan lectura asistida si falta BarcodeDetector', () => {
  const html = pageHtml({ tenant: 'MCN', code: '', branding: { companyName: 'Mecan' } });
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  new vm.Script(script);
  assert.match(script, /createLocalBarcodeDetector/);
  assert.match(script, /new Worker\(assetBase \+ 'worker-v1.js'\)/);
  assert.doesNotMatch(script, /tryPrintedBarcode|scanOcr|scanFallbackTimer/);
  assert.match(script, /async function identifyPhoto/);
  assert.doesNotMatch(script, /Este navegador no admite lectura automática/);
});

test('Manager consulta directamente código de barras sin descargar el catálogo', () => {
  const url = new URL(managerDirectLookupUrl('https://manager.example/v300/api/Api_Articulos/Consulta?key=x&campo=ID&valor=*', '236100016'));
  assert.equal(url.searchParams.get('campo'), 'OTRO');
  assert.equal(url.searchParams.get('valor'), '%codbarra:236100016');
});

test('Manager conserva consulta puntual por código interno', () => {
  const url = new URL(managerDirectLookupUrl('https://manager.example/v300/api/Api_Articulos/Consulta?key=x', 'BP-MAR0475'));
  assert.equal(url.searchParams.get('campo'), 'ID');
  assert.equal(url.searchParams.get('valor'), 'BP-MAR0475');
});

test('Manager acepta SKU en minúsculas y lo consulta normalizado', () => {
  const url = new URL(managerDirectLookupUrl('https://manager.example/v300/api/Api_Articulos/Consulta?key=x', 'bp-mar0475'));
  assert.equal(url.searchParams.get('campo'), 'ID');
  assert.equal(url.searchParams.get('valor'), 'BP-MAR0475');
});

test('la búsqueda general usa descripción flexible y normaliza preguntas y plurales', () => {
  assert.equal(generalCatalogSearchQuery('¿Tenés motosierras?'), 'motosierra');
  assert.equal(generalCatalogSearchQuery('Mostrame taladros percutores Bosch'), 'taladro%percutor%bosch');
  const url = new URL(managerCatalogSearchUrl('https://manager.example/v300/api/Api_Articulos/Consulta?key=x', generalCatalogSearchQuery('¿Tenés motosierras?')));
  assert.equal(url.searchParams.get('campo'), 'OTRO');
  assert.equal(url.searchParams.get('valor'), '%motosierra%');
  assert.equal(isGeneralCatalogQuery('¿Tenés motosierras?'), true);
});
function load(api, overrides = {}) {
  const f = fixture(), routes = new Map();
  const config = { qr_enabled: true, qr_api_url: 'https://example.invalid/products', qr_api_method: 'POST', ...overrides };
  const db = { collection: name => name === 'settings' ? { findOne: async () => config } : f.col };
  const file = path.resolve(__dirname, '../qr_product_web.js'), realRequire = createRequire(file);
  const sandbox = { module: { exports: {} }, process, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setImmediate() {}, Buffer, URL,
    require: name => name === './product_insights' ? {trackLookup(){}} : name === './logic' ? {} : name === './db' ? { getDb: async () => db } : name === './monetization_engine' ? { recordMonetizationEvent: async () => ({ recorded: true }) } : name === 'axios' ? api : realRequire(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  sandbox.module.exports.mountQrProductWeb({ get: (route, handler) => routes.set(route, handler), post() {} });
  async function request(code) {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await routes.get('/api/ext/qr/product')({ query: { tenant: 'A', codigo: code } }, res);
    return res;
  }
  return { ...f, request, config, routes };
}
const sqlConfig = { qr_api_url: 'https://manager.example/v300/api/Api_Consultas_Generales/Consulta_sql?key=test&sql_id=195', qr_api_method: 'GET' };
test('SQL conserva LP1, mapea campos y la caché sirve barras sin otra consulta', async () => {
  let calls = 0;
  const f = load(async options => {
    calls++; assert.equal(new URL(options.url).searchParams.get('filtros'), 'tipo:SKU;busqueda:PROM-52G');
    assert.equal(options.params, undefined);
    return { status: 200, data: [{ codigo:'PROM-52G', codbarra:'7798225228547', descripcion:'Motosierra', precio_lp1:101519, precio_lp2:90000, stock:1, activo:'S', puntaje:1000 }] };
  }, sqlConfig);
  const first = await f.request('PROM-52G'); assert.equal(first.body.product.price, 101519);
  assert.equal((await f.request('7798225228547')).body.product.price, 101519); assert.equal(calls,1);
  f.config.qr_field_price = 'Precio_Lp2';
  assert.equal((await f.request('PROM-52G')).body.product.price,90000);
});
test('SQL no elige arbitrariamente entre dos artículos del mismo código de barras', async () => {
  const f=load(async options=>{assert.equal(new URL(options.url).searchParams.get('filtros'),'tipo:BARRA;busqueda:886661822775');return {status:200,data:['MS194T/35','MS194T/40'].map(codigo=>({codigo,codbarra:'886661822775',descripcion:'Motosierra',precio_lp1:10}))}},sqlConfig);
  assert.equal((await f.request('886661822775')).statusCode,409);
});
test('SQL numérico sin coincidencia BARRA reintenta SKU preservando ceros', async()=>{
  const types=[];const f=load(async options=>{const filter=new URL(options.url).searchParams.get('filtros');types.push(filter);return {status:200,data:types.length===1?[]:[{codigo:'000123456',descripcion:'SKU numérico',precio_lp1:20,stock:1}]}},sqlConfig);
  assert.equal((await f.request('000123456')).body.product.price,20);
  assert.deepEqual(types,['tipo:BARRA;busqueda:000123456','tipo:SKU;busqueda:000123456']);
});
test('SQL vacío no inventa artículos ni precios', async()=>{
  const f=load(async()=>({status:200,data:[]}),sqlConfig);
  const response=await f.request('NO-EXISTE');assert.equal(response.statusCode,404);assert.equal(response.body.error,'product_unavailable');assert.match(response.body.detail,/sin stock o no disponible/);
});
test('SQL no muestra precio de un artículo sin stock y devuelve un aviso claro',async()=>{
 const f=load(async()=>({status:200,data:[{codigo:'5140062-86',codbarra:'420200103',descripcion:'Mordaza',precio_lp1:3199,stock:0,activo:'S'}]}),sqlConfig);
 const response=await f.request('420200103');assert.equal(response.statusCode,404);assert.equal(response.body.error,'product_unavailable');assert.match(response.body.detail,/sin stock o no disponible/);assert.equal(response.body.product,undefined);
});
test('SQL JSON textual se procesa aunque Axios no haya transformado la respuesta',async()=>{
 const f=load(async()=>({status:200,data:JSON.stringify([{codigo:'PROM-52G',descripcion:'Motosierra',precio_lp1:101519,puntaje:1000,stock:1}])}),sqlConfig);
 assert.equal((await f.request('PROM-52G')).body.product.price,101519);
});
test('POST funciona y el siguiente escaneo de barras usa MongoDB', async () => {
  let calls = 0;
  const f = load(async options => { calls++; assert.equal(options.data.codigo, '0012'); return { status: 200, data: { product: { Codigo: '0012', Codbarra: '000123', Descripcion: 'Producto', Precio_Lp1: 12 } } }; });
  const first = await f.request('0012'); assert.equal(first.statusCode, 200);
  const second = await f.request('000123'); assert.equal(second.statusCode, 200);
  assert.equal(calls, 1); assert.equal(f.rows.length, 1);
});
test('no acepta otro artículo de una respuesta múltiple', async () => {
  const f = load(async () => ({ status: 200, data: [{ Codigo: 'OTHER', Descripcion: 'Otro' }] }));
  assert.equal((await f.request('0012')).statusCode, 404); assert.equal(f.rows.length, 0);
});
test('404 externo no se convierte en caída de API', async () => {
  const f = load(async () => ({ status: 404, data: {} }));
  for (let i = 0; i < 6; i++) assert.equal((await f.request('missing')).statusCode, 404);
});
test('desactivar QR impide leer incluso un producto guardado', async () => {
  const f = load(async () => ({ status: 200, data: { Codigo: '1', Descripcion: 'Uno' } }));
  assert.equal((await f.request('1')).statusCode, 200);
  f.config.qr_enabled = false;
  assert.equal((await f.request('1')).statusCode, 404);
});
test('100 faltantes distintos respetan el máximo de 10 llamadas externas', async () => {
  let active = 0, peak = 0, calls = 0;
  const f = load(async options => {
    active++; calls++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { status: 200, data: { Codigo: options.data.codigo, Descripcion: 'Producto' } };
  });
  const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => f.request(String(i))));
  assert.equal(calls, 100); assert.ok(peak <= 10); assert.ok(responses.every(res => res.statusCode === 200));
});
test('cambio de campo de precio se aplica a los datos locales', async () => {
  let calls = 0;
  const f = load(async () => { calls++; return { status: 200, data: { Codigo: '1', Descripcion: 'Uno', Precio_Lp1: 10, Mayorista: 8 } }; });
  await f.request('1'); f.config.qr_field_price = 'Mayorista';
  const response = await f.request('1');
  assert.equal(response.body.product.price, 8); assert.equal(calls, 1);
});
test('la API tampoco puede resolver barras duplicadas arbitrariamente', async () => {
  const f = load(async () => ({ status: 200, data: [
    { Codigo: '1', Codbarra: '123', Descripcion: 'Uno' },
    { Codigo: '2', Codbarra: '123', Descripcion: 'Dos' },
  ] }));
  assert.equal((await f.request('123')).statusCode, 409); assert.equal(f.rows.length, 0);
});

test('las opciones alternativas usan el catálogo, excluyen el producto actual y limitan a cinco', async () => {
  const rows = [
    { Codigo: '001', Descripcion: 'Látex blanco 4 L', Marca: 'Marca actual', Precio_Lp1: 300 },
    ...Array.from({ length: 7 }, (_, i) => ({ Codigo: `ALT-${i}`, Descripcion: 'Látex blanco 4 L', Marca: `Marca ${i}`, Precio_Lp1: 250 - i })),
  ];
  const f = load(async options => {
    const url = new URL(options.url);
    if (url.searchParams.get('campo') === 'ID') return { status: 200, data: rows[0] };
    return { status: 200, data: rows };
  });
  f.config.qr_api_method = 'GET';
  f.config.qr_api_url = 'https://manager.example/v300/api/Api_Articulos/Consulta?key=x';
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await f.routes.get('/api/ext/qr/alternatives')({ query: { tenant: 'A', codigo: '001' }, headers: {}, socket: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alternatives.length, 5);
  assert.ok(res.body.alternatives.every(item => item.code !== '001' && item.price !== null));
});
