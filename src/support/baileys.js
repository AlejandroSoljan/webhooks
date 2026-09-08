// Asisto | Version: 5.00.065 | Fecha: 2026-09-08
const { scopedId, fail } = require('./core');

async function encryptedAuth(service, scope, baileys, assertOwner) {
  const col = service.col('auth');
  const idFor = (type, id) => scopedId(scope, 'auth', type, id);
  const locks = new Map();
  const locked = async (id, fn) => {
    const previous = locks.get(id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(fn); locks.set(id, pending);
    try { return await pending; } finally { if (locks.get(id) === pending) locks.delete(id); }
  };
  const read = async (type, key) => {
    const _id = idFor(type, key);
    return locked(_id, async () => {
      const row = await col.findOne({ _id, ...scope });
      return row ? JSON.parse(service.vault.open(row.payload, _id), baileys.BufferJSON.reviver) : null;
    });
  };
  const write = async (type, key, value) => {
    await assertOwner();
    const _id = idFor(type, key);
    await locked(_id, async () => {
      await assertOwner();
      if (value == null) await col.deleteOne({ _id, ...scope });
      else await col.updateOne({ _id, ...scope }, { $set: { payload: service.vault.seal(JSON.stringify(value, baileys.BufferJSON.replacer), _id) } }, { upsert: true });
    });
  };
  const creds = await read('creds', 'main') || baileys.initAuthCreds();
  await write('creds', 'main', creds);
  let saving = Promise.resolve();
  return {
    state: { creds, keys: {
      async get(type, ids) {
        const data = {};
        for (const id of ids) {
          let value = await read(type, id);
          if (type === 'app-state-sync-key' && value) value = baileys.proto.Message.AppStateSyncKeyData.fromObject(value);
          data[id] = value;
        }
        return data;
      },
      async set(data) { for (const [type, entries] of Object.entries(data)) for (const [id, value] of Object.entries(entries)) await write(type, id, value); },
    } },
    saveCreds() { saving = saving.then(() => write('creds', 'main', creds)); return saving; },
  };
}

function normalizeMessage(raw, baileys) {
  const jid = raw.key?.remoteJid;
  if (!jid || !raw.key.id) return null;
  const msg = baileys.normalizeMessageContent(raw.message);
  if (!msg) return null;
  const audio = msg.audioMessage;
  const content = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.documentMessage?.caption || '';
  if (!content && !audio) return null;
  return { id: raw.key.id, jid, fromMe: !!raw.key.fromMe, name: raw.pushName || '', at: new Date(Number(raw.messageTimestamp) * 1000), text: content,
    audio: audio ? { seconds: Number(audio.seconds || 0), mimetype: audio.mimetype || 'audio/ogg', bytes: Number(audio.fileLength || 0) } : null,
    raw: audio ? JSON.stringify(raw, baileys.BufferJSON.replacer) : null };
}

class BaileysSessions {
  constructor(service, assertOwner, loader = () => import('@whiskeysockets/baileys')) {
    this.service = service; this.assertOwner = assertOwner; this.loader = loader; this.sockets = new Map();
  }
  async sync() {
    const sessions = await this.service.col('sessions').find({ desired: 'connected' }).limit(101).toArray();
    if (sessions.length > 100) fail('session_capacity_exceeded', 503);
    const wanted = new Set(sessions.map(s => s._id));
    for (const [id, entry] of this.sockets) if (!wanted.has(id)) {
      entry.socket.end(undefined); this.sockets.delete(id);
      await entry.tail;
      await this.service.col('sessions').updateOne({ _id: id, desired: 'disconnected' }, { $set: { state: 'disconnected', qr: null } });
    }
    for (const session of sessions) {
      const scope = { tenantId: session.tenantId, userId: session.userId };
      const { ObjectId } = require('mongodb');
      const user = ObjectId.isValid(scope.userId) ? await this.service.db.collection('users').findOne({ _id: new ObjectId(scope.userId), tenantId: scope.tenantId, isLocked: { $ne: true } }) : null;
      const allowed = user && ['user', 'admin', 'superadmin'].includes(user.role) && (user.role === 'superadmin' || !Array.isArray(user.allowedPages) || user.allowedPages.includes('support'));
      if (!allowed) {
        this.sockets.get(session._id)?.socket.end(undefined); this.sockets.delete(session._id);
        await this.service.col('sessions').updateOne({ _id: session._id }, { $set: { desired: 'disconnected', state: 'access_revoked', qr: null } });
        continue;
      }
      if (!this.sockets.has(session._id) && (!session.retryAt || session.retryAt <= this.service.now())) await this.connect(scope, session._id);
    }
  }
  async connect(scope, id) {
    const b = await this.loader();
    await this.assertOwner();
    const auth = await encryptedAuth(this.service, scope, b, this.assertOwner);
    const socket = b.default({ auth: auth.state, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: true, shouldSyncHistoryMessage: () => true,
      shouldIgnoreJid: jid => /@(g\.us|broadcast|newsletter)$/.test(jid),
      logger: require('pino')({ level: 'silent' }), getMessage: async () => undefined });
    const entry = { socket, tail: Promise.resolve() };
    this.sockets.set(id, entry);
    const run = fn => { entry.tail = entry.tail.then(async () => { await this.assertOwner(); if (this.sockets.get(id) === entry) await fn(); }).catch(async () => {
      socket.end(undefined); if (this.sockets.get(id) === entry) this.sockets.delete(id);
      await this.service.audit(scope, 'session_event_failed', id, 'session_event_failed').catch(() => {});
    }); };
    socket.ev.on('creds.update', () => run(auth.saveCreds));
    socket.ev.on('connection.update', update => run(async () => {
      const patch = { updatedAt: this.service.now() };
      if (update.qr) { patch.qr = this.service.vault.seal(update.qr, id + ':qr'); patch.qrExpiresAt = new Date(+this.service.now() + 45000); patch.state = 'qr'; }
      if (update.connection === 'open') { patch.state = 'connected'; patch.qr = null; patch.failures = 0; }
      if (update.connection === 'close') {
        const loggedOut = update.lastDisconnect?.error?.output?.statusCode === b.DisconnectReason.loggedOut;
        patch.state = loggedOut ? 'logged_out' : 'reconnecting'; patch.qr = null;
        const current = await this.service.col('sessions').findOne({ _id: id, ...scope });
        patch.failures = (current?.failures || 0) + 1;
        patch.retryAt = new Date(+this.service.now() + Math.min(300000, 2000 * 2 ** Math.min(patch.failures, 8)));
        if (loggedOut) { patch.desired = 'disconnected'; await this.service.col('auth').deleteMany(scope); }
        this.sockets.delete(id);
      }
      await this.service.col('sessions').updateOne({ _id: id, ...scope }, { $set: patch });
    }));
    const ingest = messages => run(async () => { for (const raw of messages) { const message = normalizeMessage(raw, b); if (message) await this.service.ingest(scope, message); } });
    socket.ev.on('messages.upsert', event => ingest(event.messages));
    socket.ev.on('messaging-history.set', event => ingest(event.messages));
  }
  async stop() {
    const entries = [...this.sockets.values()]; this.sockets.clear();
    for (const entry of entries) entry.socket.end(undefined);
    await Promise.allSettled(entries.map(e => e.tail));
  }
}

async function downloadAudio(raw, audio, loadBaileys = () => import('@whiskeysockets/baileys')) {
    if (!Number.isFinite(audio.seconds) || audio.seconds <= 0 || audio.seconds > 600 || !Number.isFinite(audio.bytes) || audio.bytes < 0 || audio.bytes > 16 * 1024 * 1024) fail('audio_limit_exceeded', 422);
    const b = await loadBaileys();
    const message = JSON.parse(raw, b.BufferJSON.reviver);
    // Prefer Baileys' fixed media host over a sender-controlled absolute URL.
    const audioMessage = b.normalizeMessageContent(message.message)?.audioMessage;
    if (!audioMessage?.directPath?.startsWith('/')) fail('invalid_audio_path', 422);
    // downloadMediaMessage requires a URL property even with a directPath.
    // Download the audio content directly so no sender-provided host is used.
    const stream = await b.downloadContentFromMessage({ directPath: audioMessage.directPath, mediaKey: audioMessage.mediaKey }, 'audio', { options: { signal: AbortSignal.timeout(25000), redirect: 'error' } });
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => stream.destroy(new Error('audio_download_timeout')), 25000);
    try {
      for await (const chunk of stream) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) fail('audio_limit_exceeded', 422); chunks.push(chunk); }
    } finally { clearTimeout(timer); stream.destroy(); }
    return Buffer.concat(chunks);
}

// Optional LOCAL gateway. Its URL is operator configured and never supplied by a user/message.
function localTranscriber(env = process.env, { loadBaileys = () => import('@whiskeysockets/baileys'), fetchImpl = fetch } = {}) {
  if (!env.SUPPORT_TRANSCRIBER_URL) return null;
  const url = new URL(env.SUPPORT_TRANSCRIBER_URL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid_transcriber_url');
  return { model: env.SUPPORT_TRANSCRIBER_MODEL || 'local-transcriber', async run(raw, audio) {
    const buffer = await downloadAudio(raw, audio, loadBaileys);
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000), headers: { 'Content-Type': audio.mimetype, ...(env.SUPPORT_TRANSCRIBER_TOKEN ? { Authorization: `Bearer ${env.SUPPORT_TRANSCRIBER_TOKEN}` } : {}) }, body: buffer });
    if (!response.ok) fail('transcription_failed', 502);
    const result = await response.json();
    return { text: result.text, costUsd: 0 };
  } };
}
module.exports = { encryptedAuth, normalizeMessage, BaileysSessions, localTranscriber, downloadAudio };
