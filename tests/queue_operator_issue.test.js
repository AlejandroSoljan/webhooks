const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {setupOperatorIssue}=require('../queue_operator_issue');
const {queuePage}=require('../queue_pages');
for(const failure of [false,true])test('queue action keeps New ticket independent and unlocks controls; failure='+failure,async()=>{
  const dom=new JSDOM('<button id="newTicket">Nuevo turno</button><button id="sound" disabled>Sonido</button><dialog><button id="confirm" disabled>Emitir</button></dialog><input id="desk" value="1"><div id="cards"><button id="finish">Finalizar</button><button id="emptyNext" disabled>Llamar siguiente</button></div>',{runScripts:'outside-only'}),w=dom.window;
  w.MODE='admin';w.busy=false;w.ADMIN='/admin';w.$=id=>w.document.getElementById(id);w.error=()=>{};w.refresh=async()=>{};
  const html=queuePage('MCN','admin');w.eval(html.match(/^function setBusy\(value\).*$/m)[0]);w.eval(html.match(/^async function act\(s,action,destination,sellerId\).*$/m)[0]);
  let release;w.request=()=>new Promise((resolve,reject)=>{release=()=>failure?reject(Error('network')):resolve({})});
  const action=w.act({id:'fer',current:{id:'t1'}},'finish');
  assert.equal(w.$('finish').disabled,true);assert.equal(w.$('newTicket').disabled,false);assert.equal(w.$('confirm').disabled,true);assert.equal(w.$('sound').disabled,true);
  release();await action;
  assert.equal(w.$('finish').disabled,false);assert.equal(w.$('emptyNext').disabled,true);assert.equal(w.$('newTicket').disabled,false);assert.equal(w.busy,false);dom.window.close();
});
test('operator issues independently and retries the same ticket after printer failure',async()=>{
  const dom=new JSDOM('<div id="content"><div id="cards">Existing active tickets</div></div>',{runScripts:'outside-only',url:'https://example.test'}),w=dom.window,calls=[];
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
  w.cfg={sectors:[{id:'fer',name:'Ferretería'},{id:'auto',name:'Autoservicio',kind:'presence'}]};w.API='/api/customer-app/TEST';w.ADMIN='/api/customer-app-admin/TEST';w.$=id=>w.document.getElementById(id);
  w.element=(tag,text,cls)=>{const e=w.document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e};w.button=(label,fn,cls)=>{const e=w.element('button',label,cls);e.onclick=fn;return e};
  w.request=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {id:'t1',displayNumber:'F001',sectorName:'Ferretería',createdAt:new Date().toISOString(),claimUrl:'https://example.test/qr'}};
  let attempts=0;w.fetch=async()=>({ok:++attempts>1});w.refresh=()=>{};
  Object.defineProperty(w.crypto,'randomUUID',{value:undefined}); // HTTP LAN does not expose randomUUID.
  w.eval('('+setupOperatorIssue.toString()+')()');
  w.document.querySelector('.operatorNewTicket').click();const select=w.$('operatorIssueSection');assert.equal(select.options.length,2);select.value='fer';select.dispatchEvent(new w.Event('change'));
  const submit=[...w.document.querySelectorAll('button')].find(e=>e.textContent==='Emitir e imprimir');await submit.onclick();
  assert.match(w.document.querySelector('[role="status"]').textContent,/reintentar sin generar otro/);assert.equal(submit.textContent,'Reintentar impresión');await submit.onclick();
  assert.equal(calls.filter(c=>c.url===w.API+'/tickets').length,1);assert.equal(calls[1].body.printRequestId,calls[2].body.printRequestId);assert.equal(calls.some(c=>/sectors/.test(c.url)),false);assert.equal(w.$('cards').textContent,'Existing active tickets');assert.equal(submit.hidden,true);dom.window.close();
});
