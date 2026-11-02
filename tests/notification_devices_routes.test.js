'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(rows) {
  const routes = new Map(), sends = [], records = [];
  const db = {collection: name => ({
    find: query => {
      const cursor = {sort(){return this;},limit(){return this;},project(){return this;},
        async toArray(){return name === 'customer_app_devices' ? rows.filter(d =>
          d.tenantId === query.tenantId && !d.disabled &&
          (!query.installId || query.installId.$in.includes(d.installId))) : [];}};
      return cursor;
    },
    async insertOne(record){records.push(record);return {insertedId:'notice'};},
    async updateOne(){return {matchedCount:1};}
  })};
  const exports = {};
  const sandbox = {module:{exports},exports,console,URL,AbortSignal,
    process:{env:{FIREBASE_CLIENT_EMAIL:'test@example.invalid',FIREBASE_PRIVATE_KEY:'fake-key'}},
    fetch:async (_url, options) => {sends.push(JSON.parse(options.body).message);return {ok:true,json:async()=>({name:'sent'})};},
    require: name => name === 'express' ? {json:()=>((_q,_s,next)=>next())} :
      name === 'googleapis' ? {google:{auth:{GoogleAuth:class {async getClient(){return {getAccessToken:async()=>({token:'fake'})};}}}}} :
      name === './db' ? {getDb:async()=>db} : require(path.resolve(__dirname,'..',name))};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../customer_notifications.js'),'utf8'),sandbox);
  const app = {locals:{},get:(route,...handlers)=>routes.set('GET '+route,handlers.at(-1)),
    post:(route,...handlers)=>routes.set('POST '+route,handlers.at(-1)),
    patch:()=>{}};
  sandbox.module.exports.mountCustomerNotifications(app,{requireAuth:(_q,_s,next)=>next()});
  async function call(method, body, user = {role:'superadmin'}) {
    const res = {code:200,status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
    await routes.get(method+' /api/customer-notifications/:tenant')({params:{tenant:'MCN'},query:{},body,user},res);
    return res;
  }
  return {call,sends,records,page:sandbox.module.exports.panelPage};
}
const rows = () => [
  {tenantId:'MCN',installId:'old',pushToken:'token',deviceName:'OnePlus',updatedAt:new Date('2026-10-29')},
  {tenantId:'MCN',installId:'new',pushToken:'token',deviceName:'OnePlus',updatedAt:new Date('2026-11-01')},
  {tenantId:'OTHER',installId:'foreign',pushToken:'other-token',updatedAt:new Date()},
];

test('panel groups registrations and counts once without exposing private token',async()=>{
  const h = harness(rows()), result = await h.call('GET');
  assert.equal(result.code,200);
  assert.equal(result.data.summary.total,1);
  assert.equal(result.data.devices[0].installId,'new');
  assert.equal(JSON.stringify(result.data).includes('pushToken'),false);
});
test('selecting both aliases sends once; selecting the old alias resolves the current target',async()=>{
  for (const installIds of [['old','new'],['old']]) {
    const h=harness(rows());
    const result=await h.call('POST',{title:'Prueba',body:'Mensaje',installIds});
    assert.equal(result.code,200);
    assert.equal(h.sends.length,1);
    assert.equal(h.sends[0].token,'token');
    assert.equal(h.records[0].targetCount,1);
    assert.equal(result.data.successCount,1);
  }
});
test('same model alone cannot collapse recipients; unauthorized tenant cannot send',async()=>{
  const own=rows();own.push({...own[1],installId:'separate',pushToken:'separate-token'});
  const h=harness(own);
  assert.equal((await h.call('GET')).data.summary.total,2);
  assert.equal((await h.call('POST',{title:'x',body:'y',installIds:['old']},{role:'user',tenantId:'OTHER'})).code,403);
  assert.equal(h.sends.length,0);
});
