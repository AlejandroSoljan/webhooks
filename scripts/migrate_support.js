// Asisto | Version: 5.00.049 | Fecha: 2026-09-08
require('dotenv').config();
const { getDb, closeDb } = require('../db');
const { migrate } = require('../src/support/migration');
(async () => { try { await migrate(await getDb()); console.log('Support migration 001 applied.'); } finally { await closeDb(); } })().catch(() => { console.error('Support migration failed.'); process.exitCode = 1; });
