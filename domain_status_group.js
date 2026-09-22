// Asisto | Version: 5.00.176 | Fecha: 2026-09-20

function normalizeDomainId(value) {
  return String(value || '').trim().toUpperCase();
}

function domainStatusGroupIds(ownerDoc, ownerId) {
  const owner = normalizeDomainId(ownerId || ownerDoc?._id);
  const associated = Array.isArray(ownerDoc?.consumption_domains)
    ? ownerDoc.consumption_domains.map(normalizeDomainId).filter(Boolean)
    : [];
  return [...new Set([owner, ...associated].filter(Boolean))];
}

function documentTenantId(doc) {
  return normalizeDomainId(doc?.tenantId || doc?.tenantid || String(doc?._id || '').split(':')[0]);
}

module.exports = { domainStatusGroupIds, documentTenantId, normalizeDomainId };
