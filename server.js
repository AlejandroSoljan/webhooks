require('dotenv').config();

const app = require('./endpoint');

const PORT = Number(process.env.PORT || 3000);
const ENABLE_TELEGRAM = /^(1|true|yes|si|sí)$/i.test(String(process.env.ENABLE_TELEGRAM || 'true'));

let telegramRuntime = null;
let telegramRoutesMounted = false;

async function loadTelegramRuntime() {
  if (!ENABLE_TELEGRAM) return null;
  if (telegramRuntime) return telegramRuntime;
  try {
    telegramRuntime = require('./telegram_runtime');
    return telegramRuntime;
  } catch (e) {
    console.error('Telegram runtime no disponible:', e?.message || e);
    return null;
  }
}

(async () => {
  const runtime = await loadTelegramRuntime();
  if (runtime && !telegramRoutesMounted && typeof runtime.mountTelegramRoutes === 'function') {
    try {
      runtime.mountTelegramRoutes(app);
      telegramRoutesMounted = true;
    } catch (e) {
      console.error('No se pudieron montar rutas Telegram:', e?.message || e);
    }
  }
})().catch(() => {});

const server = app.listen(PORT, () => {
  console.log(`🚀 Web corriendo en http://localhost:${PORT}`);
});

(async () => {
  const runtime = await loadTelegramRuntime();
  if (!runtime || typeof runtime.startTelegramRuntime !== 'function') return;

  try {
    const status = await runtime.startTelegramRuntime();
    console.log('🤖 Telegram runtime:', {
      total: status?.total || 0,
      started: status?.started || 0,
      tenants: Array.isArray(status?.items)
        ? status.items.map((x) => ({
            tenantId: x.tenantId,
            botState: x.botState,
            botStarted: x.botStarted,
            username: x.telegramBotUsername,
          }))
        : [],
    });
  } catch (e) {
    console.error('❌ No se pudo iniciar Telegram:', e?.message || e);
  }
})().catch(() => {});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} recibido. Cerrando web + Telegram...`);

  try {
    const runtime = await loadTelegramRuntime();
    if (runtime?.stopTelegramRuntime) {
      await runtime.stopTelegramRuntime(signal);
    }
  } catch (e) {
    console.error('Error cerrando Telegram:', e?.message || e);
  }

  try {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  } catch {
    process.exit(0);
  }
}

process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGBREAK', () => { shutdown('SIGBREAK'); });
