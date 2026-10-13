// Asisto | Version: 5.00.291 | Fecha: 2026-10-13
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function domainOptions(domains, current) {
  return [...new Set([current, ...domains.map(d => String(d._id))])].filter(Boolean).sort((a,b) => a.localeCompare(b)).map(id => `<option value="${escape(id)}"${id === current ? ' selected' : ''}>${escape(id)}</option>`).join('');
}
module.exports = { domainOptions };
