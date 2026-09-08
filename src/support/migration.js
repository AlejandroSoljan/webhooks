// Asisto | Version: 5.00.049 | Fecha: 2026-09-08
// Additive, repeatable migration. No writes to existing Asisto collections.
const indexes = {
  support_sessions: [{ key: { tenantId: 1, userId: 1 }, unique: true, name: 'owner' }],
  support_auth: [{ key: { tenantId: 1, userId: 1 }, name: 'owner' }],
  support_settings: [{ key: { tenantId: 1, userId: 1 }, unique: true, name: 'owner' }],
  support_messages: [{ key: { tenantId: 1, userId: 1, jid: 1, at: 1 }, name: 'conversation_range' }],
  support_jobs: [{ key: { state: 1, dueAt: 1 }, name: 'queue' }, { key: { tenantId: 1, userId: 1 }, name: 'owner' }],
  support_drafts: [{ key: { tenantId: 1, userId: 1, updatedAt: -1 }, name: 'inbox' }],
  support_memory: [{ key: { tenantId: 1, userId: 1, jid: 1 }, unique: true, name: 'identity' }],
  support_usage: [{ key: { tenantId: 1, userId: 1, at: -1 }, name: 'owner_usage' }],
  support_audit: [{ key: { tenantId: 1, userId: 1, at: -1 }, name: 'owner_audit' }],
  support_integrations: [{ key: { tenantId: 1 }, unique: true, name: 'tenant' }],
  support_leases: [],
};
async function migrate(db) {
  for (const [name, specs] of Object.entries(indexes)) {
    if (specs.length) await db.collection(name).createIndexes(specs);
  }
  await db.collection('support_migrations').updateOne({ _id: '001' }, { $setOnInsert: { appliedAt: new Date(), description: 'Isolated support intake' } }, { upsert: true });
}
module.exports = { migrate, indexes };
