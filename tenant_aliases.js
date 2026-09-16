// Alias explícitos de dominios para las consultas públicas de Asisto.
// Se configuran en tenant_config.<api_aliases> del dominio propietario.

function normalizeTenantId(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeTenantAliases(value, ownerId) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : null;
  if (!source) throw new Error('tenant_aliases_invalid');
  if (source.length > 50) throw new Error('tenant_aliases_limit');
  const owner = normalizeTenantId(ownerId);
  const aliases = [...new Set(source.map(normalizeTenantId).filter(Boolean))];
  if (aliases.some(alias => !/^[A-Z0-9_-]{2,80}$/.test(alias) || alias === owner)) {
    throw new Error('tenant_aliases_invalid');
  }
  return aliases;
}

async function resolveCanonicalTenantId(db, requested) {
  const original = String(requested || '').trim();
  const tenantId = normalizeTenantId(original);
  if (!tenantId) return '';

  const owners = await db.collection('tenant_config')
    .find({ api_aliases: tenantId }, { projection: { _id: 1 } })
    .limit(2)
    .toArray();
  if (owners.length > 1) throw new Error('tenant_alias_ambiguous');
  return owners.length ? String(owners[0]._id || '').trim() : original;
}

async function resolveCanonicalLockId(db, lockId) {
  const raw = String(lockId || '').trim();
  const separator = raw.indexOf(':');
  if (separator < 0) return raw;
  const tenantId = await resolveCanonicalTenantId(db, raw.slice(0, separator));
  return `${tenantId}:${raw.slice(separator + 1)}`;
}

module.exports = { normalizeTenantId, normalizeTenantAliases, resolveCanonicalTenantId, resolveCanonicalLockId };
