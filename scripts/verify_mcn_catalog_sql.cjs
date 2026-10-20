// Asisto | Post-deploy probes; no AI, idempotent existing monetization event | 2026-10-20
const fs=require('fs'),cp=require('child_process'),vm=require('vm'),assert=require('node:assert/strict');
const root=fs.realpathSync('/opt/asisto/current'),req=require('node:module').createRequire(root+'/package.json');
const pid=cp.execFileSync('systemctl',['show','asisto-production','-p','MainPID','--value']).toString().trim();
for(const item of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0')){const i=item.indexOf('=');if(i>0)process.env[item.slice(0,i)]=item.slice(i+1)}
req('dotenv').config({path:process.env.DOTENV_CONFIG_PATH||'/etc/asisto/production.env',quiet:true});
(async()=>{
 const {getDb,closeDb}=req('./db');try{
  const db=await getDb();assert.equal(db.databaseName,'Cluster0');
  const cfg=await req('./qr_product_web').loadQrConfig(db,'MCN');assert.ok(req('./manager_sql_catalog').isManagerSql(cfg.apiUrl));assert.equal(cfg.fieldPrice,'Precio_Lp1');
  const events=db.collection('monetization_events'),event=await events.findOne({tenantId:'MCN',eventKey:{$in:['catalog.qr_read','catalog.code_lookup']}});assert.ok(event);
  const original=JSON.stringify(event),results=[];
  for(const[code,status]of [['PROM-52G',200],['7798225228547',200],['ASISTO-NOEXISTE-20261020',404],['886661822775',409]]){
   const url=new URL('https://asistobot.com.ar/api/ext/qr/product');url.searchParams.set('tenant','MCN');url.searchParams.set('codigo',code);url.searchParams.set('via',event.eventKey==='catalog.qr_read'?'qr':'sku');url.searchParams.set('eventId',event.sourceId);
   const start=Date.now(),response=await fetch(url),body=await response.json();assert.equal(response.status,status);
   if(status===200){assert.equal(body.product.code,'PROM-52G');assert.equal(body.product.price,101519);}
   results.push({code,status,ms:Date.now()-start,price:body.product?.price});
  }
  assert.equal(JSON.stringify(await events.findOne({_id:event._id})),original);
  const setting=await db.collection('settings').findOne({_id:'behavior:MCN'}),action=setting.external_actions.find(x=>x.name==='consulta_articulos');assert.ok(req('./manager_sql_catalog').isManagerSql(action.url));
  const logic=fs.readFileSync(root+'/logic.js','utf8'),fn=logic.slice(logic.indexOf('async function executeConversationalHttpApi('),logic.indexOf('\nfunction extractResponsesApiText('));
  const box={require:req,axios:req('axios'),safeStringify:JSON.stringify,console:{log(){},warn(){}}};vm.runInNewContext(fn+'\nthis.execute=executeConversationalHttpApi;',box);
  const tool=await box.execute(action,{query:'%motosierra%52cc%'});assert.equal(tool.ok,true);const rows=JSON.parse(tool.body);assert.equal(rows[0].codigo,'PROM-52G');
  console.log(JSON.stringify({host:cp.execFileSync('hostname').toString().trim(),db:db.databaseName,release:root,priceField:cfg.fieldPrice,currency:cfg.currency,results,articleActionStatus:tool.status,articleActionRows:rows.length,reusedEventUnchanged:true,aiCalls:0}));
 }finally{await closeDb();}
})().catch(error=>{console.error('MCN verification failed:',error.name,error.message.replace(/https?:\/\/\S+/g,'[URL]'));process.exitCode=1});
