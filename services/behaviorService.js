// services/behaviorService.js
const { getDb } = require("./mongoService");

async function getBehaviorUI(req, res) {
  res.send("<h1>Comportamiento del Bot</h1>");
}

async function getBehavior(req, res) {
  const db = await getDb();
  const behavior = await db.collection("behavior").findOne({});
  res.json(behavior || { behavior: "default" });
}

async function saveBehavior(req, res) {
  const db = await getDb();
  await db.collection("behavior").updateOne({}, { $set: req.body }, { upsert: true });
  res.json({ success: true });
}

module.exports = { getBehaviorUI, getBehavior, saveBehavior };
