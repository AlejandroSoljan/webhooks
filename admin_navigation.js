// Asisto | Version: 5.00.186 | Fecha: 2026-09-22
// Presentation only: receives the existing, permission-filtered navigation.
const CONFIG_SECTIONS = Object.freeze({
  tenant_config: { title: 'Dominio', description: 'Datos del negocio, dominios secundarios y parámetros generales.', src: '/admin/tenant-config?embed=1' },
  canales: { title: 'Canales', description: 'Conexiones y credenciales de los canales de atención.', src: '/canales?embed=1' },
  comportamiento: { title: 'Asistente IA', description: 'Comportamiento, instrucciones y reglas del asistente.', src: '/comportamiento' },
  horarios: { title: 'Horarios', description: 'Disponibilidad y horarios de atención.', src: '/horarios' },
  order_config: { title: 'Reglas de pedidos', description: 'Validaciones y opciones para la toma de pedidos.', src: '/admin/order-config?embed=1' },
  client_access: { title: 'Clientes habilitados', description: 'Permisos de atención por número o identificador.', src: '/admin/client-phone-access?embed=1' },
});

const GROUPS = [
  { key: 'attention', title: 'Atención al cliente', description: 'Conversaciones, seguimiento y oportunidades.', icon: 'chat', keys: ['inbox', 'admin', 'followup', 'leads'] },
  { key: 'connections', title: 'Mensajes y conexiones', description: 'Estado y gestión de las sesiones conectadas.', icon: 'connection', keys: ['wweb', 'telegram'] },
  { key: 'operations', title: 'Ventas y operaciones', description: 'Catálogo, restaurante y viajes.', icon: 'box', keys: ['productos', 'resto', 'fleteros'] },
  { key: 'app', title: 'App del comercio', description: 'Notificaciones a los clientes con la app.', icon: 'phone', keys: ['notifications'] },
  { key: 'queue', title: 'Turnero', description: 'Emisión, atención, pantalla de llamados y estadísticas.', icon: 'queue', keys: ['queue_kiosk', 'queue_attention', 'queue_display', 'queue_stats'] },
  { key: 'costs', title: 'Consumos y facturación', description: 'Uso de IA, mensajes e importes a cobrar.', icon: 'chart', keys: ['token_control'] },
  { key: 'configuration', title: 'Configuración del negocio', description: 'Dominio, canales, asistente, horarios y reglas.', icon: 'settings', keys: Object.keys(CONFIG_SECTIONS) },
  { key: 'administration', title: 'Administración', description: 'Usuarios, accesos y pruebas del bot.', icon: 'shield', keys: ['users', 'web_access', 'bot_test'] },
];

function configurationItems(items) {
  return Object.keys(CONFIG_SECTIONS).flatMap(key => {
    const item = items.find(it => it.key === key);
    return item ? [{ ...item, ...CONFIG_SECTIONS[key], href: '/ui/configuracion?seccion=' + key }] : [];
  });
}

function navigationGroups(items) {
  const groups = GROUPS.map(group => ({ ...group, items: group.keys.flatMap(key => {
    const item = items.find(it => it.key === key);
    if (!item) return [];
    return [{ ...item, ...(CONFIG_SECTIONS[key] ? { title: CONFIG_SECTIONS[key].title, href: '/ui/configuracion?seccion=' + key } : {}) }];
  }) })).filter(group => group.items.length);
  // Future screens remain reachable even before they have a dedicated group.
  const known = new Set(['home', ...GROUPS.flatMap(group => group.keys)]);
  const other = items.filter(item => !known.has(item.key));
  if (other.length) groups.push({ key: 'other', title: 'Otras herramientas', description: 'Más funciones disponibles.', icon: 'box', items: other });
  return groups;
}

function configurationState(items, user, requestedSection, rawQuery = '') {
  const sections = configurationItems(items);
  const key = String(requestedSection || sections[0]?.key || '');
  const section = sections.find(item => item.key === key);
  if (!section) return null;
  const params = new URLSearchParams(rawQuery);
  params.delete('seccion');
  params.delete('embed');
  // Never carry a foreign domain into an ordinary user's embedded form.
  if (user.role !== 'superadmin') {
    params.set('tenant', String(user.tenantId || 'default'));
    params.set('tenantId', String(user.tenantId || 'default'));
  }
  const src = new URL(section.src, 'http://asisto.local');
  for (const [name, value] of params) src.searchParams.append(name, value);
  return { section, sections, src: src.pathname + src.search, query: params.toString() };
}

function icon(name) {
  const paths = {
    home: '<path d="m3 10 9-7 9 7v10H3zM9 20v-7h6v7"/>',
    chat: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0Z"/><path d="M7 10h10M7 14h6"/>',
    connection: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/>',
    box: '<path d="m3 7 9-4 9 4v10l-9 4-9-4Zm0 0 9 4 9-4m-9 4v10"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
    chart: '<path d="M4 3v18h17M8 16v-5m5 5V7m5 9V4"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    shield: '<path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5Z"/><path d="m8 12 3 3 5-6"/>',
    queue: '<path d="M4 5h16v11H4zM8 20h8M12 16v4"/><path d="M8 9h8m-8 3h5"/>',
  };
  return `<svg class="menuIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
}

module.exports = { CONFIG_SECTIONS, configurationItems, configurationState, navigationGroups, icon };
