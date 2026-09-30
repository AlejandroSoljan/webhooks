// Asisto | Version: 5.00.270 | Fecha: 2026-09-30
const OpenAI = require('openai');
const { fail, text } = require('./core');
const { resolveOpenAiApiKey } = require('../../ai_key_router');

const COST_OPTIMIZED_TASK_TENANTS = new Set(['ALSO', 'DEMJG', 'SANA']);

function resolveTasksModel(config, env, tenantId) {
  const configured = String(
    config?.openai?.tasks_model ||
    config?.openai?.tasksModel ||
    config?.tareas_ws_model ||
    ''
  ).trim();
  // These tenants explicitly opted into the less expensive model. Transparently
  // migrate only the former default, while preserving any other future override.
  if (COST_OPTIMIZED_TASK_TENANTS.has(String(tenantId || '').trim().toUpperCase()) &&
      (!configured || /^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/i.test(configured))) {
    return 'gpt-4o-mini';
  }
  return configured || String(env.SUPPORT_TASK_MODEL || '').trim() || 'gpt-4o-mini';
}

function asistoTitleAnalyzer(env = process.env, { runtimeFor = tenantId => require('../../tenant_runtime').getRuntimeByTenantId(tenantId), configFor = async tenantId => (await require('../../db').getDb()).collection('tenant_config').findOne({ _id: tenantId }), clientFor = key => new OpenAI({ apiKey: key }) } = {}) {
  return { async run(messages, context) {
    const [runtime, config] = await Promise.all([runtimeFor(context.tenantId), configFor(context.tenantId)]);
    const apiKey = resolveOpenAiApiKey('tareas_ws', env);
    if (!apiKey) fail('task_title_provider_required', 422);
    // Tareas WhatsApp tiene una carga breve y estructurada. Su modelo se
    // configura aparte para no alterar pedidos, ayuda ni el bot conversacional.
    const model = resolveTasksModel(config, env, context.tenantId);
    const transcript = messages.map(m => `${m.fromMe ? 'OPERADOR' : 'CLIENTE'}: ${m.text}`).join('\n').slice(-30000);
    const response = await clientFor(apiKey).chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Analizá una conversación cronológica de soporte y respondé únicamente JSON válido con {"subject":"...","description":"..."}. subject: nombre concreto de la tarea, máximo 80 caracteres; no copies una frase textual ni incluyas nombres, saludos o fechas. description: resumen operativo breve, sin copiar la conversación; explicá el problema o pedido, el contexto relevante, lo realizado y sólo lo que realmente queda pendiente al final. Los mensajes más recientes prevalecen sobre pasos anteriores: si después se confirma "ya está", "listo", "resuelto", una solución equivalente, o el cliente agradece sin formular otro pedido, indicá que quedó resuelto y no digas que se espera respuesta. No inventes datos. Máximo 700 caracteres.' },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 300,
    });
    let parsed;
    try { parsed = JSON.parse(String(response?.choices?.[0]?.message?.content || '')); } catch { fail('task_title_failed', 502); }
    // Model length instructions are advisory. Bound generated text here so a
    // slightly long summary cannot abort all later messages in the contact.
    const bounded = (value, max) => {
      const raw = String(value || '').trim();
      if (raw.length <= max) return raw;
      const prefix = raw.slice(0, max - 1);
      const end = prefix.lastIndexOf(' ');
      return prefix.slice(0, end > max / 2 ? end : prefix.length).trimEnd() + '…';
    };
    const subject = text(bounded(parsed?.subject, 80), 80), description = text(bounded(parsed?.description, 700), 700);
    if (!subject || !description) fail('task_title_failed', 502);
    const usage = response?.usage || {};
    return { subject, description, model, inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0, outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0, totalTokens: Number(usage.total_tokens || 0) || 0 };
  } };
}
module.exports = { asistoTitleAnalyzer, resolveTasksModel };
