const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const {queuePage}=require('../queue_pages'),{resolveDualSectors}=require('../queue_dual_display');
const sectors=['Ferretería','Herrajes','Bulonería','Servicio Técnico'].map((name,i)=>({id:['ferreteria','herrajes','buloneria','servicio'][i],name,waiting:0,next:[],current:i===1?null:{id:'t'+i,displayNumber:['F024','H012','B008','S005'][i],desk:'Mostrador '+(i+1),sellerName:'VENDEDOR',calledAt:'2026-09-29T12:00:00Z'}}));
test('dual selection preserves order, resolves names/accents and rejects invalid selections',()=>{
  assert.deepEqual(resolveDualSectors(sectors,'Herrajes,Ferretería'),['herrajes','ferreteria']);
  for(const input of ['', 'ferreteria','ferreteria,ferreteria','ferreteria,noexiste','ferreteria,herrajes,buloneria'])assert.throws(()=>resolveDualSectors(sectors,input));
  assert.throws(()=>resolveDualSectors([...sectors,{id:'auto',kind:'presence'}],'ferreteria,auto'));
});
for(const [query,kind] of [['?layout=dual&principal=ferreteria,herrajes','dual'],['?sector=ferreteria','focused'],['','all']]){
  test('display renders '+kind+' without changing other formats',async()=>{
    const dom=new JSDOM(queuePage('MCN','display'),{url:'https://example.test/ui/turnero/MCN/display'+query,runScripts:'outside-only'}),w=dom.window;
    w.AbortSignal=AbortSignal;w.setInterval=()=>0;w.fetch=async url=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>url.endsWith('/config')?{businessName:'Mecan',sectors}:{sectors}});
    for(const script of w.document.querySelectorAll('script'))w.eval(script.textContent);
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(w.document.getElementById('error').textContent,'');
    assert.equal(w.document.body.classList.contains('dualMode'),kind==='dual');
    if(kind==='dual'){
      assert.equal(w.document.querySelectorAll('.dualDisplay>.focusedPrimary').length,2);assert.equal(w.document.querySelectorAll('.dualSmall').length,2);
      assert.match(w.document.querySelectorAll('.focusedPrimary')[1].textContent,/Esperando el próximo llamado/);
      assert.match(w.document.querySelector('.dualSmallNext').textContent,/Sin turnos en espera/);
      w.eval('playCallSound=()=>{window.chimes=(window.chimes||0)+1}');
      await w.refresh();assert.equal(w.chimes,undefined);
      sectors[2].current.calledAt='2026-09-29T12:01:00Z';await w.refresh();assert.equal(w.chimes,1);await w.refresh();assert.equal(w.chimes,1);
    }else{assert.equal(w.document.querySelectorAll('.dualDisplay').length,0);assert.equal(w.document.querySelectorAll(kind==='focused'?'.focusedPrimary':'.card').length,kind==='focused'?1:4)}
    dom.window.close();
  });
}
