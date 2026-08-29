// Asisto | Version: 5.00.001 | Fecha: 2026-08-29
// db.js
const os = require("os");
const { MongoClient, ServerApiVersion } = require("mongodb");

let _client = null;
let _db = null;
let _connectPromise = null;
let _idleCloseTimer = null;
let _lastDbUseAt = 0;
let _idleClosePromise = null;

function readIntEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.max(min, Math.min(max, value));
}

function readIdleDisconnectMs() {
  const raw = Number(process.env.MONGODB_FULL_IDLE_DISCONNECT_MS);
  if (Number.isFinite(raw) && raw <= 0) return 0;
  const value = Number.isFinite(raw) ? Math.trunc(raw) : 300000;
  return Math.max(60000, Math.min(86400000, value));
}

function clearIdleCloseTimer() {
  if (!_idleCloseTimer) return;
  try { clearTimeout(_idleCloseTimer); } catch {}
  _idleCloseTimer = null;
}

function touchDbActivity() {
  _lastDbUseAt = Date.now();
  armIdleCloseTimer();
}

function armIdleCloseTimer() {
  clearIdleCloseTimer();

  const idleMs = readIdleDisconnectMs();
  if (!idleMs || !_client || !_db) return;

  const elapsed = Math.max(0, Date.now() - (_lastDbUseAt || Date.now()));
  const waitMs = Math.max(1000, idleMs - elapsed);

  _idleCloseTimer = setTimeout(async () => {
    _idleCloseTimer = null;
    if (_idleClosePromise || _connectPromise || !_client || !_db) return;

    const inactiveFor = Date.now() - (_lastDbUseAt || 0);
    if (inactiveFor < idleMs) {
      armIdleCloseTimer();
      return;
    }

    _idleClosePromise = closeDb(`idle_timeout_${inactiveFor}ms`)
      .catch(() => {})
      .finally(() => { _idleClosePromise = null; });
    await _idleClosePromise;
  }, waitMs);

  if (_idleCloseTimer && typeof _idleCloseTimer.unref === "function") {
    _idleCloseTimer.unref();
  }
}


function buildMongoAppName() {
  const service = String(
    process.env.RENDER_SERVICE_NAME ||
    process.env.SERVICE_NAME ||
    process.env.APP_NAME ||
    "web"
  ).trim();

  return `asisto-render-${service}-${os.hostname()}-${process.pid}`
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .slice(0, 128);
}

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
    const path = (u.pathname || "").trim();
    if (path && path !== "/") {
      dbName = decodeURIComponent(path.slice(1));
    }
  } catch (e) {}

  if (!dbName) {
    dbName = process.env.MONGODB_DBNAME || "test";
  }
  return dbName;
}

function createMongoClient(uri) {
  const maxPoolSize = readIntEnv("MONGODB_MAX_POOL_SIZE", 5, 1, 20);
  return new MongoClient(uri, {
   serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    appName: buildMongoAppName(),

    // Atlas M0 tiene un límite global bajo. Este proceso comparte un solo pool.
    maxPoolSize,
   minPoolSize: 0,
    maxConnecting: readIntEnv("MONGODB_MAX_CONNECTING", 2, 1, Math.min(10, maxPoolSize)),
    maxIdleTimeMS: readIntEnv("MONGODB_MAX_IDLE_TIME_MS", 60000, 1000, 3600000),
    waitQueueTimeoutMS: readIntEnv("MONGODB_WAIT_QUEUE_TIMEOUT_MS", 10000, 1000, 120000),

    // Evita que el server quede colgado intentando conectar.
    serverSelectionTimeoutMS: readIntEnv("MONGODB_SERVER_SELECTION_TIMEOUT_MS", 8000, 1000, 120000),
    connectTimeoutMS: readIntEnv("MONGODB_CONNECT_TIMEOUT_MS", 8000, 1000, 120000),
    socketTimeoutMS: readIntEnv("MONGODB_SOCKET_TIMEOUT_MS", 45000, 1000, 300000),
  });
}


async function getDb() {
  touchDbActivity();
  if (_idleClosePromise) {
    try { await _idleClosePromise; } catch {}
  }
  if (_db) return _db;
  if (_connectPromise) return _connectPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Falta MONGODB_URI en variables de entorno.");
  if (!_client) _client = createMongoClient(uri);
  const client = _client;

  const dbName = resolveDbNameFromUriOrEnv();

    _connectPromise = (async () => {
    try {
      await client.connect();
      const db = client.db(dbName);

      try {
        await db.command({ ping: 1 });
      } catch (e) {
        console.warn("⚠️ Ping a Mongo falló (continuo igual):", e?.message);
      }

     _db = db;
     touchDbActivity();
      console.log(
           `✅ Conectado a MongoDB | db="${dbName}" | appName="${buildMongoAppName()}" | maxPoolSize=${readIntEnv("MONGODB_MAX_POOL_SIZE", 5, 1, 20)} | fullIdleDisconnectMs=${readIdleDisconnectMs()}`
     );
      return _db;
    } catch (e) {
      if (_client === client) {
        _client = null;
        _db = null;
      }
      try { await client.close(); } catch {}
      throw e;
    } finally {
      _connectPromise = null;
    }
  })();

  return _connectPromise;
}

async function closeDb(reason = "manual") {
  clearIdleCloseTimer();
  const pending = _connectPromise;
  if (pending) {
    try {
      await Promise.race([
        pending.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {}
  }
  const client = _client;
  _client = null;
  _db = null;
  _connectPromise = null;

  try {
    if (client) {
      await client.close();
      console.log(`🔌 Conexión MongoDB cerrada. reason=${String(reason || "manual")}`);
    }
  } catch (e) {
    console.warn("⚠️ Error cerrando MongoDB:", e?.message);
  }
}

module.exports = { getDb, closeDb };
