// Asisto | SQL catalog contract | 2026-10-20
const {test}=require('node:test'),assert=require('node:assert/strict');
const {managerSqlUrl,managerSqlRow,rankedManagerRows,managerSqlActionUrl}=require('../manager_sql_catalog');
const {managerDirectLookupUrl,managerCatalogSearchUrl,generalCatalogSearchQuery,normalizeQrProduct}=require('../qr_product_web');
const base='https://manager.example/v300/api/Api_Consultas_Generales/Consulta_sql?key=test&sql_id=195';
test('SQL URLs preserve authentication server-side and encode a single filter parameter',()=>{
  const u=new URL(managerDirectLookupUrl(base,'7798225228547'));assert.equal(u.searchParams.get('filtros'),'tipo:BARRA;busqueda:7798225228547');assert.equal(u.searchParams.get('sql_id'),'195');assert.equal(u.searchParams.get('key'),'test');
  assert.equal(new URL(managerCatalogSearchUrl(base,generalCatalogSearchQuery('Necesito una motosierra 52cc'))).searchParams.get('filtros'),'tipo:ALTERNATIVOS;busqueda:motosierra 52cc');
  assert.throws(()=>managerSqlUrl(base,'SKU','X;tipo:BARRA'));
});
test('SQL keeps all configured price lists rather than selecting a cheaper list',()=>{
  const raw=managerSqlRow({codigo:'SKU',descripcion:'Artículo',precio_lp1:100,precio_lp2:80,precio_lp3:70,stock:2,desc_rubro:'Herramientas'});
  for(const [field,expected]of [['Precio_Lp1',100],['Precio_Lp2',80],['Precio_Lp3',70]])assert.equal(normalizeQrProduct(raw,{fieldPrice:field,additionalPrices:[]}).price,expected);
});
test('conversational Manager searches accept legacy patterns without using the old endpoint',()=>{
  for(const [input,filter]of [['%motosierra%52cc%','tipo:ALTERNATIVOS;busqueda:motosierra 52cc'],['%codbarra:000123456','tipo:BARRA;busqueda:000123456'],['PROM-52G','tipo:SKU;busqueda:PROM-52G'],['sku:0012','tipo:SKU;busqueda:0012']])assert.equal(new URL(managerSqlActionUrl(base,input)).searchParams.get('filtros'),filter);
});
test('HTTP executor uses SQL filters but preserves legacy GET query parameters',async()=>{
  const fs=require('fs'),vm=require('vm');const source=fs.readFileSync(require.resolve('../logic'),'utf8');
  const fn=source.slice(source.indexOf('async function executeConversationalHttpApi('),source.indexOf('\nfunction extractResponsesApiText('));
  const requests=[];const box={require:()=>require('../manager_sql_catalog'),console:{log(){},warn(){}},safeStringify:JSON.stringify,axios:{request:async r=>{requests.push(r);return{status:200,data:[],headers:{}}}}};
  vm.runInNewContext(fn+'\nthis.execute=executeConversationalHttpApi;',box);
  assert.equal((await box.execute({url:base,method:'GET',query_param:'valor'},{query:'%motosierra%52cc%'})).ok,true);
  assert.equal(new URL(requests[0].url).searchParams.get('filtros'),'tipo:ALTERNATIVOS;busqueda:motosierra 52cc');assert.equal(requests[0].params,undefined);
  await box.execute({url:'https://legacy.example/products',method:'GET',query_param:'valor'},{query:'SKU-1'});
  assert.equal(requests[1].params.valor,'SKU-1');
});
test('SQL scores rank rather than imply percentage, inactive articles excluded',()=>{
  assert.deepEqual(rankedManagerRows([{codigo:'B',puntaje:58},{codigo:'X',puntaje:1000,activo:'N'},{codigo:'A',puntaje:912}]).map(x=>x.codigo),['A','B']);
});
test('direct alternatives clean text, preserve score order, exclude current and filter cheaper without AI',async()=>{
  const fs=require('fs'),vm=require('vm'),path=require('path'),{createRequire}=require('module');
  const file=path.resolve(__dirname,'../qr_product_web.js'),realRequire=createRequire(file);let calls=0;
  const box={module:{exports:{}},process,console,setTimeout,clearTimeout,Buffer,URL,require:name=>name==='./logic'?{}:name==='axios'?async options=>{calls++;assert.equal(new URL(options.url).searchParams.get('filtros'),'tipo:ALTERNATIVOS;busqueda:motosierra 52cc');return{status:200,data:[{codigo:'CURRENT',descripcion:'Motosierra 52cc',precio_lp1:100,puntaje:1000},{codigo:'BEST',descripcion:'Motosierra 52cc B',precio_lp1:90,puntaje:912},{codigo:'OTHER',descripcion:'Motosierra 52cc C',precio_lp1:80,puntaje:800},{codigo:'EXPENSIVE',descripcion:'Motosierra 52cc D',precio_lp1:200,puntaje:950}].map(row=>({...row,stock:1}))}}:realRequire(name)};
  vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nmodule.exports.searchForTest=fetchGeneralCatalogSuggestions;',box,{filename:file});
  const result=await box.module.exports.searchForTest({apiUrl:base,apiMethod:'GET',apiTimeoutMs:5000,fieldPrice:'Precio_Lp1',additionalPrices:[]},'Necesito una motosierra 52cc',{code:'CURRENT',price:100},'otra más barata');
  assert.deepEqual(Array.from(result,p=>p.code),['BEST','OTHER']);assert.equal(calls,1);
});
