// Asisto | Version: 5.00.160 | Fecha: 2026-09-18
(() => {
  const base = document.body.dataset.base;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let items = [], cart = {}, toastTimer, ordersEnabled = true, features = {}, configLoaded = false, sending = false, requestFingerprint = '', orderRequestId = '', accountBalance = null;
  const visitorKey = `asistoRestoVisitor:${base}`;
  let visitorId = localStorage.getItem(visitorKey);
  if (!/^[a-f0-9-]{36}$/.test(visitorId || '')) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    visitorId = [...bytes].map((byte, index) => (index === 4 || index === 6 || index === 8 || index === 10 ? '-' : '') + byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(visitorKey, visitorId);
  }
  const cursorKey = `asistoRestoCursor:${base}`;
  let notificationCursor = localStorage.getItem(cursorKey) || '';
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
  function renderMenu() {
    const groups = new Map();
    for (const item of items) {
      const category = String(item.categoria || 'Carta').trim() || 'Carta';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    }
    $('menu').innerHTML = [...groups].map(([category, products]) => `<details><summary>${esc(category)} <small>${products.length}</small></summary><div class="category-items">${products.map(item => `<div class="item">${item.imagen ? `<img class="item-image" src="${esc(item.imagen)}" alt="${esc(item.nombre)}" loading="lazy">` : ''}<div class="item-head"><strong>${esc(item.nombre)}</strong><span class="price">${price(item.precio)}</span></div><p>${esc(item.observacion)}</p>${ordersEnabled ? `<button data-add="${esc(item.id)}" ${item.disponible ? '' : 'disabled'}>${item.disponible ? 'Agregar' : 'No disponible'}</button><span class="item-feedback" data-feedback="${esc(item.id)}" aria-live="polite"></span>` : ''}</div>`).join('')}</div></details>`).join('') || '<p>No hay artículos disponibles en la carta.</p>';
  }
  function renderCart() {
    const count = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
    $('cart-count').textContent = `(${count})`;
    $('cart').innerHTML = Object.entries(cart).map(([id, quantity]) => {
      const item = items.find(product => product.id === id);
      return item ? `<p><span>${esc(item.nombre)} × ${quantity} · ${price(item.precio * quantity)}</span><button data-remove="${esc(id)}" aria-label="Quitar uno de ${esc(item.nombre)}">−</button></p>` : '';
    }).join('') || '<p>Todavía no agregaste platos.</p>';
  }
  document.addEventListener('click', event => {
    const add = event.target.closest('[data-add]');
    if (add && !add.disabled) {
      if (sending) return;
      const id = add.dataset.add, item = items.find(product => product.id === id);
      if (!item) return;
      if ((cart[id] || 0) >= 20) return notify('Máximo 20 unidades por artículo.');
      cart[id] = (cart[id] || 0) + 1;
      renderCart();
      const feedback = add.parentElement.querySelector('[data-feedback]');
      feedback.textContent = `Agregado ✓ (${cart[id]})`;
      notify(`${item.nombre} agregado al pedido`);
      return;
    }
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      if (sending) return;
      const id = remove.dataset.remove;
      cart[id]--;
      if (!cart[id]) delete cart[id];
      renderCart();
      const feedback = [...document.querySelectorAll('[data-feedback]')].find(element => element.dataset.feedback === id);
      if (feedback) feedback.textContent = cart[id] ? `Agregado ✓ (${cart[id]})` : '';
    }
  });
  async function action(type) {
    try {
      await post('/events', { type, visitorId });
      $('msg').textContent = type === 'call' ? 'Avisamos al mozo.' : 'Pediste la cuenta.';
    } catch (error) { $('msg').textContent = error.message; }
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
      sending = true; $('order').disabled = true; $('order').textContent = 'Enviando…';
      await post('/events', { ...payload, requestId:orderRequestId });
      requestFingerprint = ''; orderRequestId = '';
      cart = {};
      $('note').value = '';
      renderCart();
      document.querySelectorAll('[data-feedback]').forEach(element => { element.textContent = ''; });
      $('msg').textContent = 'Pedido enviado al restaurante.';
      notify('Pedido enviado al restaurante');
      pollAccount();
    } catch (error) { $('msg').textContent = error.message; }
    finally { sending = false; $('order').disabled = false; $('order').textContent = 'Enviar pedido'; }
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
        notify(notification.body);
        if ('Notification' in window && Notification.permission === 'granted') {
          try { new Notification(notification.title, { body: notification.body, tag: notification.id }); } catch (_) {}
        }
        notificationCursor = notification.id;
        localStorage.setItem(cursorKey, notificationCursor);
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
    try {
      const response = await fetch(base + '/account?visitorId=' + encodeURIComponent(visitorId));
      if (!response.ok) return;
      const result = await response.json();
      const states = { received:'Recibido', preparing:'En preparación', ready:'Listo para entregar', served:'Entregado', cancelled:'Cancelado' };
      $('guestOrderStatus').innerHTML = (result.orders || []).map(order => `<article class="guest-message"><strong>${states[order.status] || 'Recibido'}</strong><p>${order.items.map(item => `${item.quantity} × ${esc(item.nombre)}`).join(' · ')}</p><p>${price(order.totalCents / 100)}</p></article>`).join('') || '<p>Cuando envíes tu pedido, podrás seguir su estado acá.</p>';
      accountBalance = typeof result.balanceCents === 'number' ? result.balanceCents : null;
      if (accountBalance !== null) $('guestOrderStatus').innerHTML += `<p><strong>Cuenta completa de la mesa: ${price(result.totalCents / 100)}</strong></p><p>Pagado: ${price(result.paidCents / 100)} · Saldo: ${price(accountBalance / 100)}</p>${result.closed ? '<p>Cuenta cerrada. ¡Gracias por visitarnos!</p>' : ''}`;
      $('splitBill').hidden = features.splitBill === false || accountBalance === null || result.closed;
      splitEstimate();
    } catch (_) {}
  }
  $('splitGuests').oninput = splitEstimate;
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
    if (!ordersEnabled) document.querySelector('.intro p').textContent = 'Explorá nuestra carta y elegí algo rico para disfrutar.';
    renderMenu(); renderCart(); refreshGuest();
  }).catch(() => { $('menu').textContent = 'No se pudo cargar la carta. Recargá la página para reintentar.'; });
})();
