// services/mongoService.js
const { MongoClient } = require("mongodb");

let client;
let db;

async function getDb() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || process.env.MONGODB_DB || "app";
  if (!uri) throw new Error("Falta MONGODB_URI");
  client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(dbName);
  return db;
}

module.exports = { getDb };
