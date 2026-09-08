// Asisto | Version: 5.00.052 | Fecha: 2026-09-08
require('dotenv').config();
const { randomUUID } = require('node:crypto');
const { getDb, closeDb } = require('../../db');
const { vaultFromEnv } = require('./crypto');
const { SupportService } = require('./service');
const { BaileysSessions, localTranscriber } = require('./baileys');
const { fail } = require('./core');

class WorkerLease {
  constructor(db, now = () => new Date()) { this.col = db.collection('support_leases'); this.owner = randomUUID(); this.now = now; }
  async acquire() {
    try {
      const row = await this.col.findOneAndUpdate({ _id: 'intake-worker', $or: [{ owner: this.owner }, { until: { $lte: this.now() } }] }, { $set: { owner: this.owner, until: new Date(+this.now() + 30000) } }, { upsert: true, returnDocument: 'after' });
      return row?.owner === this.owner;
    } catch (e) { if (e.code === 11000) return false; throw e; }
  }
  async assert() { if (!await this.col.findOne({ _id: 'intake-worker', owner: this.owner, until: { $gt: this.now() } })) fail('worker_lease_lost', 409); }
  async renew() {
    const result = await this.col.updateOne({ _id: 'intake-worker', owner: this.owner, until: { $gt: this.now() } }, { $set: { until: new Date(+this.now() + 30000) } });
    if (!result.matchedCount) fail('worker_lease_lost', 409);
  }
  async release() { await this.col.deleteOne({ _id: 'intake-worker', owner: this.owner }); }
}

async function startWorker({ onFatal = () => { process.exitCode = 1; } } = {}) {
  if (process.env.SUPPORT_ENABLED !== 'true') throw new Error('support_disabled');
  const vault = vaultFromEnv(), db = await getDb();
  if (!await db.collection('support_migrations').findOne({ _id: '001' })) throw new Error('support_migration_required');
  const service = new SupportService(db, vault, { transcribe: localTranscriber() });
  const lease = new WorkerLease(db);
  if (!await lease.acquire()) throw new Error('support_worker_already_running');
  let stopped = false, busy = false, renewing = false;
  const assertOwner = async () => { if (stopped) fail('worker_stopped', 409); await lease.assert(); };
  const sessions = new BaileysSessions(service, assertOwner);
  const stop = async () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); clearInterval(heartbeat);
    await sessions.stop();
    await lease.release().catch(() => {});
  };
  const heartbeat = setInterval(async () => {
    if (renewing || stopped) return;
    renewing = true;
    // db.js tracks getDb() calls, not operations on an already obtained Db object.
    // Touch its shared pool so the idle timer cannot close active Baileys storage.
    try { await getDb(); await lease.renew(); } catch { await stop(); console.error('Support worker lost its lease; restart required.'); await onFatal(); }
    finally { renewing = false; }
  }, 5000);
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await assertOwner(); await sessions.sync(); await service.repairQueue(); await service.runOne(assertOwner); }
    catch { console.error('Support worker cycle failed; retrying.'); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 2000);
  await tick();
  return { stop, service };
}
if (require.main === module) {
  let closing = false;
  const running = startWorker({ onFatal: async () => { await closeDb(); process.exit(1); } });
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(1), 6000).unref();
    try { await (await running).stop(); } catch {}
    await closeDb(); process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('SIGBREAK', shutdown);
  // A dead parent must not leave an orphan retaining WhatsApp socket ownership.
  if (process.send) process.on('disconnect', shutdown);
  running.then(() => {
    if (closing) return;
    console.log('Support worker ready.');
    if (process.connected) process.send({ type: 'support-ready' });
  }).catch(async () => { console.error('Support worker startup failed: check Asisto configuration, migration and worker lease.'); await closeDb(); process.exit(1); });
}
module.exports = { WorkerLease, startWorker };
