// Asisto | Version: 5.00.307 | Fecha: 2026-10-22
const { normalize, conversationResolved, fail } = require('./core');
function contextOnly(messages) {
  return messages.length > 0 && messages.every(m => {
    const t = normalize(m.text).replace(/["“”]/g, '');
    return !t || (m.fromMe && /^este es un mensaje automatico[\s.!:]*estoy fuera de mi horario laboral/.test(t)) ||
      /^(?:prueba|test|hola|hola ale|buen dia|buenos dias|buenas tardes|buenas noches|ok|oka|okaa|dale|dale dale|gracias|muchas gracias|perfecto|joya)[\s!.,:;]*$/.test(t) || /^[\s\p{P}\p{S}]+$/u.test(t);
  });
}
function summaryDecision(parsed, messages) {
  if (!parsed || parsed.status == null) return {}; // Older/injected analyzers remain compatible.
  if (!['Nuevo', 'En Proceso', 'Cerrado RESUELTO'].includes(parsed.status)) fail('task_assessment_invalid', 502);
  const index = parsed.resolutionMessage, quote = String(parsed.resolutionQuote || '').trim();
  if (parsed.status === 'Cerrado RESUELTO') {
    if (!Number.isInteger(index) || !messages[index] || quote.length < 3 || !normalize(messages[index].text).includes(normalize(quote)) ||
        !conversationResolved(messages.slice(index), { strictResolution: true })) fail('task_assessment_invalid', 502);
    if (/(?:sin confirmacion de resolucion|no (?:hay|se confirma|se puede considerar).{0,50}(?:resolucion|resuelt))/i.test(normalize(parsed.description))) fail('task_assessment_invalid', 502);
  }
  return { status: parsed.status, assessment: { version: 'task-assessment-v1', resolutionMessage: index ?? null, resolutionQuote: quote || null } };
}
function repairable(row) {
  const allowed = new Set(['generated','source_changed','tasks_merged','changed_source_summarized_ai','history_import_archived','title_regenerated_ai','description_summarized_ai']);
  return row && !['merged','ignored'].includes(row.state) && !row.hubspot?.ticketId &&
    !['saved','sending','uncertain'].includes(row.hubspot?.state) &&
    Array.isArray(row.events) && row.events.every(e => !e.by && allowed.has(e.action));
}
module.exports = { contextOnly, summaryDecision, repairable };
