require('dotenv').config();

const app = require('./endpoint');
const {
  startTelegramRuntime,
  stopTelegramRuntime,
  mountTelegramRoutes,
} = require('./telegram_runtime');

const PORT = Number(process.env.PORT || 3000);

mountTelegramRoutes(app);

const server = app.listen(PORT, () => {
  console.log(`🚀 Web + Telegram corriendo en http://localhost:${PORT}`);
});

(async () => {
  try {
    const status = await startTelegramRuntime();
    console.log('🤖 Telegram runtime:', {
      tenantId: status?.tenantId,
      botState: status?.botState,
      botStarted: status?.botStarted,
      username: status?.telegramBotUsername,
    });
  } catch (e) {
    console.error('❌ No se pudo iniciar Telegram:', e?.message || e);
  }
})();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} recibido. Cerrando web + Telegram...`);

  try {
    await stopTelegramRuntime(signal);
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
