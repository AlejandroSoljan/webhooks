// Asisto | Actionable commercial analysis, same dashboard design | 2026-10-21
const markup = '<section class="panel commercialPanel" aria-labelledby="commercialTitle"><div class="chartHead"><div><h2 id="commercialTitle">Productos y consultas</h2><p class="muted">Interés observado, dudas y oportunidades para mejorar la atención.</p></div><span class="commercialBadge">Análisis comercial</span></div><div id="commercialContent" aria-live="polite">Cargando análisis comercial…</div></section>';
const css = '.commercialPanel{margin-top:18px}.commercialPanel h2{margin-bottom:4px}.commercialPanel .chartHead p{margin:0 0 16px}.commercialBadge{background:#dcf8f3;color:#087d72;border-radius:20px;padding:7px 12px;font-size:12px;white-space:nowrap}.commercialFacts{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0 18px}.commercialFact{background:#f6f9fc;border-radius:12px;padding:13px}.commercialFact strong{display:block;font-size:25px}.commercialFact span{font-size:12px;color:#60758e}.commercialInsights{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.commercialInsight{border:1px solid #dce7f1;border-left:4px solid #10bfa8;border-radius:12px;padding:16px;overflow-wrap:anywhere}.commercialInsight.warning{border-left-color:#e1a126;background:#fffcf3}.commercialInsight.neutral{border-left-color:#8ea2b7}.commercialInsight h3{font-size:15px;margin:0 0 8px}.commercialInsight p{margin:8px 0}.commercialEvidence,.commercialMethod{color:#657b96;font-size:12px}.commercialAction{color:#087d72;font-size:13px;font-weight:650}.commercialProducts{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.commercialProduct{background:#f6f9fc;border-radius:12px;padding:14px;overflow-wrap:anywhere}.commercialProduct small{display:block;margin-top:7px;color:#657b96}.commercialPanel h3.sectionTitle{font-size:15px;margin:22px 0 10px}.commercialTopics{display:flex;gap:8px;flex-wrap:wrap}.commercialTopic{background:#eef5f8;border:1px solid #dce7f1;border-radius:20px;padding:7px 12px;font-size:12px}.commercialMethod{margin:16px 0 0}.commercialUnavailable{padding:20px;background:#fff8e8;border-radius:12px;color:#76510a}@media(max-width:850px){.commercialFacts,.commercialInsights,.commercialProducts{grid-template-columns:repeat(2,1fr)}.commercialPanel .chartHead{align-items:flex-start;flex-wrap:wrap}}@media(max-width:560px){.commercialFacts,.commercialInsights,.commercialProducts{grid-template-columns:1fr}}';
function commercialClient() {
  let commercialSequence = 0, commercialAbort;
  const commercialNode = (tag, content, className) => { const e=document.createElement(tag);e.textContent=content;if(className)e.className=className;return e; };
  async function loadProductAnalysis() {
    const sequence=++commercialSequence,root=q('commercialContent');
    if(!root)return;
    commercialAbort?.abort();commercialAbort=new AbortController();
    const controller=commercialAbort,timer=setTimeout(()=>controller.abort(),14000);
    root.replaceChildren(commercialNode('p','Cargando análisis del período seleccionado…','muted'));
    try {
      const response=await fetch('/api/customer-app-admin/'+encodeURIComponent(TENANT)+'/product-stats?from='+encodeURIComponent(q('from').value)+'&to='+encodeURIComponent(q('to').value),{cache:'no-store',signal:controller.signal});
      const result=await response.json();
      if(sequence!==commercialSequence)return;
      if(!response.ok||!result.ok){const error=Error(response.status===401||response.status===403?'Iniciá sesión con permiso para consultar el análisis comercial.':'No se pudo consultar el análisis comercial central. Podés volver a actualizar este bloque.');error.publicMessage=true;throw error;}
      root.replaceChildren();
      const facts=commercialNode('div','','commercialFacts'),m=result.metrics;
      for(const [value,label]of [[m.successful,'Fichas consultadas con resultado'],[m.written,'Preguntas escritas'],[m.infoRequests,'Solicitudes de más información'],[result.coverage?.measuredInPeriod?m.camera:null,'Consultas llegadas desde la cámara (registro nuevo)']]){
        const box=commercialNode('div','','commercialFact');box.append(commercialNode('strong',value==null?'—':Number(value||0).toLocaleString('es-AR')),commercialNode('span',label));facts.append(box);
      }
      root.append(facts);
      const insights=commercialNode('div','','commercialInsights');
      for(const item of result.insights||[]){
        const card=commercialNode('article','','commercialInsight '+(['warning','neutral'].includes(item.tone)?item.tone:''));
        card.append(commercialNode('h3',item.title),commercialNode('p',item.finding),commercialNode('p',item.evidence,'commercialEvidence'),commercialNode('p','Acción sugerida: '+item.action,'commercialAction'));insights.append(card);
      }
      root.append(insights);
      if(!m.successful&&!m.written&&!m.infoRequests){const wider=commercialNode('button','Ver últimos 7 días','secondary');wider.type='button';wider.style.marginTop='14px';wider.onclick=()=>{q('period').value='7';setPeriod();load()};root.append(wider)}
      const products=(result.topProducts||[]).filter(p=>p.views>0||p.questions>0).slice(0,3);
      if(products.length){root.append(commercialNode('h3','Productos que están generando interés','sectionTitle'));const list=commercialNode('div','','commercialProducts');for(const p of products){const item=commercialNode('article','','commercialProduct');item.append(commercialNode('b',p.description),commercialNode('small',p.views+' consultas de ficha · '+p.questions+' preguntas'));list.append(item)}root.append(list)}
      if(result.topics?.length){root.append(commercialNode('h3','Qué se pregunta sobre los productos','sectionTitle'));const list=commercialNode('div','','commercialTopics');for(const item of result.topics)list.append(commercialNode('span',item.label+': '+item.count,'commercialTopic'));root.append(list)}
      const since=result.coverage?.trackingSince;
      root.append(commercialNode('p',(since?'Cámara, disponibilidad y errores: registro nuevo desde '+new Date(since).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'})+'. ':'Todavía no hay lecturas con el registro nuevo; no se puede medir disponibilidad ni uso de cámara en el histórico. ')+(result.coverage?.note||''),'commercialMethod'));
      root.append(commercialNode('p','Actualizado '+new Date(result.generatedAt).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'})+' · Período '+result.from+' a '+result.to+'.','commercialMethod'));
    }catch(error){if(sequence===commercialSequence)root.replaceChildren(commercialNode('p',error.name==='AbortError'?'El análisis comercial está demorando. Podés volver a actualizar; no modifica la gestión de turnos.':error.publicMessage?error.message:'No se pudo consultar el análisis comercial. Podés volver a actualizar este bloque.','commercialUnavailable'));}
    finally{clearTimeout(timer)}
  }
  // Shared with the existing date/domain filters; no extra global identifiers.
  window.loadProductAnalysis = loadProductAnalysis;
}
const client = '('+commercialClient.toString()+')();';
function enhance(html) {
  return html.replace('</style>',css+'</style>').replace('<div class="content">',markup+'<div class="content">').replace('async function load(e){',client+'\nasync function load(e){').replace("q('csv').disabled=true;try{","q('csv').disabled=true;window.loadProductAnalysis();try{");
}
module.exports = { markup, css, client, enhance };
