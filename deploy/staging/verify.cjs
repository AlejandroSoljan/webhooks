// Run inside the staging app network namespace; never accepts a production URI.
const net = require('net');
const { MongoClient } = require('/opt/asisto-staging/current/node_modules/mongodb');
const probe = (host, port) => new Promise(resolve => {
  const s = net.createConnection({ host, port });
  s.setTimeout(1000);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.once('timeout', () => { s.destroy(); resolve(false); });
});
(async () => {
  const client = await MongoClient.connect('mongodb://127.0.0.1:27018/asisto_staging', { serverSelectionTimeoutMS: 3000 });
  try {
    const db = client.db('asisto_staging');
    await db.command({ ping: 1 });
    if (await probe('127.0.0.1', 27017)) throw Error('Host MongoDB reachable');
    if (await probe('1.1.1.1', 443)) throw Error('Internet reachable');
    console.log(JSON.stringify({ database: db.databaseName, hostMongoBlocked: true, internetBlocked: true, collections: (await db.listCollections().toArray()).length }));
  } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
