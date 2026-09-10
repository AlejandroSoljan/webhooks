// Asisto | Version: 5.00.079 | Fecha: 2026-09-10
// Selección centralizada de claves OpenAI por tipo de IA.

const ENV_BY_KIND = Object.freeze({
  pedidos: 'OPENAI_API_KEY_PEDIDOS',
  conversacional: 'OPENAI_API_KEY_CONVERSACIONAL',
  ayuda: 'OPENAI_API_KEY_AYUDA',
  tareas_ws: 'OPENAI_API_KEY_TAREAS_WS',
});

function normalizeAiKeyKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (kind === 'qr_web') return 'conversacional';
  if (kind === 'help_api' || kind === 'help') return 'ayuda';
  if (kind === 'whatsapp_tasks' || kind === 'tareas' || kind === 'support') return 'tareas_ws';
  if (kind === 'conversational') return 'conversacional';
  return Object.hasOwn(ENV_BY_KIND, kind) ? kind : '';
}

function resolveOpenAiApiKey(kind, env = process.env) {
  const normalized = normalizeAiKeyKind(kind);
  const envName = ENV_BY_KIND[normalized];
  return envName ? String(env?.[envName] || '').trim() : '';
}

function requireOpenAiApiKey(kind, env = process.env) {
  const normalized = normalizeAiKeyKind(kind);
  const key = resolveOpenAiApiKey(normalized, env);
  if (!key) {
    const error = new Error(`openai_api_key_missing:${ENV_BY_KIND[normalized] || 'unknown'}`);
    error.code = 'OPENAI_API_KEY_MISSING';
    throw error;
  }
  return key;
}

module.exports = { ENV_BY_KIND, normalizeAiKeyKind, resolveOpenAiApiKey, requireOpenAiApiKey };
