'use strict';
const fs=require('fs'),crypto=require('crypto');
const [runtime,pid,report]=process.argv.slice(2);
for(const item of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0')){const i=item.indexOf('=');if(i>0)process.env[item.slice(0,i)]=item.slice(i+1);}
require(runtime+'/node_modules/dotenv').config({path:'/etc/asisto/production.env',quiet:true});
(async()=>{
 const db=await require(runtime+'/db').getDb();
 if(db.databaseName!=='Cluster0'||new URL(process.env.MONGODB_URI).hostname!=='127.0.0.1')throw Error('unexpected_database');
 const c=require(runtime+'/customer_notifications').firebaseCredentials();if(!c.configured)throw Error('firebase_not_configured');
 const {google}=require(runtime+'/node_modules/googleapis');
 const auth=new google.auth.GoogleAuth({credentials:{client_email:c.clientEmail,private_key:c.privateKey},scopes:['https://www.googleapis.com/auth/firebase.messaging']});
 const access=await(await auth.getClient()).getAccessToken(),bearer=access.token||access;
 const rows=await db.collection('customer_app_devices').find({disabled:{$ne:true},pushToken:{$type:'string'}}).toArray(),results=[];
 let next=0;await Promise.all(Array.from({length:4},async()=>{while(next<rows.length){const d=rows[next++];
  let code='UNKNOWN';try{
   const r=await fetch('https://fcm.googleapis.com/v1/projects/'+encodeURIComponent(c.projectId)+'/messages:send',{method:'POST',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},body:JSON.stringify({validate_only:true,message:{token:d.pushToken,data:{asisto_validation:'1'}}})});
   const body=await r.json();code=r.ok?'VALID':(body.error?.details||[]).find(v=>v.errorCode)?.errorCode||body.error?.status||'HTTP_'+r.status;
  }catch(e){code=e.name;}
  results.push({tenantId:d.tenantId,installId:d.installId,deviceName:d.deviceName,tokenHash:crypto.createHash('sha256').update(d.pushToken).digest('hex'),code,at:new Date().toISOString()});
 }}));
 fs.writeFileSync(report,JSON.stringify({database:db.databaseName,validateOnly:true,results},null,2),{mode:0o600});
 console.log(JSON.stringify({total:results.length,codes:results.reduce((out,r)=>(out[r.code]=(out[r.code]||0)+1,out),{}),onePlus:results.filter(r=>/oneplus/i.test(r.deviceName||'')).map(r=>({id:r.installId.slice(-10),code:r.code})),report}));process.exit(0);
})().catch(e=>{console.error(e.name);process.exit(1);});
