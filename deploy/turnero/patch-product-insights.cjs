// Asisto | Preserve installed queue/expiry/reopening fixes; add private analysis only | 2026-10-21
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(process.argv[2]);assert.ok(root.startsWith('/opt/asisto/turnero'));
const stats=path.join(root,'queue_stats.js'),cloud=path.join(root,'queue_cloud_sync.js'),page=path.join(root,'queue_stats_page.js');
let source=fs.readFileSync(stats,'utf8');
if(!source.includes('mountProductInsights')){
 const anchor='function mountQueueStats(app, { scope, wrap, allowed, isOpen = () => false, dayKey, auth }) {';
 assert.equal(source.split(anchor).length,2,'Stats integration anchor changed');
 const addition="\n  require('./product_insights_routes').mountProductInsights(app, { scope, wrap, allowed, dayKey, isOpen });";
 const patched=source.replace(anchor,anchor+addition);assert.equal(patched.replace(addition,''),source);fs.writeFileSync(stats,patched);
}
source=fs.readFileSync(stats,'utf8');
if(source.includes('mountProductInsights(app, { scope, wrap, allowed, dayKey });')) fs.writeFileSync(stats,source.replace('mountProductInsights(app, { scope, wrap, allowed, dayKey });','mountProductInsights(app, { scope, wrap, allowed, dayKey, isOpen });'));
source=fs.readFileSync(cloud,'utf8');
if(!source.includes('handleProductStatsSync')){
 const anchor='const rows = Array.isArray(req.body?.tickets)';assert.equal(source.split(anchor).length,2,'Cloud integration anchor changed');
 const addition="if (await require('./product_insights_routes').handleProductStatsSync(req, res, { getDb })) return;\n    ";
 const patched=source.replace(anchor,addition+anchor);assert.equal(patched.replace(addition,''),source);fs.writeFileSync(cloud,patched);
}
source=fs.readFileSync(page,'utf8');
if(!source.includes('__productStatsBase')){
 assert.ok(source.includes('async function load(e){')&&source.includes('<div class="content">')&&source.includes("q('csv').disabled=true;try{"),'Page integration anchors changed');
 fs.writeFileSync(page,source+"\nconst __productStatsBase=module.exports.statsPage;\nmodule.exports.statsPage=(...args)=>require('./product_insights_panel').enhance(__productStatsBase(...args));\n");
}
console.log('PRIVATE_PRODUCT_INSIGHTS_INTEGRATED_QUEUE_HISTORY_PRESERVED');
