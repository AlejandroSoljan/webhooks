// Asisto | Version: 5.00.083 | Fecha: 2026-09-09
const OpenAI = require('openai');
const { fail, text } = require('./core');
const { resolveOpenAiApiKey } = require('../../ai_key_router');

function asistoTitleAnalyzer(env = process.env, { runtimeFor = tenantId => require('../../tenant_runtime').getRuntimeByTenantId(tenantId), configFor = async tenantId => (await require('../../db').getDb()).collection('tenant_config').findOne({ _id: tenantId }), clientFor = key => new OpenAI({ apiKey: key }) } = {}) {
  return { async run(messages, context) {
    const [runtime, config] = await Promise.all([runtimeFor(context.tenantId), configFor(context.tenantId)]);
    const apiKey = resolveOpenAiApiKey('tareas_ws', env);
    if (!apiKey) fail('task_title_provider_required', 422);
    const model = String(config?.openai?.chat_model || config?.openai?.chatModel || config?.CHAT_MODEL || config?.chat_model || config?.chatModel || env.CHAT_MODEL || 'gpt-5.4');
    const transcript = messages.map(m => `${m.fromMe ? 'OPERADOR' : 'CLIENTE'}: ${m.text}`).join('\n').slice(-30000);
    const response = await clientFor(apiKey).chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Analizá una conversación de soporte y respondé únicamente JSON válido con {"subject":"...","description":"..."}. subject: nombre concreto de la tarea, máximo 80 caracteres; no copies una frase textual ni incluyas nombres, saludos o fechas. description: resumen operativo breve, sin copiar la conversación; explicá el problema o pedido, el contexto relevante, lo realizado y lo que queda pendiente. No inventes datos. Máximo 700 caracteres.' },
        { role: 'user', content: transcript },
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 300,
    });
    let parsed;
    try { parsed = JSON.parse(String(response?.choices?.[0]?.message?.content || '')); } catch { fail('task_title_failed', 502); }
    const subject = text(String(parsed?.subject || '').trim(), 80), description = text(String(parsed?.description || '').trim(), 700);
    if (!subject || !description) fail('task_title_failed', 502);
    const usage = response?.usage || {};
    return { subject, description, model, inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0, outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0, totalTokens: Number(usage.total_tokens || 0) || 0 };
  } };
}
module.exports = { asistoTitleAnalyzer };
