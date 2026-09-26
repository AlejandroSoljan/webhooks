const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {setupOperatorIssue}=require('../queue_operator_issue');
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
