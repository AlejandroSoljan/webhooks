// seed_user.js
// Crea un usuario inicial en MongoDB (colección "users").
//
// Uso:
//   node seed_user.js --username admin --password "TuClave" --tenant default --role admin
//
// Requiere: MONGODB_URI (y opcional MONGODB_DBNAME)

require("dotenv").config();
const { getDb } = require("./db");
const { hashPassword } = require("./auth_ui");

function arg(name, def = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  return process.argv[idx + 1] ?? def;
}

(async () => {
  const username = String(arg("username", "")).trim();
  const password = String(arg("password", ""));
  const tenantId = String(arg("tenant", "default")).trim() || "default";
  const role = String(arg("role", "admin")).trim();

  if (!username || !password) {
    console.error("Faltan parámetros: --username y --password");
    process.exit(1);
  }

  const db = await getDb();

  const exists = await db.collection("users").findOne({ username });
  if (exists) {
    console.error("El usuario ya existe:", username);
    process.exit(2);
  }

  const passwordDoc = hashPassword(password);

  await db.collection("users").insertOne({
    username,
    tenantId,
    role: ["user","admin","superadmin"].includes(role) ? role : "admin",
    password: passwordDoc,
    createdAt: new Date(),
    updatedAt: new Date(),
    isLocked: false,
  });

  console.log("✅ Usuario creado:", { username, tenantId, role });
  process.exit(0);
})().catch((e) => {
  console.error("Error:", e);
  process.exit(99);
});
