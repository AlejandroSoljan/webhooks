// Asisto | Version: 5.00.179 | Fecha: 2026-09-20
(() => {
  const root = document.getElementById('operationsDashboard');
  if (!root) return;
  const el = id => document.getElementById(id), tenant = el('opsTenant'), period = el('opsPeriod'), status = el('opsStatus'), button = el('opsRefresh');
  const labels = { whatsapp: 'sesiones WhatsApp', telegram: 'sesiones Telegram', sent: 'envíos WhatsApp', confirmationErrors: 'fallos de confirmación', review: 'conversaciones por revisar', contacts: 'contactos pendientes', orders: 'pedidos', leads: 'leads', tokens: 'consumo IA', tasks: 'tareas' };
  const states = { online: 'Conectada', inactive: 'Sin señal reciente', paused: 'Pausada', disabled: 'Deshabilitada', auth_failure: 'Fallo de autenticación', qr: 'Requiere QR', iniciando: 'Iniciando', disconnected: 'Desconectada' };
  const node = (tag, text = '', className = '') => { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; };
  const number = n => new Intl.NumberFormat('es-AR').format(n);
  const svg = (tag, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
  function icon(type) {
    const paths = { whatsapp: 'M21 11.5a9 9 0 0 1-13 8L3 21l1.5-5A9 9 0 1 1 21 11.5ZM8 7c-2 4 5 10 8 7l-3-2-1 1-2-2 1-1-3-3Z', cart: 'M2 3h3l3 12h11l3-9H6M9 20h.01M18 20h.01', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l4 2', chip: 'M6 6h12v12H6ZM9 9h6v6H9ZM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4', warning: 'M12 3 2 21h20L12 3Zm0 6v5m0 3v.1', chat: 'M3 3h18v14H8l-5 4V3Zm4 5h10M7 12h7', settings: 'M3 6h18M3 12h18M3 18h18M8 3v6m8 0v6m-7 0v6', chart: 'M4 3v18h17M8 16v-5m5 5V7m5 9V4' };
    const n = svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(svg('path', { d: paths[type] || paths.warning })); return n;
  }
  function link(text, href, className) { const n = node('a', text, className); n.href = href; return n; }
  function empty(target, text) { el(target).replaceChildren(node('p', text, 'opsEmpty')); }
  let request, sequence = 0, tenantsError = '', currentData, showAll = false;
  function renderActivity(data) {
    if (!Array.isArray(data.activity)) return empty('opsActivity', data.unavailable.includes('sent') ? 'No se pudo consultar la actividad.' : 'Sin permiso para consultar mensajes.');
    let rows = data.activity;
    if (data.period === 'today') rows = rows.slice(0, new Date(Date.parse(data.generatedAt) - 10800000).getUTCHours() + 1);
    const width = 720, height = 220, left = 40, right = 16, top = 12, bottom = 32, baseline = height - bottom;
    const max = Math.max(4, ...rows.flatMap(r => [r.sent, r.received]));
    const step = Math.max(1, Math.ceil(max / 4)), ceiling = step * 4;
    const x = i => left + i * (width-left-right) / Math.max(1, rows.length-1), y = v => baseline - v * (baseline-top) / ceiling;
    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Mensajes enviados y recibidos por ' + (['7d','month','30d'].includes(data.period) ? 'día' : 'hora'), class: 'opsLineChart' });
    for (let i=0;i<=4;i++) {
      const yy=y(i*step); chart.append(svg('line',{x1:left,y1:yy,x2:width-right,y2:yy,stroke:'#e8eff6'}));
      const t=svg('text',{x:left-10,y:yy+4,'text-anchor':'end'});t.textContent=number(i*step);chart.append(t);
    }
    rows.forEach((r,i) => {
      if (i % Math.max(1, Math.ceil(rows.length/7)) === 0 || i === rows.length-1) { const t=svg('text',{x:x(i),y:height-9,'text-anchor':'middle'}); t.textContent=r.label;chart.append(t); }
    });
    for (const [key,color] of [['received','#1687ff'],['sent','#0cc5ab']]) {
      const points = rows.map((r,i)=>`${x(i)},${y(r[key])}`).join(' ');
      if (rows.length > 1) chart.append(svg('polygon',{points:`${left},${baseline} ${points} ${x(rows.length-1)},${baseline}`,fill:color,'fill-opacity':'.12'}));
      chart.append(svg('polyline',{points,fill:'none',stroke:color,'stroke-width':2.4,'stroke-linejoin':'round'}));
      rows.forEach((r,i)=>{const point=svg('circle',{cx:x(i),cy:y(r[key]),r:3,fill:color});const tip=svg('title');tip.textContent=`${r.label}: ${number(r[key])} ${key==='sent'?'enviados':'recibidos'}`;point.append(tip);chart.append(point);});
    }
    const details=node('details','','opsChartData');details.append(node('summary','Ver valores del gráfico'));
    const table=node('table'); const head=node('tr'); ['Período','Enviados','Recibidos'].forEach(t=>head.append(node('th',t)));table.append(head);
    rows.forEach(r=>{const tr=node('tr');[r.label,number(r.sent),number(r.received)].forEach(t=>tr.append(node('td',t)));table.append(tr);});details.append(table);
    el('opsActivity').replaceChildren(chart,details);
  }
  function renderConnections(data) {
    const available = data.access ? data.access.some(a=>['wweb','telegram'].includes(a)) : data.sessions.length;
    if (!available) return empty('opsConnectionChart', 'Sin permiso para consultar conexiones.');
    if (!data.sessions.length) return empty('opsConnectionChart', data.unavailable.some(k=>['whatsapp','telegram'].includes(k)) ? 'No disponible' : 'Sin sesiones registradas.');
    const items = [ ['Conectadas', '#08c4ac', data.sessions.filter(s=>s.state==='online').length], ['Por revisar','#ffbc21',data.sessions.filter(s=>!['online','paused','disabled'].includes(s.state)).length], ['Pausadas','#84a3bd',data.sessions.filter(s=>s.state==='paused').length], ['Deshabilitadas','#cad5e1',data.sessions.filter(s=>s.state==='disabled').length] ];
    const wrap=node('div','','opsDonutWrap'), total=data.sessions.length;
    const donut=svg('svg',{viewBox:'0 0 190 190',role:'img','aria-label':items.map(i=>`${i[2]} ${i[0]}`).join(', '),class:'opsDonut'});let offset=0;
    items.forEach(([label,color,value])=>{if(!value)return;const length=value/total*100;donut.append(svg('circle',{cx:95,cy:95,r:72,fill:'none',stroke:color,'stroke-width':26,pathLength:100,'stroke-dasharray':`${length} ${100-length}`,'stroke-dashoffset':-offset,transform:'rotate(-90 95 95)'}));offset+=length;});
    const count=svg('text',{x:95,y:94,'text-anchor':'middle',class:'opsDonutTotal'});count.textContent=number(total);
    const sub=svg('text',{x:95,y:117,'text-anchor':'middle',class:'opsDonutLabel'});sub.textContent='sesiones';donut.append(count,sub);
    const legend=node('div','','opsDonutLegend');items.filter(i=>i[2]||i[0]!=='Deshabilitadas').forEach(([label,color,value])=>{const r=node('div');const dot=node('i');dot.style.backgroundColor=color;r.append(dot,node('strong',number(value)),node('span',label.toLowerCase()));legend.append(r);});wrap.append(donut,legend);
    el('opsConnectionChart').replaceChildren(wrap,node('p','Estado actual · no histórico','opsMiniNote'));
  }
  function renderAlerts(data, metrics) {
    const rows=[];
    data.sessions.filter(s=>!['online','paused','disabled'].includes(s.state)).forEach(s=>rows.push({icon:'warning',kind:'amber',tenant:s.tenantId,title:s.channel+' · '+(states[s.state]||s.state),detail:'Revisá la conexión y su última señal.',action:'Ver sesión',href:s.channel==='Telegram'?'/ui/telegram':'/admin/wweb'}));
    if(metrics.review?.value) rows.push({icon:'chat',kind:'blue',tenant:data.tenant||'Todos',title:`${number(metrics.review.value)} conversaciones por revisar`,detail:'Pendientes de revisión en Seguimiento.',action:'Revisar',href:metrics.review.href});
    data.sessions.filter(s=>s.versionMismatch).forEach(s=>rows.push({icon:'settings',kind:'slate',tenant:s.tenantId,title:'Versión del agente pendiente',detail:`Instalada: ${s.version} · Objetivo: ${s.target}`,action:'Ver versión',href:'/admin/wweb'}));
    if(metrics.confirmationErrors?.value) rows.push({icon:'warning',kind:'amber',tenant:data.tenant||'Todos',title:`${number(metrics.confirmationErrors.value)} fallos de confirmación`,detail:'Fallos registrados durante el período seleccionado.',action:'Revisar',href:metrics.confirmationErrors.href});
    el('opsAlerts').replaceChildren();
    for(const item of (showAll?rows:rows.slice(0,3))){const row=node('div','','opsAlertRow');const badge=node('span','','opsAlertIcon '+item.kind);badge.append(icon(item.icon));const text=node('div','','opsAlertText');text.append(node('strong',item.title),node('small',item.detail));row.append(badge,node('span',item.tenant,'opsTenantTag'),text,link(item.action,item.href,'opsAlertAction '+item.kind));el('opsAlerts').append(row);}
    if(!rows.length) empty('opsAlerts',data.unavailable.length?'Sin alertas adicionales. Hay consultas no disponibles.':'No hay alertas en los registros consultados.');
    el('opsShowAlerts').hidden=rows.length<=3;el('opsShowAlerts').textContent=showAll?'Ver menos':`Ver todas (${rows.length})`;
  }
  function render(data) {
    currentData=data; data.unavailable ||= []; data.sessions ||= [];
    const features=data.features||{whatsapp:true,telegram:true,orders:true,followup:true,leads:true,tokens:true,tasks:true};
    const metrics=Object.fromEntries(data.metrics.map(m=>[m.key,m]));
    el('opsMetrics').replaceChildren();el('opsNotices').replaceChildren();
    const pendingAvailable=metrics.review && metrics.contacts;
    const pendingValue=pendingAvailable?metrics.review.value+metrics.contacts.value:null;
    const cards=[features.whatsapp&&['sent','WhatsApp enviados','whatsapp','green','Envíos registrados · no solicitudes API'],features.orders&&['orders',data.period==='today'||!data.period?'Pedidos de hoy':'Pedidos del período','cart','teal','Pedidos confirmados'],features.followup&&['attention','Pendientes de atención','clock','amber',pendingAvailable?`${number(metrics.review.value)} por revisar · ${number(metrics.contacts.value)} por contactar`:'Pendientes acumulados'],features.tokens&&['tokens','Consumo IA','chip','teal',data.period==='today'||!data.period?'Tokens utilizados hoy':'Tokens utilizados en el período']].filter(Boolean);
    cards.forEach(([key,title,type,color,detail])=>{
      const m=key==='attention'?(pendingAvailable?{value:pendingValue,href:metrics.review.href}:null):metrics[key];
      const failed=key==='attention'?['review','contacts'].some(k=>data.unavailable.includes(k)):data.unavailable.includes(key);
      const card=m?link('',m.href,'opsMetric'):node('div','','opsMetric opsMissing');const badge=node('span','','opsMetricIcon '+color);badge.append(icon(type));const text=node('div','','opsMetricText');
      text.append(node('span',title),node('strong',m?number(m.value):failed?'No disponible':'Sin acceso'),node('small',detail));card.append(badge,text);card.title=m?.detail||(key==='attention'?'Suma de acciones pendientes; una conversación puede requerir revisión y contacto.':detail);el('opsMetrics').append(card);
    });
    if(tenantsError)el('opsNotices').append(node('p',tenantsError,'opsNotice'));
    if(data.unavailable.length)el('opsNotices').append(node('p','Información parcial: no disponible '+data.unavailable.map(k=>labels[k]||k).join(', ')+'.','opsNotice'));
    if(data.sessionsTruncated)el('opsNotices').append(node('p','Conexiones: se muestran hasta 500 registros por canal; totales parciales.','opsNotice'));
    const showActivity=features.whatsapp,showConnections=features.whatsapp||features.telegram,showAlerts=showConnections||features.followup,showPending=features.followup||features.tasks;
    el('opsActivityBox').hidden=!showActivity;el('opsConnectionsBox').hidden=!showConnections;el('opsMessagingRow').hidden=!showActivity&&!showConnections;
    el('opsAlertsBox').hidden=!showAlerts;el('opsPendingBox').hidden=!showPending;el('opsAttentionRow').hidden=!showAlerts&&!showPending;
    if(showActivity)renderActivity(data);if(showConnections)renderConnections(data);if(showAlerts)renderAlerts(data,metrics);
    el('opsPending').replaceChildren();const maximum=Math.max(1,...['review','contacts','tasks'].map(k=>metrics[k]?.value||0));
    for(const [key,label,color] of [['review','Conversaciones','blue'],['contacts','Contactos','mint'],['tasks','Mis tareas','slate']].filter(([key])=>key==='tasks'?features.tasks:features.followup)){
      const m=metrics[key],row=node('div','','opsBarRow');const track=node('span','','opsBarTrack'),fill=node('i','',color);fill.style.width=`${m?m.value/maximum*100:0}%`;track.append(fill);row.append(node('span',label),track,node('strong',m?number(m.value):data.unavailable.includes(key)?'N/D':'—'));el('opsPending').append(row);
    }
    if(metrics.review)el('opsPending').append(link('Ver seguimiento →',metrics.review.href,'opsFollowLink'));
    el('opsQuick').replaceChildren();const access=data.access||[];
    for(const [allowed,text,href,type] of [[features.whatsapp&&access.includes('inbox'),'Abrir WhatsApp','/admin/inbox','whatsapp'],[features.tokens&&!!metrics.tokens,'Ver consumos',metrics.tokens?.href,'chart'],[access.some(k=>['tenant_config','canales','comportamiento','horarios','order_config','client_access'].includes(k)),'Configurar negocio','/ui/configuracion','settings']]){if(!allowed)continue;const a=link('',href,'opsQuickLink');a.append(icon(type),node('span',text),node('b','›'));el('opsQuick').append(a);}el('opsQuick').hidden=!el('opsQuick').children.length;
    el('opsSecondary').replaceChildren(); data.metrics.forEach(m=>{const row=node('div','','opsDetailMetric');row.append(link(m.label,m.href),node('strong',number(m.value)),node('small',m.detail));el('opsSecondary').append(row);});
    const table=node('table','','opsTable');const header=node('tr');['Dominio / canal','Número','Estado actual','Última señal','Versión / objetivo'].forEach(t=>header.append(node('th',t)));table.append(header);
    data.sessions.forEach(s=>{const row=node('tr');[s.tenantId+' · '+s.channel,s.number||'—',states[s.state]||s.state,s.lastSeenAt?new Date(s.lastSeenAt).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'}):'Sin registro',[s.version,s.target].filter(Boolean).join(' / ')||'—'].forEach(t=>row.append(node('td',t)));table.append(row);});el('opsConnections').replaceChildren(table);
    status.textContent='Datos reales · '+new Date(data.generatedAt).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'})+' · hora argentina';
  }
  function clear(){['opsMetrics','opsNotices','opsActivity','opsConnectionChart','opsAlerts','opsPending','opsQuick','opsSecondary','opsConnections'].forEach(id=>el(id).replaceChildren());el('opsShowAlerts').hidden=true;}
  async function load() {
    const current=++sequence;request?.abort();request=new AbortController();const controller=request,timeout=setTimeout(()=>controller.abort(),20000);button.disabled=true;status.textContent='Consultando indicadores…';
    try{const params=new URLSearchParams({period:period.value});if(tenant?.value)params.set('tenant',tenant.value);const response=await fetch('/api/operations-dashboard?'+params,{signal:controller.signal,headers:{Accept:'application/json'}});if(!response.ok||response.redirected)throw new Error('unavailable');const data=await response.json();if(current===sequence)render(data);}
    catch{if(current===sequence){clear();status.textContent='No se pudo actualizar. Revisá tu conexión o sesión y volvé a intentar.';el('opsNotices').append(node('p',status.textContent,'opsNotice'));}}
    finally{clearTimeout(timeout);if(current===sequence)button.disabled=false;}
  }
  function changed(){clear();showAll=false;const url=new URL(location.href);if(tenant?.value)url.searchParams.set('tenant',tenant.value);else url.searchParams.delete('tenant');url.searchParams.set('period',period.value);history.replaceState(null,'',url.pathname+url.search);load();}
  async function init(){
    const params=new URLSearchParams(location.search);if(['today','yesterday','7d','month','30d'].includes(params.get('period')))period.value=params.get('period');
    if(tenant){try{const response=await fetch('/api/operations-dashboard/tenants',{signal:AbortSignal.timeout(10000)});if(!response.ok||response.redirected)throw new Error('tenants');const data=await response.json();data.tenants.forEach(t=>{const option=node('option',t.id+(t.name?' · '+t.name:''));option.value=t.id;tenant.append(option);});if(data.tenants.some(t=>t.id===params.get('tenant')))tenant.value=params.get('tenant');if(data.truncated)tenantsError='El selector muestra los primeros 2000 dominios.';}catch{tenantsError='No se pudo cargar el selector de dominios; se muestra la vista global.';}tenant.addEventListener('change',changed);}
    period.addEventListener('change',changed);button.addEventListener('click',load);el('opsShowAlerts').addEventListener('click',()=>{showAll=!showAll;if(currentData)renderAlerts(currentData,Object.fromEntries(currentData.metrics.map(m=>[m.key,m])));});load();setInterval(()=>{if(!document.hidden&&!button.disabled)load();},60000);
  }
  init();
})();
