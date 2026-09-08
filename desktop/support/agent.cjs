// Asisto | Version: 5.00.062 | Fecha: 2026-09-08
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { storage } = require('./storage.cjs');
const { startLocal } = require('./local.cjs');
const BASE = 'https://asistobot.com.ar';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(options = {}) {
  const profile = options.profile || process.argv[2];
  if (!profile || !path.isAbsolute(profile)) throw new Error('Profile required');
  const store = options.store || storage(profile), instance = crypto.randomUUID(), pause = options.sleep || sleep;
  const status = value => fs.writeFileSync(path.join(profile, 'status.json'), JSON.stringify({ ...value, updatedAt: new Date().toISOString() }));
  let account = store.read('account'), socket, socketGeneration = 0, stopped = false, retryAt = 0, tail = Promise.resolve();
  const b = await (options.loadBaileys || (() => import('@whiskeysockets/baileys')))();
  const request = async (route, body = {}) => {
    const response = await (options.fetchImpl || fetch)(BASE + '/api/support/device/' + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Asisto-Instance': instance, ...(account?.token ? { Authorization: 'Bearer ' + account.token } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) { const error = new Error('Agent request failed'); error.status = response.status; throw error; }
    return response.json();
  };
  const stopSocket = () => { socketGeneration++; const current = socket; socket = undefined; current?.end(undefined); };
  const quit = () => { stopped = true; stopSocket(); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  if (!account?.approved) {
    if (!account || new Date(account.expiresAt) <= new Date()) {
      account = await request('start', { name: os.hostname(), sessionsPanel: true }); store.write('account', account);
    }
    // Publish the pairing link for manual opening; the background agent never opens a browser.
    const url = new URL(account.verificationUrl);
    if (url.origin !== BASE || !['/ui/support', '/admin/wweb'].includes(url.pathname)) throw new Error('Invalid approval URL');
    status({ state: 'awaiting_approval', verificationUrl: url.href });
    while (!stopped && new Date(account.expiresAt) > new Date()) {
      try {
        const state = await request('poll');
        if (state.state === 'approved') { account = { ...account, ...state, approved: true }; store.write('account', account); break; }
      } catch (error) { if (error.status === 401) { store.write('account', null); return; } }
      await pause(3000);
    }
    if (!account.approved || stopped) return;
  }
  // Auth remains on this Windows user's PC. No MongoDB or global Asisto secret.
  const readAuth = id => { const value = store.read('auth:' + id); return value ? JSON.parse(value, b.BufferJSON.reviver) : null; };
  const writeAuth = (id, value) => {
    const ids = store.read('auth-index') || [];
    if (!ids.includes(id)) store.write('auth-index', [...ids, id]);
    store.write('auth:' + id, value == null ? null : JSON.stringify(value, b.BufferJSON.replacer));
  };
  const clearAuth = () => { for (const id of store.read('auth-index') || []) store.write('auth:' + id, null); store.write('auth-index', []); };
  // Preserve the saved queue order without reading thousands of payload files at startup.
  const order = new Map(Object.entries(store.read('outbox-order') || {})), seen = new Set(store.read('outbox-index') || []);
  let uploadLimit = 25;
  const recentFirst = ids => ids.sort((a, b) => (order.get(b) || 0) - (order.get(a) || 0));
  const queue = async (messages, historical = false) => {
    for (let offset = 0; offset < messages.length; offset += 50) {
      const index = new Set(store.read('outbox-index') || []);
      let changed = false;
      for (const raw of messages.slice(offset, offset + 50)) {
      const msg = b.normalizeMessageContent(raw.message), jid = raw.key?.remoteJid;
      if (!msg || !raw.key?.id || !/^[^@]+@(s\.whatsapp\.net|lid)$/.test(jid || '')) continue;
      const content = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.documentMessage?.caption || '';
      if (!content && !msg.audioMessage) continue;
      const audio = msg.audioMessage;
      const message = { id: raw.key.id, jid, fromMe: !!raw.key.fromMe, name: (raw.pushName || '').slice(0, 200), at: new Date(Number(raw.messageTimestamp) * 1000).toISOString(), text: content.length > 20000 ? '' : content, contentTooLarge: content.length > 20000, audio: audio ? { seconds: Number(audio.seconds || 0), mimetype: audio.mimetype || 'audio/ogg', bytes: Number(audio.fileLength || 0) } : null, raw: audio ? JSON.stringify(raw, b.BufferJSON.replacer) : null };
      const id = crypto.createHash('sha256').update(JSON.stringify([jid, raw.key.id, !!raw.key.fromMe])).digest('hex');
      // An interrupted upload is replayed idempotently using the WhatsApp ID.
      if (!seen.has(id)) { store.write('outbox:' + id, { ...message, historical }); index.add(id); seen.add(id); order.set(id, Date.parse(message.at)); changed = true; }
      }
      if (changed) { store.write('outbox-index', recentFirst([...index])); store.write('outbox-order', Object.fromEntries(order)); }
      // Large history events must yield so heartbeat and uploads keep running.
      await pause(0);
    }
  };
  const connect = () => {
    const creds = readAuth('creds') || b.initAuthCreds(); writeAuth('creds', creds);
    const generation = ++socketGeneration;
    const active = b.default({ auth: { creds, keys: {
      async get(type, ids) { const result = {}; for (const id of ids) { let value = readAuth(type + ':' + id); if (type === 'app-state-sync-key' && value) value = b.proto.Message.AppStateSyncKeyData.fromObject(value); result[id] = value; } return result; },
      async set(data) { for (const [type, values] of Object.entries(data)) for (const [id, value] of Object.entries(values)) writeAuth(type + ':' + id, value); },
    } }, logger: require('pino')({ level: 'silent' }), markOnlineOnConnect: false, syncFullHistory: true, shouldSyncHistoryMessage: () => true, shouldIgnoreJid: jid => /@(g\.us|broadcast|newsletter)$/.test(jid), getMessage: async () => undefined });
    socket = active;
    const event = fn => { tail = tail.then(async () => { if (generation === socketGeneration) await fn(); }).catch(() => { if (generation === socketGeneration) { stopSocket(); retryAt = Date.now() + 15000; } }); };
    active.ev.on('creds.update', () => event(() => writeAuth('creds', creds)));
    active.ev.on('messages.upsert', update => event(() => queue(update.messages, update.type === 'append')));
    active.ev.on('messaging-history.set', update => event(() => queue(update.messages, true)));
    active.ev.on('connection.update', update => event(async () => {
      if (update.qr) await request('session', { state: 'qr', qr: update.qr });
      if (update.connection === 'open') await request('session', { state: 'connected' });
      if (update.connection === 'close') {
        socket = undefined; retryAt = Date.now() + 10000;
        const logout = update.lastDisconnect?.error?.output?.statusCode === b.DisconnectReason.loggedOut;
        if (logout) clearAuth();
        await request('session', { state: logout ? 'logged_out' : 'reconnecting' });
      }
    }));
  };
  while (!stopped) {
    try {
      const state = await request('heartbeat', { queuedMessages: (store.read('outbox-index') || []).length });
      status({ state: 'active', whatsapp: state.desired });
      if (state.desired !== 'connected') {
        if (socket) { stopSocket(); await request('session', { state: 'disconnected' }); }
      } else if (!socket && Date.now() >= retryAt) connect();
      // Processing must progress even when a subsequent upload times out.
      await request('work');
      await request('heartbeat', { queuedMessages: (store.read('outbox-index') || []).length });
      // Bounded batches avoid one HTTP request and one full index rewrite per message.
      const messages = [], ids = [];
      for (const id of (store.read('outbox-index') || []).slice(0, uploadLimit)) {
        const message = store.read('outbox:' + id);
        if (message && Buffer.byteLength(JSON.stringify({ messages: [...messages, message] })) > 110000) break;
        ids.push(id); if (message) messages.push(message);
      }
      if (messages.length) {
        try { await request('messages', { messages }); }
        catch (error) { uploadLimit = Math.max(1, Math.floor(uploadLimit / 2)); throw error; }
      }
      if (ids.length) {
        const sent = new Set(ids);
        store.write('outbox-index', (store.read('outbox-index') || []).filter(value => !sent.has(value)));
        for (const id of ids) store.write('outbox:' + id, null);
      }
      await request('heartbeat', { queuedMessages: (store.read('outbox-index') || []).length });
    } catch (error) {
      if (error.status === 401 || error.status === 403) { stopSocket(); status({ state: 'access_revoked' }); process.exitCode = 2; return; }
      if (error.status === 409) stopSocket();
      // A slow Asisto request does not require reconnecting WhatsApp and importing history again.
      status({ state: 'retrying', error: error.status || error.name, uploadLimit });
    }
    await pause((store.read('outbox-index') || []).length ? 250 : 5000);
  }
  await tail;
}
async function main() {
  const profile = process.argv[2], store = storage(profile);
  const local = await startLocal({ readAccount: () => store.read('account') });
  try { await run({ profile, store }); }
  finally { local.closeAllConnections(); await new Promise(resolve => local.close(resolve)); }
}
if (require.main === module) main().catch(() => { console.error('Asisto: no se pudo iniciar el agente. Se reintentará automáticamente.'); process.exitCode = 1; });
module.exports = { run };
