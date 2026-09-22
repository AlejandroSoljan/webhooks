// Asisto | Version: 5.00.184 | Fecha: 2026-09-21
(() => {
  const base = document.body.dataset.base;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let items = [], cart = {}, toastTimer, ordersEnabled = true, features = {}, configLoaded = false, sending = false, requestFingerprint = '', orderRequestId = '', accountBalance = null;
  const readStorage = (storage, key) => { try { return window[storage].getItem(key); } catch (_) { return null; } };
  const writeStorage = (storage, key, value) => { try { window[storage].setItem(key, value); } catch (_) {} };
  const draftKey = `asistoRestoDraft:${base}`;
  let accountSequence = 0, sentOrders = [];
  const receiptKey = `asistoRestoReceipts:${base}`;
  function thumbnail(item) {
    return item?.imagen && features.showImages !== false ? `<button class="photo-button" data-dish="${esc(item.id)}" aria-label="Ampliar foto de ${esc(item.nombre)}"><img class="item-image" src="${esc(item.imagen)}" alt="${esc(item.nombre)}" loading="lazy">${magnifier}</button>` : '';
  }
  function renderSent() {
    const states = { awaiting_confirmation:'Esperando confirmación', received:'Recibido', preparing:'En preparación', ready:'Listo para entregar', served:'Entregado', cancelled:'Cancelado' };
    $('sentSection').hidden = !sentOrders.length;
    $('sentOrders').innerHTML = sentOrders.map(order => {
      const step = {received:0,preparing:1,ready:1,served:2}[order.status];
      const tracking = features.orderTracking !== false;
      return `<article class="sent-card"><header><svg class="chef-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 17h10v4H7zM6 15a5 5 0 0 1-1-10 7 7 0 0 1 14 0 5 5 0 0 1-1 10v1H6z"/></svg><strong>${tracking ? states[order.status] || 'Enviado' : 'Enviado al restaurante'}</strong><small>${order.status === 'preparing' ? 'Estamos preparando tu pedido.' : order.status === 'ready' ? 'Tu pedido está listo para entregar.' : ''}</small></header>${tracking && step !== undefined ? `<ol class="progress" aria-label="Estado del pedido">${['Recibido','Preparando','Entregado'].map((label,index)=>`<li class="${index<=step?'done':''} ${index===step?'current':''}"><span>${index<step?'✓':''}</span>${label}</li>`).join('')}</ol>` : ''}${order.items.map(line=>{const item=items.find(i=>i.id===line.productId || i.id===line.id || i.nombre===line.nombre);return `<div class="order-row">${thumbnail(item)}<div class="row-copy"><strong>${esc(line.nombre)}</strong><small>${esc(item?.observacion || '').slice(0,100)}</small><span class="sent-quantity"><span aria-hidden="true">× ${line.quantity}</span><span class="sr-only">${line.quantity} × ${esc(line.nombre)}</span></span></div>${Number.isFinite(line.unitPrice) ? `<b>${price(line.unitPrice*line.quantity)}</b>` : ''}</div>`;}).join('')}<p class="cart-total">Total <strong>${price(order.totalCents/100)}</strong></p></article>`;
    }).join('');
    renderCart();
  }
  function saveReceipts() { writeStorage("sessionStorage", receiptKey, JSON.stringify({orders:sentOrders,at:Date.now()})); }
  function saveDraft() {
    writeStorage('sessionStorage', draftKey, JSON.stringify({ cart, note:$('note').value, requestFingerprint, orderRequestId, savedAt:Date.now() }));
  }
  function restoreDraft() {
    try {
      const draft = JSON.parse(readStorage('sessionStorage', draftKey) || 'null');
      if (!draft || Date.now() - draft.savedAt > 2 * 60 * 60 * 1000 || !Number.isFinite(draft.savedAt)) return;
      cart = Object.fromEntries(Object.entries(draft.cart || {}).filter(([id, quantity]) => Number.isInteger(quantity) && quantity > 0 && quantity <= 20 && items.some(item => item.id === id && item.disponible)).slice(0,30));
      $('note').value = String(draft.note || '').slice(0,500);
      requestFingerprint = typeof draft.requestFingerprint === 'string' ? draft.requestFingerprint : '';
      orderRequestId = typeof draft.orderRequestId === 'string' ? draft.orderRequestId : '';
    } catch (_) {}
  }
  const visitorKey = `asistoRestoVisitor:${base}`;
  let visitorId = readStorage('localStorage', visitorKey) || readStorage('sessionStorage', visitorKey);
  if (!/^[a-f0-9-]{36}$/.test(visitorId || '')) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    visitorId = [...bytes].map((byte, index) => (index === 4 || index === 6 || index === 8 || index === 10 ? '-' : '') + byte.toString(16).padStart(2, '0')).join('');
    writeStorage('localStorage', visitorKey, visitorId);
    writeStorage('sessionStorage', visitorKey, visitorId);
  }
  const cursorKey = `asistoRestoCursor:${base}`;
  let notificationCursor = readStorage('localStorage', cursorKey) || '';
  const price = value => '$ ' + Number(value || 0).toLocaleString('es-AR');
  const visitKey='asistoRestoVisit:'+base;
  const deviceKey='asistoRestoDevice:'+base;
  let deviceToken=readStorage('localStorage',deviceKey) || readStorage('sessionStorage',deviceKey);
  if(!/^[a-f0-9]{64}$/.test(deviceToken || '')){deviceToken=[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');writeStorage('localStorage',deviceKey,deviceToken);writeStorage('sessionStorage',deviceKey,deviceToken);}
  let visitToken=readStorage('sessionStorage',visitKey) || '',visitPolicy=null,deviceStatus='',scanning=false;
  function expireVisit(){visitToken='';writeStorage('sessionStorage',visitKey,'');$('syncStatus').textContent='Esta visita terminó o venció. Podés seguir viendo la carta; el personal debe habilitarte nuevamente.';$('tableAccount').hidden=true;$('splitBill').hidden=true;}
  async function scanDevice(request=false){
    if(!visitPolicy || scanning)return;
    scanning=true;
    try{
      const result=await post('/scan',{visitorId,deviceToken,...(request?{request:true,name:$('deviceName').value}:{})});
      deviceStatus=result.status;
      $('deviceAccess').hidden=result.status==='approved';
      if(result.status==='approved'){visitToken=deviceToken;writeStorage('sessionStorage',visitKey,visitToken);}else{visitToken='';writeStorage('sessionStorage',visitKey,'');}
      $('deviceState').textContent=result.label+' · '+({pending:'Esperando habilitación para realizar pedidos',approved:'Celular habilitado',blocked:'Acceso bloqueado',ended:'Visita finalizada'})[result.status];
      $('deviceHint').textContent=result.status==='approved'?'Ya podés usar las funciones disponibles de tu mesa.':result.status==='pending'?'':'Podés seguir viendo la carta. Consultá al personal para volver a habilitarte.';
      $('deviceHint').hidden=!$('deviceHint').textContent;
      $('deviceName').hidden=result.status==='approved';$('deviceAccess').querySelector('label').hidden=result.status==='approved';
      $('deviceRequest').hidden=result.status==='approved';
      $('deviceRequest').textContent=result.status==='pending'?'Actualizar mi nombre':'Solicitar habilitación';
    }catch(error){$('deviceState').textContent=error.message;}finally{scanning=false;}
  }
  $('deviceRequest').onclick=()=>scanDevice(true);
  async function ensureVisit(){
    if(!visitPolicy)return;
    await scanDevice();if(deviceStatus!=='approved' || !visitToken)throw Error(visitPolicy.operatorApproval?'El personal debe habilitar tu celular desde el panel. Tu pedido todavía no se envió.':'La mesa debe estar abierta y tu visita vigente. Consultá al personal.');
  }
  async function post(path, data) {
    if(path==='/events'){await ensureVisit();data={...data,visitToken};}
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-restaurant-visit':visitToken }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) {if(response.status===403 && path!=='/visit' && /visita|habilit/.test(result.error || '')) expireVisit();throw Error(result.error || 'No se pudo completar la solicitud');}
    return result;
  }
  function notify(message) {
    $('toast').textContent = message;
    $('toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3000);
  }
  let dishReturnPanel = '';
  function openPanel(id) {
    if(id === 'dishDialog') dishReturnPanel = document.querySelector('dialog[open]')?.id || '';
    if (id === 'cartDialog') { renderCart(); pollAccount(); }
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    $(id).showModal();
    $(id).scrollTop=0;
  }
  $('dishDialog').addEventListener('close',()=>{if(dishReturnPanel){const id=dishReturnPanel;dishReturnPanel='';openPanel(id);}});
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  });
  const magnifier = '<span class="zoom-hint" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg></span>';
  function renderMenu() {
    const query = ($('menuSearch').value || '').toLocaleLowerCase('es').trim();
    const openGroups = new Set([...document.querySelectorAll('#menu details[open]')].map(el=>el.dataset.category));
    const groups = new Map();
    for (const item of items) {
      if (query && ![item.nombre,item.categoria,item.observacion].join(' ').toLocaleLowerCase('es').includes(query)) continue;
      const category = String(item.categoria || 'Carta').trim() || 'Carta';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    }
    const categoryIcon = category => {
      const c=category.toLowerCase();
      const path=c.includes('bebida')?'<path d="M7 3h10l-1 18H8ZM8 8h8M14 3l2-2"/>':c.includes('postre')?'<path d="M4 11h16v10H4ZM4 16h16M7 11V7h10v4M12 7V3"/>':c.includes('entrada')?'<path d="M6 3v7M3 3v5a3 3 0 0 0 6 0V3M6 11v10M17 3c-4 6-4 10 1 10V3M18 13v8"/>':'<path d="M3 18h18M4 16a8 8 0 0 1 16 0ZM12 6V3M10 3h4"/>';
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+path+'</svg>';
    };
    $('menu').innerHTML = [...groups].map(([category, products]) => `<details data-category="${esc(category)}" ${query || openGroups.has(category)?'open':''}><summary>${categoryIcon(category)}<span class="category-label">${esc(category)}</span><span class="chevron" aria-hidden="true">⌄</span></summary><div class="category-items">${products.map(item => `<article class="item">${thumbnail(item)}<button class="dish-open" data-dish="${esc(item.id)}" aria-label="Ver ingredientes de ${esc(item.nombre)}"><strong>${esc(item.nombre)}</strong><small>${esc(item.observacion || 'Ver ingredientes')}${item.disponible?'':' · No disponible'}</small></button><div class="item-side"><span class="price">${price(item.precio)}</span>${ordersEnabled ? `<div data-menu-controls="${esc(item.id)}"></div><span class="item-feedback" data-feedback="${esc(item.id)}" aria-live="polite"></span>` : ''}</div></article>`).join('')}</div></details>`).join('') || '<p class="empty-state">No encontramos platos con esa búsqueda.</p>';
    renderCart();
  }
  function renderCart() {
    const count = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
    $('cart-count').textContent = count ? `(${count} sin enviar)` : '';
    $('draftTitle').hidden = !count;
    const total = Object.entries(cart).reduce((sum,[id,quantity]) => sum + (items.find(item => item.id === id)?.precio || 0) * quantity, 0);
    $('cartBar').hidden = !ordersEnabled || (!count && !sentOrders.length);
    $('cartExtras').hidden = !count;
    $('cartBarLabel').textContent = count ? `Ver mi pedido · ${count}` : 'Ver mi pedido';
    document.querySelectorAll('.nav-badge').forEach(el=>{el.hidden=!count;el.textContent=count;});
    $('cartTotal').textContent = price(total);
    $('cartBarTotal').textContent = count ? price(total) : 'Enviado ✓';
    document.querySelectorAll('[data-feedback]').forEach(element => { const quantity = cart[element.dataset.feedback] || 0; element.textContent = quantity ? `Agregado ✓ (${quantity})` : ''; });
    document.querySelectorAll('[data-menu-controls]').forEach(el=>{const id=el.dataset.menuControls,item=items.find(i=>i.id===id),quantity=cart[id]||0;el.innerHTML=quantity?`<span class="quantity-controls"><button data-remove="${esc(id)}" aria-label="Quitar uno de ${esc(item.nombre)}">−</button><span>${quantity}</span><button data-increase="${esc(id)}" aria-label="Agregar uno de ${esc(item.nombre)}">+</button></span>`:`<button class="add-button" data-add="${esc(id)}" ${item.disponible?'':'disabled'}>${item.disponible?'+ Agregar':'No disponible'}</button>`;});
    $('cart').innerHTML = Object.entries(cart).map(([id, quantity]) => {
      const item = items.find(product => product.id === id);
      return item ? `<article class="order-row">${thumbnail(item)}<div class="row-copy"><strong>${esc(item.nombre)}<span class="sr-only"> × ${quantity}</span></strong><small>${esc(item.observacion || '').slice(0,110)}</small><span class="quantity-controls"><button data-remove="${esc(id)}" aria-label="Quitar uno de ${esc(item.nombre)}">−</button><span>${quantity}</span><button data-increase="${esc(id)}" aria-label="Agregar uno de ${esc(item.nombre)}">+</button></span></div><div class="row-end"><b>${price(item.precio * quantity)}</b><button class="delete-item" data-delete="${esc(id)}" aria-label="Eliminar ${esc(item.nombre)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg></button></div></article>` : '';
    }).join('') || (sentOrders.length ? '' : '<p class="empty-state">Elegí platos de la carta y agregalos a tu pedido.</p>');
  }
  $('menuSearch').oninput = renderMenu;
  document.addEventListener('click', event => {
    if (event.target.closest('[data-home]')) { document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close()); return; }
    const deletion=event.target.closest('[data-delete]');
    if(deletion && !sending){delete cart[deletion.dataset.delete];renderCart();saveDraft();return;}
    const opener = event.target.closest('[data-open]');
    if (opener) openPanel(opener.dataset.open);
    if (event.target.closest('[data-close]')) event.target.closest('dialog').close();
    const dishButton = event.target.closest('[data-dish]');
    if (dishButton) {
      const item = items.find(product => product.id === dishButton.dataset.dish);
      if (item) {
        $('dishTitle').textContent = item.nombre;
        $('dishContent').innerHTML = `${item.imagen ? `<img src="${esc(item.imagen)}" alt="${esc(item.nombre)}">` : ''}<p class="price">${price(item.precio)}</p><p>${esc(item.observacion || 'Consultá al personal por los ingredientes de este plato.')}</p><small>Si tenés alergias, confirmá con el personal antes de pedir.</small>`;
        openPanel('dishDialog');
      }
    }
    const add = event.target.closest('[data-add], [data-increase]');
    if (add && !add.disabled) {
      if (sending) return;
      const id = add.dataset.add || add.dataset.increase, item = items.find(product => product.id === id);
      if (!item) return;
      if ((cart[id] || 0) >= 20) return notify('Máximo 20 unidades por artículo.');
      cart[id] = (cart[id] || 0) + 1;
      $('msg').textContent = '';
      renderCart();
      saveDraft();
      const feedback = [...document.querySelectorAll('[data-feedback]')].find(element => element.dataset.feedback === id);
      if (feedback) feedback.textContent = `Agregado ✓ (${cart[id]})`;
      notify(`${item.nombre} agregado al pedido`);
      return;
    }
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      if (sending) return;
      const id = remove.dataset.remove;
      if (!cart[id]) return;
      cart[id]--;
      if (!cart[id]) delete cart[id];
      renderCart();
      saveDraft();
      const feedback = [...document.querySelectorAll('[data-feedback]')].find(element => element.dataset.feedback === id);
      if (feedback) feedback.textContent = cart[id] ? `Agregado ✓ (${cart[id]})` : '';
    }
  });
  async function action(type) {
    try {
      await post('/events', { type, visitorId });
      $('msg').textContent = type === 'call' ? 'Avisamos al mozo.' : 'Pediste la cuenta.';
      $('helpStatus').textContent = $('orderHelpStatus').textContent = $('msg').textContent;
      notify($('msg').textContent);
    } catch (error) { $('helpStatus').textContent = $('orderHelpStatus').textContent = error.message; }
  }
  $('call').onclick = () => action('call');
  $('bill').onclick = $('orderBill').onclick = () => action('bill');
  $('orderCall').onclick = () => action('call');
  $('order').onclick = async () => {
    if (sending) return;
    try {
      if (!Object.keys(cart).length) throw Error('Agregá al menos un plato');
      const payload = { type:'order', visitorId, items:Object.entries(cart).map(([id, quantity]) => ({ id, quantity })), note:$('note').value };
      const fingerprint = JSON.stringify(payload);
      if (fingerprint !== requestFingerprint) { requestFingerprint = fingerprint; orderRequestId = crypto.randomUUID(); }
      saveDraft();
      sending = true; $('order').disabled = true; $('order').textContent = 'Enviando…';
      const receipt = await post('/events', { ...payload, requestId:orderRequestId });
      sentOrders.push({id:receipt.id || orderRequestId,status:receipt.status || 'received',items:payload.items.map(line => ({productId:line.id,nombre:items.find(item=>item.id===line.id).nombre,unitPrice:items.find(item=>item.id===line.id).precio,quantity:line.quantity})),totalCents:Math.round(payload.items.reduce((sum,line)=>sum+items.find(item=>item.id===line.id).precio*line.quantity,0)*100)});
      saveReceipts(); renderSent();
      requestFingerprint = ''; orderRequestId = '';
      cart = {};
      $('note').value = '';
      renderCart();
      saveDraft();
      document.querySelectorAll('[data-feedback]').forEach(element => { element.textContent = ''; });
      $('msg').textContent = '';
      $('cartDialog').scrollTop = 0;
      notify('Pedido enviado al restaurante');
      await pollAccount();
      $('cartDialog').scrollTop = 0;

    } catch (error) { $('msg').textContent = error.message; }
    finally { sending = false; $('order').disabled = false; $('order').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m22 2-7 20-4-9-9-4ZM22 2 11 13"/></svg>Enviar al restaurante'; }
  };
  $('ask').onclick = async () => {
    try {
      $('answer').textContent = 'Consultando…';
      $('answer').textContent = (await post('/ask', { question: $('question').value })).answer;
    } catch (error) { $('answer').textContent = error.message; }
  };
  async function registerVisitor() {
    await post('/visitors', { visitorId, browserNotifications: 'Notification' in window && Notification.permission === 'granted' });
  }
  async function pollNotifications() {
    try {
      const query = new URLSearchParams({ visitorId });
      if (notificationCursor) query.set('after', notificationCursor);
      const response = await fetch(base + '/notifications?' + query,{headers:{'x-restaurant-visit':visitToken}});
      if (!response.ok) return;
      const result = await response.json();
      for (const notification of result.notifications || []) {
        const card = document.createElement('article');
        card.className = 'guest-message';
        const heading = document.createElement('strong');
        heading.textContent = notification.title;
        const body = document.createElement('p');
        body.textContent = notification.body;
        card.append(heading, body);
        $('guestMessages').prepend(card);
        $('noticeCount').textContent = `(${$('guestMessages').children.length})`;
        $('openHelp').setAttribute('aria-label','Mozo · Nuevo aviso');
        notify(notification.body);
        if ('Notification' in window && Notification.permission === 'granted') {
          try { new Notification(notification.title, { body: notification.body, tag: notification.id }); } catch (_) {}
        }
        notificationCursor = notification.id;
        writeStorage('localStorage', cursorKey, notificationCursor);
      }
    } catch (_) {}
  }
  $('enableGuestAlerts').onclick = async () => {
    try { await ensureVisit(); } catch(error) { $('guestAlertStatus').textContent=error.message; return; }
    if (!('Notification' in window)) { $('guestAlertStatus').textContent = 'Este navegador no admite avisos. Los mensajes aparecerán aquí mientras la carta esté abierta.'; return; }
    const permission = await Notification.requestPermission();
    $('guestAlertStatus').textContent = permission === 'granted' ? 'Avisos activados mientras esta carta esté abierta.' : 'Los mensajes aparecerán en esta página mientras la tengas abierta.';
    registerVisitor().catch(() => {});
  };
  function splitEstimate() {
    const count = Number($('splitGuests').value);
    $('splitResult').textContent = accountBalance !== null && Number.isInteger(count) && count >= 1 && count <= 100 ? `${price(Math.ceil(accountBalance / count) / 100)} por persona, aproximadamente.` : 'Ingresá entre 1 y 100 comensales.';
  }
  async function pollAccount() {
    if (!configLoaded || features.orderTracking === false || visitPolicy && !visitToken) return;
    const sequence = ++accountSequence;
    try {
      const response = await fetch(base + '/account?visitorId=' + encodeURIComponent(visitorId),{headers:{'x-restaurant-visit':visitToken}});
      if(response.status===403){expireVisit();return;}
      if (!response.ok) throw Error('account');
      const result = await response.json();
      if (sequence !== accountSequence) return;
      sentOrders = result.orders || []; saveReceipts(); renderSent();
      $('syncStatus').textContent = '';
      $('tableAccount').hidden = typeof result.balanceCents !== 'number';
      $('trackOrder').hidden = !(result.orders || []).length || result.closed;
      $('guestOrderStatus').innerHTML = '';
      accountBalance = typeof result.balanceCents === 'number' ? result.balanceCents : null;
      if (accountBalance !== null) $('guestOrderStatus').innerHTML += `<p><strong>Cuenta completa de la mesa: ${price(result.totalCents / 100)}</strong></p><p>Pagado: ${price(result.paidCents / 100)} · Saldo: ${price(accountBalance / 100)}</p>${result.closed ? '<p>Cuenta cerrada. ¡Gracias por visitarnos!</p>' : ''}`;
      $('splitBill').hidden = features.splitBill === false || accountBalance === null || result.closed;
      splitEstimate();
    } catch (_) { $('syncStatus').textContent = 'No pudimos actualizar el estado. Tu pedido enviado sigue guardado; reintentamos automáticamente.'; }
  }
  $('splitGuests').oninput = splitEstimate;
  $('note').oninput = saveDraft;
  $('payMercadoPago').onclick = () => { $('paymentInfo').textContent = 'Mercado Pago estará disponible próximamente. No se realizó ningún cobro. Coordiná el pago con el personal.'; notify('Mercado Pago: próximamente'); };
  function refreshGuest() {
    if (!configLoaded || document.hidden) return;
    if (features.guestNotifications !== false && (!visitPolicy || visitToken)) registerVisitor().then(pollNotifications).catch(() => {});
    scanDevice();
    pollAccount();
  }
  setInterval(refreshGuest, 10000);
  fetch(base + '/menu').then(response => {
    if (!response.ok) throw Error('No se pudo cargar la carta.');
    return response.json();
  }).then(result => {
    features = result.features || {}; visitPolicy=result.visitPolicy || null; configLoaded = true; $('deviceAccess').hidden=!visitPolicy;
    items = (result.items || []).map(item => features.showImages === false ? { ...item, imagen:'' } : item);
    ordersEnabled = result.ordersEnabled !== false && features.guestOrders !== false;
    $('pedido').hidden = !ordersEnabled;
    for (const [id, flag] of [['call','callWaiter'],['bill','requestBill'],['guestAiSection','guestAi'],['guestAccount','orderTracking'],['guestPayment','mercadoPago']]) $(id).hidden = features[flag] === false;
    document.querySelector('.guest-notifications').hidden = features.guestNotifications === false;
    $('openHelp').hidden = ['callWaiter','requestBill','guestAi','guestNotifications'].every(flag => features[flag] === false);
    $('openAccount').hidden = !ordersEnabled && features.orderTracking === false && features.mercadoPago === false;
    $('openAccount').dataset.open = 'cartDialog';
    document.querySelectorAll('[data-nav-order-label]').forEach(el=>el.textContent=ordersEnabled?'Mi pedido':'Mi cuenta');
    document.querySelectorAll('[data-order-nav]').forEach(el=>el.hidden=$('openAccount').hidden);
    document.querySelectorAll('[data-help-nav]').forEach(el=>el.hidden=$('openHelp').hidden);
    $('aiShortcut').hidden=features.guestAi===false;
    $('orderCall').hidden=features.callWaiter===false;
    $('orderBill').hidden=features.requestBill===false;
    try { const saved = JSON.parse(readStorage('sessionStorage', receiptKey) || 'null'); if (saved && Date.now()-saved.at < 2*60*60*1000 && Array.isArray(saved.orders)) sentOrders=saved.orders; } catch (_) {}
    renderSent();
    restoreDraft(); renderMenu(); renderCart(); refreshGuest();
  }).catch(() => { $('menu').textContent = 'No se pudo cargar la carta. Recargá la página para reintentar.'; });
})();
