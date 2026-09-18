// Asisto | Version: 5.00.154 | Fecha: 2026-09-17
(() => {
  const root = document.getElementById('operationsDashboard');
  if (!root) return;
  const el = id => document.getElementById(id);
  const tenant = el('opsTenant'), status = el('opsStatus'), button = el('opsRefresh');
  const labels = { whatsapp: 'sesiones WhatsApp', telegram: 'sesiones Telegram', sent: 'envíos WhatsApp', confirmationErrors: 'fallos de confirmación', review: 'conversaciones por revisar', contacts: 'contactos pendientes', orders: 'pedidos', leads: 'leads', tokens: 'consumo IA', tasks: 'tareas' };
  const order = ['sent', 'orders', 'tokens', 'leads', 'review', 'contacts', 'tasks', 'confirmationErrors'];
  const states = { online: 'Conectada', inactive: 'Sin heartbeat reciente', paused: 'Pausada', disabled: 'Deshabilitada', auth_failure: 'Fallo de autenticación', qr: 'Requiere QR', starting: 'Iniciando', iniciando: 'Iniciando', disconnected: 'Desconectada', polling_error: 'Error de conexión', webhook_error: 'Error de webhook' };
  const node = (tag, text, className) => { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; };
  const number = n => new Intl.NumberFormat('es-AR').format(n);
  let request = null, sequence = 0, tenantsError = '';
  function alert(text, type = '') { el('opsAlerts').append(node('p', text, 'opsAlert ' + type)); }
  function render(data) {
    el('opsMetrics').replaceChildren(); el('opsAlerts').replaceChildren(); el('opsConnections').replaceChildren();
    for (const metric of data.metrics.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))) {
      const card = node('a', '', 'opsMetric'); card.href = metric.href;
      card.append(node('span', metric.label), node('strong', number(metric.value)), node('small', metric.detail));
      el('opsMetrics').append(card);
    }
    for (const key of data.unavailable) {
      const card = node('div', '', 'opsMetric opsMissing');
      card.append(node('span', labels[key] || key), node('strong', 'No disponible'), node('small', 'La consulta no respondió. Podés reintentar con Actualizar.'));
      el('opsMetrics').append(card);
    }
    if (tenantsError) alert(tenantsError);
    if (data.unavailable.length) alert('Información parcial: no se pudieron consultar ' + data.unavailable.map(key => labels[key] || key).join(', ') + '.');
    const sessions = data.sessions;
    const disconnected = sessions.filter(s => !['online', 'paused', 'disabled'].includes(s.state));
    const differentVersion = sessions.filter(s => s.versionMismatch);
    if (disconnected.length) alert(number(disconnected.length) + (disconnected.length === 1 ? ' conexión necesita' : ' conexiones necesitan') + ' revisión. Verificá su estado en Mensajes y conexiones.');
    if (differentVersion.length) alert(number(differentVersion.length) + (differentVersion.length === 1 ? ' agente tiene' : ' agentes tienen') + ' una versión distinta de la indicada en su dominio.');
    const errors = data.metrics.find(m => m.key === 'confirmationErrors');
    if (errors?.value) alert(number(errors.value) + ' fallos de confirmación registrados hoy. Revisá Sesiones WhatsApp.');
    if (data.sessionsTruncated) alert('Vista limitada a las primeras 500 sesiones de cada canal. Los totales de conexiones son parciales.');
    if (sessions.length) {
      const wrap = el('opsConnections');
      wrap.append(node('h3', 'Conexiones · ' + number(sessions.filter(s => s.state === 'online').length) + ' de ' + number(sessions.length) + ' conectadas'));
      const tableWrap = node('div', '', 'opsTableWrap'), table = node('table', '', 'opsTable');
      const head = node('thead', ''), tr = node('tr', '');
      ['Dominio / canal', 'Número', 'Estado', 'Última señal', 'Versión / objetivo'].forEach(t => tr.append(node('th', t)));
      head.append(tr); table.append(head);
      const body = node('tbody', '');
      sessions.slice(0, 20).forEach(s => {
        const row = node('tr', '');
        row.append(node('td', s.tenantId + ' · ' + s.channel), node('td', s.number || '—'));
        const state = node('td', ''); state.append(node('span', states[s.state] || s.state || 'Sin estado', 'opsState ' + (s.state === 'online' ? 'opsOnline' : ''))); row.append(state);
        row.append(node('td', s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : 'Sin registro'), node('td', [s.version, s.target].filter(Boolean).join(' / ') || '—'));
        body.append(row);
      });
      table.append(body); tableWrap.append(table); wrap.append(tableWrap);
      if (sessions.length > 20) wrap.append(node('p', 'Se muestran 20 conexiones, priorizando las que requieren revisión. El detalle completo está en Mensajes y conexiones.', 'opsFootnote'));
    } else if (!data.unavailable.includes('whatsapp') && !data.unavailable.includes('telegram')) {
      el('opsConnections').append(node('p', 'Sin sesiones registradas para este filtro, o sin permiso para consultar conexiones.', 'opsFootnote'));
    }
    if (!data.metrics.length && !data.unavailable.length) alert('No hay indicadores habilitados para tus permisos. Los accesos disponibles siguen debajo.');
    status.textContent = 'Datos al ' + new Date(data.generatedAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) + ' · actualización automática cada 60 s mientras esta página está visible.';
  }
  async function load() {
    const current = ++sequence;
    if (request) request.abort();
    request = new AbortController();
    const controller = request;
    const timeout = setTimeout(() => controller.abort(), 15000);
    button.disabled = true; status.textContent = 'Consultando indicadores…';
    try {
      const response = await fetch('/api/operations-dashboard' + (tenant?.value ? '?tenant=' + encodeURIComponent(tenant.value) : ''), { signal: request.signal, headers: { Accept: 'application/json' } });
      if (!response.ok || response.redirected) throw new Error('unavailable');
      const data = await response.json();
      if (current === sequence) render(data);
    } catch {
      if (current === sequence) {
        status.textContent = 'No se pudo actualizar. Revisá tu conexión o sesión y volvé a intentar.';
        el('opsMetrics').replaceChildren(); el('opsAlerts').replaceChildren(); el('opsConnections').replaceChildren();
      }
    } finally { clearTimeout(timeout); if (current === sequence) button.disabled = false; }
  }
  async function init() {
    if (tenant) {
      try {
        const response = await fetch('/api/operations-dashboard/tenants', { signal: AbortSignal.timeout(10000) });
        if (!response.ok || response.redirected) throw new Error('tenants');
        const data = await response.json();
        data.tenants.forEach(t => { const option = node('option', t.id + (t.name ? ' · ' + t.name : '')); option.value = t.id; tenant.append(option); });
        const requested = new URLSearchParams(location.search).get('tenant') || '';
        if (data.tenants.some(t => t.id === requested)) tenant.value = requested;
        if (data.truncated) tenantsError = 'El selector muestra los primeros 2000 dominios.';
      } catch { tenantsError = 'No se pudo cargar el selector de dominios; se muestra la vista global.'; }
      tenant.addEventListener('change', () => {
        el('opsMetrics').replaceChildren(); el('opsAlerts').replaceChildren(); el('opsConnections').replaceChildren();
        const url = new URL(location.href); if (tenant.value) url.searchParams.set('tenant', tenant.value); else url.searchParams.delete('tenant');
        history.replaceState(null, '', url.pathname + url.search); load();
      });
    }
    button.addEventListener('click', load);
    load();
    setInterval(() => { if (!document.hidden && !button.disabled) load(); }, 60000);
  }
  init();
})();
