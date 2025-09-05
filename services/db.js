const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DBNAME || 'whatsapp';

if (!uri) {
  console.warn('⚠️  MONGODB_URI no está definido en .env');
}

let client, db;
async function connect() {
  if (db) return db;
  client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(dbName);
  return db;
}

async function getDb() {
  if (db) return db;
  return connect();
}

module.exports = { connect, getDb };
