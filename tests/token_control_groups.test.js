// Asisto | Version: 5.00.176 | Fecha: 2026-09-20
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUsageMatch, resolveUsageTenantIds, loadBillingOwners } = require('../token_control_stats');

test('consumption group keeps owner and distinct associated domains', async () => {
  const db = { collection: () => ({ findOne: async () => ({ consumption_domains: ['ALSO', 'DEMJG', 'ALSO', ''] }) }) };
  assert.deepEqual(await resolveUsageTenantIds(db, 'MSM'), ['MSM', 'ALSO', 'DEMJG']);
  const { match, safeTenant, safeTenants } = buildUsageMatch({ tenantId: 'MSM', tenantIds: ['MSM', 'ALSO', 'DEMJG'] });
  assert.equal(safeTenant, 'MSM');
  assert.deepEqual(safeTenants, ['MSM', 'ALSO', 'DEMJG']);
  assert.deepEqual(match.tenantId, { $in: ['MSM', 'ALSO', 'DEMJG'] });
});

test('domain without group preserves exact tenant filtering', async () => {
  const db = { collection: () => ({ findOne: async () => null }) };
  assert.deepEqual(await resolveUsageTenantIds(db, 'RVL'), ['RVL']);
  assert.equal(buildUsageMatch({ tenantId: 'RVL', tenantIds: ['RVL'] }).match.tenantId, 'RVL');
});

test('associated domains inherit their configured billing owner generically', async () => {
  const docs = [
    { _id: 'MSM', consumption_domains: ['ALSO', 'DEMJG'] },
    { _id: 'PEV', consumption_domains: ['PEV1', 'PEV2', 'PEV3', 'PEV4'] },
  ];
  const db = { collection: () => ({ find: () => ({ toArray: async () => docs }) }) };
  assert.deepEqual(await loadBillingOwners(db), {
    MSM: 'MSM', ALSO: 'MSM', DEMJG: 'MSM',
    PEV: 'PEV', PEV1: 'PEV', PEV2: 'PEV', PEV3: 'PEV', PEV4: 'PEV',
  });
});
