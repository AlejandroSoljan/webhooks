// Run once as root within staging's network namespace. Never prints credentials.
const fs = require('fs'), crypto = require('crypto');
const { MongoClient } = require('/opt/asisto-staging/current/node_modules/mongodb');
(async () => {
  const client = await MongoClient.connect('mongodb://127.0.0.1:27018/asisto_staging');
  try {
    const db = client.db('asisto_staging');
    if (await db.collection('users').countDocuments()) throw Error('Refusing to seed nonempty user collection');
    const plain = crypto.randomBytes(24).toString('base64url'), salt = crypto.randomBytes(16);
    const access = '/etc/asisto-staging-access.json';
    fs.writeFileSync(access, JSON.stringify({ username: 'staging-admin', password: plain, tenantId: 'DEMO_DEV' }), { mode: 0o600, flag: 'wx' });
    await db.collection('users').insertOne({ username: 'staging-admin', role: 'superadmin', tenantId: 'DEMO_DEV', password: { salt: salt.toString('hex'), hash: crypto.scryptSync(plain, salt, 64).toString('hex') }, createdAt: new Date() });
    console.log('Synthetic staging administrator created; credential stored root-only at ' + access);
  } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
