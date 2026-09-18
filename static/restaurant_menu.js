// Asisto | Version: 5.00.158 | Fecha: 2026-09-18
(() => {
  const base = document.body.dataset.base;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let items = [], cart = {}, toastTimer;
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
    $('menu').innerHTML = [...groups].map(([category, products]) => `<details><summary>${esc(category)} <small>${products.length}</small></summary><div class="category-items">${products.map(item => `<div class="item"><div class="item-head"><strong>${esc(item.nombre)}</strong><span class="price">${price(item.precio)}</span></div><p>${esc(item.observacion)}</p><button data-add="${esc(item.id)}" ${item.disponible ? '' : 'disabled'}>${item.disponible ? 'Agregar' : 'No disponible'}</button><span class="item-feedback" data-feedback="${esc(item.id)}" aria-live="polite"></span></div>`).join('')}</div></details>`).join('') || '<p>No hay artículos disponibles en la carta.</p>';
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
      const id = add.dataset.add, item = items.find(product => product.id === id);
      if (!item) return;
      cart[id] = (cart[id] || 0) + 1;
      renderCart();
      const feedback = add.parentElement.querySelector('[data-feedback]');
      feedback.textContent = `Agregado ✓ (${cart[id]})`;
      notify(`${item.nombre} agregado al pedido`);
      return;
    }
    const remove = event.target.closest('[data-remove]');
    if (remove) {
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
      await post('/events', { type });
      $('msg').textContent = type === 'call' ? 'Avisamos al mozo.' : 'Pediste la cuenta.';
    } catch (error) { $('msg').textContent = error.message; }
  }
  $('call').onclick = () => action('call');
  $('bill').onclick = () => action('bill');
  $('order').onclick = async () => {
    try {
      if (!Object.keys(cart).length) throw Error('Agregá al menos un plato');
      await post('/events', { type: 'order', items: Object.entries(cart).map(([id, quantity]) => ({ id, quantity })), note: $('note').value });
      cart = {};
      $('note').value = '';
      renderCart();
      document.querySelectorAll('[data-feedback]').forEach(element => { element.textContent = ''; });
      $('msg').textContent = 'Pedido enviado al restaurante.';
      notify('Pedido enviado al restaurante');
    } catch (error) { $('msg').textContent = error.message; }
  };
  $('ask').onclick = async () => {
    try {
      $('answer').textContent = 'Consultando…';
      $('answer').textContent = (await post('/ask', { question: $('question').value })).answer;
    } catch (error) { $('answer').textContent = error.message; }
  };
  fetch(base + '/menu').then(response => {
    if (!response.ok) throw Error('No se pudo cargar la carta.');
    return response.json();
  }).then(result => { items = result.items || []; renderMenu(); renderCart(); }).catch(() => { $('menu').textContent = 'No se pudo cargar la carta.'; });
})();
