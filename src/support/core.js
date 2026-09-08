// Asisto | Version: 5.00.067 | Fecha: 2026-09-08
const crypto = require('node:crypto');

class SupportError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new SupportError(code, status); };
function scopeOf(user) {
  if (!user?.uid || !user?.tenantId) fail('authentication_required', 401);
  if (!['user', 'admin', 'superadmin'].includes(user.role)) fail('forbidden', 403);
  if (user.role !== 'superadmin' && Array.isArray(user.allowedPages) && !user.allowedPages.includes('support')) fail('forbidden', 403);
  return { tenantId: String(user.tenantId), userId: String(user.uid) };
}
const hash = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const scopedId = (scope, ...parts) => hash(scope.tenantId, scope.userId, ...parts);
function text(value, max = 200) {
  if (typeof value !== 'string' || value.length > max) fail('invalid_text');
  return value.trim();
}
function range(from, to) {
  const start = new Date(from), end = new Date(to);
  if (!from || !to || !Number.isFinite(+start) || !Number.isFinite(+end) || start >= end || end - start > 31 * 86400000) fail('invalid_range_max_31_days');
  return { start, end };
}
const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function settings(input = {}) {
  const inactivityMs = input.inactivityMs ?? 180000;
  if (!Number.isInteger(inactivityMs) || inactivityMs < 30000 || inactivityMs > 1800000) fail('invalid_inactivity');
  const lists = {};
  for (const key of ['excludedJids', 'excludedNames']) {
    const list = input[key] ?? [];
    if (!Array.isArray(list) || list.length > 500) fail('invalid_exclusions');
    lists[key] = [...new Set(list.map(v => text(v, 200)))];
  }
  if (input.mode && !['suggest', 'approval'].includes(input.mode)) fail('automation_not_enabled');
  return { inactivityMs, ...lists, mode: input.mode || 'approval' };
}
function excluded(message, config) {
  if (!/^[^@]+@(s\.whatsapp\.net|lid)$/.test(message.jid)) return true;
  return config.excludedJids.includes(message.jid) || config.excludedNames.some(n => normalize(n) === normalize(message.name));
}
function groupMessages(messages, inactivityMs) {
  const groups = [];
  for (const message of [...messages].sort((a, b) => +a.at - +b.at || a._id.localeCompare(b._id))) {
    const last = groups.at(-1);
    if (!last || message.at - last.at(-1).at > inactivityMs) groups.push([message]);
    else last.push(message);
  }
  return groups;
}
function taskTopics(value) {
  const input = normalize(value);
  return [
    ['stock', /stock|inventario|cereal/], ['accounting', /contabili|contable|totaliz|sumas? y saldos?/],
    ['invoicing', /factur|remito/], ['printing', /imprim|impresora/], ['access', /acceso|ingresar|contrasena/],
    ['update', /actualiz|nueva version/], ['server', /servidor|vps/], ['license', /licencia|abono/],
  ].filter(([, pattern]) => pattern.test(input)).map(([topic]) => topic);
}
function groupTasks(messages) {
  const groups = [];
  for (const message of [...messages].sort((a, b) => +a.at - +b.at || a._id.localeCompare(b._id))) {
    const last = groups.at(-1), input = normalize(message.text);
    const topics = taskTopics(input);
    const priorTopics = last ? new Set(last.filter(m => !m.fromMe).flatMap(m => taskTopics(m.text))) : new Set();
    const request = /necesit|podrias|podes|podemos|quisiera|consulta|problema|error|no (funciona|puedo|abre|imprime)|coordin|actualiz|configur/.test(input);
    const explicitChange = /otro tema|otra (cosa|consulta|tarea)|por otro lado|ademas|tambien/.test(input) && request;
    const differentRequest = last && message.at - last.at(-1).at > 180000 && request && topics.length > 0 && priorTopics.size > 0 && topics.every(topic => !priorTopics.has(topic));
    const continuation = /^(dale|ok|perfecto|listo|gracias|si[, .]|ya te|te paso|ahi|eso|seguimos|sigue|todavia)/.test(input);
    const longGap = last && message.at - last.at(-1).at > 86400000 && !continuation;
    if (!last || (!message.fromMe && (explicitChange || differentRequest || longGap))) groups.push([message]);
    else last.push(message);
  }
  return groups;
}
// Every non-excluded exchange is documented. Categories are reviewable HubSpot labels.
const ANALYZER_VERSION = 'support-task-groups-v4';
function analyze(messages) {
  const transcript = messages.map(m => `${m.at.toISOString()} ${m.fromMe ? 'Operador' : 'Contacto'}: ${m.text}`).join('\n');
  const incoming = normalize(messages.filter(m => !m.fromMe).map(m => m.text).join(' '));
  const outgoing = normalize(messages.filter(m => m.fromMe).map(m => m.text).join(' '));
  const context = incoming + ' ' + outgoing;
  if (!messages.some(message => message.text.trim())) return { result: 'ignored', reason: 'empty_conversation', description: transcript };
  const accounting = /contabili|contable|sumas? y saldos?|estado de resultado/.test(context);
  const totals = accounting && /totaliz/.test(incoming) && /cuenta/.test(incoming);
  const period = /fecha|periodo|mes|agosto/.test(incoming);
  const guidance = !!incoming && !!outgoing;
  const promisedVideo = /(?:paso|mando|voy a (?:pasar|enviar)|enviare).{0,60}vide(?:o|ito)/.test(outgoing);
  let description = transcript;
  if (totals) {
    const lines = ['Solicitud: Obtener un totalizador por cuenta' + (period ? ' para un rango de fechas' : '') + (/gasto/.test(incoming) ? ' para analizar los gastos.' : '.')];
    if (/modulo de contabilidad/.test(outgoing)) lines.push('Orientación brindada: Consultar los reportes del módulo de contabilidad.');
    if (/suma.*saldo/.test(outgoing)) lines.push('Se indicó consultar sumas y saldos por niveles.');
    if (/interfaz contable/.test(outgoing)) lines.push('Se explicó el uso de la interfaz contable para generar los movimientos hacia contabilidad.');
    if (promisedVideo) lines.push('Seguimiento: El operador indicó que enviaría un video explicativo; el envío y la resolución deben confirmarse.');
    description = lines.join('\n') + '\n\nConversación de origen:\n' + transcript;
  }
  const category = /servidor virtual|\bvps\b/.test(context) ? 'Soporte Servidor Virtual'
    : /preinstall|preinstal/.test(context) ? 'Soporte Preinstall'
    : /presencial|visita tecnica|en (tu|su) (oficina|local)/.test(context) ? 'Soporte en Lugar'
    : /desarroll|programar|nuevo modulo|agregar (una )?funcionalidad/.test(context) ? 'Desarrollo'
    : /implement|migracion|relevamiento|puesta en marcha/.test(context) ? 'Analisis e Implementacion'
    : /reunion|videollamada/.test(context) ? 'Reunion Cliente'
    : /licencia|abono|renovacion|pago del servicio/.test(context) ? 'Soporte Administrativo'
    : /impresora|disco rigido|memoria ram|teclado|monitor|hardware/.test(context) ? 'Soporte Hardware'
    : /(?:enviame|pasame|solicito|necesito).*(?:listado|archivo|datos)|exportar datos/.test(incoming) ? 'Solicitud de Datos'
    : 'Soporte Remoto';
  const errorType = /actualiz/.test(incoming) ? 'Actualización'
    : /preinstall|preinstal/.test(context) ? 'Preinstall'
    : /relevamiento/.test(context) ? 'Relevamiento'
    : /no (existe|tiene|permite).*funcionalidad|falta (una )?funcionalidad/.test(context) ? 'Falta funcionalidad'
    : /(?:depende|pendiente).*(?:proveedor|tercero)/.test(context) ? 'Falta soporte 3ro'
    : /error de configuracion|mal configurad/.test(context) ? 'Error configuración'
    : /error de usuario|error al cargar|cargaste mal/.test(context) ? 'Error usuario'
    : /configur|implement/.test(incoming) ? 'Configuración / Implementación'
    : /error|problema|no (puedo|funciona|imprime|abre)|falla/.test(incoming) ? 'Error software'
    : /consulta|necesit|como |posibilidad|totaliz/.test(incoming) ? 'Consulta / Capacitacion' : 'No es error';
  const subject = totals ? 'Totalizador' + (/gasto/.test(incoming) ? ' de gastos' : '') + ' por cuenta' + (period ? ' y período' : '') : /stock|inventario|cereal/.test(incoming) ? (/venta/.test(incoming) ? 'Consulta sobre stock y carga de ventas' : 'Consulta sobre stock') : accounting ? 'Consulta sobre reportes contables' : messages.find(m => !m.fromMe && /manager/i.test(m.text))?.text.slice(0, 120) || messages.find(m => !m.fromMe && m.text.trim())?.text.slice(0, 120) || 'Consulta de soporte';
  return { result: 'draft', subject, description, category, errorType, status: guidance || promisedVideo ? 'En Proceso' : 'Nuevo', channel: 'WhatsApp', confidence: 'needs_review' };
}
module.exports = { SupportError, fail, scopeOf, hash, scopedId, text, range, normalize, settings, excluded, groupMessages, groupTasks, analyze, ANALYZER_VERSION };
