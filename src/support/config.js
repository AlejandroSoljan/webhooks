// Asisto | Version: 5.00.053 | Fecha: 2026-09-08
const { vaultFromEnv, hasConfiguredCookieSecret } = require('./crypto');

// Safe diagnostics for the setup panel. Never return environment values or parser errors.
function inspectConfiguration(env = process.env) {
  let publicOrigin, vault;
  try {
    const url = new URL(env.SUPPORT_PUBLIC_ORIGIN ?? env.PUBLIC_BASE_URL);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) publicOrigin = url.origin;
  } catch {}
  try { vault = vaultFromEnv(env); } catch {}
  const checks = [
    { key: 'enabled', ok: env.SUPPORT_ENABLED === 'true', label: 'Habilitar el procesamiento de soporte' },
    { key: 'origin', ok: !!publicOrigin, label: 'Configurar el dominio de Asisto' },
    { key: 'encryption', ok: !!vault, label: 'Protección de sesiones con la configuración de Asisto' },
    { key: 'authentication', ok: hasConfiguredCookieSecret(env), label: 'Configuración de inicio de sesión de Asisto' },
    { key: 'database', ok: !!env.MONGODB_URI, label: 'Configurar la conexión a la base de datos' },
  ];
  return { checks, ready: checks.every(c => c.ok), publicOrigin, vault };
}
module.exports = { inspectConfiguration };
