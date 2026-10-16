// Asisto | Version: 5.00.297 | Fecha: 2026-10-16
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {MongoMemoryServer}=require('mongodb-memory-server');
const {MongoClient}=require('mongodb');
const {createVault}=require('../src/support/crypto');
const {SupportService}=require('../src/support/service');
const {SupportMail,configOf,publicAddress,mailbox}=require('../src/support/mail');
let mongo,client,db,service,mail,options,sends,verified,outcome,now;
const scope={tenantId:'ALSO',userId:'one'},other={tenantId:'ALSO',userId:'two'};
const config={host:'smtp.example.com',port:587,user:'u@example.com',password:'APP-SECRET',from:'u@example.com',name:'Usuario'};
const message={key:'12345678-1234-1234-1234-123456789012',to:'client@example.com',subject:'Tarea',body:'Resumen',confirm:true};
before(async()=>{mongo=await MongoMemoryServer.create();client=await MongoClient.connect(mongo.getUri());db=client.db('mail_test');});
after(async()=>{await client?.close();await mongo?.stop();});
beforeEach(async()=>{await db.dropDatabase();now=new Date();sends=[];verified=0;outcome='ok';options=null;
 service=new SupportService(db,createVault({test:Buffer.alloc(32,2).toString('base64')},'test'),{now:()=>now});
 mail=new SupportMail(service,{resolve:async()=>['8.8.8.8'],transportFactory:o=>{options=o;return{verify:async()=>{++verified;},sendMail:async m=>{sends.push(m);if(outcome==='timeout')throw new Error('secret-provider-error');if(outcome==='reject')throw Object.assign(new Error('secret-error'),{responseCode:550});return{accepted:['client@example.com']};},close(){}};}});
});
test('SMTP config is encrypted per user, masked on read and never reuses password on another account',async()=>{
 await mail.save(scope,config);const view=await mail.view(scope);assert.equal(view.configured,true);assert.equal(view.password,undefined);
 assert.equal((await mail.view(other)).configured,false);
 const stored=await service.col('mail_settings').findOne({userId:'one'});assert.ok(!JSON.stringify(stored).includes('APP-SECRET'));
 await mail.save(scope,{...config,password:''});assert.equal((await mail.config(scope)).password,'APP-SECRET');
 await assert.rejects(mail.save(scope,{...config,user:'other@example.com',password:''}),/mail_password_required/);
 assert.throws(()=>configOf({...config,port:25}),/mail_invalid_server/);
});
test('SMTP pins public IPs, requires TLS and rejects internal DNS, IP literals and header injection',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','224.0.0.1'])await assert.rejects(publicAddress('smtp.example.com',async()=>[ip]),/mail_server_not_public/);
 await assert.rejects(publicAddress('smtp.example.com',async()=>['8.8.8.8','10.0.0.1']),/mail_server_not_public/);
 assert.throws(()=>configOf({...config,host:'127.0.0.1'}),/mail_invalid_server/);
 assert.throws(()=>mailbox('a@example.com\r\nBcc:x@example.com'),/mail_invalid_address/);
 await mail.save(scope,config);await mail.verify(scope);assert.equal(verified,1);assert.equal(sends.length,0);
 assert.equal(options.host,'8.8.8.8');assert.equal(options.requireTLS,true);assert.equal(options.tls.servername,config.host);assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.disableFileAccess,true);
 await assert.rejects(mail.verify(scope),/mail_rate_limited/);
});
test('confirmed email is sent once, recorded against task/ticket and retries never duplicate it',async()=>{
 await mail.save(scope,config);const draft={_id:'task',hubspot:{ticketId:'42'}};
 await assert.rejects(mail.send(scope,draft,{...message,confirm:false}),/mail_confirmation_required/);
 const first=await mail.send(scope,draft,message);const second=await mail.send(scope,draft,message);
 assert.equal(first.state,'accepted');assert.equal(second.duplicate,true);assert.equal(sends.length,1);assert.equal(sends[0].text,'Resumen');assert.equal(sends[0].html,undefined);
 const stored=await service.col('mail_attempts').findOne({_id:first.id});assert.equal(stored.ticketId,'42');assert.ok(!JSON.stringify(stored).includes('client@example.com'));
 assert.equal((await mail.history(other,'task')).length,0);assert.equal((await mail.history(scope,'task'))[0].state,'accepted');
 await assert.rejects(mail.send(scope,draft,{...message,body:'otro'}),/mail_key_conflict/);
});
test('ambiguous timeouts remain uncertain, SMTP rejections stay distinct and no automatic retry occurs',async()=>{
 await mail.save(scope,config);outcome='timeout';assert.equal((await mail.send(scope,{_id:'task'},message)).state,'uncertain');
 assert.equal((await mail.send(scope,{_id:'task'},message)).state,'uncertain');assert.equal(sends.length,1);
 now=new Date(+now+4000);outcome='reject';assert.equal((await mail.send(scope,{_id:'task'},{...message,key:'22345678-1234-1234-1234-123456789012'})).state,'rejected');
 assert.ok(!JSON.stringify(await mail.history(scope,'task')).includes('secret'));
});
