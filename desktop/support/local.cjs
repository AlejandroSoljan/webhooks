// Asisto | Version: 5.00.074 | Fecha: 2026-09-09
const http = require('node:http');
const ORIGIN = 'https://asistobot.com.ar';
const EXTENSION_ORIGIN = 'chrome-extension://mhdkipfdcoobcghfoklghmpfgkcbbaop';
async function startLocal({ readAccount, port = 17658 }) {
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const deny = status => { res.writeHead(status); res.end(); };
    const origin = req.headers.origin;
    const extensionRequest = req.url === '/extension-session' && origin === EXTENSION_ORIGIN;
    const pairingRequest = req.url === '/pairing' && origin === ORIGIN;
    if ((!extensionRequest && !pairingRequest) || req.headers.host !== `127.0.0.1:${server.address().port}`) return deny(403);
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      if (req.headers['access-control-request-method'] !== 'GET' || !String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(x => x.trim()).includes('x-asisto-local')) return deny(403);
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'X-Asisto-Local');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      return deny(204);
    }
    if (req.method !== 'GET' || req.headers['x-asisto-local'] !== '1') return deny(403);
    try {
      const account = readAccount();
      if (extensionRequest) {
        if (!account?.approved || !/^[A-Za-z0-9_-]{43}$/.test(account.token || '')) return deny(401);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ token: account.token }));
      }
      let state = { state: 'starting' };
      if (account?.approved) state = { state: 'approved', userId: account.userId, tenantId: account.tenantId };
      else if (account && new Date(account.expiresAt) > new Date() && /^[A-F0-9]{12}$/.test(account.code || '')) state = { state: 'pending', code: account.code };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state));
    } catch { deny(503); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 20;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
module.exports = { startLocal };
