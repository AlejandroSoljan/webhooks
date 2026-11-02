'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {groupNotificationDevices: group, publicNotificationDevice: publicDevice} = require('../notification_devices');
const row = (installId, pushToken, more = {}) => ({tenantId:'MCN', installId, pushToken,
  deviceName:'OnePlus OnePlus8Pro', updatedAt:new Date('2026-10-30'), ...more});

test('multiple installation IDs sharing a push destination count once, newest first', () => {
  const grouped = group([row('old','token',{label:'Mi celular'}),row('new','token',{updatedAt:new Date('2026-11-01')})]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].installId, 'new');
  assert.equal(grouped[0].label, 'Mi celular');
  assert.deepEqual(grouped[0].installIds, ['new','old']);
});
test('same model with distinct identities and tokens remains separate', () => {
  assert.equal(group([row('a','one'),row('b','two')]).length, 2);
});
test('token rotation links transitively through the same installation', () => {
  const result = group([row('a','old'),row('b','old'),row('b','new',{updatedAt:new Date('2026-11-01')})]);
  assert.equal(result.length, 1);
  assert.equal(result[0].pushToken, 'new');
});
test('never joins different tenants or missing identity records', () => {
  assert.equal(group([row('a','token'),row('a','token',{tenantId:'NEA'}),row(null,null),row(null,null)]).length, 4);
});
test('public device does not expose token, aliases or internal fields', () => {
  const [device] = group([row('a','secret',{userAgent:'private',pushInvalidAt:new Date()})]);
  const out = publicDevice(device, new Date('2026-10-01'));
  assert.equal(out.active, true);
  assert.equal(out.recordCount, 1);
  for (const name of ['pushToken','userAgent','installIds','pushInvalidAt']) assert.equal(name in out, false);
});
test('verified historical group links future reinstalls via a stable device key',()=>{
 const result=group([row('old','old-token',{notificationGroupId:'confirmed'}),
   row('current','current-token',{notificationGroupId:'confirmed',deviceKey:'stable'}),
   row('reinstalled','new-token',{deviceKey:'stable',updatedAt:new Date('2026-11-02')})]);
 assert.equal(result.length,1);assert.equal(result[0].installId,'reinstalled');
});
test('invalid token is excluded only while that exact token remains registered',()=>{
 const {tokenHash}=require('../notification_devices');
 assert.equal(group([row('a','old',{notificationInvalidTokenHash:tokenHash('old')})])[0].pushToken,null);
 assert.equal(group([row('a','new',{notificationInvalidTokenHash:tokenHash('old')})])[0].pushToken,'new');
});
