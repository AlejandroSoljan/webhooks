// Asisto | Browser QA against controlled summaries; no production writes or AI | 2026-10-21
const express=require('express'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {statsPage}=require('../queue_stats_page'),{summarizeProductInsights}=require('../product_insights');
(async()=>{
 const app=express();app.get('/stats',(_q,r)=>r.type('html').send(statsPage('MCN','2026-10-21',{tenants:['MCN','OTHER'],isSuper:true})));
 app.get('/api/customer-app-admin/:tenant/stats',(_q,r)=>r.json({summary:{issued:3,finished:1,waiting:1,skipped:0,qr:2,mobile:0,printed:1,otherOrigin:0,waitSamples:1,serviceSamples:1},sectors:[],days:[],hours:Array.from({length:24},(_,hour)=>({hour,issued:0})),sellers:[],tickets:[]}));
 const insight=summarizeProductInsights({from:'2026-10-21',to:'2026-10-21',trackingSince:new Date('2026-10-21T10:00Z'),current:{totals:[{_id:'available',count:16,camera:12},{_id:'unavailable',count:4,camera:3}],products:[{_id:'SKU-1',description:'Motosierra Einhell',count:9},{_id:'SKU-2',description:'Taladro percutor',count:7}]},chats:{topics:[{_id:'alternatives',count:5},{_id:'price_stock',count:2},{_id:'info',count:8}],products:[{_id:'SKU-1',description:'Motosierra Einhell',questions:5}]}});
 app.get('/api/customer-app-admin/:tenant/product-stats',(q,r)=>r.json({...insight,from:q.query.from,to:q.query.to}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.SCANNER_CHROMIUM_EXECUTABLE?{executablePath:process.env.SCANNER_CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port+'/stats');
  await page.getByText('Ofrecer opciones comparables con stock',{exact:false}).waitFor();
  assert.equal(await page.locator('#issued').textContent(),'3');assert.match(await page.locator('#commercialContent').innerText(),/sin stock o sin un código/);
  fs.mkdirSync('output/test-runtime',{recursive:true});await page.locator('.commercialPanel').screenshot({path:'output/test-runtime/product-insights-desktop.png'});
  await page.locator('#period').selectOption('7');await page.locator('.commercialMethod').filter({hasText:'Período '}).waitFor();
  await page.route('**/product-stats?**',r=>r.fulfill({status:503,contentType:'text/html',body:'PRIVATE TECHNICAL ERROR'}));
  await page.getByRole('button',{name:'Actualizar',exact:true}).click();await page.getByText('No se pudo consultar el análisis comercial.',{exact:false}).waitFor();assert.equal(await page.locator('#issued').textContent(),'3');assert.doesNotMatch(await page.locator('#commercialContent').innerText(),/PRIVATE|Unexpected token/);
  await page.unroute('**/product-stats?**');await page.route('**/product-stats?**',r=>r.fulfill({json:{...insight,topProducts:[{code:'X',description:'<img src=x onerror=alert(1)>',views:1,questions:0}]}}));
  await page.getByRole('button',{name:'Actualizar',exact:true}).click();await page.getByText('<img src=x onerror=alert(1)>',{exact:true}).waitFor();assert.equal(await page.locator('.commercialPanel img').count(),0);
  await page.unroute('**/product-stats?**');await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Actualizar',exact:true}).click();await page.getByText('Ofrecer opciones comparables con stock',{exact:false}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('.commercialPanel').screenshot({path:'output/test-runtime/product-insights-mobile.png'});assert.deepEqual(errors,[]);
  console.log('PRODUCT_INSIGHTS_BROWSER_OK desktop/mobile, shared filters, safe DOM, outage isolation, queue preserved');
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
