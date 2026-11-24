// Asisto | Destinatarios verificables, sin tokens públicos | 2026-11-04
'use strict';
function snapshot(d){return {installId:d.installId,installIds:d.installIds||[d.installId],deviceName:String(d.deviceName||'Dispositivo sin identificar').slice(0,120),label:String(d.label||'').slice(0,100),status:'pending'};}
async function history(db,tenantId,devices,selected){
 const group=selected&&devices.find(d=>d.installIds.includes(selected));
 const ids=group?group.installIds:selected?[selected]:[];
 const receiptFilter={tenantId,...(selected?{installIds:{$in:ids}}:{})};
 // Filter in Mongo before the history limit, including older receipt-backed sends.
 let receiptIds=[];
 if(selected)receiptIds=(await db.collection('customer_app_receipts').aggregate([{$match:receiptFilter},{$group:{_id:'$notificationId'}}]).toArray()).map(r=>r._id);
 const filter={tenantId,...(selected?{$or:[{'recipients.installIds':{$in:ids}},{_id:{$in:receiptIds}}]}:{})};
 const rows=await db.collection('customer_app_notifications').find(filter).sort({createdAt:-1}).limit(100).project({title:1,body:1,createdAt:1,notificationType:1,purpose:1,status:1,targetCount:1,successCount:1,failureCount:1,trackingEnabled:1,recipients:1}).toArray();
 const receipts=await db.collection('customer_app_receipts').find({tenantId,notificationId:{$in:rows.map(h=>String(h._id))}}).project({_id:0,notificationId:1,installId:1,installIds:1,deviceName:1,label:1,acceptedAt:1,openedAt:1}).toArray();
 return rows.map(h=>{
  const saved=Array.isArray(h.recipients)?h.recipients:[];
  const rs=receipts.filter(r=>r.notificationId===String(h._id));
  const targets=saved.length?saved:rs.map(r=>({...r,status:r.acceptedAt?'accepted':'unknown'}));
  return {...h,recipients:targets.map(r=>{const d=devices.find(d=>d.installIds.some(id=>(r.installIds||[r.installId]).includes(id)));const receipt=rs.find(x=>(x.installIds||[x.installId]).includes(r.installId));return {installId:r.installId,shortId:String(r.installId||'').slice(-8),label:d?.label||r.label||'',deviceName:d?.deviceName||r.deviceName||'Dispositivo sin identificar',status:r.status,openedAt:receipt?.openedAt||null};}),recipientsComplete:saved.length===h.targetCount&&saved.length>0,recipientEvidence:saved.length?'saved':rs.length?'receipts':'unavailable'};
 });
}
module.exports={snapshot,history};
