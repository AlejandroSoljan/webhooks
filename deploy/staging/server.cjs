// Isolated staging entrypoint. Socket exposed only through the host loopback proxy.
const fs = require('fs');
if (process.env.MONGODB_URI !== 'mongodb://127.0.0.1:27018/asisto_staging') throw Error('Unexpected staging database');
if (process.env.ASISTO_ENVIRONMENT !== 'staging') throw Error('Staging marker required');
const app = require(process.env.ASISTO_STAGING_RELEASE + '/endpoint');
const socket = '/run/asisto-staging/web.sock';
if (fs.existsSync(socket)) fs.unlinkSync(socket);
const server = app.listen(socket, () => { fs.chmodSync(socket, 0o660); console.log('Isolated staging ready'); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
