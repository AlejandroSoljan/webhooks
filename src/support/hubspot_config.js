// Asisto | Version: 5.00.085 | Fecha: 2026-09-10
const { hash } = require('./core');

function tenantSuffix(tenantId) { return String(tenantId || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_'); }
async function hubspotCredential(service, scope, env = process.env) {
  const specific = String(env[`HUBSPOT_PRIVATE_APP_TOKEN_${tenantSuffix(scope.tenantId)}`] || '').trim();
  const globalTenant = String(env.HUBSPOT_TENANT_ID || '').trim();
  const global = !globalTenant || globalTenant === scope.tenantId ? String(env.HUBSPOT_PRIVATE_APP_TOKEN || '').trim() : '';
  const token = specific || global;
  if (token) return { token, source: 'environment', connection: { portalId: String(env[`HUBSPOT_PORTAL_ID_${tenantSuffix(scope.tenantId)}`] || env.HUBSPOT_PORTAL_ID || '').trim() || null } };
  const connection = await service.col('integrations').findOne({ tenantId: scope.tenantId });
  if (!connection?.token) return null;
  return { token: service.vault.open(connection.token, hash(scope.tenantId, 'hubspot')), source: 'encrypted_legacy', connection };
}
module.exports = { hubspotCredential, tenantSuffix };
