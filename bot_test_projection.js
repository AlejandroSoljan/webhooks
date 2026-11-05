const crypto=require('crypto');
const {ObjectId}=require('mongodb');
const oid=value=>new ObjectId(crypto.createHash('sha256').update(value).digest('hex').slice(0,24));
async function syncPilotRecord(db,record){
 if(record?.tenant!=='NEA_PRUEBAS')return;
 const tenantId='NEA_PRUEBAS',conversationId=oid('pilot:'+record.sessionId+':'+record.userId);
 const col=db.collection('conversations'),prior=await col.findOne({_id:conversationId,tenantId});
 const newer=!prior||new Date(record.createdAt)>new Date(prior.lastUserTs||0);
 const set={isTest:true,channelType:'bot_test',sourceTenant:'NEA_PRUEBAS',botMode:'conversacional',contactName:'Prueba NEA · '+record.sessionId.slice(0,12)};
 if(newer)Object.assign(set,{finalized:false,status:'OPEN',manualOpen:false});
 await col.updateOne({_id:conversationId,tenantId},{$set:set,$setOnInsert:{tenantId,waId:'BOT_TEST:'+String(conversationId),openedAt:record.createdAt,createdAt:record.createdAt},$max:{updatedAt:record.createdAt,lastUserTs:record.createdAt}},{upsert:true});
 const entries=[['user',record.message,record.createdAt]];
 if(record.status==='completed')entries.push(['assistant',record.reply,record.completedAt||record.createdAt]);
 for(const [role,content,ts] of entries)await db.collection('messages').updateOne({_id:oid('pilot-message:'+record._id+':'+role)},{$set:{tenantId,conversationId,isTest:true,role,type:'text',content,ts,createdAt:ts}},{upsert:true});
 return conversationId;
}
module.exports={syncPilotRecord};
