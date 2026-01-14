// scripts/migrate_products_tenant.js
const { MongoClient } = require("mongodb");

async function run() {
  const uri = process.env.MONGO_URI;
  const dbName = process.env.DB_NAME || "Cluster0";
  const tenantId = process.env.DEFAULT_TENANT || "CARICO";

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const r = await db.collection("products").updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId } }
  );

  console.log("Matched:", r.matchedCount, "Modified:", r.modifiedCount);
  await client.close();
}

run().catch(e => { console.error(e); process.exit(1); });