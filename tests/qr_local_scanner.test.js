// Asisto | Actual barcode pixels and camera lifecycle regression | 2026-10-16
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const express = require('express');
const ZXing = require('../static/qr-scanner/zxing-0.21.3.min.js');
const QRCode = require('qrcode');
const { decodeLocalBarcodeFrame, localScannerWorker, createLocalBarcodeDetector, mountLocalScannerAssets, mountQueueScannerRedirect } = require('../qr_local_scanner');
const client = require('../qr_scanner_page_client');

function barcodeImage(type, value) {
  const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  const R=L.map(v=>[...v].map(c=>c==='1'?'0':'1').join(''));
  const parity=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
  let bits='';
  if(type==='UPC_A'){type='EAN_13';value='0'+value}
  if(type==='EAN_13')bits='101'+[...value.slice(1,7)].map((d,i)=>(parity[+value[0]][i]==='L'?L:G)[+d]).join('')+'01010'+[...value.slice(7)].map(d=>R[+d]).join('')+'101';
  if(type==='EAN_8')bits='101'+[...value.slice(0,4)].map(d=>L[+d]).join('')+'01010'+[...value.slice(4)].map(d=>R[+d]).join('')+'101';
  if(type==='CODE_128'){
    const values=[104,...[...value].map(c=>c.charCodeAt(0)-32)];values.push((values[0]+values.slice(1).reduce((sum,n,i)=>sum+n*(i+1),0))%103,106);
    bits=values.map(v=>Array.from(ZXing.Code128Reader.CODE_PATTERNS[v],(width,i)=>(i%2?'0':'1').repeat(width)).join('')).join('');
  }
  const scale=3,width=(bits.length+24)*scale,height=150,rgba=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=15;y<135;y++)for(let x=0;x<bits.length*scale;x++)if(bits[Math.floor(x/scale)]==='1'){const p=(y*width+x+12*scale)*4;rgba[p]=rgba[p+1]=rgba[p+2]=0}
  return {rgba,width,height};
}
function reader(){const r=new ZXing.MultiFormatReader();const hints=new Map([[ZXing.DecodeHintType.TRY_HARDER,true]]);r.setHints(hints);return r}
function decode(image){return decodeLocalBarcodeFrame(ZXing,image.rgba,image.width,image.height,reader())}
function rotate(image){const {width,height,rgba}=image,out=new Uint8ClampedArray(rgba.length);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const from=(y*width+x)*4,to=(x*height+height-1-y)*4;out.set(rgba.subarray(from,from+4),to)}return{rgba:out,width:height,height:width}}
for(const [type,value,expected]of [['EAN_13','7791234567898'],['EAN_13','0123456789012','123456789012'],['EAN_8','96385074'],['UPC_A','036000291452'],['CODE_128','COCAT-50N-BI'],['CODE_128','0000123456']]){
  test('real pixels decode '+type+' '+value+' without AI',()=>{const result=decode(barcodeImage(type,value));assert.equal(result[0]?.rawValue,expected||value)});
}
test('rotated barcode is decoded locally',()=>{assert.equal(decode(rotate(barcodeImage('EAN_13','7791234567898')))[0]?.rawValue,'7791234567898')});
test('actual QR pixels decode the product URL and blank frames never navigate',()=>{const text='https://asistobot.com.ar/qr/MCN?codigo=COCAT-50N',m=QRCode.create(text).modules,scale=5,width=(m.size+8)*scale,rgba=new Uint8ClampedArray(width*width*4).fill(255);for(let y=0;y<m.size;y++)for(let x=0;x<m.size;x++)if(m.get(y,x))for(let j=0;j<scale;j++)for(let i=0;i<scale;i++){const p=(((y+4)*scale+j)*width+(x+4)*scale+i)*4;rgba[p]=rgba[p+1]=rgba[p+2]=0}assert.equal(decode({rgba,width,height:width})[0]?.rawValue,text);rgba.fill(255);assert.deepEqual(decode({rgba,width,height:width}),[])});
test('worker decodes transferred barcode pixels and returns no image to a server',()=>{const messages=[],scope={ZXing,Map,Int32Array,Uint8ClampedArray,self:{postMessage:x=>messages.push(x)},importScripts:url=>assert.equal(url,'/api/ext/qr/scanner-assets/zxing-0.21.3.min.js')};vm.runInNewContext(decodeLocalBarcodeFrame.toString()+';('+localScannerWorker.toString()+')()',scope);const img=barcodeImage('CODE_128','COCAT-50N');scope.self.onmessage({data:{id:12,buffer:img.rgba.buffer,width:img.width,height:img.height}});assert.equal(messages[0].ready,true);assert.equal(messages[1].results[0].rawValue,'COCAT-50N');assert.equal(messages[1].id,12)});

