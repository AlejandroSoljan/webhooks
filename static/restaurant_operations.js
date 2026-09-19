// Asisto | Version: 5.00.167 | Fecha: 2026-09-19
(() => {
  const root = document.createElement('section'); root.id = 'restaurantOps'; root.className = 'section';
  document.querySelector('.metrics').after(root);
  root.innerHTML = `<nav class="ops-nav" aria-label="Vistas del restaurante"><button data-view="salon" aria-current="page">Salón</button><button data-view="kitchen">Cocina</button><button data-view="history">Historial</button><button data-view="alerts">Avisos</button><button data-view="qr">QR de mesas</button><button data-view="ai">Asistente IA</button></nav><div class="salon-head sectionHead"><div><h2>Salón</h2><p>Todo lo que pasa en tus mesas.</p></div><label>Ver<select id="opsFilter"><option value="all">Todas las mesas</option><option value="attention">Necesitan atención</option><option value="occupied">Ocupadas</option><option value="free">Libres</option></select></label></div><p id="opsMessage" role="status" aria-live="polite"></p><div class="ops-layout"><div class="ops-salon"><div id="opsMetrics" class="ops-metrics"></div><div id="opsAttention"></div><div class="ops-filters"><button data-filter="all" aria-pressed="true">Todas</button><button data-filter="attention">Con avisos</button><button data-filter="occupied">Ocupadas</button><button data-filter="free">Libres</button></div><div id="opsBoard"></div><div id="opsPriorities" class="ops-priorities"></div></div><section id="opsDetail" aria-label="Detalle de la mesa">Seleccioná una mesa.</section></div><details id="kitchenSection"><summary>Cocina · pedidos en preparación</summary><div id="opsKitchen"></div></details><details id="historySection"><summary>Últimas cuentas cerradas</summary><div id="opsHistory"></div></details><details id="operatorAiSection"><summary>Asistente de IA del operario</summary><p>Consultá prioridades, demoras, composición de platos y sugerencias de la carta.</p><form id="opsAiForm"><label>Consulta<input id="opsAiQuestion" maxlength="800" placeholder="¿Qué mesas requieren atención primero?" required></label><button>Consultar IA</button></form><p id="opsAiAnswer" class="ops-answer" role="status"></p></details><p class="hint">Las funciones y el logo se administran en Configuración de dominio → Variables restaurante y logo.</p>`;
  const iconPaths={salon:'M4 3v7m3-7v7m-6-7v5a3 3 0 0 0 6 0M4 11v10M17 3c-4 6-4 10 1 10V3m0 10v8',kitchen:'M3 18h18M4 16a8 8 0 0 1 16 0ZM12 6V3m-2 0h4',history:'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2',alerts:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 13h4',qr:'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h3v3h4v4h-7Z',ai:'m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Z'};
  root.querySelectorAll('[data-view]').forEach(el=>el.insertAdjacentHTML('afterbegin','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+iconPaths[el.dataset.view]+'"/></svg>'));
  root.dataset.view='salon';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = cents => '$ ' + (Number(cents || 0) / 100).toLocaleString('es-AR', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const stateNames = { received:'Recibido', preparing:'En preparación', ready:'Listo para entregar', served:'Entregado', cancelled:'Cancelado', occupied:'Ocupada', reserved:'Reservada', bill_requested:'Pidió la cuenta', closed:'Libre', free:'Libre' };
  let tenant = '', snapshot = null, selectedId = '', editingOrder = '', detailDirty = false, requestSequence = 0;
  const table = () => snapshot?.tables.find(x => x.id === selectedId);
  const message = text => { $('opsMessage').textContent = text; if ($('opsDetailMessage')) $('opsDetailMessage').textContent = text; };
  async function api(path, data, method = 'POST') {
    const response = await fetch(path + '?tenant=' + encodeURIComponent(tenant), data === undefined ? {} : { method, headers:{ 'content-type':'application/json' }, body:JSON.stringify(data) });
    const result = await response.json(); if (!response.ok) throw Error(result.error || 'No se pudo completar la operación.'); return result;
  }
  function drawBoard() {
    if (!snapshot) return;
    const active = snapshot.tables.filter(x => x.service && x.service.status !== 'closed');
    const attention=snapshot.tables.filter(x=>x.pending.length || x.service?.status!=='closed' && x.service?.orders.some(o=>['received','ready'].includes(o.status)));
    $('opsMetrics').innerHTML = `<span><b>${active.length}</b>ocupadas</span><span><b>${attention.length}</b>necesitan atención</span><span><b>${snapshot.tables.length-active.length}</b>libres</span>`;
    $('opsAttention').innerHTML=snapshot.tables.flatMap(x=>x.pending.map(p=>`<div class="attention-line ${p.type==='bill'?'bill':''}"><span><strong>Mesa ${esc(x.label)}</strong> · ${p.type==='call'?'llama al mozo':'pidió la cuenta'}</span><button data-select-table="${x.id}">Ver mesa →</button></div>`)).join('');
    const ready=snapshot.tables.filter(x=>x.service?.status!=='closed' && x.service?.orders.some(o=>o.status==='ready'));
    $('opsPriorities').innerHTML='<strong>Prioridades del salón</strong><p>'+ (ready.length ? 'Pedidos listos en mesa '+ready.map(x=>esc(x.label)).join(', ')+'. ' : '')+(attention.length ? 'Revisá las mesas que necesitan atención.' : 'Sin avisos pendientes.')+'</p>';
    document.querySelectorAll('[data-view="kitchen"]').forEach(el=>el.hidden=!snapshot.features.kitchenBoard);
    document.querySelectorAll('[data-view="ai"]').forEach(el=>el.hidden=!snapshot.features.operatorAi);
    const filter = $('opsFilter').value;
    $('opsBoard').innerHTML = snapshot.tables.filter(x => filter === 'all' || (filter === 'attention' ? x.pending.length || x.service?.status !== 'closed' && x.service?.orders.some(o => ['received','ready'].includes(o.status)) : filter === 'free' ? !x.service || x.service.status === 'closed' : x.service && x.service.status !== 'closed')).map(x => {
      const service = x.service, active = service && service.status !== 'closed', pending = x.pending;
      const mins = active ? Math.max(0, Math.floor((Date.now() - new Date(service.openedAt)) / 60000)) : 0;
      const ready=active && service.orders.some(o=>o.status==='ready'),preparing=active && service.orders.some(o=>o.status==='preparing');
      const status=pending.some(p=>p.type==='call')?'Llama al mozo':pending.some(p=>p.type==='bill')?'Pidió la cuenta':ready?'Para entregar':preparing?'En preparación':stateNames[service?.status || 'free'];
      return `<button type="button" class="ops-table ${active ? 'occupied' : 'free'} ${x.id === selectedId ? 'selected' : ''} ${pending.length ? 'attention' : ''}" data-select-table="${x.id}"><strong>Mesa ${esc(x.label)}</strong><span class="table-state">${status}</span>${active ? `<span>${service.guests} comensales · ${mins} min</span><span>${esc(service.waiter || 'Sin mozo asignado')}</span><b>${money(x.totalCents)}</b><span>${x.paymentStatus === 'paid' ? 'Pagada' : x.paymentStatus === 'partial' ? 'Pago parcial · ' + money(x.balanceCents) + ' pendiente' : 'Sin pago registrado'}</span>` : ''}${pending.some(p => p.type === 'call') ? '<em>Llama al mozo</em>' : ''}${pending.some(p => p.type === 'bill') ? '<em>Pidió la cuenta</em>' : ''}${!active ? '<span class="open-table">＋ Abrir mesa</span>' : ''}${x.legacyOrders.length ? '<em>Pedidos anteriores por revisar</em>' : ''}</button>`;
    }).join('') || '<p>No hay mesas con este filtro.</p>';
    $('kitchenSection').hidden = !snapshot.features.kitchenBoard;
    $('operatorAiSection').hidden = !snapshot.features.operatorAi;
    if(root.dataset.view==='ai' && !snapshot.features.operatorAi || root.dataset.view==='kitchen' && !snapshot.features.kitchenBoard)showView('salon');
    $('opsKitchen').innerHTML = snapshot.tables.flatMap(x => (x.service?.status !== 'closed' ? x.service?.orders || [] : []).filter(o => ['received','preparing','ready'].includes(o.status)).map(o => `<article class="ops-order"><strong>Mesa ${esc(x.label)} · ${stateNames[o.status]}</strong><p>${o.items.map(i => `${i.quantity} × ${esc(i.nombre)}`).join(' · ')}</p><p>${esc(o.note)}</p><button type="button" data-select-table="${x.id}">Ver mesa</button></article>`)).join('') || '<p>No hay pedidos pendientes de cocina.</p>';
    const currentClosed = snapshot.tables.filter(x => x.service?.status === 'closed').map(x => ({ id:x.service.id, tableLabel:x.label, closedAt:x.service.closedAt, totalCents:x.totalCents, paidCents:x.paidCents }));
    $('opsHistory').innerHTML = [...currentClosed, ...snapshot.history].sort((a,b) => new Date(b.closedAt) - new Date(a.closedAt)).slice(0,20).map(x => `<p>Mesa ${esc(x.tableLabel)} · ${new Date(x.closedAt).toLocaleString('es-AR')} · ${money(x.totalCents)} · pagado ${money(x.paidCents)}</p>`).join('') || '<p>No hay cuentas cerradas todavía.</p>';
  }
  function drawDetail() {
    const x = table(); if (!x) { $('opsDetail').textContent = 'Seleccioná una mesa.'; return; }
    detailDirty = false; const s = x.service, active = s && s.status !== 'closed';
    $('opsDetail').innerHTML = `<div class="detail-heading"><div><h2>Mesa ${esc(x.label)}</h2><p>${active ? esc(s.guests)+' personas · '+esc(s.waiter || 'Sin mozo asignado') : 'Libre para una nueva visita'}</p></div><button type="button" id="opsHideDetail" class="soft" aria-label="Cerrar detalle">✕</button></div><button type="button" id="opsReloadDetail" class="soft">Actualizar detalle</button>${x.pending.map(p => `<p class="ops-pending">${p.type === 'call' ? 'Llamado al mozo' : 'Pidió la cuenta'} · ${new Date(p.createdAt).toLocaleTimeString('es-AR')} <button type="button" data-attend="${p.id}">Atender</button></p>`).join('')}${x.legacyOrders.map(o => `<article class="ops-order"><strong>Pedido anterior · ${money(o.total * 100)}</strong><p>${o.items.map(i => `${i.quantity} × ${esc(i.nombre)}`).join(', ')}</p><p>Este pedido anterior no está incluido en la cuenta nueva. Podés incorporarlo conservando su precio original.</p><button type="button" data-import-legacy="${o.id}">Incorporar a esta cuenta</button></article>`).join('')}<details ${active ? '' : 'open'}><summary>Editar datos de la mesa</summary><form id="opsDetailsForm"><div class="ops-fields"><label>Comensales<input name="guests" type="number" min="1" max="100" value="${active ? s.guests : 1}" required></label><label>Mozo<input name="waiter" maxlength="80" value="${esc(active ? s.waiter : '')}"></label><label>Estado<select name="status">${['occupied','reserved','bill_requested'].map(v => `<option value="${v}" ${s?.status === v ? 'selected' : ''}>${stateNames[v]}</option>`).join('')}</select></label></div><label>Notas de la mesa<textarea name="note" maxlength="500" placeholder="Reserva, preferencias, indicaciones">${esc(active ? s.note : '')}</textarea></label><button>${active ? 'Guardar mesa' : 'Abrir mesa / reservar'}</button></form></details>${active ? `<h3>Pedidos</h3><div>${s.orders.map(o => `<article class="ops-order"><strong>${stateNames[o.status]} · ${money(o.totalCents)}</strong><small>${o.origin === 'guest' ? 'Desde el celular' : 'Cargado por operario'} · ${new Date(o.createdAt).toLocaleTimeString('es-AR')}</small><p>${o.items.map(i => `${i.quantity} × ${esc(i.nombre)}`).join('<br>')}</p><p>${esc(o.note)}</p>${o.status !== 'cancelled' ? `<div class="ops-buttons">${x.paidCents === 0 ? `<button type="button" data-edit-order="${o.id}">Editar pedido</button>` : ''}${[{received:'preparing',preparing:'ready',ready:'served'}[o.status]].filter(Boolean).map(v => `<button type="button" data-order-state="${v}" data-order-id="${o.id}">${({preparing:'Enviar a cocina',ready:'Marcar listo',served:'Marcar entregado'})[v]}</button>`).join('')}${x.paidCents === 0 ? `<button type="button" data-order-state="cancelled" data-order-id="${o.id}">Cancelar</button>` : ''}</div>` : ''}</article>`).join('') || '<p>Todavía no hay pedidos.</p>'}</div><details id="opsOrderEditor"><summary id="opsOrderHeading">+ Agregar pedido</summary><form id="opsOrderForm"><div id="opsOrderLines"></div><button type="button" id="opsAddLine" class="soft">+ Artículo</button><label>Indicaciones para cocina<textarea id="opsOrderNote" maxlength="500"></textarea></label><button>Guardar pedido</button><button type="button" id="opsCancelEdit" class="soft" hidden>Cancelar edición</button></form></details><h3>Cobro y cierre</h3><div class="ops-balance"><strong>Total ${money(x.totalCents)}</strong><span>Pagado ${money(x.paidCents)}</span><b>Saldo ${money(x.balanceCents)}</b></div>${snapshot.features.manualPayments ? `<details id="opsPaymentEditor"><summary>Registrar pago recibido</summary><p>Registro manual del operario. No realiza cobros ni verifica Mercado Pago.</p><form id="opsPaymentForm"><div class="ops-fields"><label>Importe<input name="amount" type="number" min="0.01" step="0.01" max="${x.balanceCents / 100}" value="${x.balanceCents / 100}" required></label><label>Medio<select name="method"><option value="cash">Efectivo</option><option value="card">Tarjeta</option><option value="transfer">Transferencia</option><option value="mercadopago_manual">Mercado Pago · confirmado manualmente</option></select></label></div><label>Referencia / observación<input name="note" maxlength="200"></label><button ${x.balanceCents <= 0 ? 'disabled' : ''}>Confirmar pago recibido</button></form></details>` : ''}<div>${s.payments.map(p => `<p>${p.voidedAt ? 'Anulado' : 'Pago'} · ${money(p.amountCents)} · ${esc(({cash:'Efectivo',card:'Tarjeta',transfer:'Transferencia',mercadopago_manual:'Mercado Pago manual'})[p.method])}${!p.voidedAt && snapshot.features.manualPayments ? ` <button type="button" data-void-payment="${p.id}">Anular con motivo</button>` : ''}</p>`).join('')}</div><button type="button" id="opsClose" class="soft">Cerrar cuenta y liberar mesa</button>${x.balanceCents > 0 ? '<p class="hint">Registrá el pago recibido antes de cerrar la cuenta.</p>' : ''}<div id="opsCloseReview" hidden></div><p id="opsDetailMessage" role="status" aria-live="polite"></p><details><summary>Movimientos de esta cuenta</summary>${s.audit.slice(-20).reverse().map(a => `<p>${new Date(a.at).toLocaleString('es-AR')} · ${esc(a.by)} · ${esc(({ open:'Apertura / reserva',details:'Datos de mesa',addOrder:'Pedido agregado',editOrder:'Pedido modificado',orderStatus:'Estado de pedido',payment:'Pago registrado',voidPayment:'Pago anulado',close:'Cierre' })[a.action] || a.action)} ${esc(a.reason)}</p>`).join('')}</details>` : ''}`;
    if(snapshot.features.guestNotifications) $('opsDetail').insertAdjacentHTML('beforeend','<details><summary>Enviar aviso al cliente</summary><form id="opsNotifyForm"><label>Mensaje<textarea name="body" maxlength="300" required placeholder="Tu pedido está listo"></textarea></label><button>Enviar aviso a esta mesa</button></form></details>');
    editingOrder = ''; if (active) addLine();
  }
  function addLine(item) {
    const row = document.createElement('div'); row.className = 'ops-line';
    const available = snapshot.catalog.filter(x => x.disponible || x.id === item?.productId);
    if (item && !available.some(x => x.id === item.productId)) available.unshift({ id:item.productId, nombre:item.nombre, precio:item.unitPrice });
    row.innerHTML = `<select aria-label="Artículo">${available.map(x => `<option value="${x.id}" ${x.id === item?.productId ? 'selected' : ''}>${esc(x.nombre)} · ${money(x.precio * 100)}</option>`).join('')}</select><input aria-label="Cantidad" type="number" min="1" max="20" value="${item?.quantity || 1}"><button type="button" data-remove-line>Quitar</button>`;
    $('opsOrderLines').append(row);
  }
  async function load(forceDetail = false, reloadSettings = false) {
    if (!tenant) return; const seq = ++requestSequence;
    try { const data = await api('/api/resto/operations'); if (seq !== requestSequence) return; snapshot = data; drawBoard(); if (forceDetail || (!detailDirty && !editingOrder && !$('opsDetail').contains(document.activeElement))) drawDetail(); }
    catch (error) { if (seq === requestSequence) message(error.message); }
  }
  async function action(name, payload = {}) {
    const x = table(); if (!x) return;
    const detailRevision = Number($('opsDetail').dataset.revision ?? x.revision);
    try { await api('/api/resto/operations/' + x.id, { action:name, revision:detailRevision, ...payload }); detailDirty = false; editingOrder = ''; await load(true); message(name === 'close' ? 'Cuenta cerrada. Mesa libre.' : 'Cambios guardados.'); }
    catch (error) { message(error.message); }
  }
  const originalDrawDetail = drawDetail;
  drawDetail = () => { originalDrawDetail(); if (table()) $('opsDetail').dataset.revision = table().revision; };
  root.addEventListener('input', e => { if ($('opsDetail').contains(e.target)) detailDirty = true; });
  root.addEventListener('click', async e => {
    const button = e.target.closest('button'); if (!button) return;
    if(button.dataset.view){showView(button.dataset.view);return;}
    if(button.dataset.filter){$('opsFilter').value=button.dataset.filter;drawBoard();document.querySelectorAll('[data-filter]').forEach(el=>el.setAttribute('aria-pressed',String(el===button)));return;}
    if(button.id==='opsHideDetail'){if(detailDirty && !confirm('¿Descartar los cambios sin guardar?'))return;selectedId='';detailDirty=false;drawDetail();drawBoard();}
    if (button.dataset.selectTable) { if (detailDirty && !confirm('Hay cambios sin guardar. ¿Cambiar de mesa?')) return; selectedId = button.dataset.selectTable; showView('salon'); drawDetail(); drawBoard(); if(window.innerWidth<1050)$('opsDetail').scrollIntoView?.({block:'start',behavior:'smooth'}); }
    if (button.id === 'opsReloadDetail') { if (!detailDirty || confirm('¿Descartar los cambios sin guardar y actualizar?')) await load(true); }
    if (button.dataset.importLegacy && confirm('¿Incorporar este pedido pendiente a la cuenta de esta mesa?')) await action('importLegacy', { eventId:button.dataset.importLegacy });
    if (button.id === 'opsAddLine') { addLine(); detailDirty = true; }
    if (button.hasAttribute('data-remove-line')) { button.closest('.ops-line').remove(); detailDirty = true; }
    if (button.dataset.editOrder) { const order = table().service.orders.find(x => x.id === button.dataset.editOrder); editingOrder = order.id; $('opsOrderEditor').open = true; $('opsOrderLines').innerHTML = ''; order.items.forEach(addLine); $('opsOrderNote').value = order.note; $('opsOrderHeading').textContent = 'Editar pedido'; $('opsCancelEdit').hidden = false; detailDirty = true; $('opsOrderHeading').scrollIntoView({ block:'center', behavior:'smooth' }); }
    if (button.id === 'opsCancelEdit') { detailDirty = false; drawDetail(); }
    if (button.dataset.orderState) { const reason = button.dataset.orderState === 'cancelled' ? prompt('Motivo de cancelación:') : ''; if (button.dataset.orderState === 'cancelled' && !reason) return; await action('orderStatus', { orderId:button.dataset.orderId, status:button.dataset.orderState, reason }); }
    if (button.dataset.voidPayment) { const reason = prompt('Motivo de anulación del pago:'); if (reason) await action('voidPayment', { paymentId:button.dataset.voidPayment, reason }); }
    if (button.id === 'opsClose') {
      detailDirty = true;
      const x = table(), pending = x.service.orders.filter(o => !['served','cancelled'].includes(o.status)).length;
      const review = $('opsCloseReview'); review.hidden = false;
      review.innerHTML = x.balanceCents > 0
        ? '<h3>No se puede cerrar todavía</h3><p>Saldo pendiente: <strong>' + money(x.balanceCents) + '</strong>. Registrá el pago recibido antes de liberar la mesa.</p>' + (snapshot.features.manualPayments ? '<button type="button" id="opsGoPayment">Ir al registro de pago</button>' : '<p>El registro de pagos está deshabilitado en Configuración de dominio.</p>')
        : '<h3>Confirmar cierre de mesa ' + esc(x.label) + '</h3><p>Saldo: ' + money(x.balanceCents) + '. Se cerrará esta cuenta y la mesa quedará libre.</p><form id="opsCloseForm">' + (pending ? '<p>Hay ' + pending + ' pedido(s) que todavía no figuran entregados.</p><label class="ops-confirm-delivery"><input id="opsConfirmDelivered" type="checkbox" required>Confirmo que estos pedidos ya fueron entregados. Marcarlos como entregados al cerrar.</label>' : '<p>Todos los pedidos están entregados o cancelados.</p>') + '<button>Confirmar cierre</button><button type="button" id="opsCancelClose" class="soft">Volver</button></form>';
      review.scrollIntoView?.({block:'nearest',behavior:'smooth'});
    }
    if (button.id === 'opsCancelClose') $('opsCloseReview').hidden = true;
    if (button.id === 'opsGoPayment') { $('opsPaymentEditor').open = true; $('opsPaymentForm')?.scrollIntoView?.({block:'center',behavior:'smooth'}); $('opsPaymentForm')?.elements.amount.focus(); }
    if (button.dataset.attend) { try { await api('/api/resto/events/' + button.dataset.attend, { status:'done' }, 'PATCH'); await load(true); } catch (error) { message(error.message); } }
  });
  root.addEventListener('submit', async e => {
    e.preventDefault(); const form = e.target, button = e.submitter; if (button) button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      if(form.id==='opsNotifyForm'){const result=await api('/api/resto/tables/'+table().id+'/notifications',{title:'Mensaje del restaurante',body:data.body});form.reset();detailDirty=false;message('Aviso enviado a '+result.recipients+' cliente(s).');}
      if (form.id === 'opsCloseForm') await action('close', { confirmDelivered:!!$('opsConfirmDelivered')?.checked });
      if (form.id === 'opsDetailsForm') await action(table().service && table().service.status !== 'closed' ? 'details' : 'open', data);
      if (form.id === 'opsOrderForm') { const items = [...$('opsOrderLines').children].map(row => ({ id:row.querySelector('select').value, quantity:Number(row.querySelector('input').value) })); await action(editingOrder ? 'editOrder' : 'addOrder', { orderId:editingOrder, items, note:$('opsOrderNote').value, requestId:crypto.randomUUID() }); }
      if (form.id === 'opsPaymentForm' && confirm('¿Confirmás que recibiste este importe?')) await action('payment', data);
      if (form.id === 'opsAiForm') { $('opsAiAnswer').textContent = 'Consultando…'; $('opsAiAnswer').textContent = (await api('/api/resto/operations-ai', { question:$('opsAiQuestion').value })).answer; }
    } catch (error) { message(error.message); if (form.id === 'opsAiForm') $('opsAiAnswer').textContent = error.message; }
    finally { if (button?.isConnected) button.disabled = false; }
  });
  function showView(view){root.dataset.view=view;root.querySelectorAll('[data-view]').forEach(el=>el.toggleAttribute('aria-current',el.dataset.view===view));for(const [id,key] of [['kitchenSection','kitchen'],['historySection','history'],['operatorAiSection','ai']])$(id).open=view===key;document.querySelectorAll('[data-workspace-view]').forEach(el=>el.hidden=el.dataset.workspaceView!==view);}
  $('opsFilter').onchange = drawBoard;
  function setTenant(value) { if (!value || value === tenant) return; tenant = value; showView('salon'); $('opsAttention').innerHTML=''; $('opsMetrics').innerHTML=''; $('opsPriorities').innerHTML=''; selectedId = ''; snapshot = null; detailDirty = false; editingOrder = ''; $('opsDetail').textContent = 'Seleccioná una mesa.'; $('opsBoard').textContent = 'Cargando…'; $('opsAiAnswer').textContent = ''; load(true,true); }
  window.addEventListener('restaurant-domain', e => setTenant(e.detail));
  if ($('domain').value) setTenant($('domain').value);
  setInterval(() => { if (!document.hidden) load(); }, 8000);
})();
