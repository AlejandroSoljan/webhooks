'use strict';
function range(from,to){const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Argentina/Buenos_Aires'});from=from||today.slice(0,8)+'01';to=to||today;if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to))throw Error('range');const start=new Date(from+'T00:00:00-03:00'),end=new Date(to+'T00:00:00-03:00');end.setUTCDate(end.getUTCDate()+1);if(!Number.isFinite(+start)||!Number.isFinite(+end)||end<=start||end-start>366*86400000)throw Error('range');return{start,end,hour:from===to};}
function mountActivitySummary(app,{guard,access,wrap,getDb,list}){
 app.get('/static/app-activity-chart.js',guard,(_q,r)=>r.type('js').sendFile(require('path').join(__dirname,'app_activity_chart.js')));
 app.get('/api/customer-notifications/:tenant/center/summary',guard,access,wrap(async(req,res)=>{
  let period;try{period=range(req.query.from,req.query.to);}catch{return res.status(400).json({error:'Elegí un rango válido de hasta 366 días.'});}
  const {start,end,hour}=period,db=await getDb(),tenantId=req.centerTenant,devices=(await list(db,tenantId)).filter(d=>d.channel==='app');
  const buckets=await db.collection('customer_app_activity').aggregate([{$match:{tenantId,at:{$gte:start,$lt:end}}},{$group:{_id:{bucket:{$dateToString:{date:'$at',format:hour?'%Y-%m-%d %H:00':'%Y-%m-%d',timezone:'America/Argentina/Buenos_Aires'}},type:'$type'},count:{$sum:1}}}]).toArray();
  const activeIds=(await db.collection('customer_app_activity').aggregate([{$match:{tenantId,at:{$gte:start,$lt:end}}},{$group:{_id:'$installId'}}]).toArray()).map(x=>x._id);
  const notices=await db.collection('customer_app_notifications').aggregate([{$match:{tenantId,createdAt:{$gte:start,$lt:end}}},{$group:{_id:null,accepted:{$sum:'$successCount'},failed:{$sum:'$failureCount'}}}]).toArray();
  const series=[];for(let at=+start;at<+end;at+=hour?3600000:86400000){const local=new Date(at-3*3600000).toISOString(),key=hour?local.slice(0,10)+' '+local.slice(11,13)+':00':local.slice(0,10);const counts=Object.fromEntries(buckets.filter(x=>x._id.bucket===key).map(x=>[x._id.type,x.count]));series.push({at:key,counts});}
  const first=d=>Math.min(...d.members.map(x=>+new Date(x.createdAt)).filter(Number.isFinite));
  res.json({series,hour,summary:{registered:devices.filter(d=>first(d)>=+start&&first(d)<+end).length,active:devices.filter(d=>d.installIds.some(id=>activeIds.includes(id))).length,sessions:buckets.filter(x=>x._id.type==='app_open').reduce((n,x)=>n+x.count,0),opened:buckets.filter(x=>x._id.type==='notification_open').reduce((n,x)=>n+x.count,0),accepted:notices[0]?.accepted||0,failed:notices[0]?.failed||0}});
 }));
}
module.exports={range,mountActivitySummary};
