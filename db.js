// db.js
const { MongoClient, ServerApiVersion } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;         // ej: mongodb+srv://user:pass@cluster.rqoqjny.mongodb.net/?retryWrites=true&w=majority
const MONGODB_DBNAME = process.env.MONGODB_DBNAME;   // ej: "mi_base"

if (!MONGODB_URI) {
  throw new Error("Falta MONGODB_URI en .env");
}
if (!MONGODB_DBNAME) {
  throw new Error("Falta MONGODB_DBNAME en .env");
}

let client;
let db;
let connectingPromise;

/**
 * Devuelve un singleton de DB. Reutiliza la conexión entre llamadas.
 */
async function getDb() {
  if (db) return db;

  if (!connectingPromise) {
    connectingPromise = (async () => {
      client = new MongoClient(MONGODB_URI, {
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true
        },
        // Opcionales, útiles en entornos serverless:
        maxPoolSize: parseInt(process.env.MONGO_MAX_POOL || "10", 10),
        minPoolSize: 0,
        connectTimeoutMS: parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS || "15000", 10),
        socketTimeoutMS: parseInt(process.env.MONGO_SOCKET_TIMEOUT_MS || "60000", 10),
        retryWrites: true,
        tls: true, // Atlas requiere TLS
      });

      await client.connect();

      // Ping de salud
      await client.db("admin").command({ ping: 1 });

      db = client.db(MONGODB_DBNAME);

      // (Opcional) crear índices si no existen aún
      await ensureIndexes(db);

      return db;
    })().catch((err) => {
      // si falló, permite reintentar en el próximo getDb
      connectingPromise = null;
      throw err;
    });
  }

  return connectingPromise;
}

/**
 * Crea índices útiles para el flujo del bot. Idempotente.
 */
async function ensureIndexes(db) {
  // Conversaciones
  await db.collection("conversations").createIndexes([
    { key: { waId: 1, status: 1 } },                // búsqueda por usuario y estado
    { key: { openedAt: -1 } },                      // orden por fecha
    { key: { closedAt: -1 } },                      // orden por cierre
  ]);

  // Mensajes
  await db.collection("messages").createIndexes([
    { key: { conversationId: 1, ts: 1 } },          // línea de tiempo de la conversación
    { key: { role: 1, ts: -1 } },                   // análisis por rol
    { key: { expireAt: 1 }, expireAfterSeconds: 0, name: "ttl_expireAt", sparse: true }, // TTL opcional
  ]);
}

/**
 * Cierra la conexión (útil en tests o scripts).
 */
async function closeDb() {
  if (client) {
    await client.close().catch(() => {});
    client = null;
    db = null;
    connectingPromise = null;
  }
}

module.exports = { getDb, closeDb };
