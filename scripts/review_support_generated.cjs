// Asisto | Version: 5.00.307 | Fecha: 2026-10-22
// Dry-run by default. Original messages and human/HubSpot records are immutable.
const { SupportService } = require('../src/support/service');
const { ANALYZER_VERSION, scopedId } = require('../src/support/core');
const { repairable } = require('../src/support/task_assessment');
async function review(db, vault, { apply = false, tenantIds = ['ALSO','DEMJG','SANA'] } = {}) {
  if (tenantIds.some(t => !['ALSO','DEMJG','SANA'].includes(t))) throw Error('invalid_review_scope');
  const s = new SupportService(db, vault), rows = await s.col('drafts').find({ tenantId: { $in: tenantIds }, state: { $nin: ['ignored','merged'] } }).toArray();
  const report = { host: require('os').hostname(), db: db.databaseName, apply, byTenant: {}, jobs: [] };
  const chats = new Map();
  for (const row of rows) {
    const totals = report.byTenant[row.tenantId] ||= { reviewed:0, protected:0, candidates:0, conversations:0, queued:0 };
    totals.reviewed++;
    if (!repairable(row)) { totals.protected++; continue; }
    if (row.analyzerVersion === ANALYZER_VERSION) continue;
    totals.candidates++;
    const key = JSON.stringify([row.tenantId,row.userId,row.jid]);
    if (!chats.has(key)) chats.set(key, []); chats.get(key).push(row);
  }
  for (const drafts of chats.values()) {
    const {tenantId,userId,jid}=drafts[0], scope={tenantId,userId}, totals=report.byTenant[tenantId];totals.conversations++;
    if (!apply) continue;
    for (const row of drafts) {
      const backupId = `generated-review-v10:${row._id}:${row.revision}`;
      await s.col('audit').updateOne({_id:backupId},{$setOnInsert:{...scope,action:'generated_review_backup',recordId:row._id,at:new Date(),snapshot:vault.seal(row,backupId)}},{upsert:true});
    }
    const _id=scopedId(scope,'generated-review',ANALYZER_VERSION,jid), now=new Date();
    const result=await s.col('jobs').updateOne({_id,...scope},{$setOnInsert:{...scope,jid,state:'pending',attempts:0,generation:1,dueAt:now,createdAt:now,generatedRepairOnly:true,reviewMessageIds:[...new Set(drafts.flatMap(r=>r.messageIds||[]))],reviewTargets:drafts.map(r=>r._id),reviewVersion:ANALYZER_VERSION}},{upsert:true});
    if (result.upsertedCount) totals.queued++;
    report.jobs.push({_id,...scope});
  }
  return report;
}
module.exports={review};
if(require.main===module)(async()=>{
 const args=process.argv.slice(2),db=await require('../db').getDb();
 if(db.databaseName!=='Cluster0')throw Error('production_database_required');
 const vault=require('../src/support/crypto').vaultFromEnv(process.env);
 console.log(JSON.stringify(await review(db,vault,{apply:args.includes('--apply'),...(args.includes('--tenant')?{tenantIds:[args[args.indexOf('--tenant')+1]]}:{})})));
 process.exit(0);
})().catch(e=>{console.error(e.code||e.name||'review_failed');process.exit(1)});
