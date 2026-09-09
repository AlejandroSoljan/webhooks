// Asisto | Version: 5.00.072 | Fecha: 2026-09-09
const OpenAI = require('openai');
const { fail, text } = require('./core');

function asistoTitleAnalyzer(env = process.env, { runtimeFor = tenantId => require('../../tenant_runtime').getRuntimeByTenantId(tenantId), clientFor = key => new OpenAI({ apiKey: key }) } = {}) {
  return { async run(messages, context) {
    const runtime = await runtimeFor(context.tenantId);
    const apiKey = String(runtime?.openaiApiKey || env.OPENAI_API_KEY || '').trim();
    if (!apiKey) fail('task_title_provider_required', 422);
    const model = String(runtime?.openaiModel || runtime?.model || 'gpt-5.6-luna');
    const transcript = messages.map(m => `${m.fromMe ? 'OPERADOR' : 'CLIENTE'}: ${m.text}`).join('\n').slice(-30000);
    const response = await clientFor(apiKey).chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Generá el nombre breve de una tarea de soporte a partir de la conversación. Expresá el problema, pedido o acción concreta. Máximo 80 caracteres. No copies una frase textual, no incluyas nombres, saludos, fechas ni comillas. Respondé únicamente el título.' },
        { role: 'user', content: transcript },
      ],
      max_completion_tokens: 60,
    });
    const subject = text(String(response?.choices?.[0]?.message?.content || '').replace(/^["“”']+|["“”']+$/g, '').trim(), 80);
    if (!subject) fail('task_title_failed', 502);
    const usage = response?.usage || {};
    return { subject, model, inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0, outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0, totalTokens: Number(usage.total_tokens || 0) || 0 };
  } };
}
module.exports = { asistoTitleAnalyzer };
