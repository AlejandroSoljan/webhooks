// Asisto | Public HTML regression, mocked price/chat only; no commercial or AI calls | 2026-10-20
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.SCANNER_CHROMIUM_EXECUTABLE?{executablePath:process.env.SCANNER_CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});let calls=0;
  await page.route('**/api/ext/qr/product?**',r=>r.fulfill({json:{ok:true,tenant:'MCN',currency:'ARS',aiEnabled:true,product:{code:'PROM-52G',description:'Motosierra de prueba',price:101519,available:true,prices:[{field:'Precio_Lp1',label:'Precio',value:101519,primary:true}]}}}));
  await page.route('**/api/ext/qr/chat/messages?**',r=>r.fulfill({json:{ok:true,items:[]}}));
  await page.route('**/api/ext/qr/chat',r=>{calls++;return r.fulfill({status:520,contentType:'text/html',body:'The origin web server returned an invalid or incomplete response to Cloudflare.'})});
  await page.goto((process.env.SCANNER_ORIGIN||'https://asistobot.com.ar')+'/qr/MCN?codigo=PROM-52G');
  await page.locator('#moreBtn').click();
  await page.getByText('El asistente no está disponible por un momento.',{exact:false}).waitFor();
  assert.equal(calls,1);assert.equal(await page.locator('#sendBtn').isEnabled(),true);assert.equal(await page.locator('#moreBtn').isEnabled(),true);
  const chat=await page.locator('#chat').innerText();assert.doesNotMatch(chat,/Cloudflare|origin web server|HTTP 520/);
  console.log('PUBLIC_HTML_FRIENDLY_ERROR_OK ONE_POST CONTROLS_ENABLED NO_AI');
 }finally{await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
