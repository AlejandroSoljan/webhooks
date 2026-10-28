// Asisto | Regresión de instalación Mecan sin perder el turno | 2026-10-27
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { handoffDuration, offerMecanInstall, restoreMecanInstallReturn, prepareMecanTicketTransfer, mecanTicketAppIntent } = require('../queue_install');
const ticket = { id: '0123456789abcdef01234567', displayNumber: 'F001', status: 'WAITING' };
function browser(options = {}) {
  const dom = new JSDOM('<html><head></head><body><div id="my"></div></body></html>', { url: 'https://asistobot.com.ar/customer-app/MCN' });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const context = vm.createContext({ document: dom.window.document, window: options.native ? { AsistoNative: {} } : {},
    TENANT: options.tenant || 'MCN', MECAN_INSTALL_PROMPT_ENABLED: options.enabled !== false,
    navigator: { userAgent: options.ua || 'Android' }, sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage,
    API: '/api/customer-app/MCN', installId: 'web-owner', Date, URL, URLSearchParams,
    location: { origin: 'https://asistobot.com.ar', href: '' }, el: id => dom.window.document.getElementById(id),
    fetch: options.fetch || (async () => ({ ok: true, json: async () => ({ code: 'a'.repeat(43), expiresAt: new Date(Date.now() + 7200000).toISOString() }) })) });
  vm.runInContext([restoreMecanInstallReturn,offerMecanInstall,prepareMecanTicketTransfer,mecanTicketAppIntent].map(fn=>fn.toString()).join('\n'), context);
  return { dom, context, offer: value => context.offerMecanInstall(value || ticket) };
}
test('handoff conserves short links and allows two hours to install', () => {
  assert.equal(handoffDuration(), 180000); assert.equal(handoffDuration('install'), 7200000);
  assert.throws(() => handoffDuration('unknown'), error => error.status === 400);
});
test('prompt is scoped to Android web, active MCN ticket, and explicit rollout flag', () => {
  for (const opts of [{ native: true }, { tenant: 'OTHER' }, { ua: 'iPhone' }, { enabled: false }]) {
    const b = browser(opts); b.offer(); assert.equal(b.dom.window.document.querySelector('dialog'), null); b.dom.window.close();
  }
  const b = browser(); b.offer({ ...ticket, status: 'DONE' }); assert.equal(b.dom.window.document.querySelector('dialog'), null); b.dom.window.close();
});
test('dismissal preserves the ticket and does not offer repeatedly', () => {
  const b = browser(); b.offer();
  assert.equal(b.dom.window.document.querySelector('.mecanInstallKeep strong').textContent, 'Tu turno F001 sigue con vos');
  b.dom.window.document.querySelector('.mecanInstallLater').click();
  b.offer(); assert.equal(b.dom.window.document.querySelector('dialog'), null); assert.equal(b.context.location.href, ''); b.dom.window.close();
});
test('saves handoff before Google Play and keeps a browser return link to the same ticket', async () => {
  let payload;
  const b = browser({ fetch: async (_url, req) => { payload = JSON.parse(req.body); return { ok: true, json: async () => ({ code: 'a'.repeat(43), expiresAt: new Date(Date.now() + 7200000).toISOString() }) }; } });
  b.offer(); await b.dom.window.document.querySelector('.mecanInstallAction').onclick();
  assert.deepEqual(payload, { installId: 'web-owner', purpose: 'install' });
  const play = new URL(b.context.location.href); assert.equal(play.hostname, 'play.google.com'); assert.equal(play.searchParams.get('id'), 'ar.com.asisto.mecan');
  const referrer = new URLSearchParams(play.searchParams.get('referrer')); assert.equal(referrer.get('mecan_ticket'), ticket.id); assert.equal(referrer.get('mecan_code'), 'a'.repeat(43));
  assert.ok(b.dom.window.localStorage.getItem('mecanInstallTransfer:' + ticket.id));
  b.dom.window.document.getElementById('mecanInstallReturn').remove();
  b.context.restoreMecanInstallReturn(ticket.id); // Reconstrucción tras regresar de Google Play o recargar.
  b.dom.window.document.getElementById('mecanInstallReturn').click();
  const app = new URL(b.context.location.href), claim = new URL(app.searchParams.get('url'));
  assert.equal(app.protocol, 'intent:'); assert.equal(claim.searchParams.get('claim'), ticket.id); assert.equal(claim.hash, '#code=' + 'a'.repeat(43));
  const fallback=new URL(decodeURIComponent(app.hash.split('S.browser_fallback_url=')[1].split(';end')[0]));
  assert.equal(fallback.hostname,'play.google.com');assert.equal(fallback.searchParams.get('id'),'ar.com.asisto.mecan');
  b.dom.window.close();
});

test('restored ticket prewarms one transfer and opens app synchronously after dismissal', async () => {
  let calls=0;
  const b=browser({fetch:async()=>{calls++;return{ok:true,json:async()=>({code:'b'.repeat(43),expiresAt:new Date(Date.now()+7200000).toISOString()})}}});
  b.offer();b.offer();
  await b.context.prepareMecanTicketTransfer(ticket);
  await Promise.resolve();
  b.dom.window.document.querySelector('.mecanInstallLater').click();
  b.offer();await Promise.resolve();
  assert.equal(calls,1);
  assert.equal(b.dom.window.document.querySelector('dialog'),null);
  const button=b.dom.window.document.getElementById('mecanInstallReturn');
  assert.equal(button.textContent,'Abrir mi turno en Mecan');
  button.click();
  assert.match(b.context.location.href,/^intent:\/\/turno/);
  assert.match(b.context.location.href,/package=ar\.com\.asisto\.mecan/);
  b.dom.window.close();
});
test('a failed or malformed handoff never sends the customer to install', async () => {
  const b = browser({ fetch: async () => ({ ok: false, json: async () => ({ error: 'El turno finalizó.' }) }) });
  b.offer(); await b.dom.window.document.querySelector('.mecanInstallAction').onclick();
  assert.equal(b.context.location.href, ''); assert.equal(b.dom.window.document.querySelector('.mecanInstallError').hidden, false); b.dom.window.close();
});
