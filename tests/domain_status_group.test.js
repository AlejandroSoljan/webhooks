// Asisto | Version: 5.00.176 | Fecha: 2026-09-20
const test = require('node:test');
const assert = require('node:assert/strict');
const { domainStatusGroupIds, documentTenantId } = require('../domain_status_group');

test('MSM exposes each associated real domain once', () => {
  assert.deepEqual(
    domainStatusGroupIds({ _id: 'MSM', consumption_domains: ['ALSO', 'DEMJG', 'also', ''] }),
    ['MSM', 'ALSO', 'DEMJG']
  );
});

test('session ownership remains attached to its own domain', () => {
  assert.equal(documentTenantId({ tenantId: 'ALSO', _id: 'MSM:549' }), 'ALSO');
  assert.equal(documentTenantId({ _id: 'DEMJG:5493462389257' }), 'DEMJG');
});
