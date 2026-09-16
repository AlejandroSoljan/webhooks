const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTenantAliases,
  resolveCanonicalTenantId,
  resolveCanonicalLockId,
} = require('../tenant_aliases');

function dbWithAliases(rows) {
  return {
    collection(name) {
      assert.equal(name, 'tenant_config');
      return {
        find(query) {
          return {
            limit() {
              return {
                async toArray() {
                  return rows.filter(row => row.api_aliases?.includes(query.api_aliases))
                    .map(row => ({ _id: row._id }));
                },
              };
            },
          };
        },
      };
    },
  };
}

test('NEA1 y NEA2 consultan como NEA; otros dominios no cambian', async () => {
  const db = dbWithAliases([{ _id: 'NEA', api_aliases: ['NEA1', 'NEA2'] }]);
  assert.equal(await resolveCanonicalTenantId(db, 'nea1'), 'NEA');
  assert.equal(await resolveCanonicalTenantId(db, 'NEA2'), 'NEA');
  assert.equal(await resolveCanonicalTenantId(db, 'NEA'), 'NEA');
  assert.equal(await resolveCanonicalTenantId(db, 'NEA3'), 'NEA3');
  assert.equal(await resolveCanonicalTenantId(db, 'default'), 'default');
  assert.equal(await resolveCanonicalLockId(db, 'nea1:5493462652375'), 'NEA:5493462652375');
});

test('valida la lista de secundarios y no permite reclamar el dominio propio', () => {
  assert.deepEqual(normalizeTenantAliases('nea1, NEA2;nea1', 'NEA'), ['NEA1', 'NEA2']);
  assert.throws(() => normalizeTenantAliases(['NEA'], 'NEA'), /tenant_aliases_invalid/);
  assert.throws(() => normalizeTenantAliases(['NEA 1'], 'NEA'), /tenant_aliases_invalid/);
});

test('un alias duplicado entre propietarios falla cerrado', async () => {
  const db = dbWithAliases([
    { _id: 'NEA', api_aliases: ['NEA1'] },
    { _id: 'OTRO', api_aliases: ['NEA1'] },
  ]);
  await assert.rejects(resolveCanonicalTenantId(db, 'NEA1'), /tenant_alias_ambiguous/);
});
