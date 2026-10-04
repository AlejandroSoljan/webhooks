// Read-only audit, or protected backup before the automatic day-end migration.
const fs=require('fs'),cp=require('child_process');
const dest=process.argv[2],mode=process.argv[3];
if(!['aws','mecan'].includes(dest)||!['backup','verify'].includes(mode))throw Error('Invalid arguments');
const root=fs.realpathSync(dest==='aws'?'/opt/asisto/turnero/current':'/opt/asisto/turnero-local/current');
const req=require('module').createRequire(root+'/package.json');
const service=dest==='aws'?'asisto-turnero':'asisto-turnero-local';
const pid=cp.execFileSync('systemctl',['show',service,'-p','MainPID','--value']).toString().trim();
for(const part of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0')){const i=part.indexOf('=');if(i>0)process.env[part.slice(0,i)]=part.slice(i+1)}
req('dotenv').config({path:process.env.DOTENV_CONFIG_PATH||(dest==='aws'?'/etc/asisto/production.env':'/etc/asisto/turnero-local.env'),quiet:true});
const {getDb,closeDb}=req('./db');
(async()=>{const db=await getDb();const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires'}).format(new Date());
 const filter={dayKey:{$lt:today,$regex:/^\d{4}-\d{2}-\d{2}$/},status:{$in:['WAITING','CALLED','RESERVED']}};
 const rows=await db.collection('queue_tickets').find(filter).toArray();
 console.log(JSON.stringify({host:require('os').hostname(),database:db.databaseName,today,pendingOld:rows.length,MCN:rows.filter(r=>r.tenantId==='MCN').length}));
 if(mode==='backup'){
  fs.mkdirSync('/var/backups/asisto',{recursive:true,mode:0o700});
  const target='/var/backups/asisto/queue-day-expiry-20261004.json';
  fs.writeFileSync(target,req('bson').EJSON.stringify(rows),{flag:'wx',mode:0o600});console.log('BACKUP '+target);
 }else{
  console.log('MCN_EXPIRED '+await db.collection('queue_tickets').countDocuments({tenantId:'MCN',expiryReason:'day_end',status:'SKIPPED'}));
  if(rows.length)throw Error('Prior-day open tickets remain');
 }
 await closeDb();})().catch(e=>{console.error(e.message);process.exitCode=1;closeDb()});
