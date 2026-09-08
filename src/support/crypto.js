// Asisto | Version: 5.00.051 | Fecha: 2026-09-08
const crypto = require('node:crypto');
// AAD binds every ciphertext to tenant, user (or tenant integration), and record purpose.
function createVault(keyring, activeKey) {
  const keys = Object.fromEntries(Object.entries(keyring).map(([id, encoded]) => {
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error('support_key_must_be_32_bytes');
    return [id, key];
  }));
  if (!keys[activeKey]) throw new Error('support_active_key_missing');
  return {
    seal(value, aad) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keys[activeKey], iv);
      cipher.setAAD(Buffer.from(aad));
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return { v: 1, kid: activeKey, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
    },
    open(envelope, aad) {
      if (envelope?.v !== 1 || !keys[envelope.kid]) throw new Error('support_unknown_key');
      const cipher = crypto.createDecipheriv('aes-256-gcm', keys[envelope.kid], Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(Buffer.from(aad));
      cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.body, 'base64')), cipher.final()]).toString('utf8'));
    },
  };
}
function hasSecureCookieSecret(env) {
  return typeof env.AUTH_COOKIE_SECRET === 'string' && env.AUTH_COOKIE_SECRET.length >= 32 && env.AUTH_COOKIE_SECRET !== 'dev-unsafe-secret-change-me';
}
function vaultFromEnv(env = process.env) {
  // Preserve explicitly configured keyrings, including failures: never silently
  // switch keys when a deployment has a malformed or incomplete configuration.
  if (env.SUPPORT_ENCRYPTION_KEYS !== undefined || env.SUPPORT_ACTIVE_KEY !== undefined) {
    return createVault(JSON.parse(env.SUPPORT_ENCRYPTION_KEYS || '{}'), env.SUPPORT_ACTIVE_KEY);
  }
  if (!hasSecureCookieSecret(env)) throw new Error('support_secure_cookie_secret_required');
  // Domain separation keeps the AES key distinct from the cookie-signing key,
  // while reusing Asisto's existing secret without another managed variable.
  const key = Buffer.from(crypto.hkdfSync('sha256', env.AUTH_COOKIE_SECRET,
    'asisto/support/v1', 'session-and-content-encryption', 32));
  return createVault({ 'asisto-auth-v1': key.toString('base64') }, 'asisto-auth-v1');
}
module.exports = { createVault, vaultFromEnv, hasSecureCookieSecret };
