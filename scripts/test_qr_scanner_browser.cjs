// Asisto | Real WebKit and Chromium scanner integration, synthetic camera only | 2026-10-16
const assert=require('node:assert/strict'),express=require('express');
const {webkit,chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pageHtml}=require('../qr_product_web'),{mountLocalScannerAssets}=require('../qr_local_scanner');
(async()=>{
 const app=express();mountLocalScannerAssets(app);app.get('/qr/MCN',(q,r)=>r.type('html').send(pageHtml({tenant:'MCN',code:'',branding:{companyName:'Mecan'}})));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const origin=process.env.SCANNER_ORIGIN||'http://127.0.0.1:'+server.address().port;
 try{
  for(const [engine,mode]of [[webkit,'worker'],[webkit,'main-thread'],[chromium,'native']]){
   const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.SCANNER_CHROMIUM_EXECUTABLE?{executablePath:process.env.SCANNER_CHROMIUM_EXECUTABLE}:{})});
   try{
    const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
    await context.addInitScript(({mode})=>{
      window.__nativeCalls=0;window.__opened=[];
      if(mode==='native')window.BarcodeDetector=class{static async getSupportedFormats(){return['ean_13']}async detect(){window.__nativeCalls++;return[{rawValue:'7791234567898'}]}};
      else {try{delete window.BarcodeDetector}catch{}Object.defineProperty(window,'BarcodeDetector',{value:undefined,configurable:true});}
      if(mode==='main-thread')window.Worker=undefined;
      Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getVideoTracks:()=>[],getTracks:()=>[]})},configurable:true});
      const draw=CanvasRenderingContext2D.prototype.drawImage;
      let fixture;
      CanvasRenderingContext2D.prototype.drawImage=function(source,...args){if(source?.id==='scanVideo')return draw.call(this,fixture,...args);return draw.call(this,source,...args)};
      document.addEventListener('DOMContentLoaded',()=>{
        fixture=document.createElement('canvas');fixture.width=357;fixture.height=150;const g=fixture.getContext('2d');g.fillStyle='white';g.fillRect(0,0,357,150);
        const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'],G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'],R=L.map(v=>[...v].map(c=>c==='1'?'0':'1').join(''));
        const v='7791234567898',p='LGLGLG',bits='101'+[...v.slice(1,7)].map((d,i)=>(p[i]==='L'?L:G)[+d]).join('')+'01010'+[...v.slice(7)].map(d=>R[+d]).join('')+'101';
        g.fillStyle='black';for(let i=0;i<bits.length;i++)if(bits[i]==='1')g.fillRect((i+12)*3,15,3,120);
        const video=document.getElementById('scanVideo');Object.defineProperty(video,'videoWidth',{value:357});Object.defineProperty(video,'videoHeight',{value:150});Object.defineProperty(video,'srcObject',{value:null,writable:true});video.play=async()=>{};
        window.openCode=code=>window.__opened.push(code);
      });
    },{mode});
    const page=await context.newPage(),requests=[],errors=[];page.on('request',r=>requests.push(r.url()));page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/qr/MCN');
    await page.locator('#scanBtn').click();
    try{await page.waitForFunction(()=>window.__opened.length>0,{},{timeout:15000})}catch(e){console.error(JSON.stringify({mode,errors,requests,status:await page.locator('#scanStatus').textContent(),opened:await page.evaluate(()=>window.__opened)}));throw e}
    assert.deepEqual(await page.evaluate(()=>window.__opened),['7791234567898']);
    assert.equal(requests.some(url=>url.includes('/api/ext/qr/photo')),false);
    if(mode==='native'){assert.equal(requests.some(url=>url.includes('zxing-0.21.3')),false);assert.ok(await page.evaluate(()=>window.__nativeCalls)>=2)}
    else assert.ok(requests.some(url=>url.includes(mode==='worker'?'worker-v1.js':'zxing-0.21.3.min.js')));
    assert.deepEqual(errors,[]);
    console.log(engine.name()+' '+mode+' REAL_BARCODE_OK NO_AI_REQUESTS');await context.close();
   }finally{await browser.close()}
  }
 }finally{await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
