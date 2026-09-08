// Asisto | Version: 5.00.064 | Fecha: 2026-09-08
const { fail } = require('./core');
const { downloadAudio, localTranscriber } = require('./baileys');

function asistoTranscriber(env = process.env, {
  download = downloadAudio,
  runtimeFor = tenantId => require('../../tenant_runtime').getRuntimeByTenantId(tenantId),
  transcribe = input => require('../../logic').transcribeAudioExternal(input),
} = {}) {
  if (env.SUPPORT_TRANSCRIBER_URL) return localTranscriber(env);
  return { model: 'asisto-transcription', async run(raw, audio, context) {
    if (!context?.tenantId || !context.userId) fail('authentication_required', 401);
    const runtime = await runtimeFor(context.tenantId);
    const openaiApiKey = runtime?.openaiApiKey || env.OPENAI_API_KEY;
    if (!openaiApiKey) fail('transcription_provider_required', 422);
    const buffer = await download(raw, audio);
    const result = await transcribe({ buffer, mime: audio.mimetype, tenantId: context.tenantId,
      openaiApiKey, conversationId: context.conversationId, waId: context.jid,
      channelType: 'whatsapp', usageTraceId: context.messageId, transcriptionTimeoutMs: 60000 });
    if (typeof result?.text !== 'string' || !result.text.trim()) fail('transcription_failed', 502);
    return { text: result.text, model: result.model || 'asisto-transcription', costUsd: null };
  } };
}
module.exports = { asistoTranscriber };