function camera(native){
  let clock=0,localCalls=0,nativeCalls=0,stopped=0;const raf=[],timers=[],opened=[],elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{classList:{add(){},remove(){}},textContent:'',value:'',play:async()=>{},videoWidth:1280,videoHeight:720});return elements.get(id)};
  const stream={getTracks:()=>[{stop(){stopped++}}],getVideoTracks:()=>[]};
  const scope={window:{},Date:{now:()=>clock},navigator:{mediaDevices:{getUserMedia:async()=>stream}},el:element,configureScannerTrack:async()=>{},normalizedCode:v=>String(v||'').trim(),openCode:v=>opened.push(v),requestAnimationFrame:fn=>{raf.push(fn);return raf.length},cancelAnimationFrame(){},setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout(){},createLocalBarcodeDetector:async()=>{localCalls++;return{detect:async()=>[{rawValue:'7791234567898'}],close(){}}}};
  if(native){scope.window.BarcodeDetector=scope.BarcodeDetector=class{static async getSupportedFormats(){if(native==='broken')throw Error('unavailable');return['ean_13','qr_code']}async detect(){nativeCalls++;return native==='empty'?[]:[{rawValue:'7791234567898'}]}}}
  vm.createContext(scope);vm.runInContext("let scanGeneration=0,scanFrame=0,scanLookupTimer=null,scanLocalDetector=null,scanTrack=null,torchOn=false,scanStream=null,scanCandidate='',scanHits=0,scanCandidateAt=0;"+client.stopScanner.toString()+';'+client.startScanner.toString(),scope);
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};
  return{scope,stream,opened,timers,element,stats:()=>({localCalls,nativeCalls,stopped}),start:async()=>{await scope.startScanner();await flush()},step:async ms=>{clock+=ms;const fn=raf.shift();if(fn)await fn();await flush()},flush};
}
test('Android keeps its native path without loading a local decoder or calling photo APIs',async()=>{const c=camera('native');await c.start();await c.step(100);c.timers.forEach(fn=>fn());assert.deepEqual(c.opened,['7791234567898']);assert.equal(c.stats().localCalls,0);assert.ok(c.stats().nativeCalls>=2);assert.equal(c.stats().stopped,1)});
for(const native of [null,'broken'])test('iPhone/native failure uses local frames and confirms the same code twice: '+native,async()=>{const c=camera(native);await c.start();assert.equal(c.opened.length,0);await c.step(300);c.timers.forEach(fn=>fn());assert.deepEqual(c.opened,['7791234567898']);assert.equal(c.stats().localCalls,1)});
test('Android local backup works after five seconds without resetting hits between throttled frames',async()=>{const c=camera('empty');await c.start();assert.equal(c.stats().localCalls,0);await c.step(5100);await c.step(50);await c.step(250);c.timers.forEach(fn=>fn());assert.deepEqual(c.opened,['7791234567898'])});
test('closing a pending camera prevents it reopening and stops every late stream',async()=>{const c=camera(null);let resolve;c.scope.navigator.mediaDevices.getUserMedia=()=>new Promise(r=>resolve=r);const opening=c.scope.startScanner();await c.flush();c.scope.stopScanner();resolve(c.stream);await opening;await c.flush();assert.equal(c.stats().stopped,1);assert.equal(c.stats().localCalls,0);assert.deepEqual(c.opened,[])});
test('closing during a pending decode prevents stale navigation',async()=>{const c=camera(null);let resolve;c.scope.createLocalBarcodeDetector=async()=>({detect:()=>new Promise(r=>resolve=r),close(){}});await c.start();c.scope.stopScanner();resolve([{rawValue:'7791234567898'}]);await c.flush();c.timers.forEach(fn=>fn());assert.deepEqual(c.opened,[])});

test('no-worker fallback loads only same-origin JS and closing releases a loading worker',async()=>{
 let appended,terminated=0;const canvas={getContext:()=>({}),width:0,height:0};
 const scope={window:{},document:{createElement:t=>t==='canvas'?{...canvas}:{remove(){}},head:{append:s=>appended=s}},Promise,Map,setTimeout,clearTimeout};
 vm.createContext(scope);vm.runInContext(createLocalBarcodeDetector.toString(),scope);const d=await scope.createLocalBarcodeDetector();assert.equal(appended.src,'/api/ext/qr/scanner-assets/zxing-0.21.3.min.js');scope.window.ZXing={DecodeHintType:{},BarcodeFormat:{},MultiFormatReader:class{setHints(){}reset(){}}};appended.onload();await d.ready;d.close();assert.equal((await d.detect({videoWidth:10,videoHeight:10})).length,0);
 scope.Worker=class{terminate(){terminated++}};const w=await scope.createLocalBarcodeDetector();w.close();await w.ready;assert.equal(terminated,1);
});
test('scanner assets are self-hosted and intranet redirect preserves product code without touching operator routes',async()=>{const app=express();mountQueueScannerRedirect(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{const root='http://127.0.0.1:'+server.address().port;for(const file of ['worker-v1.js','zxing-0.21.3.min.js']){const r=await fetch(root+'/api/ext/qr/scanner-assets/'+file);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/javascript/);assert.match(r.headers.get('cache-control'),/max-age/)}assert.equal((await fetch(root+'/api/ext/qr/scanner-assets/unknown')).status,404);const r=await fetch(root+'/qr/MCN?scan=1&codigo=00123',{redirect:'manual'});assert.equal(r.status,302);const target=new URL(r.headers.get('location'));assert.equal(target.origin,'https://asistobot.com.ar');assert.equal(target.searchParams.get('codigo'),'00123');assert.equal(target.searchParams.get('scan'),'1');assert.equal((await fetch(root+'/ui/turnero/MCN',{redirect:'manual'})).status,404)}finally{await new Promise(r=>server.close(r))}});
