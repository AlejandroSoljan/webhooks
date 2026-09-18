// Asisto | Version: 5.00.157 | Fecha: 2026-09-18
(() => {
  const el = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  let tenant = '', firstLoad = true, seen = new Set(), loading = false;
  const query = () => '?tenant=' + encodeURIComponent(tenant);
  const request = async (url, options) => {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  };
  const message = text => { el('status').textContent = text; };
  function reflectTenant() {
    const url = new URL(location.href);
    url.searchParams.set('tenant', tenant);
    history.replaceState(null, '', url.pathname + url.search);
    try {
      if (parent !== window && parent.location.pathname === '/ui/resto') parent.history.replaceState(null, '', '/ui/resto' + query());
    } catch {}
    sessionStorage.setItem('asistoSelectedTenant', tenant);
    el('products').href = '/ui/productos' + query();
    el('pdf').href = '/api/resto/qr-pdf' + query();
  }
  function notifyNew(events) {
    if (firstLoad) { seen = new Set(events.map(x => x._id)); firstLoad = false; return; }
    const fresh = events.filter(x => !seen.has(x._id));
    events.forEach(x => seen.add(x._id));
    if (!fresh.length || localStorage.getItem('asistoRestaurantAlerts') !== 'yes' || !('Notification' in window) || Notification.permission !== 'granted') return;
    const item = fresh[0], title = fresh.length > 1 ? `${fresh.length} nuevas solicitudes` : `${{ call:'Llaman al mozo', bill:'Piden la cuenta', order:'Nuevo pedido' }[item.type] || 'Nueva solicitud'} · Mesa ${item.tableLabel}`;
    try { new Notification(title, { body: `Restaurante ${tenant}`, tag: `restaurant-${tenant}-${item._id}` }); } catch {}
    try { navigator.vibrate?.([200, 100, 200]); } catch {}
  }
  function renderEvents(events) {
    el('pendingCount').textContent = events.length;
    el('events').classList.toggle('empty', !events.length);
    el('events').innerHTML = events.length ? events.map(x => `<article class="event"><div class="eventHead"><h3>Mesa ${escape(x.tableLabel)} · ${escape(({ call:'Llama al mozo', bill:'Pide la cuenta', order:'Pedido' })[x.type] || x.type)}</h3><small>${new Date(x.createdAt).toLocaleString('es-AR')}</small></div>${x.items?.length ? `<ul>${x.items.map(i => `<li>${Number(i.quantity)} × ${escape(i.nombre)}</li>`).join('')}</ul><strong>Total: $ ${Number(x.total).toLocaleString('es-AR')}</strong>` : ''}${x.note ? `<p>Nota: ${escape(x.note)}</p>` : ''}<div><button data-done="${escape(x._id)}" type="button">Marcar atendido</button></div></article>`).join('') : 'No hay solicitudes pendientes. Cuando una mesa llame, pida la cuenta o haga un pedido aparecerá acá.';
  }
  function renderTables(tables) {
    el('tableCount').textContent = tables.filter(x => x.active).length;
    el('tables').classList.toggle('empty', !tables.length);
    el('tables').innerHTML = tables.length ? tables.map(x => `<article class="table"><h3>Mesa ${escape(x.label)}</h3><img src="/api/resto/tables/${encodeURIComponent(x.id)}/qr${query()}" alt="QR de mesa ${escape(x.label)}"><a href="${escape(x.url)}" target="_blank" rel="noopener">Abrir carta de esta mesa</a></article>`).join('') : 'Todavía no hay mesas. Agregá una para generar su QR.';
  }
  async function load() {
    if (!tenant || loading) return;
    loading = true;
    try {
      const [summary, events, tables] = await Promise.all([
        request('/api/resto/summary' + query()),
        request('/api/resto/events' + query()),
        request('/api/resto/tables' + query()),
      ]);
      el('menuCount').textContent = summary.menuCount;
      el('setup').classList.toggle('hidden', summary.enabled);
      el('addTable').disabled = !summary.enabled;
      el('pdf').classList.toggle('disabled', !tables.tables.length);
      renderEvents(events.events || []);
      renderTables(tables.tables || []);
      notifyNew(events.events || []);
      message(`Dominio ${tenant} · actualizado ${new Date().toLocaleTimeString('es-AR')}`);
    } catch (error) { message('No se pudo actualizar: ' + error.message); }
    finally { loading = false; }
  }
  async function init() {
    try {
      const data = await request('/api/resto/domains');
      const domains = data.domains || [];
      const select = el('domain');
      select.innerHTML = '';
      for (const domain of domains) {
        const option = document.createElement('option');
        option.value = domain.id;
        option.textContent = domain.id + (domain.name ? ' · ' + domain.name : '') + (domain.enabled ? '' : ' (sin activar)');
        select.appendChild(option);
      }
      if (!data.isSuper) el('domainControl').classList.add('hidden');
      const requested = new URLSearchParams(location.search).get('tenant') || '';
      const saved = sessionStorage.getItem('asistoSelectedTenant') || '';
      const selected = [requested, saved, domains.find(x => x.enabled)?.id, domains[0]?.id].find(id => domains.some(x => x.id === id));
      if (!selected) { message('No hay dominios disponibles.'); return; }
      tenant = selected;
      select.value = tenant;
      reflectTenant();
      await load();
      select.onchange = () => { tenant = select.value; firstLoad = true; seen = new Set(); reflectTenant(); load(); };
      el('refresh').onclick = load;
      el('enable').onclick = async () => { try { await request('/api/resto/config' + query(), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ enabled:true }) }); await load(); } catch (e) { message(e.message); } };
      el('addTable').onclick = async () => { const label = el('tableLabel').value.trim(); if (!label) return message('Escribí el nombre de la mesa.'); try { await request('/api/resto/tables' + query(), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ label }) }); el('tableLabel').value = ''; await load(); } catch (e) { message(e.message); } };
      el('events').onclick = async e => { const id = e.target.closest('[data-done]')?.dataset.done; if (!id) return; try { await request('/api/resto/events/' + encodeURIComponent(id) + query(), { method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify({ status:'done' }) }); await load(); } catch (error) { message(error.message); } };
      el('alerts').onclick = async () => { if (!('Notification' in window)) return message('Este navegador no admite avisos. Mantené el panel abierto para ver las solicitudes.'); const permission = await Notification.requestPermission(); if (permission === 'granted') { localStorage.setItem('asistoRestaurantAlerts','yes'); el('alerts').textContent = 'Avisos activados'; message('Los avisos llegarán mientras el panel esté abierto.'); } else message('El navegador no autorizó los avisos.'); };
      if (localStorage.getItem('asistoRestaurantAlerts') === 'yes' && 'Notification' in window && Notification.permission === 'granted') el('alerts').textContent = 'Avisos activados';
      setInterval(() => { if (!document.hidden) load(); }, 5000);
    } catch (error) { message('No se pudieron cargar los dominios: ' + error.message); }
  }
  init();
})();
