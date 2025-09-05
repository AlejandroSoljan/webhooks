// services/mongoService.js
const { MongoClient } = require("mongodb");

let client;
let db;

async function getDb() {
  if (!db) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db();
    console.log("✅ Conectado a MongoDB");
  }
  return db;
}

module.exports = { getDb };
