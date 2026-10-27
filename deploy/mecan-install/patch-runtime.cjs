// Asisto | Aplicación acotada sobre las variantes vigentes del turnero | 2026-10-27
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(root, 'customer_queue.js'))) throw Error('Falta una release explícita del turnero.');
function patch(file, changes) {
  const target = path.join(root, file); let text = fs.readFileSync(target, 'utf8');
  for (const [before, after] of changes) {
    if (text.includes(after)) continue;
    if (text.split(before).length !== 2) throw Error('Marcador ambiguo o ausente: ' + file + ' / ' + before.slice(0, 60));
    text = text.replace(before, after);
  }
  fs.writeFileSync(target, text);
}
patch('queue_mobile.js', [
  ["    setupTicketNotices();", "    setupTicketNotices();\n    try { if (window.AsistoNative?.completeInstallTicket) window.AsistoNative.completeInstallTicket(x.id); } catch (_) {}\n    if (typeof offerMecanInstall === 'function') offerMecanInstall(x);"],
  ["function setupTicketNotices() {", "function setupTicketNotices() {\n  if (typeof restoreMecanInstallReturn === 'function') restoreMecanInstallReturn(localStorage.asistoTicketId);"]
]);
patch('customer_app_web.js', [
  ["const branding = require('./queue_branding');", "const branding = require('./queue_branding');\nconst { offerMecanInstall, restoreMecanInstallReturn } = require('./queue_install');"],
  ['${linkReservedTicket.toString()}', '${linkReservedTicket.toString()}\nconst MECAN_INSTALL_PROMPT_ENABLED=${/^(1|true)$/i.test(process.env.MECAN_INSTALL_PROMPT_ENABLED || \'\')};\n${offerMecanInstall.toString()}\n${restoreMecanInstallReturn.toString()}']
]);
patch('customer_queue.js', [
  ["const QRCode = require('qrcode');", "const QRCode = require('qrcode');\nconst { handoffDuration } = require('./queue_install');"],
  ["  app.post('/api/customer-app/:tenant/tickets/:id/handoff', wrap(async (req, res) => {", "  app.post('/api/customer-app/:tenant/tickets/:id/handoff', wrap(async (req, res) => {\n    const expiresAt = new Date(Date.now() + handoffDuration(req.body?.purpose));"],
  ['handoffExpiresAt: new Date(Date.now() + 180000)', 'handoffExpiresAt: expiresAt'],
  ['res.json({ code });', 'res.json({ code, expiresAt });']
]);
console.log('Integración de instalación aplicada sobre la release conservando sus demás funciones.');
