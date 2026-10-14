// Asisto | Version: 5.00.292 | Fecha: 2026-10-14
// Scope an import incident; archive only untouched drafts with entirely stale
// historical evidence. Audit encrypted snapshots before optimistic updates.
const { MongoClient } = require('mongodb');
const { SupportService } = require('../src/support/service');
const { vaultFromEnv } = require('../src/support/crypto');
const { enabled } = require('../src/support/task_grouping');
async function repair(db, vault, { scope, start, end, boundary, apply = false }) {
  if (!enabled(scope.tenantId) || !scope.userId || !Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) throw Error('invalid_repair_scope');
  const s = new SupportService(db, vault);
  const incident = { ...scope, receivedAt: { $gte: start, $lt: end }, historical: true };
  const messages = await s.col('messages').find(incident).toArray();
  const resumeAt = boundary || (await s.col('sessions').findOne(scope, { projection: { historyResumeAt: 1 } }))?.historyResumeAt;
  if (!resumeAt || !Number.isFinite(+new Date(resumeAt))) throw Error('repair_boundary_required');
  const invalid = messages.filter(row => !s.recentHistory(scope, row, row.receivedAt, resumeAt));
  const incorrectFlags = invalid.filter(row => row.catchup === true);
  const invalidIds = new Set(invalid.map(row => row._id));
  const drafts = await s.col('drafts').find({ ...scope, createdAt: { $gte: start, $lt: end }, state: 'pending', 'hubspot.ticketId': { $exists: false }, 'hubspot.state': { $nin: ['saved', 'sending', 'uncertain'] } }).toArray();
  const candidates = drafts.filter(row => row.messageIds?.length && row.messageIds.every(id => invalidIds.has(id)) && row.events?.every(event => !event.by && ['generated', 'source_changed', 'tasks_merged', 'changed_source_summarized_ai'].includes(event.action)));
  const report = { host: require('os').hostname(), db: db.databaseName, scope, resumeAt, apply, imported: messages.length, staleMessages: invalid.length, incorrectFlags: incorrectFlags.length, archiveDrafts: candidates.length, preservedDrafts: drafts.length - candidates.length, archived: 0, conflicts: 0 };
  if (!apply) return report;
  for (const row of candidates) {
    const backupId = 'history-import-v1:draft:' + row._id;
    await s.col('audit').updateOne({ _id: backupId }, { $setOnInsert: { ...scope, action: 'history_import_archive_backup', recordId: row._id, at: new Date(), snapshot: vault.seal(row, backupId) } }, { upsert: true });
    const result = await s.col('drafts').updateOne({ _id: row._id, ...scope, state: 'pending', revision: row.revision, 'hubspot.ticketId': { $exists: false }, 'hubspot.state': { $nin: ['saved', 'sending', 'uncertain'] } }, { $set: { state: 'ignored', sourceChanged: false, reconciliationRequired: false, historyImportArchived: true, updatedAt: new Date() }, $inc: { revision: 1 }, $push: { events: { action: 'history_import_archived', at: new Date(), reason: 'reconnection_history_before_last_sync', backupId } } });
    result.modifiedCount ? report.archived++ : report.conflicts++;
  }
  for (const row of incorrectFlags) {
    const backupId = 'history-import-v1:message:' + row._id;
    await s.col('audit').updateOne({ _id: backupId }, { $setOnInsert: { ...scope, action: 'history_import_message_backup', recordId: row._id, at: new Date(), snapshot: vault.seal({ catchup: row.catchup, assignmentRecoveryV1: row.assignmentRecoveryV1 }, backupId) } }, { upsert: true });
    await s.col('messages').updateOne({ _id: row._id, ...scope, historical: true }, { $set: { catchup: false, assignmentRecoveryV1: true } });
  }
  return report;
}
module.exports = { repair };
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2), flag = name => args[args.indexOf(name) + 1];
    if (!args.includes('--tenant') || !args.includes('--user') || !args.includes('--start') || !args.includes('--end')) throw Error('required: --tenant --user --start --end [--apply]');
    const client = await MongoClient.connect(process.env.MONGODB_URI);
    try { console.log(JSON.stringify(await repair(client.db('Cluster0'), vaultFromEnv(process.env), { scope: { tenantId: flag('--tenant'), userId: flag('--user') }, start: new Date(flag('--start')), end: new Date(flag('--end')), boundary: args.includes('--boundary') ? new Date(flag('--boundary')) : null, apply: args.includes('--apply') }))); }
    finally { await client.close(); }
  })().catch(error => { console.error(error.message); process.exit(1); });
}
