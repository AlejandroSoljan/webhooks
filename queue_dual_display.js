// Asisto | Optional two-primary television layout | 2026-09-29
function resolveDualSectors(sectors,raw){
  const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  const names=String(raw||'').split(',').map(normalize);
  if(names.length!==2||names.some(n=>!n))throw Error('Indicá dos secciones en principal, separadas por coma.');
  const selected=names.map(name=>sectors.find(s=>s.kind!=='presence'&&(normalize(s.id)===name||normalize(s.name)===name)));
  if(selected.some(s=>!s)||selected[0].id===selected[1].id)throw Error('Las dos secciones principales deben existir y ser diferentes.');
  return selected.map(s=>s.id);
}
function dualSectionIcon(s){
  const id=String(s.id+' '+s.name).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(),icon=uiIcon('wrench');
  let paths='';
  if(id.includes('herraje'))paths='<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/><path d="M10 8h4M10 16h4"/>';
  else if(id.includes('bulon'))paths='<path d="m8 4 8 0 4 7-4 7H8l-4-7 4-7Z"/><circle cx="12" cy="11" r="3"/>';
  else if(id.includes('servicio')||id.includes('tecnico'))paths='<path d="m5 4 15 15M19 4 4 19M8 7 5 4M16 7l3-3"/>';
  if(paths){icon.classList.remove('filledIcon');icon.innerHTML='<svg viewBox="0 0 24 24">'+paths+'</svg>'}return icon;
}
function renderDualDisplay(sectors,ids){
  const primary=ids.map(id=>sectors.find(s=>s.id===id));
  if(primary.some(s=>!s))throw Error('Una sección principal ya no está disponible. Revisá el enlace de la pantalla.');
  const secondary=sectors.filter(s=>!ids.includes(s.id)&&s.kind!=='presence').slice(0,2),fragment=document.createDocumentFragment();
  for(const s of primary){
    const card=element('section',undefined,'focusedPrimary'),title=element('h2',s.name,'focusedTitle'),body=element('div',undefined,'focusedBody');title.prepend(dualSectionIcon(s));
    body.append(element('div','ATENDIENDO AHORA','dualNow'),element('div',s.current?.displayNumber||'—','focusedNumber'),element('div',s.current?(s.current.desk||'Acercate al sector'):'Esperando el próximo llamado','focusedDesk'));
    if(s.current?.sellerName)body.append(sellerNameLine(s.current.sellerName,'focusedSellerName'));
    body.append(queueSummary({...s,next:s.next||[]}));card.append(title,body);fragment.append(card);
  }
  const aside=element('aside',undefined,'dualAside');aside.setAttribute('aria-label','Otras secciones');
  for(const s of secondary){
    const card=element('section',undefined,'dualSmall'),title=element('h2',s.name,'dualSmallTitle');title.prepend(dualSectionIcon(s));
    card.append(title,element('div',s.current?.displayNumber||'—','dualSmallNumber'),element('div',s.current?(s.current.desk||'Acercate al sector'):'Sin llamados','dualSmallDesk'));
    if(s.current?.sellerName)card.append(sellerNameLine(s.current.sellerName,'dualSmallSeller'));
    card.append(element('div',s.next?.length?'Próximo: '+s.next[0].displayNumber:'Sin turnos en espera','dualSmallNext'));aside.append(card);
  }
  fragment.append(aside);const root=$('cards');root.replaceChildren(fragment);root.className='dualDisplay';
  return [...primary,...secondary];
}
async function refreshDualDisplay(){
  try{
    const x=await request(API+'/queue'),visible=renderDualDisplay(x.sectors,dualPrimaryIds),calls={};
    let changed=false;
    for(const s of visible){const key=s.current?s.current.id+':'+s.current.calledAt:'';calls[s.id]=key;if(Object.keys(lastCall).length&&key&&key!==lastCall[s.id])changed=true}
    if(changed)playCallSound();lastCall=calls;ok();
  }catch(e){error(e)}
}
const css=`
body.display.dualMode{height:100vh;overflow:hidden;background:#f4f4f4}
.display.dualMode header{padding:18px 32px;height:104px}.display.dualMode header .mecanLogo{width:220px}
.display.dualMode main{padding:20px 24px}
.display.dualMode #soundControl{position:fixed;top:24px;right:220px;min-height:40px;padding:9px 14px;font-size:13px}
.display.dualMode #soundControl:disabled{display:none}
.dualDisplay{height:100%;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(280px,.62fr);gap:18px}
.dualDisplay .focusedPrimary{border-radius:20px;display:flex;flex-direction:column;box-shadow:0 4px 15px #00000006}
.dualDisplay .focusedTitle{display:flex;align-items:center;justify-content:center;gap:15px;text-transform:uppercase;font-size:34px;padding:25px 12px;margin:0}
.dualDisplay .focusedTitle .uiIcon{font-size:34px}
.dualDisplay .focusedBody{height:auto;flex:1;padding:26px 22px;justify-content:flex-start;min-height:0}
.dualNow{align-self:flex-start;font-size:14px;font-weight:850;letter-spacing:.1em;color:#687386}
.dualDisplay .focusedNumber{font-size:clamp(80px,10.5vw,205px);margin:auto 0 0;line-height:1;font-weight:950;letter-spacing:-.055em}
.dualDisplay .focusedDesk{font-size:36px;margin:12px 0 34px}
.dualDisplay .focusedSellerName{font-size:24px;margin:0 0 auto;color:#35604b;overflow-wrap:anywhere}
.dualDisplay .sellerNameLine svg{fill:currentColor;stroke:none;width:100%;height:100%}
.dualDisplay .tvQueue{width:100%;grid-template-columns:1fr;gap:20px;margin-top:35px;padding-top:22px}
.dualDisplay .tvWaiting{border:0;padding:0;justify-content:center}.dualDisplay .tvWaiting strong{font-size:36px}.dualDisplay .tvWaiting .uiIcon{font-size:37px}.dualDisplay .tvWaiting span{max-width:none;font-size:18px}
.dualDisplay .tvNext{display:flex;gap:10px}.dualDisplay .tvNext span{flex:1;font-size:25px;padding:14px 6px}.dualDisplay .tvNextLabel{font-size:15px;margin-bottom:10px}
.dualAside{display:grid;grid-template-rows:1fr 1fr;gap:18px;min-height:0}
.dualSmall{display:flex;flex-direction:column;align-items:center;min-height:0;background:white;border:1px solid #e1e5ec;border-radius:20px;overflow:hidden;padding-bottom:22px}
.dualSmallTitle{display:flex;align-items:center;justify-content:center;gap:10px;background:#ed101c;color:white;font-size:23px;margin:0;width:100%;padding:23px 8px;text-align:center}
.dualSmallTitle .uiIcon{font-size:26px}
.dualSmallNumber{font-size:82px;line-height:1;font-weight:950;letter-spacing:-.05em;margin:auto 0 5px;color:#090909}
.dualSmallDesk{font-size:23px;font-weight:800;color:#596273}
.dualSmallSeller{font-size:16px;margin:17px 0 auto;overflow-wrap:anywhere}.dualSmallSeller .uiIcon{width:19px;height:19px}
.dualSmallNext{border-top:1px solid #dde3eb;width:84%;margin-top:16px;padding-top:13px;text-align:center;font-size:19px;font-weight:800;color:#596273}
.display.dualMode .brandFooter .poweredAsisto{padding:12px;font-size:13px}.display.dualMode .brandFooter .poweredAsisto img{width:30px;height:24px}.display.dualMode .brandFooter .poweredAsisto strong{font-size:16px}
@media(max-height:850px){.display.dualMode header{height:80px;padding:12px 24px}.display.dualMode header .mecanLogo{width:170px}.display.dualMode main{padding:12px 16px}.dualDisplay .focusedTitle{font-size:27px;padding:17px 10px}.dualDisplay .focusedBody{padding:18px}.dualDisplay .focusedDesk{font-size:26px;margin:8px 0 20px}.dualDisplay .focusedSellerName{font-size:20px}.dualDisplay .tvQueue{margin-top:22px;padding-top:14px;gap:12px}.dualDisplay .tvNext span{font-size:20px;padding:10px 4px}.dualSmallTitle{font-size:20px;padding:15px 6px}.dualSmallNumber{font-size:64px}.dualSmallDesk{font-size:20px}.dualSmallSeller{margin:10px 0 auto;font-size:14px}.dualSmall{padding-bottom:14px}.dualSmallNext{font-size:16px;margin-top:10px;padding-top:10px}}
@media(max-width:900px){body.display.dualMode{height:auto;overflow:auto}.display.dualMode main{overflow:visible}.dualDisplay{height:auto;grid-template-columns:1fr 1fr}.dualDisplay .focusedPrimary{min-height:550px}.dualAside{grid-column:1/-1;grid-template-columns:1fr 1fr;grid-template-rows:350px}.display.dualMode #soundControl{position:static}.dualDisplay .focusedTitle{font-size:24px}.dualDisplay .focusedDesk{font-size:23px}}
`;
module.exports={css,resolveDualSectors,dualSectionIcon,renderDualDisplay,refreshDualDisplay};
