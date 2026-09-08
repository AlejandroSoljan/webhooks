// Asisto | Version: 5.00.063 | Fecha: 2026-09-08
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
// Conservative, inspectable baseline. No inferred identity or automatic CRM writes.
function analyze(messages) {
  const description = messages.map(m => `${m.at.toISOString()} ${m.fromMe ? 'Operador' : 'Contacto'}: ${m.text}`).join('\n');
  const incoming = normalize(messages.filter(m => !m.fromMe).map(m => m.text).join(' '));
  const support = /\bmanager\b/.test(incoming) && /error|problema|no (puedo|funciona|imprime|abre)|como |configur|actualiz|necesito|consulta|falla/.test(incoming);
  if (!support) return { result: 'ignored', reason: 'no_explicit_manager_task', description };
  const errorType = /actualiz/.test(incoming) ? 'Actualización' : /configur/.test(incoming) ? 'Configuración / Implementación' : /como |consulta/.test(incoming) ? 'Consulta / Capacitacion' : 'Error software';
  return { result: 'draft', subject: messages.find(m => !m.fromMe && /manager/i.test(m.text))?.text.slice(0, 120) || 'Consulta sobre Manager', description, category: 'Soporte Remoto', errorType, status: 'Nuevo', channel: 'WhatsApp', confidence: 'needs_review' };
}
module.exports = { SupportError, fail, scopeOf, hash, scopedId, text, range, normalize, settings, excluded, groupMessages, analyze };
