// Browser initializer, injected only into the operator page.
function setupOperatorIssue() {
  const style=element('style');style.textContent='.operatorNewTicket{align-self:flex-end;margin:12px 0;min-height:46px;padding:12px 20px;background:#e00000!important;color:#fff;border-radius:10px}#operatorIssueDialog{width:min(560px,92vw);text-align:left;max-height:90vh;overflow:auto}#operatorIssueDialog select{width:100%}#operatorIssueDialog [role="status"]{overflow-wrap:anywhere}#operatorIssueDialog button[hidden]{display:none!important}';document.head.append(style);
  let ticket=null, issueId=null, printId=null, running=false, printed=false;
  const requestId=()=>typeof globalThis.crypto?.randomUUID==='function'?globalThis.crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);
  const dialog=element('dialog',undefined,'sellerDialog'),title=element('h2','Nuevo turno'),description=element('p','Elegí la sección y emití un ticket impreso. Los turnos en atención no se modifican.'),label=element('label','Sección'),select=element('select'),status=element('p'),actions=element('div',undefined,'sellerDialogActions');
  dialog.id='operatorIssueDialog';title.id='operatorIssueTitle';dialog.setAttribute('aria-labelledby',title.id);select.id='operatorIssueSection';label.htmlFor=select.id;status.setAttribute('role','status');
  select.append(new Option('Elegí una sección',''));
  cfg.sectors.filter(s=>s.kind!=='presence').forEach(s=>select.append(new Option(s.name,s.id)));
  const close=button('Cerrar',()=>dialog.close(),'secondary'),submit=button('Emitir e imprimir',emit),again=button('Emitir otro turno',()=>{ticket=null;issueId=null;printId=null;printed=false;status.textContent='';select.value='';update()});
  function update(){select.disabled=running||!!issueId;close.disabled=running;submit.disabled=running||!select.value;submit.hidden=printed;again.hidden=!printed;submit.textContent=running?'Procesando…':ticket?'Reintentar impresión':'Emitir e imprimir';}
  async function emit(){
    if(running||!select.value||printed)return;
    running=true;issueId=issueId||requestId();printId=printId||requestId();update();status.textContent='Preparando el ticket…';
    try{
      if(!ticket)ticket=await request(API+'/tickets',{method:'POST',body:JSON.stringify({sectorId:select.value,installId:issueId,source:'kiosk',delivery:'qr_or_print'})});
      const x=await request(ADMIN+'/tickets/'+encodeURIComponent(ticket.id)+'/print',{method:'POST',body:JSON.stringify({printRequestId:printId,clientPrinter:'local_http'})});
      const date=new Date(x.createdAt||Date.now()),fecha=new Intl.DateTimeFormat('es-AR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
      status.textContent='Turno '+x.displayNumber+' emitido. Enviando a la impresora…';
      const response=await fetch('http://127.0.0.1:9105/imprimir',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({numero:x.displayNumber,seccion:x.sectorName,fecha,qr:x.claimUrl}),signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw Error('La impresora no confirmó la impresión.');
      printed=true;status.textContent='Turno '+x.displayNumber+' enviado a la impresora correctamente.';
      refresh();
    }catch(e){status.textContent=(ticket?'Turno '+ticket.displayNumber+'. ':'')+(e.message||'No se pudo imprimir.')+' Podés reintentar sin generar otro turno. Si ya salió el papel, no reintentes.';}
    finally{running=false;update();}
  }
  select.onchange=update;dialog.addEventListener('cancel',e=>{if(running)e.preventDefault()});actions.append(close,again,submit);dialog.append(title,description,label,select,status,actions);document.body.append(dialog);
  const open=button('＋ Nuevo turno',()=>{if(printed){ticket=null;issueId=null;printId=null;printed=false;select.value='';status.textContent=''}update();dialog.showModal()},'operatorNewTicket');
  $('content').insertBefore(open,$('cards'));update();
}
module.exports={setupOperatorIssue};
