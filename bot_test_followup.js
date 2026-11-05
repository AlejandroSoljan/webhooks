// Read-only adapter for the isolated NEA pilot. Never copies records into live conversations.
'use strict';
function allowed(tenant){if(!['NEA','NEA_PRUEBAS'].includes(tenant))throw Error('forbidden')}
async function listPilotSessions(db,tenant,{q='',from,to}={}){
 allowed(tenant);
 const match={tenant:'NEA_PRUEBAS'};
 if(from||to){match.createdAt={};if(from)match.createdAt.$gte=from;if(to)match.createdAt.$lte=to}
 const pipeline=[{$match:match},{$sort:{createdAt:1,_id:1}},{$group:{_id:{sessionId:'$sessionId',userId:'$userId'},id:{$first:'$_id'},lastAt:{$last:'$createdAt'},preview:{$last:'$message'},count:{$sum:1},failed:{$sum:{$cond:[{$eq:['$status','failed']},1,0]}},search:{$push:{$concat:[{$ifNull:['$message','']},' ',{$ifNull:['$reply','']}]}}}}];
 if(q)pipeline.push({$match:{search:{$regex:q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'}}});
 pipeline.push({$sort:{lastAt:-1}},{$limit:500},{$project:{search:0}});
 const rows=await db.collection('bot_test_history').aggregate(pipeline).toArray();
 return rows.map(x=>({id:String(x.id),sessionId:x._id.sessionId,lastAt:x.lastAt,preview:x.preview,count:x.count,failed:x.failed}));
}
async function readPilotSession(db,tenant,id){
 allowed(tenant);const col=db.collection('bot_test_history');
 const first=await col.findOne({_id:id,tenant:'NEA_PRUEBAS'});if(!first)return null;
 const records=await col.find({tenant:'NEA_PRUEBAS',sessionId:first.sessionId,userId:first.userId}).sort({createdAt:1,_id:1}).limit(1000).toArray();
 return records.flatMap(x=>[
  {_id:String(x._id)+':user',role:'user',content:x.message,createdAt:x.createdAt},
  {_id:String(x._id)+':reply',role:'assistant',content:x.status==='completed'?x.reply:(x.status==='failed'?'[Error al procesar esta consulta]':'[Respuesta pendiente o prueba interrumpida]'),createdAt:x.completedAt||x.createdAt}
 ]);
}
module.exports={listPilotSessions,readPilotSession};
