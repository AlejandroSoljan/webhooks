// Asisto | Version: 5.00.164 | Fecha: 2026-09-19
(() => {
  const root = document.createElement('section'); root.id = 'restaurantOps'; root.className = 'section';
  document.querySelector('.metrics').after(root);
  root.innerHTML = `<div class="sectionHead"><div><p class="eyebrow">Sala en vivo</p><h2>Control de mesas</h2></div><label>Ver<select id="opsFilter"><option value="all">Todas las mesas</option><option value="attention">Necesitan atención</option><option value="occupied">Ocupadas</option><option value="free">Libres</option></select></label></div><p id="opsMessage" role="status" aria-live="polite"></p><div id="opsMetrics" class="ops-metrics"></div><div class="ops-layout"><div id="opsBoard"></div><section id="opsDetail" aria-label="Detalle de la mesa">Seleccioná una mesa.</section></div><details id="kitchenSection"><summary>Cocina · pedidos en preparación</summary><div id="opsKitchen"></div></details><details><summary>Últimas cuentas cerradas</summary><div id="opsHistory"></div></details><details id="operatorAiSection"><summary>Asistente de IA del operario</summary><p>Consultá prioridades, demoras, composición de platos y sugerencias de la carta.</p><form id="opsAiForm"><label>Consulta<input id="opsAiQuestion" maxlength="800" placeholder="¿Qué mesas requieren atención primero?" required></label><button>Consultar IA</button></form><p id="opsAiAnswer" class="ops-answer" role="status"></p></details><p class="hint">Las funciones y el logo se administran en Configuración de dominio → Variables restaurante y logo.</p>`;
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
    $('opsMetrics').innerHTML = `<span><b>${active.length}</b> mesas abiertas</span><span><b>${snapshot.tables.filter(x => x.pending.length).length}</b> con llamados o cuenta</span><span><b>${money(active.reduce((n,x) => n + x.balanceCents,0))}</b> por cobrar</span>`;
    const filter = $('opsFilter').value;
    $('opsBoard').innerHTML = snapshot.tables.filter(x => filter === 'all' || (filter === 'attention' ? x.pending.length || x.service?.orders.some(o => ['received','ready'].includes(o.status)) : filter === 'free' ? !x.service || x.service.status === 'closed' : x.service && x.service.status !== 'closed')).map(x => {
      const service = x.service, active = service && service.status !== 'closed', pending = x.pending;
      const mins = active ? Math.max(0, Math.floor((Date.now() - new Date(service.openedAt)) / 60000)) : 0;
      return `<button type="button" class="ops-table ${x.id === selectedId ? 'selected' : ''} ${pending.length ? 'attention' : ''}" data-select-table="${x.id}"><strong>Mesa ${esc(x.label)}</strong><span>${stateNames[service?.status || 'free']}</span>${active ? `<span>${service.guests} comensales · ${mins} min</span><span>${esc(service.waiter || 'Sin mozo asignado')}</span><b>${money(x.totalCents)}</b><span>${x.paymentStatus === 'paid' ? 'Pagada' : x.paymentStatus === 'partial' ? 'Pago parcial · ' + money(x.balanceCents) + ' pendiente' : 'Sin pago registrado'}</span>` : ''}${pending.some(p => p.type === 'call') ? '<em>Llama al mozo</em>' : ''}${pending.some(p => p.type === 'bill') ? '<em>Pidió la cuenta</em>' : ''}${x.legacyOrders.length ? '<em>Pedidos anteriores por revisar</em>' : ''}</button>`;
    }).join('') || '<p>No hay mesas con este filtro.</p>';
    $('kitchenSection').hidden = !snapshot.features.kitchenBoard;
    $('operatorAiSection').hidden = !snapshot.features.operatorAi;
    $('opsKitchen').innerHTML = snapshot.tables.flatMap(x => (x.service?.status !== 'closed' ? x.service?.orders || [] : []).filter(o => ['received','preparing','ready'].includes(o.status)).map(o => `<article class="ops-order"><strong>Mesa ${esc(x.label)} · ${stateNames[o.status]}</strong><p>${o.items.map(i => `${i.quantity} × ${esc(i.nombre)}`).join(' · ')}</p><p>${esc(o.note)}</p><button type="button" data-select-table="${x.id}">Ver mesa</button></article>`)).join('') || '<p>No hay pedidos pendientes de cocina.</p>';
    const currentClosed = snapshot.tables.filter(x => x.service?.status === 'closed').map(x => ({ id:x.service.id, tableLabel:x.label, closedAt:x.service.closedAt, totalCents:x.totalCents, paidCents:x.paidCents }));
    $('opsHistory').innerHTML = [...currentClosed, ...snapshot.history].sort((a,b) => new Date(b.closedAt) - new Date(a.closedAt)).slice(0,20).map(x => `<p>Mesa ${esc(x.tableLabel)} · ${new Date(x.closedAt).toLocaleString('es-AR')} · ${money(x.totalCents)} · pagado ${money(x.paidCents)}</p>`).join('') || '<p>No hay cuentas cerradas todavía.</p>';
  }
  function drawDetail() {
    const x = table(); if (!x) { $('opsDetail').textContent = 'Seleccioná una mesa.'; return; }
    detailDirty = false; const s = x.service, active = s && s.status !== 'closed';
    $('opsDetail').innerHTML = `<h2>Mesa ${esc(x.label)}</h2><button type="button" id="opsReloadDetail" class="soft">Actualizar detalle</button>${x.pending.map(p => `<p class="ops-pending">${p.type === 'call' ? 'Llamado al mozo' : 'Pidió la cuenta'} · ${new Date(p.createdAt).toLocaleTimeString('es-AR')} <button type="button" data-attend="${p.id}">Atender</button></p>`).join('')}${x.legacyOrders.map(o => `<article class="ops-order"><strong>Pedido anterior · ${money(o.total * 100)}</strong><p>${o.items.map(i => `${i.quantity} × ${esc(i.nombre)}`).join(', ')}</p><p>Este pedido anterior no está incluido en la cuenta nueva. Podés incorporarlo conservando su precio original.</p><button type="button" data-import-legacy="${o.id}">Incorporar a esta cuenta</button></article>`).join('')}<form id="opsDetailsForm"><div class="ops-fields"><label>Comensales<input name="guests" type="number" min="1" max="100" value="${active ? s.guests : 1}" required></label><label>Mozo<input name="waiter" maxlength="80" value="${esc(active ? s.waiter : '')}"></label><label>Estado<select name="status">${['occupied','reserved','bill_requested'].map(v => `<option value="${v}" ${s?.status === v ? 'selected' : ''}>${stateNames[v]}</option>`).join('')}</select></label></div><label>Notas de la mesa<textarea name="note" maxlength="500" placeholder="Reserva, preferencias, indicaciones">${esc(active ? s.note : '')}</textarea></label><button>${active ? 'Guardar mesa' : 'Abrir mesa / reservar'}</button></form>${active ? `<div class="ops-balance"><strong>Total ${money(x.totalCents)}</strong><span>Pagado ${money(x.paidCents)}</span><b>Saldo ${money(x.balanceCents)}</b></div><h3>Pedidos</h3><div>${s.orders.map(o => `<article class="ops-order"><strong>${stateNames[o.status]} · ${money(o.totalCents)}</strong><small>${o.origin === 'guest' ? 'Desde el celular' : 'Cargado por operario'} · ${new Date(o.createdAt).toLocaleTimeString('es-AR')}</small><p>${o.items.map(i => `${i.quantity} × ${esc(i.nombre)}`).join('<br>')}</p><p>${esc(o.note)}</p>${o.status !== 'cancelled' ? `<div class="ops-buttons">${x.paidCents === 0 ? `<button type="button" data-edit-order="${o.id}">Editar pedido</button>` : ''}${['preparing','ready','served'].filter(v => v !== o.status).map(v => `<button type="button" data-order-state="${v}" data-order-id="${o.id}">${stateNames[v]}</button>`).join('')}${x.paidCents === 0 ? `<button type="button" data-order-state="cancelled" data-order-id="${o.id}">Cancelar</button>` : ''}</div>` : ''}</article>`).join('') || '<p>Todavía no hay pedidos.</p>'}</div><h3 id="opsOrderHeading">Agregar pedido</h3><form id="opsOrderForm"><div id="opsOrderLines"></div><button type="button" id="opsAddLine" class="soft">+ Artículo</button><label>Indicaciones para cocina<textarea id="opsOrderNote" maxlength="500"></textarea></label><button>Guardar pedido</button><button type="button" id="opsCancelEdit" class="soft" hidden>Cancelar edición</button></form>${snapshot.features.manualPayments ? `<h3>Registrar pago recibido</h3><p>Registro manual del operario. No realiza cobros ni verifica Mercado Pago.</p><form id="opsPaymentForm"><div class="ops-fields"><label>Importe<input name="amount" type="number" min="0.01" step="0.01" max="${x.balanceCents / 100}" value="${x.balanceCents / 100}" required></label><label>Medio<select name="method"><option value="cash">Efectivo</option><option value="card">Tarjeta</option><option value="transfer">Transferencia</option><option value="mercadopago_manual">Mercado Pago · confirmado manualmente</option></select></label></div><label>Referencia / observación<input name="note" maxlength="200"></label><button ${x.balanceCents <= 0 ? 'disabled' : ''}>Confirmar pago recibido</button></form>` : ''}<div>${s.payments.map(p => `<p>${p.voidedAt ? 'Anulado' : 'Pago'} · ${money(p.amountCents)} · ${esc(({cash:'Efectivo',card:'Tarjeta',transfer:'Transferencia',mercadopago_manual:'Mercado Pago manual'})[p.method])}${!p.voidedAt && snapshot.features.manualPayments ? ` <button type="button" data-void-payment="${p.id}">Anular con motivo</button>` : ''}</p>`).join('')}</div><button type="button" id="opsClose">Cerrar cuenta y liberar mesa</button><div id="opsCloseReview" hidden></div><p id="opsDetailMessage" role="status" aria-live="polite"></p><details><summary>Movimientos de esta cuenta</summary>${s.audit.slice(-20).reverse().map(a => `<p>${new Date(a.at).toLocaleString('es-AR')} · ${esc(a.by)} · ${esc(({ open:'Apertura / reserva',details:'Datos de mesa',addOrder:'Pedido agregado',editOrder:'Pedido modificado',orderStatus:'Estado de pedido',payment:'Pago registrado',voidPayment:'Pago anulado',close:'Cierre' })[a.action] || a.action)} ${esc(a.reason)}</p>`).join('')}</details>` : ''}`;
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
    if (button.dataset.selectTable) { if (detailDirty && !confirm('Hay cambios sin guardar. ¿Cambiar de mesa?')) return; selectedId = button.dataset.selectTable; drawDetail(); drawBoard(); }
    if (button.id === 'opsReloadDetail') { if (!detailDirty || confirm('¿Descartar los cambios sin guardar y actualizar?')) await load(true); }
    if (button.dataset.importLegacy && confirm('¿Incorporar este pedido pendiente a la cuenta de esta mesa?')) await action('importLegacy', { eventId:button.dataset.importLegacy });
    if (button.id === 'opsAddLine') { addLine(); detailDirty = true; }
    if (button.hasAttribute('data-remove-line')) { button.closest('.ops-line').remove(); detailDirty = true; }
    if (button.dataset.editOrder) { const order = table().service.orders.find(x => x.id === button.dataset.editOrder); editingOrder = order.id; $('opsOrderLines').innerHTML = ''; order.items.forEach(addLine); $('opsOrderNote').value = order.note; $('opsOrderHeading').textContent = 'Editar pedido'; $('opsCancelEdit').hidden = false; detailDirty = true; $('opsOrderHeading').scrollIntoView({ block:'center', behavior:'smooth' }); }
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
    if (button.id === 'opsGoPayment') { $('opsPaymentForm')?.scrollIntoView?.({block:'center',behavior:'smooth'}); $('opsPaymentForm')?.elements.amount.focus(); }
    if (button.dataset.attend) { try { await api('/api/resto/events/' + button.dataset.attend, { status:'done' }, 'PATCH'); await load(true); } catch (error) { message(error.message); } }
  });
  root.addEventListener('submit', async e => {
    e.preventDefault(); const form = e.target, button = e.submitter; if (button) button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      if (form.id === 'opsCloseForm') await action('close', { confirmDelivered:!!$('opsConfirmDelivered')?.checked });
      if (form.id === 'opsDetailsForm') await action(table().service && table().service.status !== 'closed' ? 'details' : 'open', data);
      if (form.id === 'opsOrderForm') { const items = [...$('opsOrderLines').children].map(row => ({ id:row.querySelector('select').value, quantity:Number(row.querySelector('input').value) })); await action(editingOrder ? 'editOrder' : 'addOrder', { orderId:editingOrder, items, note:$('opsOrderNote').value, requestId:crypto.randomUUID() }); }
      if (form.id === 'opsPaymentForm' && confirm('¿Confirmás que recibiste este importe?')) await action('payment', data);
      if (form.id === 'opsAiForm') { $('opsAiAnswer').textContent = 'Consultando…'; $('opsAiAnswer').textContent = (await api('/api/resto/operations-ai', { question:$('opsAiQuestion').value })).answer; }
    } catch (error) { message(error.message); if (form.id === 'opsAiForm') $('opsAiAnswer').textContent = error.message; }
    finally { if (button?.isConnected) button.disabled = false; }
  });
  $('opsFilter').onchange = drawBoard;
  function setTenant(value) { if (!value || value === tenant) return; tenant = value; selectedId = ''; snapshot = null; detailDirty = false; editingOrder = ''; $('opsDetail').textContent = 'Seleccioná una mesa.'; $('opsBoard').textContent = 'Cargando…'; $('opsAiAnswer').textContent = ''; load(true,true); }
  window.addEventListener('restaurant-domain', e => setTenant(e.detail));
  if ($('domain').value) setTenant($('domain').value);
  setInterval(() => { if (!document.hidden) load(); }, 8000);
})();
