// Asisto | Explicit production migration, URL via private stdin only | 2026-10-20
const fs=require('fs'),cp=require('child_process'),assert=require('node:assert/strict');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const root=fs.realpathSync('/opt/asisto/current');
assert.ok(root.includes(input.expectedCommit.slice(0,12)), 'Unexpected active release');
const requireApp=require('node:module').createRequire(root+'/package.json');
const pid=cp.execFileSync('systemctl',['show','asisto-production','-p','MainPID','--value']).toString().trim();
for(const entry of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0')){const i=entry.indexOf('=');if(i>0)process.env[entry.slice(0,i)]=entry.slice(i+1)}
requireApp('dotenv').config({path:process.env.DOTENV_CONFIG_PATH||'/etc/asisto/production.env',quiet:true});
(async()=>{
 const {getDb,closeDb}=requireApp('./db'),db=await getDb();assert.equal(db.databaseName,'Cluster0');
 const url=new URL(input.url);assert.equal(url.origin,'https://msm.mecan-sa.com.ar');assert.equal(url.pathname,'/v300/api/Api_Consultas_Generales/Consulta_sql');assert.equal(url.searchParams.get('sql_id'),'195');assert.ok(url.searchParams.get('key'));
 const helper=requireApp('./manager_sql_catalog'),web=requireApp('./qr_product_web');assert.equal(typeof helper.managerSqlActionUrl,'function');
 const settings=db.collection('settings'),original=await settings.findOne({_id:'behavior:MCN'});assert.ok(original);assert.equal(original.qr_api_method,'GET');
 const cfg=await web.loadQrConfig(db,'MCN');assert.equal(cfg.fieldPrice,'Precio_Lp1');
 const axios=requireApp('axios');const probe=await axios.get(helper.managerSqlUrl(url.href,'SKU','PROM-52G'),{timeout:15000});assert.equal(probe.status,200);const rows=typeof probe.data==='string'?JSON.parse(probe.data):probe.data;assert.equal(rows[0].codigo,'PROM-52G');assert.equal(web.normalizeQrProduct(helper.managerSqlRow(rows[0]),cfg).price,rows[0].precio_lp1);
 const snapshot={qr_api_url:original.qr_api_url,external_actions:original.external_actions};
 if(Object.hasOwn(original,'external_api_url'))snapshot.external_api_url=original.external_api_url;
 await settings.updateOne({_id:'migration:MCN:catalog-sql:20261020'},{$setOnInsert:{original:snapshot,createdAt:new Date(),codeCommit:input.expectedCommit}},{upsert:true});
 const updates={qr_api_url:url.href,external_actions:(original.external_actions||[]).map(action=>action.name==='consulta_articulos'&&/\/api\/Api_Articulos\/Consulta/i.test(action.url||'')?{...action,url:url.href,query_param:'',description:'Consultar artículos del negocio por SKU, código de barras o descripción. Usar texto de búsqueda sin frases conversacionales; sku:CODIGO para un SKU numérico, %codbarra:CODIGO para barras. Devuelve precio, stock, puntaje y motivo; puntaje no es porcentaje ni garantiza equivalencia técnica.'}:action)};
 if(/\/api\/Api_Articulos\/Consulta/i.test(original.external_api_url||''))updates.external_api_url=url.href;
 const result=await settings.updateOne({_id:'behavior:MCN',qr_api_url:original.qr_api_url,external_actions:original.external_actions},{$set:updates});assert.equal(result.matchedCount,1,'Concurrent config change');
 try {
  const after=await settings.findOne({_id:'behavior:MCN'});
  for(const [key,value]of Object.entries(original))if(key.startsWith('qr_')&&key!=='qr_api_url')assert.deepEqual(after[key],value,`Preserved ${key}`);
  assert.equal(after.external_actions.find(a=>a.name==='consulta_articulos').url,url.href);
  assert.equal((await web.loadQrConfig(db,'MCN')).fieldPrice,cfg.fieldPrice);
 }catch(error){await settings.updateOne({_id:'behavior:MCN',qr_api_url:url.href},{$set:snapshot});throw error;}
 console.log(JSON.stringify({host:cp.execFileSync('hostname').toString().trim(),db:db.databaseName,release:root,migrated:true,priceField:cfg.fieldPrice,currency:cfg.currency,backup:'settings/migration:MCN:catalog-sql:20261020',aiCalls:0}));
 await closeDb();
})().catch(error=>{console.error('MCN migration failed:',error.name);process.exitCode=1});
