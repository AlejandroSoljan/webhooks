const css = `body.admin{height:auto;min-height:100vh;overflow:auto}.admin main{overflow:visible}.admin #content{height:auto}.admin #cards{display:block!important;height:auto}.multiSection{margin:12px 0 24px}.multiHeading{display:flex;justify-content:space-between;align-items:center;background:#e00000;color:white;border-radius:9px;padding:15px 20px;margin-bottom:14px;gap:20px}.multiHeading h2{display:flex;gap:12px;align-items:center;font-size:25px;margin:0;text-transform:uppercase}.multiHeading small{font-size:17px;font-weight:700}.multiLayout{display:grid;grid-template-columns:minmax(0,3.3fr) minmax(240px,1fr);gap:16px}.multiTickets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-content:start}.multiTicket{background:#fff;border:1px solid #ddd;border-left:8px solid #e00000;border-radius:10px;padding:18px;min-width:0}.multiEyebrow{color:#68707a;font-weight:800;font-size:13px}.multiNumber{font-size:54px;font-weight:950;line-height:1.1;color:#080808;letter-spacing:-.04em;margin-top:4px}.multiDesk{font-size:18px;color:#646b75;font-weight:750}.multiSeller{display:flex;align-items:center;gap:12px;margin:14px 0 7px;font-size:17px;font-weight:800;overflow-wrap:anywhere}.multiSeller .uiIcon{color:#e00000}.multiTimer{font-size:16px;margin-bottom:12px;color:#222}.multiActions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.multiActions button{display:flex;align-items:center;justify-content:center;gap:9px;min-height:44px;padding:10px 7px;font-size:14px;border-radius:8px}.multiActions .multiAbsent{background:white!important;color:#333;border:1px solid #c5c8cc}.multiActions .multiRepeat{background:white!important;color:#e00000;border:1px solid #e00000}.multiActions .multiTransfer{background:#292b2d!important;color:white}.multiAside{background:#fff;border:1px solid #ddd;border-radius:12px;padding:22px;display:flex;flex-direction:column;min-width:0}.multiAside h2{font-size:28px;margin:0 0 14px}.multiWaiting{display:flex;align-items:center;gap:12px;font-size:23px;font-weight:800;padding-bottom:18px;border-bottom:1px solid #ddd}.multiWaiting .uiIcon{font-size:36px;color:#e00000}.multiQueue{margin:10px 0 24px}.multiQueue div{font-size:25px;font-weight:850;padding:13px 0;border-bottom:1px solid #ddd}.multiNext{margin-top:auto;font-size:18px;min-height:54px;border-radius:9px}.multiAside p{font-size:13px;margin:12px 0 0}.multiEmpty{padding:30px;color:#646b75;grid-column:1/-1}.multiTransferDialog{text-align:left}.multiTransferDialog h2{font-size:26px}.multiTransferDialog .actions{justify-content:flex-end}.admin[data-theme="dark"] .multiTicket,.admin[data-theme="dark"] .multiAside{background:#1e293b;border-color:#475569}.admin[data-theme="dark"] .multiNumber,.admin[data-theme="dark"] .multiTimer{color:#fff}@media(max-width:1250px){.multiTickets{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:800px){.multiLayout{grid-template-columns:1fr}.multiTickets{grid-template-columns:repeat(2,minmax(0,1fr))}.multiHeading{flex-wrap:wrap}}@media(max-width:530px){.multiTickets{grid-template-columns:1fr}}`;
function renderMultiSection(s) {
  const section=element('section',undefined,'multiSection'),heading=element('div',undefined,'multiHeading'),title=element('h2',s.name);
  title.prepend(uiIcon('wrench'));const tickets=s.activeTickets|| (s.current?[s.current]:[]);
  section.dataset.count=String(tickets.length);heading.append(title,element('small',tickets.length+' '+(tickets.length===1?'turno':'turnos')+' en atención'));section.append(heading);
  const layout=element('div',undefined,'multiLayout'),grid=element('div',undefined,'multiTickets');
  for(const t of [...tickets].reverse()){
    const card=element('article',undefined,'multiTicket');card.append(element('div','EN ATENCIÓN','multiEyebrow'),element('div',t.displayNumber,'multiNumber'),element('div',t.desk||'Acercate al sector','multiDesk'));
    const seller=element('div',undefined,'multiSeller');seller.append(sellerNameLine(t.sellerName||'Sin vendedor',''),element('span',''));
    card.append(seller);
    const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(t.serviceStartedAt||t.calledAt))/1000));
    card.append(element('div','◷ '+Math.floor(seconds/60).toString().padStart(2,'0')+':'+(seconds%60).toString().padStart(2,'0'),'multiTimer'));
    const actions=element('div',undefined,'multiActions');
    for(const [label,action,cls,icon] of [['Finalizar','finish','','check'],['Ausente','skip','multiAbsent','absent'],['Repetir','recall','multiRepeat','repeat'],['Derivar','transfer','multiTransfer','transfer']]){
      const b=button(label,()=>action==='transfer'?chooseTransfer(s,t):act({...s,current:t},action),cls);b.prepend(uiIcon(icon));actions.append(b);
    }card.append(actions);grid.append(card);
  }
  if(!tickets.length)grid.append(element('div','No hay turnos en atención.','multiEmpty'));
  const aside=element('aside',undefined,'multiAside'),waiting=element('div',undefined,'multiWaiting');waiting.append(uiIcon('users'),element('span',s.waiting+' '+(s.waiting===1?'persona':'personas')));aside.append(element('h2','En espera'),waiting);
  const list=element('div',undefined,'multiQueue');for(const t of s.next||[])list.append(element('div',t.displayNumber));aside.append(list);
  const next=button('Llamar siguiente',()=>chooseSeller(s),'multiNext');next.disabled=!s.waiting;aside.append(next,element('p','Seleccioná el vendedor que va a atender.'));layout.append(grid,aside);section.append(layout);return section;
}
function chooseTransfer(s,t){
  let d=$('multiTransferDialog');if(d)d.remove();d=document.createElement('dialog');d.id='multiTransferDialog';d.className='multiTransferDialog';d.append(element('h2','Derivar turno '+t.displayNumber));const label=element('label','Sección de destino'),select=element('select');select.id='multiDestination';label.htmlFor=select.id;select.append(new Option('Elegí una sección',''));cfg.sectors.filter(z=>z.id!==s.id&&z.kind!=='presence').forEach(z=>select.append(new Option(z.name,z.id)));const actions=element('div',undefined,'actions'),confirm=button('Derivar',()=>{if(!select.value)return;d.close();act({...s,current:t},'transfer',select.value)});confirm.disabled=true;select.onchange=()=>confirm.disabled=!select.value;actions.append(button('Cancelar',()=>d.close(),'secondary'),confirm);d.append(label,select,actions);document.body.append(d);d.showModal();
}
function compactOperatorToolbar(){
  const root=$('content'),toolbar=element('div',undefined,'operatorToolbar'),titles=element('div',undefined,'operatorTitles'),controls=element('div',undefined,'operatorControls'),field=element('div',undefined,'operatorDeskField');
  titles.append(root.querySelector('.eyebrow'),root.querySelector('h1'));
  const desk=$('desk'),label=root.querySelector(':scope > label');label.htmlFor='desk';field.append(label,desk);
  controls.append(field,$('soundControl'),root.querySelector('.operatorNewTicket'));toolbar.append(titles,controls);root.prepend(toolbar);
}
const compactCss=`
body.admin{background:#f4f4f5}
body.admin header{padding:12px 32px;min-height:78px}
body.admin header .mecanLogo{width:174px}
body.admin main{width:100%;max-width:1440px;margin:0 auto;padding:24px 32px 16px;overflow:visible}
.admin.singleSectorMode #content,.admin #content{display:flex;height:auto;gap:0}
.operatorToolbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:20px}
.operatorTitles{flex-shrink:0}.operatorTitles .eyebrow{font-size:11px;letter-spacing:.12em;color:#707780}
.operatorTitles h1{font-size:30px;line-height:1.2;margin:4px 0 0;letter-spacing:-.035em}
.operatorControls{display:flex;align-items:flex-end;gap:12px}
.operatorDeskField{width:180px}.operatorDeskField label{display:block;font-size:12px;font-weight:700;margin:0 0 5px;color:#5b626c}
.operatorDeskField #desk{height:44px;width:100%;padding:10px 12px;margin:0;font-size:14px;border-radius:9px}
.admin .operatorControls #soundControl{position:static;width:auto;min-height:44px;height:44px;margin:0;padding:10px 14px;font-size:12px;border:1px solid #d9dce1;background:#fff;color:#333;border-radius:9px}
.admin .operatorControls .operatorNewTicket{align-self:auto;margin:0;min-height:44px;height:44px;font-size:14px;padding:10px 18px;border-radius:9px;white-space:nowrap}
.admin #cards{margin-top:0!important;flex:none}
.multiSection{margin:0 0 20px}.multiHeading{padding:15px 20px;border-radius:12px;margin-bottom:16px;background:#e00000}
.multiHeading h2{font-size:22px;gap:12px}.multiHeading small{font-size:13px;background:#ffffff26;padding:7px 12px;border-radius:7px}
.multiLayout{grid-template-columns:minmax(0,1fr) 300px;gap:18px;align-items:start}
.multiTickets{grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.multiTicket{padding:18px 18px 16px;border:1px solid #dedfe3;border-left:5px solid #e00000;border-radius:12px;box-shadow:0 3px 9px #00000004}
.multiEyebrow{font-size:10px;letter-spacing:.09em}.multiNumber{font-size:58px;margin-top:5px;letter-spacing:-.055em}.multiDesk{font-size:15px}
.multiSeller{margin:15px 0 7px}.multiSeller .sellerNameLine{font-size:13px;text-align:left;justify-content:flex-start;color:#202329;gap:8px}.multiSeller svg{fill:currentColor;stroke:none}.multiSeller .uiIcon{color:#e00000}
.multiTimer{font-size:13px;margin-bottom:16px;color:#636b76}.multiActions{gap:8px}.multiActions button{font-size:12px;min-height:40px;padding:9px 6px;gap:6px;border-radius:7px}
.multiAside{padding:22px;border-radius:12px;align-self:stretch}.multiAside h2{font-size:23px;margin:0 0 18px}.multiWaiting{font-size:19px;gap:12px;padding-bottom:20px}.multiWaiting .uiIcon{font-size:30px}.multiQueue{margin:4px 0 22px}.multiQueue div{font-size:22px;padding:15px 2px}.multiNext{min-height:49px;font-size:15px;border-radius:8px;margin-top:auto}.multiAside p{font-size:11px;line-height:1.5;text-align:center;color:#747c85}
.multiSection[data-count="1"] .multiTickets,.multiSection[data-count="0"] .multiTickets{grid-template-columns:1fr}
.multiSection[data-count="2"] .multiTickets{grid-template-columns:repeat(2,minmax(0,1fr))}
.multiSection[data-count="1"] .multiLayout{grid-template-columns:minmax(0,1fr) 330px}
.multiSection[data-count="1"] .multiTicket{padding:26px 30px;display:flex;flex-direction:column;align-items:center;min-height:430px}
.multiSection[data-count="1"] .multiEyebrow{align-self:flex-start;font-size:12px}
.multiSection[data-count="1"] .multiNumber{font-size:112px;margin:12px 0 0;line-height:1}
.multiSection[data-count="1"] .multiDesk{font-size:24px}
.multiSection[data-count="1"] .multiSeller{margin:20px 0 8px}.multiSection[data-count="1"] .sellerNameLine{font-size:18px}
.multiSection[data-count="1"] .multiTimer{font-size:15px;margin-bottom:24px}
.multiSection[data-count="1"] .multiActions{width:100%;max-width:560px;grid-template-columns:repeat(4,1fr);margin-top:auto}
.multiSection[data-count="1"] .multiActions button{min-height:48px;font-size:14px}
.admin .brandFooter{padding:8px;margin-top:auto}.multiTicket .multiActions button:disabled{opacity:.5}
.admin[data-theme="dark"] .multiSeller .sellerNameLine,.admin[data-theme="dark"] .multiTimer{color:#e5e7eb}
.multiSection:not([data-count="1"]) .multiTicket{padding:14px 18px}
.multiSection:not([data-count="1"]) .multiSeller{margin:10px 0 5px}
.multiSection:not([data-count="1"]) .multiTimer{margin-bottom:10px}
.multiSection:not([data-count="1"]) .multiNumber{font-size:54px}
.multiSection:not([data-count="1"]) .multiAside{align-self:start}
.admin .brandFooter .poweredAsisto{padding:0;flex-wrap:nowrap;font-size:11px;gap:7px}
.admin .brandFooter .poweredAsisto img{width:23px;height:18px}
.admin .brandFooter .poweredAsisto strong{font-size:13px}
.admin .brandFooter .poweredAsisto a{flex-basis:auto;font-size:11px}
@media(max-width:1100px){.operatorToolbar{align-items:flex-start;flex-direction:column;gap:14px}.operatorControls{width:100%}.operatorDeskField{margin-right:auto}.multiLayout{grid-template-columns:minmax(0,1fr) 260px}.multiTickets{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:740px){body.admin main{padding:18px 14px}.operatorControls{flex-wrap:wrap}.operatorDeskField{width:100%;margin:0}.multiLayout,.multiSection[data-count="1"] .multiLayout{grid-template-columns:1fr}.multiTickets{grid-template-columns:repeat(2,minmax(0,1fr))}.multiSection[data-count="1"] .multiActions{grid-template-columns:repeat(2,1fr)}.multiHeading{gap:10px}.multiHeading h2{font-size:18px}}
@media(max-width:490px){.multiTickets,.multiSection[data-count="2"] .multiTickets{grid-template-columns:1fr}.operatorTitles h1{font-size:27px}.operatorControls{gap:8px}}
`;
module.exports={css:css+compactCss,renderMultiSection,chooseTransfer,compactOperatorToolbar};
