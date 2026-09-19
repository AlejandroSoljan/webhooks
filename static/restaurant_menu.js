// Asisto | Version: 5.00.162 | Fecha: 2026-09-19
(() => {
  const base = document.body.dataset.base;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let items = [], cart = {}, toastTimer, ordersEnabled = true, features = {}, configLoaded = false, sending = false, requestFingerprint = '', orderRequestId = '', accountBalance = null;
  const readStorage = (storage, key) => { try { return window[storage].getItem(key); } catch (_) { return null; } };
  const writeStorage = (storage, key, value) => { try { window[storage].setItem(key, value); } catch (_) {} };
  const draftKey = `asistoRestoDraft:${base}`;
  let accountSequence = 0;
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
  async function post(path, data) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'No se pudo completar la solicitud');
    return result;
  }
  function notify(message) {
    $('toast').textContent = message;
    $('toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3000);
  }
  function openPanel(id) {
    if (id === 'cartDialog') renderCart();
    if (id === 'accountDialog') pollAccount();
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    $(id).showModal();
  }
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  });
  const magnifier = '<span class="zoom-hint" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg></span>';
  function renderMenu() {
    const groups = new Map();
    for (const item of items) {
      const category = String(item.categoria || 'Carta').trim() || 'Carta';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    }
    $('menu').innerHTML = [...groups].map(([category, products]) => `<details><summary><span class="category-label">${esc(category)}<small>${products.length} ${products.length === 1 ? 'opción' : 'opciones'}</small></span><span class="chevron" aria-hidden="true">⌄</span></summary><div class="category-items">${products.map(item => `<article class="item"><button class="dish-open" data-dish="${esc(item.id)}" aria-label="Ver ingredientes de ${esc(item.nombre)}"><strong>${esc(item.nombre)}</strong><span class="price">${price(item.precio)}</span><small>Ver ingredientes${item.disponible ? '' : ' · No disponible'}</small></button>${item.imagen ? `<button class="photo-button" data-dish="${esc(item.id)}" aria-label="Ampliar foto de ${esc(item.nombre)}"><img class="item-image" src="${esc(item.imagen)}" alt="${esc(item.nombre)}" loading="lazy">${magnifier}</button>` : ''}${ordersEnabled ? `<div class="item-add"><span class="item-feedback" data-feedback="${esc(item.id)}" aria-live="polite"></span><button data-add="${esc(item.id)}" ${item.disponible ? '' : 'disabled'}>${item.disponible ? '+ Agregar' : 'No disponible'}</button></div>` : ''}</article>`).join('')}</div></details>`).join('') || '<p>No hay artículos disponibles en la carta.</p>';
  }
  function renderCart() {
    const count = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
    $('cart-count').textContent = `(${count})`;
    const total = Object.entries(cart).reduce((sum,[id,quantity]) => sum + (items.find(item => item.id === id)?.precio || 0) * quantity, 0);
    $('cartBar').hidden = !ordersEnabled || !count;
    $('cartExtras').hidden = !count;
    $('cartBarLabel').textContent = `Ver mi pedido (${count})`;
    if (ordersEnabled) $('openAccount').textContent = count ? `Mi pedido (${count})` : 'Mi pedido';
    $('pendingAccount').hidden = !ordersEnabled || !count;
    $('pendingAccountText').textContent = `${count} artículo(s) sin enviar · ${price(total)}`;
    $('cartBarTotal').textContent = $('cartTotal').textContent = price(total);
    document.querySelectorAll('[data-feedback]').forEach(element => { const quantity = cart[element.dataset.feedback] || 0; element.textContent = quantity ? `Agregado ✓ (${quantity})` : ''; });
    $('cart').innerHTML = Object.entries(cart).map(([id, quantity]) => {
      const item = items.find(product => product.id === id);
      return item ? `<p><span>${esc(item.nombre)} × ${quantity} · ${price(item.precio * quantity)}</span><span class="quantity-controls"><button data-remove="${esc(id)}" aria-label="Quitar uno de ${esc(item.nombre)}">−</button><button data-increase="${esc(id)}" aria-label="Agregar uno de ${esc(item.nombre)}">+</button></span></p>` : '';
    }).join('') || '<p>Todavía no agregaste platos.</p>';
  }
  document.addEventListener('click', event => {
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
      $('helpStatus').textContent = $('msg').textContent;
      notify($('msg').textContent);
    } catch (error) { $('helpStatus').textContent = error.message; }
  }
  $('call').onclick = () => action('call');
  $('bill').onclick = () => action('bill');
  $('order').onclick = async () => {
    if (sending) return;
    try {
      if (!Object.keys(cart).length) throw Error('Agregá al menos un plato');
      const payload = { type:'order', visitorId, items:Object.entries(cart).map(([id, quantity]) => ({ id, quantity })), note:$('note').value };
      const fingerprint = JSON.stringify(payload);
      if (fingerprint !== requestFingerprint) { requestFingerprint = fingerprint; orderRequestId = crypto.randomUUID(); }
      saveDraft();
      sending = true; $('order').disabled = true; $('order').textContent = 'Enviando…';
      await post('/events', { ...payload, requestId:orderRequestId });
      requestFingerprint = ''; orderRequestId = '';
      cart = {};
      $('note').value = '';
      renderCart();
      saveDraft();
      document.querySelectorAll('[data-feedback]').forEach(element => { element.textContent = ''; });
      $('msg').textContent = 'Pedido enviado al restaurante.';
      notify('Pedido enviado al restaurante');
      await pollAccount();
      if (features.orderTracking !== false) openPanel('accountDialog');
    } catch (error) { $('msg').textContent = error.message; }
    finally { sending = false; $('order').disabled = false; $('order').textContent = 'Confirmar y enviar pedido'; }
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
      const response = await fetch(base + '/notifications?' + query);
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
        $('openHelp').textContent = 'Necesito algo · Nuevo aviso';
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
    if (!configLoaded || features.orderTracking === false) return;
    const sequence = ++accountSequence;
    try {
      const response = await fetch(base + '/account?visitorId=' + encodeURIComponent(visitorId));
      if (!response.ok) return;
      const result = await response.json();
      if (sequence !== accountSequence) return;
      $('trackOrder').hidden = !(result.orders || []).length || result.closed;
      const states = { received:'Recibido', preparing:'En preparación', ready:'Listo para entregar', served:'Entregado', cancelled:'Cancelado' };
      $('guestOrderStatus').innerHTML = (result.orders || []).map(order => `<article class="guest-message"><strong>${states[order.status] || 'Recibido'}</strong><p>${order.items.map(item => `${item.quantity} × ${esc(item.nombre)}`).join(' · ')}</p><p>${price(order.totalCents / 100)}</p></article>`).join('') || '<p>Cuando envíes tu pedido, podrás seguir su estado acá.</p>';
      accountBalance = typeof result.balanceCents === 'number' ? result.balanceCents : null;
      if (accountBalance !== null) $('guestOrderStatus').innerHTML += `<p><strong>Cuenta completa de la mesa: ${price(result.totalCents / 100)}</strong></p><p>Pagado: ${price(result.paidCents / 100)} · Saldo: ${price(accountBalance / 100)}</p>${result.closed ? '<p>Cuenta cerrada. ¡Gracias por visitarnos!</p>' : ''}`;
      $('splitBill').hidden = features.splitBill === false || accountBalance === null || result.closed;
      splitEstimate();
    } catch (_) {}
  }
  $('splitGuests').oninput = splitEstimate;
  $('note').oninput = saveDraft;
  $('payMercadoPago').onclick = () => { $('paymentInfo').textContent = 'Mercado Pago estará disponible próximamente. No se realizó ningún cobro. Coordiná el pago con el personal.'; notify('Mercado Pago: próximamente'); };
  function refreshGuest() {
    if (!configLoaded || document.hidden) return;
    if (features.guestNotifications !== false) registerVisitor().then(pollNotifications).catch(() => {});
    pollAccount();
  }
  setInterval(refreshGuest, 10000);
  fetch(base + '/menu').then(response => {
    if (!response.ok) throw Error('No se pudo cargar la carta.');
    return response.json();
  }).then(result => {
    features = result.features || {}; configLoaded = true;
    items = (result.items || []).map(item => features.showImages === false ? { ...item, imagen:'' } : item);
    ordersEnabled = result.ordersEnabled !== false && features.guestOrders !== false;
    $('pedido').hidden = !ordersEnabled;
    for (const [id, flag] of [['call','callWaiter'],['bill','requestBill'],['guestAiSection','guestAi'],['guestAccount','orderTracking'],['guestPayment','mercadoPago']]) $(id).hidden = features[flag] === false;
    document.querySelector('.guest-notifications').hidden = features.guestNotifications === false;
    $('openHelp').hidden = ['callWaiter','requestBill','guestAi','guestNotifications'].every(flag => features[flag] === false);
    $('openAccount').hidden = !ordersEnabled && features.orderTracking === false && features.mercadoPago === false;
    $('openAccount').dataset.open = ordersEnabled ? 'cartDialog' : 'accountDialog';
    $('openAccount').textContent = ordersEnabled ? 'Mi pedido' : 'Mi cuenta';
    $('viewSentOrders').hidden = features.orderTracking === false && features.mercadoPago === false;
    restoreDraft(); renderMenu(); renderCart(); refreshGuest();
  }).catch(() => { $('menu').textContent = 'No se pudo cargar la carta. Recargá la página para reintentar.'; });
})();
