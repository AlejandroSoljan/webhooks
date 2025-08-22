// db.js
const { MongoClient, ServerApiVersion } = require("mongodb");

let client;
let db;

async function getDb() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "helabot";
  if (!uri) throw new Error("Falta MONGODB_URI");

  client = new MongoClient(uri, {
    maxPoolSize: 10,
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    tls: true,
    directConnection: false
  });

  await client.connect();
  db = client.db(dbName);

  // Índices recomendados (idempotentes)
  await Promise.all([
    db.collection("conversations").createIndex({ waId: 1, openedAt: -1 }),
    db.collection("conversations").createIndex({ status: 1, closedAt: -1 }),
    db.collection("messages").createIndex({ conversationId: 1, ts: 1 }),
    db.collection("contacts").createIndex({ waId: 1 }, { unique: true }) // contactos por número
  ]);

  return db;
}

module.exports = { getDb };
