const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveWwebTenantScope,
  wwebTenantFilter,
  wwebTenantAllowed,
} = require('../auth_ui');

test('usuario agrupador accede solo a sus dominios WhatsApp asociados', async () => {
  const db = {
    collection(name) {
      assert.equal(name, 'tenant_config');
      return {
        findOne: async (filter) => {
          assert.deepEqual(filter, { _id: 'PET' });
          return { wweb_domains: ['PET1', 'PET2', 'PET3', 'PET4', 'PET1', ''] };
        },
      };
    },
  };

  const scope = await resolveWwebTenantScope(db, { tenantId: 'PET', role: 'admin' });
  assert.deepEqual(scope, ['PET', 'PET1', 'PET2', 'PET3', 'PET4']);
  assert.deepEqual(wwebTenantFilter(scope), { tenantId: { $in: scope } });
  assert.equal(wwebTenantAllowed(scope, 'PET3'), true);
  assert.equal(wwebTenantAllowed(scope, 'RVL'), false);
});

test('superadmin conserva acceso global', async () => {
  const scope = await resolveWwebTenantScope(null, { tenantId: 'CARICO', role: 'superadmin' });
  assert.equal(scope, null);
  assert.deepEqual(wwebTenantFilter(scope), {});
  assert.equal(wwebTenantAllowed(scope, 'RVL'), true);
});
