// db.js
const { MongoClient, ServerApiVersion } = require("mongodb");

let _client = null;
let _db = null;

/**
 * Extrae el dbName desde la MONGODB_URI (si viene en el path).
 * Si no viene, usa MONGODB_DBNAME o 'test'.
 */
function resolveDbNameFromUriOrEnv() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Falta MONGODB_URI en variables de entorno.");

  let dbName = null;
  try {
    const u = new URL(uri);
    // pathname viene como '/nombre' o '/' si no hay db
    const path = (u.pathname || "").trim();
    if (path && path !== "/") {
      dbName = decodeURIComponent(path.slice(1));
    }
  } catch (e) {
    // Si la URI no parsea con URL (casos muy viejos), ignoramos y seguimos
  }

  if (!dbName) {
    dbName = process.env.MONGODB_DBNAME || "test";
  }
  return dbName;
}

async function getDb() {
  if (_db) return _db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Falta MONGODB_URI en variables de entorno.");

  const dbName = resolveDbNameFromUriOrEnv();

  if (!_client) {
    _client = new MongoClient(uri, {
      // Recomendado por Atlas
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      // TLS por defecto en mongodb+srv; no hace falta más en Render/Atlas
      // useUnifiedTopology/useNewUrlParser ya no son necesarios en drivers modernos
    });
  }

  if (!_client.topology?.isConnected()) {
    await _client.connect();
    // (opcional) ping de cortesía
    try {
      await _client.db(dbName).command({ ping: 1 });
      console.log(`✅ Conectado a MongoDB | db="${dbName}"`);
    } catch (e) {
      console.warn("⚠️ Ping a Mongo falló (continuo igual):", e?.message);
    }
  }

  _db = _client.db(dbName);
  return _db;
}

async function closeDb() {
  try {
    if (_client) {
      await _client.close();
      _client = null;
      _db = null;
      console.log("🔌 Conexión MongoDB cerrada.");
    }
  } catch (e) {
    console.warn("⚠️ Error cerrando MongoDB:", e?.message);
  }
}

module.exports = { getDb, closeDb };
