const test=require('node:test'),assert=require('node:assert/strict');
const {beginTestRecord}=require('../bot_test_history');
test('archive failure prevents accepting an unrecorded test',async()=>{
 await assert.rejects(beginTestRecord({collection:()=>({insertOne:async()=>{throw Error('unavailable')}})},{tenant:'NEA'}),/unavailable/);
});
