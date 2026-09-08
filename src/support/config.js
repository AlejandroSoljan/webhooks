// Asisto | Version: 5.00.049 | Fecha: 2026-09-08
const { createVault } = require('./crypto');

// Safe diagnostics for the setup panel. Never return environment values or parser errors.
function inspectConfiguration(env = process.env) {
  let publicOrigin, vault;
  try {
    const url = new URL(env.SUPPORT_PUBLIC_ORIGIN);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) publicOrigin = url.origin;
  } catch {}
  try { vault = createVault(JSON.parse(env.SUPPORT_ENCRYPTION_KEYS || '{}'), env.SUPPORT_ACTIVE_KEY); } catch {}
  const checks = [
    { key: 'enabled', ok: env.SUPPORT_ENABLED === 'true', label: 'Habilitar el procesamiento de soporte' },
    { key: 'origin', ok: !!publicOrigin, label: 'Configurar el dominio de Asisto' },
    { key: 'encryption', ok: !!vault, label: 'Configurar la clave de cifrado de las sesiones' },
    { key: 'authentication', ok: !!env.AUTH_COOKIE_SECRET && env.AUTH_COOKIE_SECRET.length >= 32 && env.AUTH_COOKIE_SECRET !== 'dev-unsafe-secret-change-me', label: 'Configurar la clave segura de inicio de sesión' },
    { key: 'database', ok: !!env.MONGODB_URI, label: 'Configurar la conexión a la base de datos' },
  ];
  return { checks, ready: checks.every(c => c.ok), publicOrigin, vault };
}
module.exports = { inspectConfiguration };
