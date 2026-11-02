'use strict';
const fs=require('fs');
const [runtime,pid]=process.argv.slice(2);
for(const item of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0')){const i=item.indexOf('=');if(i>0)process.env[item.slice(0,i)]=item.slice(i+1);}
require(runtime+'/node_modules/dotenv').config({path:'/etc/asisto/production.env',quiet:true});
const routes=new Map(),app={locals:{},get:(p,...h)=>routes.set(p,h.at(-1)),post(){},patch(){}};
require(runtime+'/customer_notifications').mountCustomerNotifications(app,{requireAuth:(_q,_s,next)=>next()});
const res={status(code){throw Error('http_'+code);},json(data){
 const onePlus=data.devices.filter(d=>/oneplus/i.test(d.deviceName||''));
 if(onePlus.length!==1||onePlus[0].recordCount!==22||data.devices.some(d=>'pushToken' in d))throw Error('unexpected_panel_result');
 console.log(JSON.stringify({summary:data.summary,devices:data.devices.map(d=>({model:d.deviceName,id:d.shortId,records:d.recordCount})),onePlusGroups:onePlus.length}));process.exit(0);
}};
routes.get('/api/customer-notifications/:tenant')({params:{tenant:'MCN'},query:{},user:{role:'superadmin'}},res).catch(e=>{console.error(e.name);process.exit(1);});
