// db.js
const { MongoClient } = require("mongodb");

let client;
let db;

async function getDb() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "helabot";
  if (!uri) throw new Error("Falta MONGODB_URI");

  client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(dbName);

  // Índices recomendados (idempotentes)
  await Promise.all([
    db.collection("conversations").createIndex({ waId: 1, openedAt: -1 }),
    db.collection("conversations").createIndex({ status: 1, closedAt: -1 }),
    db.collection("messages").createIndex({ conversationId: 1, ts: 1 }),
    // TTL opcional: habilitar si querés auto-limpiar mensajes viejos
    // db.collection("messages").createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })
  ]);

  return db;
}

module.exports = { getDb };
