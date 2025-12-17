// seed_user.js
// Uso:
//   node seed_user.js --username admin --password "TuClave" --tenant default --role admin
//
// Crea/actualiza el usuario en la colección "users" (MongoDB).

require("dotenv").config();
const { getDb } = require("./db");
const { hashPassword } = require("./auth_ui");

function arg(name, def = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return def;
}

(async () => {
  const username = String(arg("username")).trim().toLowerCase();
  const password = String(arg("password")).trim();
  const tenantId = String(arg("tenant", "default")).trim();
  const role = String(arg("role", "admin")).trim();

  if (!username || !password) {
    console.log("Faltan parámetros. Ejemplo:");
    console.log('  node seed_user.js --username admin --password "TuClave" --tenant default --role admin');
    process.exit(1);
  }

  const db = await getDb();
  const doc = {
    username,
    password: hashPassword(password),
    tenantId,
    role,
    active: true,
    updatedAt: new Date(),
  };

  const res = await db.collection("users").updateOne(
    { username },
    { $set: doc, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  console.log("OK. Usuario listo:", { username, tenantId, role, upserted: !!res.upsertedId, modified: res.modifiedCount });
  process.exit(0);
})().catch((e) => {
  console.error("seed_user error:", e);
  process.exit(1);
});
