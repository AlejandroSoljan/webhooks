/*script:telegram_runtime*/
/*version:2.00.00   21/04/2026   */

const TelegramBot = require('node-telegram-bot-api');
const { getDb } = require('./db');
const auth = require('./auth_ui');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AR_TZ = 'America/Argentina/Cordoba';
const instanceId = process.env.INSTANCE_ID || `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const CONFIG_COLLECTION = String(process.env.ASISTO_CONFIG_COLLECTION || 'tenant_config').trim() || 'tenant_config';
const REFRESH_CONFIG_MS = Math.max(15000, Number(process.env.TG_REFRESH_CONFIG_MS || 60000) || 60000);
const HEARTBEAT_MS = Math.max(5000, Number(process.env.TG_HEARTBEAT_MS || 5000) || 5000);
const ACTION_POLL_MS = Math.max(3000, Number(process.env.TG_ACTION_POLL_MS || 4000) || 4000);
const EXPIRY_POLL_MS = Math.max(3000, Number(process.env.TG_EXPIRY_POLL_MS || 5000) || 5000);
const LOCK_STALE_MS = Math.max(15000, Number(process.env.TG_LOCK_STALE_MS || 30000) || 30000);

const fetchJson = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));
};

const signatures = {
  JVBERi0: 'application/pdf',
  R0lGODdh: 'image/gif',
  R0lGODlh: 'image/gif',
  iVBORw0KGgo: 'image/png',
  '/9j/': 'image/jpg'
};

const logFilePathEvent = path.join(__dirname, 'telegram_runtime_event.log');
const logFilePathError = path.join(__dirname, 'telegram_runtime_error.log');

const manager = {
  started: false,
  routesMounted: false,
  refreshTimer: null,
  refreshing: false,
  contexts: new Map(), // tenantId -> ctx
  byUsername: new Map(),
};

function logLine(message, type = 'event') {
  try {
    const line = `[${new Date().toISOString()}] ${String(message || '')}\n`;
    const target = String(type || 'event').toLowerCase() === 'error' ? logFilePathError : logFilePathEvent;
    fs.appendFileSync(target, line, 'utf8');
    console.log(line.trim());
  } catch (e) {
    try { console.log('telegram_runtime log error', e?.message || e); } catch {}
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowArgentinaISO() {
  try {
    const dt = new Date();
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: AR_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(dt).replace(' ', 'T');
  } catch {
    return new Date().toISOString();
  }
}

function normalizeString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeChatId(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return value;
  const raw = String(value).trim();
  if (!raw) return '';
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  return raw;
}

function detectMimeType(base64) {
  const token = String(base64 || '').slice(0, 12);
  for (const prefix of Object.keys(signatures)) {
    if (token.startsWith(prefix)) return signatures[prefix];
  }
  return 'application/octet-stream';
}

function buildMediaPayloadFromBase64(base64, filename, caption) {
  const mimetype = detectMimeType(base64);
  const safeName = normalizeString(filename, `archivo_${Date.now()}`);
  return {
    type: 'media',
    mimetype,
    filename: safeName,
    caption: normalizeString(caption, ''),
    buffer: Buffer.from(String(base64 || ''), 'base64')
  };

}

function getApiBotNumber(ctx) {
  return String(
    ctx?.config?.numero ||
    ctx?.numero ||
    ctx?.telegramSelfId ||
    ''
  ).trim();
}

function buildTelegramIdReply(msg) {
  const userId = String(msg?.from?.id || '').trim();
  const chatId = String(msg?.chat?.id || '').trim();
  const username = String(msg?.from?.username || '').trim();
  const parts = [];

  if (userId) parts.push(`Tu ID de Telegram es: ${userId}`);
  if (chatId && chatId !== userId) parts.push(`ID del chat: ${chatId}`);
  if (username) parts.push(`Usuario: @${username}`);

  return parts.length ? parts.join('\n') : 'No pude obtener tu ID de Telegram.';
}

function getErrorConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'configuracion_errores.json'), 'utf8'));
    const conf = (raw && raw.configuracion && typeof raw.configuracion === 'object') ? raw.configuracion : raw;
    return {
      msg_errores: normalizeString(conf?.msg_error, ''),
      email_err: normalizeString(conf?.email_err, ''),
    };
  } catch {
    return { msg_errores: '', email_err: '' };
  }
}

function baseTenantDefaults() {
  return {
    numero: '',
    status_token: '',
    telegram_bot_token: '',
    telegram_bot_username: '',
    seg_desde: 8000,
    seg_hasta: 12000,
    seg_msg: 5000,
    seg_tele: 3000,
    api: 'http://managermsm.ddns.net:2002/v200/api/Api_Chat_Cab/ProcesarMensajePost',
    api2: 'http://managermsm.ddns.net:2002/v200/api/Api_Mensajes/Consulta_no_enviados',
    api3: 'http://managermsm.ddns.net:2002/v200/api/Api_Mensajes/Actualiza_mensaje',
    key: 'FMM0325*',
    msg_inicio: '',
    msg_fin: '',
    cant_lim: 0,
    msg_lim: 'Continuar? S / N',
    time_cad: 0,
    msg_cad: '',
    msg_can: '',
    nom_chatbot: '',
  };
}

function normalizeTenantDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const conf = (doc.configuracion && typeof doc.configuracion === 'object') ? doc.configuracion : doc;
  const tenantId = normalizeString(doc.tenantId || doc._id || conf.tenantId || conf._id, '').toUpperCase();
  const token = normalizeString(
    conf.telegram_bot_token || conf.bot_token || conf.token_bot_telegram || conf.telegramToken || doc.telegram_bot_token,
    ''
  );
  if (!tenantId || !token) return null;

  const out = baseTenantDefaults();
  out.tenantId = tenantId;
  out.numero = normalizeString(conf.numero || conf.NUMERO || doc.numero || `telegram_${tenantId}`, `telegram_${tenantId}`);
  out.status_token = normalizeString(conf.status_token || doc.status_token || process.env.STATUS_TOKEN || '', '');
  out.telegram_bot_token = token;
  out.telegram_bot_username = normalizeString(
    conf.telegram_bot_username || conf.bot_username || conf.username_bot_telegram || conf.telegramBotUsername || doc.telegram_bot_username,
    ''
  );
  out.seg_desde = normalizeNumber(conf.seg_desde ?? doc.seg_desde, out.seg_desde);
  out.seg_hasta = normalizeNumber(conf.seg_hasta ?? doc.seg_hasta, out.seg_hasta);
  out.seg_msg = normalizeNumber(conf.seg_msg ?? doc.seg_msg, out.seg_msg);
  out.seg_tele = normalizeNumber(conf.seg_tele ?? doc.seg_tele, out.seg_tele);
  out.api = normalizeString(conf.api || doc.api, out.api);
  out.api2 = normalizeString(conf.api2 || doc.api2, out.api2);
  out.api3 = normalizeString(conf.api3 || doc.api3, out.api3);
  out.key = normalizeString(conf.key || doc.key, out.key);
  out.msg_inicio = normalizeString(conf.msg_inicio ?? doc.msg_inicio, '');
  out.msg_fin = normalizeString(conf.msg_fin ?? doc.msg_fin, '');
  out.cant_lim = normalizeNumber(conf.cant_lim ?? doc.cant_lim, 0);
  out.msg_lim = normalizeString(conf.msg_lim ?? doc.msg_lim, out.msg_lim);
  out.time_cad = normalizeNumber(conf.time_cad ?? doc.time_cad, 0);
  out.msg_cad = normalizeString(conf.msg_cad ?? doc.msg_cad, '');
  out.msg_can = normalizeString(conf.msg_can ?? doc.msg_can, '');
  out.nom_chatbot = normalizeString(conf.nom_chatbot || conf.nom_emp || doc.nom_chatbot || doc.nom_emp, '');
  return out;
}

function getContextStatus(ctx) {
  return {
    tenantId: ctx.tenantId,
    numero: ctx.numero,
    lockId: ctx.lockId,
    botState: ctx.botState,
    botStarted: !!ctx.botStarted,
    telegramBotUsername: ctx.telegramSelfUsername || ctx.telegramBotUsername || '',
    telegramBotId: ctx.telegramSelfId || '',
    startedAt: ctx.lockAcquiredAt || null,
    lastSeenAt: ctx.lastSeenAt || null,
    knownChats: ctx.knownChats || 0,
  };
}

function botConnectionSignature(cfg) {
  return JSON.stringify({
    token: cfg.telegram_bot_token,
    username: cfg.telegram_bot_username,
  });
}

function runtimeConfigSignature(cfg) {
  return JSON.stringify({
    numero: cfg.numero,
    api: cfg.api,
    api2: cfg.api2,
    api3: cfg.api3,
    key: cfg.key,
    seg_desde: cfg.seg_desde,
    seg_hasta: cfg.seg_hasta,
    seg_msg: cfg.seg_msg,
    seg_tele: cfg.seg_tele,
    cant_lim: cfg.cant_lim,
    msg_lim: cfg.msg_lim,
    time_cad: cfg.time_cad,
    msg_cad: cfg.msg_cad,
    msg_can: cfg.msg_can,
    msg_inicio: cfg.msg_inicio,
    msg_fin: cfg.msg_fin,
    status_token: cfg.status_token,
    nom_chatbot: cfg.nom_chatbot,
  });
}

function createContext(cfg) {
  const errCfg = getErrorConfig();
  return {
    tenantId: cfg.tenantId,
    numero: cfg.numero,
    lockId: `${cfg.tenantId}:${cfg.numero || 'telegram'}`,
    lockAcquiredAt: new Date(),
    botState: 'idle',
    botStarted: false,
    startingNow: false,
    bot: null,
    knownChats: 0,
    lastSeenAt: null,
    telegramSelfId: '',
    telegramSelfUsername: '',
    config: { ...cfg, msg_errores: errCfg.msg_errores },
    statusToken: cfg.status_token || '',
    jsonGlobal: [],
    recentOutgoingStatIds: new Map(),
    actionBusy: false,
    heartbeatBusy: false,
    outboundBusy: false,
    shuttingDown: false,
    ownsLock: false,
    timers: {
      heartbeat: null,
      action: null,
      outbound: null,
      expiry: null,
    },
  };
}

async function getTenantConfigsFromDb() {
  const db = await getDb();
  const rows = await db.collection(CONFIG_COLLECTION).find({}).toArray();
  const configs = [];
  for (const row of rows || []) {
    const normalized = normalizeTenantDoc(row);
    if (normalized) configs.push(normalized);
  }

  if (!configs.length) {
    const fallback = normalizeTenantDoc({
      _id: normalizeString(process.env.TENANT_ID, ''),
      telegram_bot_token: normalizeString(process.env.TELEGRAM_BOT_TOKEN, ''),
      telegram_bot_username: normalizeString(process.env.TELEGRAM_BOT_USERNAME, ''),
      numero: normalizeString(process.env.NUMERO, ''),
      status_token: normalizeString(process.env.STATUS_TOKEN, ''),
      api: process.env.TG_API || undefined,
      api2: process.env.TG_API2 || undefined,
      api3: process.env.TG_API3 || undefined,
      key: process.env.TG_API_KEY || undefined,
    });
    if (fallback) configs.push(fallback);
  }

  return configs;
}

async function getPolicySafe(ctx) {
  try {
    const db = await getDb();
    const coll = db.collection('tg_bot_policies');
    const p = await coll.findOne({
      numero: ctx.numero,
      $or: [{ tenantId: ctx.tenantId }, { tenantid: ctx.tenantId }]
    });
    if (p) return p;
    return await coll.findOne({ _id: ctx.lockId });
  } catch {
    return null;
  }
}

function lockStateAllowsTakeover(state) {
  const s = normalizeString(state, '').toLowerCase();
  return ['offline', 'removed', 'disabled', 'error', 'conflict', 'reconfiguring', 'released', 'sigterm', 'sigint', 'sigbreak', 'stopped'].includes(s);
}

async function acquireLock(ctx, desiredState = 'starting') {
  try {
    const db = await getDb();
    const coll = db.collection('tg_locks');
    const now = new Date();
    const staleBefore = new Date(Date.now() - LOCK_STALE_MS);

    try {
      await coll.updateOne(
        {
          _id: ctx.lockId,
          $or: [
            { holderId: instanceId },
            { holderId: { $exists: false } },
            { holderId: null },
            { lastSeenAt: { $lt: staleBefore } },
            { state: { $in: ['offline', 'removed', 'disabled', 'error', 'conflict', 'reconfiguring', 'released', 'SIGTERM', 'SIGINT', 'SIGBREAK', 'stopped'] } }
          ]
        },
        {
          $set: {
            tenantId: ctx.tenantId,
            tenantid: ctx.tenantId,
            numero: ctx.numero,
            holderId: instanceId,
            host: os.hostname(),
            pid: process.pid,
            state: desiredState,
            startedAt: ctx.lockAcquiredAt || now,
            lastSeenAt: now,
            botId: String(ctx.telegramSelfId || ''),
            botUsername: String(ctx.telegramSelfUsername || ctx.telegramBotUsername || ''),
          }
        },
        { upsert: true }
      );
    } catch (e) {
      if (!(String(e?.code || '') === '11000' || /duplicate key/i.test(String(e?.message || e)))) {
        throw e;
      }
    }

    const doc = await coll.findOne({ _id: ctx.lockId });
    ctx.ownsLock = !!doc && String(doc.holderId || '') === instanceId;
    if (ctx.ownsLock) ctx.lastSeenAt = doc.lastSeenAt || now;
    return ctx.ownsLock;
  } catch (e) {
    logLine(`[${ctx.tenantId}] acquireLock error: ${e?.message || e}`, 'error');
    ctx.ownsLock = false;
    return false;
  }
}

async function updateLockState(ctx, state) {
  try {
    ctx.botState = normalizeString(state, ctx.botState || 'idle');
    ctx.lastSeenAt = new Date();
    if (!ctx.ownsLock) return;

    const db = await getDb();
    await db.collection('tg_locks').updateOne(
      { _id: ctx.lockId, holderId: instanceId },
      {
        $set: {
          tenantId: ctx.tenantId,
          tenantid: ctx.tenantId,
          numero: ctx.numero,
          holderId: instanceId,
          host: os.hostname(),
          pid: process.pid,
          state: ctx.botState,
          startedAt: ctx.lockAcquiredAt || new Date(),
          lastSeenAt: ctx.lastSeenAt,
          botId: String(ctx.telegramSelfId || ''),
          botUsername: String(ctx.telegramSelfUsername || ctx.telegramBotUsername || ''),
        }
      },
      { upsert: false }
    );
  } catch (e) {
    logLine(`[${ctx.tenantId}] updateLockState error: ${e?.message || e}`, 'error');
  }
}

async function forceReleaseLock(ctx, finalState = 'offline') {
  try {
    if (!ctx.ownsLock) return;
    const db = await getDb();
    await db.collection('tg_locks').updateOne(
      { _id: ctx.lockId, holderId: instanceId },
      {
        $set: {
          tenantId: ctx.tenantId,
          tenantid: ctx.tenantId,
          numero: ctx.numero,
          holderId: null,
          host: os.hostname(),
          pid: process.pid,
          state: String(finalState || 'offline'),
          releasedAt: new Date(),
          releasedBy: instanceId,
          lastSeenAt: new Date(),
          botId: String(ctx.telegramSelfId || ''),
          botUsername: String(ctx.telegramSelfUsername || ctx.telegramBotUsername || ''),
        }
      },
      { upsert: false }
    );
  } catch (e) {
    logLine(`[${ctx.tenantId}] forceReleaseLock error: ${e?.message || e}`, 'error');
  } finally {
    ctx.ownsLock = false;
  }
}

async function pushHistory(ctx, event, detail) {
  try {
    const db = await getDb();
    await db.collection('tg_bot_history').insertOne({
      lockId: ctx.lockId,
      tenantId: ctx.tenantId,
      numero: ctx.numero,
      event: String(event || ''),
      host: os.hostname(),
      pid: process.pid,
      detail: detail || null,
      at: new Date()
    });
  } catch {}
}

function arDatePartsForStats(date) {
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: AR_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(date || new Date());
    const map = {};
    for (const p of (parts || [])) if (p && p.type) map[p.type] = p.value;
    return {
      dayKey: `${map.year || '0000'}-${map.month || '00'}-${map.day || '00'}`,
      atLocal: `${map.year || '0000'}-${map.month || '00'}-${map.day || '00'}T${map.hour || '00'}:${map.minute || '00'}:${map.second || '00'}`
    };
  } catch {
    const iso = (date || new Date()).toISOString();
    return { dayKey: iso.slice(0, 10), atLocal: iso.slice(0, 19) };
  }
}

async function logMessageStat(ctx, direction, contact, payload) {
  try {
    const dir = normalizeString(direction, '').toLowerCase();
    if (dir !== 'in' && dir !== 'out') return;
    const now = new Date();
    const parts = arDatePartsForStats(now);
    let messageType = 'text';
    let hasMedia = false;
    let body = '';

    if (typeof payload === 'string') {
      body = payload;
    } else if (payload && typeof payload === 'object') {
      if (typeof payload.body === 'string') body = payload.body;
      if (typeof payload.caption === 'string' && !body) body = payload.caption;
      if (payload.type) messageType = String(payload.type);
      if (payload.hasMedia === true) hasMedia = true;
      if (payload.mimetype || payload.filename || payload.buffer || payload.base64) hasMedia = true;
      if (!messageType || messageType === 'undefined') messageType = hasMedia ? 'media' : 'text';
    }

    const db = await getDb();
    await db.collection('tg_bot_message_log').insertOne({
      tenantId: ctx.tenantId,
      numero: ctx.numero,
      contact: String(contact || '').trim(),
      direction: dir,
      messageType: messageType || (hasMedia ? 'media' : 'text'),
      body: String(body || ''),
      bodyLength: String(body || '').length,
      hasMedia: !!hasMedia,
      at: now,
      atLocal: parts.atLocal,
      dayKey: parts.dayKey,
    });
  } catch (e) {
    logLine(`[${ctx.tenantId}] logMessageStat error: ${e?.message || e}`, 'error');
  }
}

function getOutgoingStatMessageId(messageLike) {
  try {
    if (!messageLike) return '';
    if (typeof messageLike === 'string') return String(messageLike || '').trim();
    const id = messageLike?.message_id || messageLike?.messageId || messageLike?.result?.message_id;
    return String(id || '').trim();
  } catch {
    return '';
  }
}

function rememberOutgoingStatLogged(ctx, messageLike) {
  try {
    const id = getOutgoingStatMessageId(messageLike);
    if (!id) return;
    const now = Date.now();
    ctx.recentOutgoingStatIds.set(id, now);
    for (const [k, ts] of ctx.recentOutgoingStatIds.entries()) {
      if (!ts || (now - ts) > 10 * 60 * 1000) ctx.recentOutgoingStatIds.delete(k);
    }
  } catch {}
}

async function updateChatRegistryFromMessage(ctx, msg) {
  try {
    if (!msg || !msg.chat) return;
    const chatId = String(msg.chat.id || '');
    if (!chatId) return;
    const from = msg.from || {};
    const keyId = `${ctx.tenantId}:${chatId}`;
    const db = await getDb();
    await db.collection('tg_chat_registry').updateOne(
      { _id: keyId },
      {
        $setOnInsert: {
          _id: keyId,
          tenantId: ctx.tenantId,
          numero: ctx.numero,
          chatId,
          firstSeenAt: new Date()
        },
        $set: {
          userId: String(from.id || ''),
          chatType: String(msg.chat.type || ''),
          username: String(from.username || msg.chat.username || ''),
          firstName: String(from.first_name || ''),
          lastName: String(from.last_name || ''),
          title: String(msg.chat.title || ''),
          isKnown: true,
          blocked: false,
          lastSeenAt: new Date()
        }
      },
      { upsert: true }
    );
  } catch (e) {
    logLine(`[${ctx.tenantId}] updateChatRegistry error: ${e?.message || e}`, 'error');
  }
}

async function getChatRegistry(ctx, chatId) {
  try {
    const db = await getDb();
    return await db.collection('tg_chat_registry').findOne({ _id: `${ctx.tenantId}:${String(chatId)}` });
  } catch {
    return null;
  }
}

function indexOf2d(ctx, itemToFind) {
  const normalized = String(itemToFind);
  for (let i = 0; i < ctx.jsonGlobal.length; i++) {
    if (String(ctx.jsonGlobal[i][0]) === normalized) return i;
  }
  return -1;
}

function rememberJson(ctx, chatId, json) {
  const indice = indexOf2d(ctx, chatId);
  const now = new Date();
  if (indice !== -1) {
    ctx.jsonGlobal[indice][0] = chatId;
    ctx.jsonGlobal[indice][2] = json;
    ctx.jsonGlobal[indice][3] = now;
  } else {
    ctx.jsonGlobal.push([chatId, 0, json, now]);
  }
}

async function safeSendTelegram(ctx, chatId, content, opts = {}) {
  if (!ctx.bot) throw new Error('telegram_bot_not_ready');
  const destination = normalizeChatId(chatId);
  if (destination === '' || destination === null) throw new Error('telegram_chat_id_missing');

  let sent = null;
  try {
    if (typeof content === 'object' && content !== null && (content.buffer || content.base64 || content.type === 'media')) {
      const payload = { ...content };
      const buffer = payload.buffer || Buffer.from(String(payload.base64 || ''), 'base64');
      const mimetype = String(payload.mimetype || detectMimeType(payload.base64 || ''));
      const filename = String(payload.filename || `archivo_${Date.now()}`);
      const caption = String(opts.caption ?? payload.caption ?? '');
      const fileOptions = { filename, contentType: mimetype };

      if (mimetype.startsWith('image/')) {
        sent = await ctx.bot.sendPhoto(destination, buffer, { caption, disable_notification: false }, fileOptions);
      } else if (mimetype.startsWith('video/')) {
        sent = await ctx.bot.sendVideo(destination, buffer, { caption, disable_notification: false }, fileOptions);
      } else {
        sent = await ctx.bot.sendDocument(destination, buffer, { caption, disable_notification: false }, fileOptions);
      }

      await logMessageStat(ctx, 'out', destination, {
        body: '', caption, type: mimetype.startsWith('image/') ? 'photo' : mimetype.startsWith('video/') ? 'video' : 'document',
        mimetype, filename, hasMedia: true, buffer: true,
      });
    } else {
      const text = String(content ?? '');
      sent = await ctx.bot.sendMessage(destination, text, {
        disable_web_page_preview: true,
        disable_notification: false,
        ...opts,
      });
      await logMessageStat(ctx, 'out', destination, { body: text, type: 'text', hasMedia: false });
    }

    rememberOutgoingStatLogged(ctx, sent);
    return sent;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/bot was blocked by the user|chat not found|forbidden/i.test(msg)) {
      try {
        const db = await getDb();
        await db.collection('tg_chat_registry').updateOne(
          { _id: `${ctx.tenantId}:${String(destination)}` },
          { $set: { blocked: true, lastSeenAt: new Date() } },
          { upsert: true }
        );
      } catch {}
    }
    throw e;
  }
}

async function actualizarEstadoMensaje(ctx, estado, tipo, nombre, contacto, direccion, email, idRenglon, idDest) {
  try {
    const params = new URLSearchParams();
    params.set('key', String(ctx.config.key || ''));
    params.set('nro_tel_from', getApiBotNumber(ctx));
    params.set('estado', String(estado || ''));
    if (tipo !== undefined && tipo !== null) params.set('tipo', String(tipo));
    if (nombre !== undefined && nombre !== null) params.set('nombre', String(nombre));
    if (contacto !== undefined && contacto !== null) params.set('contacto', String(contacto));
    if (direccion !== undefined && direccion !== null) params.set('direccion', String(direccion));
    if (email !== undefined && email !== null) params.set('email', String(email));
    if (idRenglon !== undefined && idRenglon !== null) params.set('Id_msj_renglon', String(idRenglon));
    if (idDest !== undefined && idDest !== null) params.set('Id_msj_dest', String(idDest));

    const url = `${ctx.config.api3}?${params.toString()}`;
    const resp = await fetchJson(url, { method: 'GET' });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      logLine(`[${ctx.tenantId}] actualizar_estado_mensaje ERROR ${txt}`, 'error');
    }
  } catch (e) {
    logLine(`[${ctx.tenantId}] actualizar_estado_mensaje error: ${e?.message || e}`, 'error');
  }
}

async function procesarMensajeLotes(ctx, json, message) {
  const chatId = String(message.from);
  const indice = indexOf2d(ctx, chatId);
  if (indice === -1) return;

  const now = new Date();

  
  const segDesde = Math.min(Number(ctx.config.seg_desde) || 0, Number(ctx.config.seg_hasta) || 0);
  const segHasta = Math.max(Number(ctx.config.seg_desde) || 0, Number(ctx.config.seg_hasta) || 0);
  const segundos = Math.random() * (segHasta - segDesde) + segDesde;
  const l_json = ctx.jsonGlobal[indice][2];
  const tam_json = Array.isArray(l_json) ? l_json.length : 0;
  ctx.jsonGlobal[indice][3] = now;

  for (let i = ctx.jsonGlobal[indice][1]; i < tam_json; i++) {
    let mensaje = '';
    if (l_json[i]?.cod_error) {
      mensaje = l_json[i].msj_error;
      logLine(`[${ctx.tenantId}] Error API en procesarMensajeLotes()`, 'error');
    } else {
      mensaje = l_json[i]?.Respuesta;
    }

    if (mensaje === '' || mensaje === null || mensaje === undefined) continue;
    mensaje = String(mensaje).replaceAll('|', '\n');

    if (i <= Number(ctx.config.cant_lim || 0) + ctx.jsonGlobal[indice][1] - 1) {
      await safeSendTelegram(ctx, chatId, mensaje);
      await sleep(segundos);
      if (tam_json - 1 === i) {
        ctx.jsonGlobal[indice][1] = 0;
        ctx.jsonGlobal[indice][2] = '';
        ctx.jsonGlobal[indice][3] = '';
      }
    } else {
      let msg_loc = String(ctx.config.msg_lim || '').replaceAll('|', '\n');
      if (tam_json <= i + Number(ctx.config.cant_lim || 0)) msg_loc = msg_loc.replace('<recuento>', String(tam_json - i));
      else msg_loc = msg_loc.replace('<recuento>', String(Number(ctx.config.cant_lim || 0) + 1));
      msg_loc = msg_loc.replace('<recuento_lote>', String(Math.max(tam_json - 2, 0)));
      msg_loc = msg_loc.replace('<recuento_pendiente>', String(Math.max(tam_json - i, 0)));
      if (msg_loc) await safeSendTelegram(ctx, chatId, msg_loc);
      ctx.jsonGlobal[indice][1] = i;
      ctx.jsonGlobal[indice][3] = now;
      return;
    }
  }
}

async function controlarHoraMsgOnce(ctx) {
  try {
    for (const item of ctx.jsonGlobal) {
      if (!item || !item[3]) continue;
      const fecha_msg = item[3].getTime ? item[3].getTime() : 0;
      const diferencia = Date.now() - fecha_msg;
      if (fecha_msg && Number(ctx.config.time_cad || 0) > 0 && diferencia > Number(ctx.config.time_cad || 0)) {
        if (ctx.config.msg_cad) await safeSendTelegram(ctx, item[0], ctx.config.msg_cad);
        item[3] = '';
        item[2] = '';
        item[1] = 0;
      }
    }
  } catch (e) {
    logLine(`[${ctx.tenantId}] controlarHoraMsgOnce error: ${e?.message || e}`, 'error');
  }
}

async function handleIncomingTelegramMessage(ctx, msg) {
  try {
    await updateChatRegistryFromMessage(ctx, msg);
    const chatId = String(msg?.chat?.id || '');
    const body = typeof msg?.text === 'string' ? msg.text : '';
    if (!chatId) return;

    const indice_telefono = indexOf2d(ctx, chatId);
    const valor_i = indice_telefono === -1 ? 0 : ctx.jsonGlobal[indice_telefono][1];
    logLine(`[${ctx.tenantId}] ${chatId} ${ctx.telegramSelfId} message ${body}`, 'event');

    if (valor_i === 0) {
      if (!body) {
        logLine(`[${ctx.tenantId}] mensaje telegram no texto -> ignorado`, 'event');
        return;
      }

      const trimmedBody = String(body || '').trim();
      const telefonoFrom = chatId;
      const telefonoTo = getApiBotNumber(ctx);
      await logMessageStat(ctx, 'in', telefonoFrom, { body, type: 'text', hasMedia: false });

      if (trimmedBody === '/id') {
        await safeSendTelegram(ctx, chatId, buildTelegramIdReply(msg));
        return;
      }


      const segDesde = Math.min(Number(ctx.config.seg_desde) || 0, Number(ctx.config.seg_hasta) || 0);
      const segHasta = Math.max(Number(ctx.config.seg_desde) || 0, Number(ctx.config.seg_hasta) || 0);
      const segundos = Math.random() * (segHasta - segDesde) + segDesde;

      if (ctx.config.msg_inicio) await safeSendTelegram(ctx, chatId, ctx.config.msg_inicio);

      const jsonTexto = { Tel_Origen: telefonoFrom, Tel_Destino: telefonoTo, Mensaje: body, Respuesta: '' };
      let timeoutId;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), 55000);
        const resp = await fetchJson(ctx.config.api, {
          method: 'POST',
          body: JSON.stringify(jsonTexto),
          headers: { 'Content-type': 'application/json; charset=UTF-8' },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const raw = await resp.text();
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}

        if (!resp.ok) {
          const detalle = json ? JSON.stringify(json) : raw;
          logLine(`[${ctx.tenantId}] Error ApiTelegram - Response ERROR ${detalle}`, 'error');
          if (ctx.config.msg_errores) await safeSendTelegram(ctx, chatId, ctx.config.msg_errores);
          return 'error';
        }

        rememberJson(ctx, chatId, json);
        await procesarMensajeLotes(ctx, json, { from: chatId, body });
        if (ctx.config.msg_fin) await safeSendTelegram(ctx, chatId, ctx.config.msg_fin);
        await sleep(segundos);
        return 'ok';
      } catch (err) {
        clearTimeout(timeoutId);
        const detalle = `Error Chatbot Telegram ${err?.message || err} ${JSON.stringify(jsonTexto)}`;
        logLine(`[${ctx.tenantId}] ${detalle}`, 'error');
        if (ctx.config.msg_errores) await safeSendTelegram(ctx, chatId, ctx.config.msg_errores);
        return 'error';
      }
    }

    const bodyUpper = String(body || '').trim().toUpperCase();
    if (valor_i !== 0 && bodyUpper === 'N') {
      if (ctx.config.msg_can) await safeSendTelegram(ctx, chatId, ctx.config.msg_can);
      ctx.jsonGlobal[indice_telefono][2] = '';
      ctx.jsonGlobal[indice_telefono][1] = 0;
      ctx.jsonGlobal[indice_telefono][3] = '';
      return;
    }

    if (valor_i !== 0 && bodyUpper !== 'N' && bodyUpper !== 'S') {
      await safeSendTelegram(ctx, chatId, '🤔 *No entiendo*,\nPor favor ingrese *S* o *N* para mostrar los siguientes resultados\n', { parse_mode: 'Markdown' });
      return;
    }

    if (valor_i !== 0 && bodyUpper === 'S') {
      await procesarMensajeLotes(ctx, ctx.jsonGlobal[indice_telefono][2], { from: chatId, body });
    }
  } catch (e) {
    logLine(`[${ctx.tenantId}] handleIncomingTelegramMessage error: ${e?.message || e}`, 'error');
  }
}

function attachBotHandlers(ctx) {
  if (!ctx.bot) return;
  ctx.bot.on('message', async (msg) => {
    await handleIncomingTelegramMessage(ctx, msg);
  });
  ctx.bot.on('polling_error', async (err) => {
    const msg = String(err?.message || err);
    logLine(`[${ctx.tenantId}] Telegram polling_error: ${msg}`, 'error');
    if (/409 Conflict/i.test(msg)) {
      await stopContext(ctx, 'conflict');
      return;
    }
    await updateLockState(ctx, 'polling_error');
  });
  ctx.bot.on('webhook_error', async (err) => {
    logLine(`[${ctx.tenantId}] Telegram webhook_error: ${err?.message || err}`, 'error');
    await updateLockState(ctx, 'webhook_error');
  });
}

async function createBotIfNeeded(ctx) {
  if (ctx.bot) return ctx.bot;
  if (!ctx.config.telegram_bot_token) throw new Error('telegram_bot_token_missing');
  ctx.bot = new TelegramBot(ctx.config.telegram_bot_token, {
    polling: {
      autoStart: false,
      interval: 300,
      params: { timeout: 10, allowed_updates: ['message'] }
    }
  });
  attachBotHandlers(ctx);
  return ctx.bot;
}

async function stopContext(ctx, reason = 'offline') {
  ctx.shuttingDown = true;
  try { if (ctx.timers.heartbeat) clearInterval(ctx.timers.heartbeat); } catch {}
  try { if (ctx.timers.action) clearInterval(ctx.timers.action); } catch {}
  try { if (ctx.timers.outbound) clearTimeout(ctx.timers.outbound); } catch {}
  try { if (ctx.timers.expiry) clearInterval(ctx.timers.expiry); } catch {}
  ctx.timers.heartbeat = ctx.timers.action = ctx.timers.outbound = ctx.timers.expiry = null;

  const bot = ctx.bot;
  ctx.bot = null;

  try {
    if (bot && typeof bot.removeAllListeners === 'function') {
      bot.removeAllListeners('message');
      bot.removeAllListeners('polling_error');
      bot.removeAllListeners('webhook_error');
    }
  } catch {}

  try {
    if (bot && typeof bot.stopPolling === 'function') {
      await bot.stopPolling({ cancel: true, reason });
    }
  } catch {}

  ctx.botStarted = false;
  ctx.startingNow = false;
  ctx.botState = String(reason || 'offline');
  await updateLockState(ctx, ctx.botState);
  await forceReleaseLock(ctx, ctx.botState);
  logLine(`[${ctx.tenantId}] Telegram detenido (${ctx.botState})`, 'event');
}

async function heartbeatTick(ctx) {
  if (ctx.heartbeatBusy) return;
  ctx.heartbeatBusy = true;
  try {
    if (ctx.ownsLock) {
      await updateLockState(ctx, ctx.botState || 'online');
    }
    const pol = await getPolicySafe(ctx);
    if (pol && pol.disabled === true) {
      await stopContext(ctx, 'disabled');
      return;
    }
    if (!ctx.botStarted && !ctx.startingNow && !ctx.shuttingDown) {
      await startContext(ctx);
    }
  } catch (e) {
    logLine(`[${ctx.tenantId}] heartbeatTick error: ${e?.message || e}`, 'error');
  } finally {
    ctx.heartbeatBusy = false;
  }
}

function scheduleOutboundPoller(ctx) {
 /* try { if (ctx.timers.outbound) clearTimeout(ctx.timers.outbound); } catch {}
  ctx.timers.outbound = setTimeout(async () => {
    try {
      await consultaApiMensajes(ctx);
    } catch (e) {
      logLine(`[${ctx.tenantId}] outbound tick error: ${e?.message || e}`, 'error');
    } finally {
      if (!ctx.shuttingDown && ctx.botStarted) scheduleOutboundPoller(ctx);
    }
  }, Math.max(1000, Number(ctx.config.seg_tele) || 3000));*/
}

async function handleActionDoc(ctx, doc) {
  const action = String(doc?.action || '').toLowerCase();
  const reason = String(doc?.reason || '');
  if (action === 'restart' || action === 'resetauth') {
    logLine(`[${ctx.tenantId}] Accion ${action.toUpperCase()} recibida: ${reason}`, 'event');
    await stopContext(ctx, action === 'restart' ? 'restarting' : 'offline');
    ctx.shuttingDown = false;
    ctx.lockAcquiredAt = new Date();
    await startContext(ctx);
    return action === 'restart' ? 'restarted' : 'restarted_no_qr';
  }
  if (action === 'release') {
    logLine(`[${ctx.tenantId}] Accion RELEASE recibida: ${reason}`, 'event');
    await stopContext(ctx, 'offline');
    return 'released';
  }
  return 'ignored';
}

async function pollActionsOnce(ctx) {
  if (ctx.actionBusy || !ctx.lockId) return;
  ctx.actionBusy = true;
  try {
    const db = await getDb();
    const coll = db.collection('tg_bot_actions');
    const doc = await coll.findOneAndUpdate(
      { lockId: ctx.lockId, doneAt: { $exists: false } },
      { $set: { doneAt: new Date(), doneBy: instanceId } },
      { sort: { requestedAt: 1 }, returnDocument: 'after' }
    );
    const row = doc?.value || doc;
    if (!row) return;

    try {
      const reqAt = row.requestedAt ? new Date(row.requestedAt) : null;
      if (ctx.lockAcquiredAt && reqAt && reqAt.getTime() < ctx.lockAcquiredAt.getTime()) {
        await coll.updateOne({ _id: row._id }, { $set: { result: 'stale_ignored' } });
        return;
      }
    } catch {}

    const result = await handleActionDoc(ctx, row);
    await coll.updateOne({ _id: row._id }, { $set: { result } });
  } catch (e) {
    logLine(`[${ctx.tenantId}] pollActionsOnce error: ${e?.message || e}`, 'error');
  } finally {
    ctx.actionBusy = false;
  }
}

async function consultaApiMensajes(ctx) {
  if (ctx.outboundBusy) return;
  ctx.outboundBusy = true;
  try {
    if (!ctx.botStarted || !ctx.bot) return;
    const botFrom = getApiBotNumber(ctx);
    if (!botFrom) return;

    const url = `${ctx.config.api2}?key=${encodeURIComponent(ctx.config.key)}&nro_tel_from=${encodeURIComponent(botFrom)}`;
    const resp = await fetchJson(url, { method: 'GET' });
    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      logLine(`[${ctx.tenantId}] ConsultaApiMensajes resp error: ${raw}`, 'error');
      return;
    }

    const json = await resp.json().catch(() => null);
    if (!Array.isArray(json) || !json[0]) return;

    const mensajes = Array.isArray(json[0].mensajes) ? json[0].mensajes : [];
    const destinatarios = Array.isArray(json[0].destinatarios) ? json[0].destinatarios : [];

    for (const destinatario of destinatarios) {
      const idRenglon = destinatario?.Id_msj_renglon;
      const idDest = destinatario?.Id_msj_dest;
      const nro_tel = String(destinatario?.Nro_tel || '').trim();
      const respuestas = mensajes.filter((element) => String(element?.Id_msj_renglon) === String(idRenglon));

      for (const respuesta of respuestas) {
        const chatId = normalizeChatId(nro_tel);
        const Msj = respuesta?.Msj == null ? '' : String(respuesta.Msj);
        const contenido = respuesta?.Content;
        const Content_nombre = respuesta?.Content_nombre || 'archivo';

        if (chatId === '' || chatId === null) {
          await actualizarEstadoMensaje(ctx, 'I', null, null, null, null, null, idRenglon, idDest);
          continue;
        }

        const chatData = await getChatRegistry(ctx, String(chatId));
        if (!chatData) {
          logLine(`[${ctx.tenantId}] Telegram destino no conocido: ${String(chatId)}`, 'event');
          await actualizarEstadoMensaje(ctx, 'I', null, null, null, null, null, idRenglon, idDest);
          continue;
        }

        try {
          if (contenido != null && contenido !== '') {
            const mediaPayload = buildMediaPayloadFromBase64(contenido, Content_nombre, Msj);
            await safeSendTelegram(ctx, chatId, mediaPayload, { caption: Msj });
          } else {
            await safeSendTelegram(ctx, chatId, Msj);
          }

          const contacto = [chatData.firstName, chatData.lastName].filter(Boolean).join(' ').trim() || chatData.title || chatData.username || '';
          const tipo = chatData.chatType === 'private' ? 'C' : 'B';
          const nombre = contacto || chatData.username || '';
          const direccion = chatData.chatType;
          await actualizarEstadoMensaje(ctx, 'E', tipo, nombre, contacto, direccion, '', idRenglon, idDest);

          const segDesde = Math.min(Number(ctx.config.seg_desde) || 0, Number(ctx.config.seg_hasta) || 0);
          const segHasta = Math.max(Number(ctx.config.seg_desde) || 0, Number(ctx.config.seg_hasta) || 0);
          const segMsg = Math.random() * (segHasta - segDesde) + segDesde;
          await sleep(segMsg);
        } catch (e) {
          logLine(`[${ctx.tenantId}] Error enviando cola Telegram: ${e?.message || e}`, 'error');
          await actualizarEstadoMensaje(ctx, 'I', null, null, null, null, null, idRenglon, idDest);
        }
      }
    }
  } catch (e) {
    logLine(`[${ctx.tenantId}] ConsultaApiMensajes error: ${e?.message || e}`, 'error');
  } finally {
    ctx.outboundBusy = false;
  }
}

async function startContext(ctx) {
  if (ctx.botStarted || ctx.startingNow) return getContextStatus(ctx);
  const pol = await getPolicySafe(ctx);
  if (pol && pol.disabled === true) {
    ctx.botState = 'disabled';
    ctx.ownsLock = false;
    await pushHistory(ctx, 'policy_disabled', { by: 'policy', disabled: true });
    return getContextStatus(ctx);
  }

  ctx.startingNow = true;
  ctx.shuttingDown = false;
  try {
    ctx.lockAcquiredAt = new Date();

    const acquired = await acquireLock(ctx, 'starting');
    if (!acquired) {
      ctx.botState = 'standby';
      return getContextStatus(ctx);
    }

    ctx.botState = 'starting';
    await updateLockState(ctx, 'starting');
    await createBotIfNeeded(ctx);
    const me = await ctx.bot.getMe();
    ctx.telegramSelfId = String(me?.id || '');
    ctx.telegramSelfUsername = String(me?.username || ctx.config.telegram_bot_username || '');
    if (ctx.telegramSelfUsername) manager.byUsername.set(String(ctx.telegramSelfUsername).toLowerCase(), ctx.tenantId);
    await ctx.bot.startPolling({ restart: true });
    ctx.botStarted = true;
    ctx.botState = 'online';
    await updateLockState(ctx, 'online');
    await pushHistory(ctx, 'lock_acquired', { holderId: instanceId, host: os.hostname() });
    logLine(`[${ctx.tenantId}] Telegram listo como @${ctx.telegramSelfUsername || ctx.config.telegram_bot_username || ''}`, 'event');

    try { if (ctx.timers.heartbeat) clearInterval(ctx.timers.heartbeat); } catch {}
    try { if (ctx.timers.action) clearInterval(ctx.timers.action); } catch {}
    try { if (ctx.timers.expiry) clearInterval(ctx.timers.expiry); } catch {}
    ctx.timers.heartbeat = setInterval(() => { heartbeatTick(ctx).catch(() => {}); }, HEARTBEAT_MS);
    ctx.timers.action = setInterval(() => { pollActionsOnce(ctx).catch(() => {}); }, ACTION_POLL_MS);
    ctx.timers.expiry = setInterval(() => { controlarHoraMsgOnce(ctx).catch(() => {}); }, EXPIRY_POLL_MS);
    scheduleOutboundPoller(ctx);

    // warm known chat count
    try {
      const db = await getDb();
      ctx.knownChats = await db.collection('tg_chat_registry').countDocuments({ tenantId: ctx.tenantId });
    } catch {}
    return getContextStatus(ctx);
  } catch (e) {
    ctx.botStarted = false;
    ctx.botState = 'error';
    logLine(`[${ctx.tenantId}] Error al inicializar Telegram: ${e?.message || e}`, 'error');
    try {
      if (ctx.bot && typeof ctx.bot.removeAllListeners === 'function') {
        ctx.bot.removeAllListeners('message');
        ctx.bot.removeAllListeners('polling_error');
        ctx.bot.removeAllListeners('webhook_error');
      }
    } catch {}
    try {
      if (ctx.bot && typeof ctx.bot.stopPolling === 'function') await ctx.bot.stopPolling({ cancel: true });
    } catch {}
    ctx.bot = null;
    await updateLockState(ctx, 'error');
    await forceReleaseLock(ctx, 'error');
    return getContextStatus(ctx);
  } finally {
    ctx.startingNow = false;
  }
}

async function ensureContextForConfig(cfg) {
  const existing = manager.contexts.get(cfg.tenantId);
  if (!existing) {
    const ctx = createContext(cfg);
    manager.contexts.set(cfg.tenantId, ctx);
    await startContext(ctx);
    return ctx;
  }

  const prevBotSig = botConnectionSignature(existing.config);
  const nextBotSig = botConnectionSignature(cfg);
  const prevRuntimeSig = runtimeConfigSignature(existing.config);
  const nextRuntimeSig = runtimeConfigSignature(cfg);
  const oldNumero = existing.numero;
  const oldLockId = existing.lockId;

  existing.config = { ...existing.config, ...cfg, ...getErrorConfig() };
  existing.numero = existing.config.numero;
  existing.statusToken = existing.config.status_token || existing.statusToken || '';
  existing.lockId = `${existing.tenantId}:${existing.numero || 'telegram'}`;

  if (prevBotSig !== nextBotSig) {
    logLine(`[${cfg.tenantId}] cambio de token/username Telegram detectado -> reiniciando bot`, 'event');
    await stopContext(existing, 'reconfiguring');
    if (oldLockId && oldLockId !== existing.lockId) {
      try {
        const db = await getDb();
        await db.collection('tg_locks').deleteOne({ _id: oldLockId });
      } catch (e) {
        logLine(`[${cfg.tenantId}] cleanup lock anterior error: ${e?.message || e}`, 'error');
      }
    }
    existing.lockAcquiredAt = new Date();
    existing.botState = 'idle';
    existing.telegramSelfId = '';
    existing.telegramSelfUsername = '';
    await sleep(1200);
    await startContext(existing);
  } else {
    if (prevRuntimeSig !== nextRuntimeSig) {
      logLine(`[${cfg.tenantId}] configuración Telegram actualizada sin reinicio de bot`, 'event');
      if (oldNumero !== existing.numero) {
        logLine(`[${cfg.tenantId}] numero API Telegram: ${oldNumero || '-'} -> ${existing.numero || '-'}`, 'event');
      }
      if (existing.ownsLock) {
        await updateLockState(existing, existing.botState || (existing.botStarted ? 'online' : 'idle'));
      }
    }
    if (!existing.botStarted && !existing.startingNow) {
      await startContext(existing);
    }
  }
  return existing;
}

async function refreshManagerFromDb() {
  if (manager.refreshing) return getTelegramStatus();
  manager.refreshing = true;
  try {
    const configs = await getTenantConfigsFromDb();
    const desiredIds = new Set(configs.map((cfg) => cfg.tenantId));

    for (const cfg of configs) {
      await ensureContextForConfig(cfg);
    }

    for (const [tenantId, ctx] of Array.from(manager.contexts.entries())) {
      if (!desiredIds.has(tenantId)) {
        await stopContext(ctx, 'removed');
        manager.contexts.delete(tenantId);
      }
    }

    if (!configs.length) {
      logLine('Telegram runtime omitido: no hay tenants con telegram_bot_token en tenant_config/env.', 'event');
    }

    return getTelegramStatus();
  } finally {
    manager.refreshing = false;
  }
}

function getVisibleContexts(req) {
  const role = String(req?.user?.role || '').toLowerCase();
  const isSuper = role === 'superadmin';
  const tenantQuery = normalizeString(req?.query?.tenantId || req?.query?.tenant || '', '');
  if (isSuper) {
    if (tenantQuery) return Array.from(manager.contexts.values()).filter((ctx) => ctx.tenantId === tenantQuery.toUpperCase());
    return Array.from(manager.contexts.values());
  }
  const userTenant = normalizeString(req?.user?.tenantId || '', '').toUpperCase();
  if (!userTenant) return [];
  const ctx = manager.contexts.get(userTenant);
  return ctx ? [ctx] : [];
}

function getTelegramStatus() {
  const items = Array.from(manager.contexts.values()).map(getContextStatus).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  return {
    ok: true,
    now: nowArgentinaISO(),
    total: items.length,
    started: items.filter((x) => x.botStarted).length,
    items,
  };
}

function tgArYmd(date) {
  try {
    const dt = date || new Date();
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: AR_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(dt);
  } catch {
    return (date || new Date()).toISOString().slice(0, 10);
  }
}

function tgArDateRange(fromYmd, toYmd) {
  const from = String(fromYmd || '').trim() || tgArYmd(new Date());
  const to = String(toYmd || '').trim() || from;
  const start = new Date(`${from}T00:00:00.000-03:00`);
  const end = new Date(`${to}T23:59:59.999-03:00`);
  return {
    start,
    end: new Date(end.getTime() + 1),
  };
}

function tgHumanizeMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '-';
  const mins = Math.floor(n / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}


function telegramAdminEmbedPage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Sesiones Telegram · Asisto</title>
  <style>
    :root{--bg:#f8fafc;--panel:#ffffff;--text:#0f172a;--muted:#64748b;--border:rgba(148,163,184,.24);--accent:#0e6b66;--danger:#b42318;--shadow:0 16px 38px rgba(15,23,42,.10);--radius:18px}
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
    .page{padding:16px}
    .toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
    .toolbar h1{margin:0 0 4px;font-size:24px}
    .sub{font-size:13px;color:var(--muted)}
    .toolbarActions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .btn,.btn2{border:1px solid var(--border);background:#fff;border-radius:12px;padding:10px 14px;font-weight:700;cursor:pointer;color:var(--text)}
    .btn:hover,.btn2:hover{background:#f8fafc}
    .btnDanger{color:var(--danger)}
    .card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
    .filters{display:grid;grid-template-columns:minmax(240px,1fr) 220px;gap:12px;align-items:end;margin-bottom:14px}
    .filters label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)}
    .inp{width:100%;border:1px solid var(--border);border-radius:12px;padding:10px 12px;background:#fff;color:var(--text)}
    .msg{margin-bottom:12px;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:#fff;font-size:13px}
    .msg.err{border-color:rgba(240,68,56,.25);background:rgba(240,68,56,.08);color:#991b1b}
    .msg.ok{border-color:rgba(14,107,102,.22);background:rgba(14,107,102,.08);color:#0f5132}
    .tableWrap{overflow:auto;max-width:100%;-webkit-overflow-scrolling:touch;padding-bottom:120px}
    .tableWrap[data-loading="1"]{opacity:.75}
    .tgTable{width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0}
    .tgTable thead th{position:sticky;top:0;background:#fff;z-index:2}
    .tgTable tbody tr{position:relative;z-index:1}
    .tgTable tbody tr:nth-child(even){background:rgba(16,24,40,.02)}
    .tgTable tbody tr.rowMenuOpen{z-index:120}
    .tgTable td,.tgTable th{padding:12px 14px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top;font-size:13px;white-space:normal;word-break:break-word}
    .tgTable th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
    .tgTable th:nth-child(1){width:160px}
    .tgTable th:nth-child(2){width:240px}
    .tgTable th:nth-child(3){width:180px}
    .tgTable th:nth-child(4){width:150px}
    .tgTable th:nth-child(5){width:180px}
    .tgTable th:nth-child(6){width:220px}
    .cellMain{font-weight:800}
    .cellSub{font-size:12px;color:var(--muted);margin-top:2px}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .status{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--border);font-size:11px;font-weight:700;background:#fff}
    .status.on{background:rgba(14,107,102,.08);color:var(--accent);border-color:rgba(14,107,102,.18)}
    .status.off{background:rgba(148,163,184,.08);color:#475569}
    .status.err{background:rgba(180,35,24,.08);color:var(--danger);border-color:rgba(180,35,24,.18)}
    .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700}
    .badgeOk{background:#1f7a3a1a;color:#1f7a3a;border:1px solid #1f7a3a55}
    .badgeWarn{background:#b453091a;color:#b45309;border:1px solid #b4530955}
    .wa-actions-cell{position:relative;z-index:1;overflow:visible}
    .wa-actions-cell.menuCellOpen{z-index:220}
    .actionBar{display:flex;gap:10px;align-items:center;justify-content:flex-start;flex-wrap:wrap}
    .btnMenu{padding:8px 12px;border-radius:12px;white-space:nowrap}
    .caret{opacity:.7;margin-left:6px}
    .menuWrap{position:relative;display:inline-block;overflow:visible;z-index:260}
    .menu{position:absolute;right:0;top:calc(100% + 8px);min-width:200px;background:#fff;border:1px solid rgba(15,23,42,.12);box-shadow:0 12px 28px rgba(2,8,23,.18);border-radius:14px;padding:8px;display:none;z-index:320}
    .menu.up{top:auto;bottom:calc(100% + 8px)}
    .menuItem{width:100%;text-align:left;padding:10px 12px;border:0;background:transparent;border-radius:10px;cursor:pointer;font-size:14px;color:var(--text)}
    .menuItem:hover{background:rgba(15,23,42,.06)}
    .menuSep{height:1px;background:rgba(15,23,42,.10);margin:8px 6px}
    .empty{padding:18px;color:var(--muted);font-size:13px}
    body.modalOpen{overflow:hidden}
    .modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px}
    .modal[hidden]{display:none !important}
    .modalBackdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}
    .modalCard{position:relative;width:min(980px,96vw);max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:16px;padding:14px 14px 16px;box-shadow:0 20px 60px rgba(0,0,0,.35);color:#0f172a}
    .modalHeader{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}
    .statsModalCard .small,.statsModalCard label,.statsModalCard #statsMeta,.statsModalCard #statsSub{color:#475467}
    .statsCards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:8px}
    .statsMiniCard{background:rgba(16,24,40,.03);border:1px solid rgba(16,24,40,.08);border-radius:12px;padding:10px 12px;color:#0f172a}
    .statsMiniCard .cellMain{color:#0f172a !important;font-weight:800}
    .statsTableWrap{max-height:48vh;overflow:auto;padding-bottom:0}
    .statsTable{width:100%;table-layout:fixed}
    .statsTable th:nth-child(1){width:190px}
    .statsTable th:nth-child(2),.statsTable th:nth-child(3),.statsTable th:nth-child(4){width:90px}
    .statsTable th:nth-child(5){width:180px}
    @media (max-width:960px){.filters{grid-template-columns:1fr}}
    @media (max-width:820px){
      .toolbar{align-items:stretch}
      .toolbarActions{width:100%}
      .toolbarActions .btn2{flex:1 1 auto;justify-content:center}
      .tableWrap{overflow:visible;padding-bottom:24px}
      .tgTable,.tgTable thead,.tgTable tbody,.tgTable th,.tgTable td,.tgTable tr{display:block;width:100%}
      .tgTable thead{display:none}
      .tgTable tbody{display:grid;gap:12px}
      .tgTable tbody tr{border:1px solid rgba(148,163,184,.22);border-radius:14px;padding:10px 12px;background:#fff !important;box-shadow:0 8px 18px rgba(15,23,42,.06);z-index:1}
      .tgTable td{border:0;padding:8px 0}
      .tgTable td + td{border-top:1px solid rgba(148,163,184,.14)}
      .menu{right:auto;left:0;min-width:min(240px,82vw)}
    }
    </style>
</head>
<body>
  <div class="page">

    <div class="toolbar">
      <div>
        <h1>Sesiones Telegram</h1>
        <div class="sub">Muestra las sesiones activas por tenant. Acciones: reiniciar, bloquear/habilitar y estadísticas.</div>
      </div>
      <div class="toolbarActions">
        <button class="btn2" id="tgReloadBtn" type="button">Recargar</button>
        <button class="btn2" id="tgRefreshBtn" type="button">Actualizar</button>
        <span id="tgStatus" class="small" style="opacity:.85"></span>
      </div>
    </div>

    <div class="filters">
      <label>Buscar sesión
        <input class="inp" id="tgSearch" type="search" placeholder="Tenant, número, bot o holder"/>
      </label>
      <label>Estado
        <select class="inp" id="tgStateFilter">
          <option value="all">Todos</option>
          <option value="active">Activas</option>
          <option value="inactive">Inactivas</option>
          <option value="starting">starting</option>
          <option value="online">online</option>
          <option value="offline">offline</option>
          <option value="standby">standby</option>
          <option value="disabled">disabled</option>
          <option value="conflict">conflict</option>
          <option value="error">error</option>
        </select>
      </label>
    </div>

    <div id="tgMsg" class="small" style="margin-top:10px"></div>

    <div class="card">
      <div class="tableWrap" id="tgTableWrap">
        <table class="tgTable">
          <thead>
            <tr>
              <th>Sesión</th>
              <th>Bot</th>
              <th>Estado</th>
              <th>Chats</th>
              <th>Última actividad</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody id="tgBody">
            <tr><td colspan="6" class="small">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="modal" id="statsModal" hidden>
      <div class="modalBackdrop" data-stats-close="1"></div>
      <div class="modalCard statsModalCard" role="dialog" aria-modal="true" aria-label="Estadísticas Telegram">
        <div class="modalHeader">
          <div>
            <div id="statsTitle" style="font-weight:800">Estadísticas</div>
            <div id="statsSub" class="small" style="opacity:.85"></div>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
            <label class="small">Desde <input type="date" id="statsFrom"/></label>
            <label class="small">Hasta <input type="date" id="statsTo"/></label>
            <button id="statsApply" class="btn2" type="button">Ver</button>
            <button id="statsClose" class="btn2" type="button">Cerrar</button>
          </div>
        </div>
        <div id="statsMeta" class="small" style="margin:10px 0"></div>
        <div id="statsCards" class="statsCards"></div>
        <div class="card" style="margin-top:12px; padding:10px 12px">
          <div class="cellMain" style="margin-bottom:6px">Contactos del rango</div>
          <div class="tableWrap statsTableWrap">
            <table class="statsTable">
              <thead>
                <tr>
                  <th>Contacto</th>
                  <th>Entrada</th>
                  <th>Salida</th>
                  <th>Total</th>
                  <th>Último mensaje</th>
                </tr>
              </thead>
              <tbody id="statsContactsBody">
                <tr><td colspan="5" class="small">Sin datos.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

  </div>
  <script>
    (function(){
     var body = document.getElementById('tgBody');
      var msg = document.getElementById('tgMsg');
      var statusEl = document.getElementById('tgStatus');
     var tableWrap = document.getElementById('tgTableWrap');
      var searchEl = document.getElementById('tgSearch');
      var stateFilterEl = document.getElementById('tgStateFilter');
      var reloadBtn = document.getElementById('tgReloadBtn');
      var refreshBtn = document.getElementById('tgRefreshBtn');
      var inflight = false;
      var lastHtml = null;
      var lastItems = [];
      var lastNowMs = Date.now();

      var statsModal = document.getElementById('statsModal');
      var statsTitle = document.getElementById('statsTitle');
     var statsSub = document.getElementById('statsSub');
      var statsMeta = document.getElementById('statsMeta');
      var statsCards = document.getElementById('statsCards');
      var statsFrom = document.getElementById('statsFrom');
      var statsTo = document.getElementById('statsTo');
      var statsApply = document.getElementById('statsApply');
      var statsClose = document.getElementById('statsClose');
      var statsContactsBody = document.getElementById('statsContactsBody');
     var statsTenant = '';
      var statsNumero = '';

      function esc(s){
        return String(s == null ? '' : s)
          .replace(/&/g,'&amp;')
          .replace(/</g,'&lt;')
          .replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;')
          .replace(/'/g,'&#39;');
      }

      function api(path, opts){
        opts = opts || {};
        opts.headers = Object.assign({ 'Content-Type':'application/json' }, (opts.headers || {}));
        return fetch(path, Object.assign({ credentials:'same-origin' }, opts)).then(function(r){
          return r.text().then(function(t){
            var data = null;
            try { data = t ? JSON.parse(t) : null; } catch(e) {}
            if(!r.ok){
              var err = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + r.status);
              throw new Error(err);
            }
            return data || {};
          });
        });
      }

      function setMsg(kind, text){
        msg.innerHTML = text ? '<div class="msg ' + (kind === 'err' ? 'err' : 'ok') + '">' + esc(text) + '</div>' : '';
      }

      function fmtDate(v){
       if(!v) return '';
        try { return new Date(v).toLocaleString('es-AR'); } catch(e) { return String(v); }
      }

      function fmtDurationMs(ms){
        var n = Number(ms);
        if(!isFinite(n) || n < 0) return '-';
        var mins = Math.floor(n / 60000);
        var d = Math.floor(mins / 1440);
        var h = Math.floor((mins % 1440) / 60);
        var m = mins % 60;
        var parts = [];
        if(d) parts.push(d + 'd');
        if(h || d) parts.push(h + 'h');
        parts.push(m + 'm');
        return parts.join(' ');
      }

      function toYmd(d){
        try {
          var y = d.getFullYear();
          var m = String(d.getMonth() + 1).padStart(2, '0');
          var day = String(d.getDate()).padStart(2, '0');
          return y + '-' + m + '-' + day;
        } catch(e) { return ''; }
      }
      function normalizedState(item, nowMs){
        var st = String((item && item.botState) || '').trim().toLowerCase();
        var last = item && item.lastSeenAt ? new Date(item.lastSeenAt).getTime() : 0;
        var active = !!(last && (nowMs - last) <= 30000);
        if (st === 'disabled') return 'disabled';
        if (st) return st;
        return active ? 'active' : 'inactive';
      }

      function lockSearchText(item){
        return [
          item && item.tenantId || '',
          item && item.numero || '',
          item && item.telegramBotUsername || '',
          item && item.telegramBotId || '',
          item && item.lockId || '',
          item && item.botState || ''
        ].join(' ').toLowerCase();
      }

      function applyFiltersAndSort(items, nowMs){
        var out = Array.isArray(items) ? items.slice() : [];
        var q = searchEl ? String(searchEl.value || '').trim().toLowerCase() : '';
        var sf = stateFilterEl ? String(stateFilterEl.value || 'all').trim().toLowerCase() : 'all';

        out.sort(function(a,b){
          var ta = String(a && a.tenantId || '').toLowerCase();
          var tb = String(b && b.tenantId || '').toLowerCase();
          if (ta !== tb) return ta.localeCompare(tb, 'es', { sensitivity:'base' });
          var na = String(a && a.numero || '').toLowerCase();
          var nb = String(b && b.numero || '').toLowerCase();
          return na.localeCompare(nb, 'es', { sensitivity:'base', numeric:true });
       });

        if (q) out = out.filter(function(item){ return lockSearchText(item).indexOf(q) >= 0; });

        if (sf && sf !== 'all') {
          out = out.filter(function(item){
            var ns = normalizedState(item, nowMs);
            if (sf === 'active') return ['active','online','starting'].indexOf(ns) >= 0;
            if (sf === 'inactive') return ['inactive','offline','standby','conflict','error'].indexOf(ns) >= 0;
            return ns === sf;
          });
        }

        return out;
      }

      function statusPill(item, nowMs){
        var raw = String(item.botState || '').toLowerCase();
        var last = item.lastSeenAt ? new Date(item.lastSeenAt).getTime() : 0;
        var active = !!(last && (nowMs - last) <= 30000);
        var cls = active && raw !== 'disabled' ? 'status on' : ((raw === 'error' || raw === 'conflict') ? 'status err' : 'status off');
        return '<span class="' + cls + '">' + esc(item.botState || '-') + '</span>';
      }

      function renderRow(item, nowMs){
        var menuId = 'm_' + String(item.lockId || item.tenantId || '').replace(/[^a-zA-Z0-9_-]/g,'') + '_' + Math.floor(Math.random() * 1e6);
        var botLabel = item.telegramBotUsername ? ('@' + String(item.telegramBotUsername).replace(/^@+/, '')) : 'Sin username';
        var isDisabled = String(item.botState || '').toLowerCase() === 'disabled';
        var ageSec = item.lastSeenAt ? Math.round((nowMs - new Date(item.lastSeenAt).getTime()) / 1000) : null;
        var ageHtml = ageSec != null ? ('<div class="cellSub">hace ' + esc(ageSec) + 's</div>') : '';
        var actions = ''
          + '<div class="menuWrap">'
          +   '<button class="btn2 btnMenu" type="button" data-action="menu" data-menu="' + esc(menuId) + '" aria-haspopup="true" aria-expanded="false">Acciones <span class="caret">▾</span></button>'
          +   '<div class="menu" id="' + esc(menuId) + '" role="menu" aria-hidden="true">'
          +     '<button class="menuItem" type="button" role="menuitem" data-action="restart" data-tenant="' + esc(item.tenantId) + '">Reiniciar</button>'
          +     '<button class="menuItem" type="button" role="menuitem" data-action="toggle" data-tenant="' + esc(item.tenantId) + '" data-numero="' + esc(item.numero || '') + '" data-disabled="' + (isDisabled ? '1' : '0') + '">' + (isDisabled ? 'Habilitar' : 'Bloquear') + '</button>'
          +     '<div class="menuSep"></div>'
          +     '<button class="menuItem" type="button" role="menuitem" data-action="stats" data-tenant="' + esc(item.tenantId) + '" data-numero="' + esc(item.numero || '') + '">Estadísticas</button>'
          +   '</div>'
          + '</div>';

        return ''
          + '<tr class="tgRow">'
          +   '<td><div class="cellMain">' + esc(item.tenantId) + '</div><div class="cellSub">' + esc(item.numero || '-') + '</div></td>'
          +   '<td><div class="cellMain">' + esc(botLabel) + '</div><div class="cellSub mono">' + esc(item.telegramBotId || '-') + '</div><div class="cellSub mono">' + esc(item.lockId || '-') + '</div></td>'
          +   '<td>' + statusPill(item, nowMs) + ageHtml + '</td>'
          +   '<td><div class="cellMain">' + esc(String(item.knownChats || 0)) + '</div></td>'
          +   '<td><div class="cellMain">' + esc(fmtDate(item.lastSeenAt) || '-') + '</div><div class="cellSub">' + esc(fmtDate(item.startedAt) ? ('Inicio: ' + fmtDate(item.startedAt)) : '-') + '</div></td>'
          +   '<td class="wa-actions-cell"><div class="actionBar">' + actions + '</div></td>'
          + '</tr>';
      }

      function renderCurrentSessions(){
        var nowMs = lastNowMs || Date.now();
        var items = applyFiltersAndSort(lastItems, nowMs);
        var html = '';
        if (!items.length) html = '<tr><td colspan="6" class="small">No hay sesiones para los filtros seleccionados.</td></tr>';
        else html = items.map(function(item){ return renderRow(item, nowMs); }).join('');

        if (html !== lastHtml) {
          var sx = tableWrap ? tableWrap.scrollLeft : 0;
          var sy = tableWrap ? tableWrap.scrollTop : 0;
          body.innerHTML = html;
          if (tableWrap) {
            tableWrap.scrollLeft = sx;
            tableWrap.scrollTop = sy;
          }
          lastHtml = html;
        }
      }

      function setLoading(on){
        if (!tableWrap) return;
        if (on) tableWrap.setAttribute('data-loading','1');
        else tableWrap.removeAttribute('data-loading');
      }

      function closeAllMenus(){
        document.querySelectorAll('.menu[aria-hidden="false"]').forEach(function(m){
          m.setAttribute('aria-hidden','true');
          m.style.display = 'none';
        });
        document.querySelectorAll('button[data-action="menu"][aria-expanded="true"]').forEach(function(b){
          b.setAttribute('aria-expanded','false');
        });
        document.querySelectorAll('.wa-actions-cell.menuCellOpen').forEach(function(cell){
          cell.classList.remove('menuCellOpen');
        });
        document.querySelectorAll('.tgRow.rowMenuOpen').forEach(function(row){
          row.classList.remove('rowMenuOpen');
        });
      }

      function positionMenu(btn){
        try {
          var wrap = btn && btn.closest ? btn.closest('.menuWrap') : null;
          if (!wrap) return;
          var menu = wrap.querySelector('.menu');
          if (!menu) return;
          menu.classList.remove('up');
          var rect = menu.getBoundingClientRect();
          var vh = window.innerHeight || document.documentElement.clientHeight || 0;
          if (rect.bottom > (vh - 12)) menu.classList.add('up');
        } catch(e) {}
      }

      function toggleMenu(menuId, btn){
        var m = document.getElementById(menuId);
        if (!m) return;
        var isOpen = (m.getAttribute('aria-hidden') === 'false');
        closeAllMenus();
        if (isOpen) return;
        var cell = btn && btn.closest ? btn.closest('.wa-actions-cell') : null;
        var row = btn && btn.closest ? btn.closest('.tgRow') : null;
        if (cell) cell.classList.add('menuCellOpen');
        if (row) row.classList.add('rowMenuOpen');
        m.setAttribute('aria-hidden','false');
        m.style.display = 'block';
        btn.setAttribute('aria-expanded','true');
        positionMenu(btn);
      }

      async function load(opts){
        opts = opts || {};
        var initial = !!opts.initial;
        if (document.hidden && !opts.force) return;
        if (inflight) return;
        inflight = true;

        if (initial && body && !body.__didInitial) {
          body.innerHTML = '<tr><td colspan="6" class="small">Cargando…</td></tr>';
          body.__didInitial = true;
        }

        setLoading(true);
        return api('/api/tg/status', { method:'GET' })
          .then(function(data){
            lastItems = Array.isArray(data.items) ? data.items : [];
            lastNowMs = data.now ? new Date(data.now).getTime() : Date.now();
            renderCurrentSessions();
            if (statusEl) statusEl.textContent = 'Última actualización: ' + new Date(lastNowMs).toLocaleTimeString('es-AR');
            if (msg) msg.textContent = '';
          })
          .catch(function(e){
            if (statusEl) statusEl.textContent = 'Error actualizando: ' + (e.message || e);
            if (lastHtml == null) {
              body.innerHTML = '<tr><td colspan="6" class="small">Error: ' + esc(e.message || e) + '</td></tr>';
              lastHtml = body.innerHTML;
            }
          })
          .finally(function(){
            inflight = false;
            setLoading(false);
          });
      }

      async function doRestart(tenantId){
        closeAllMenus();
        if (!confirm('¿Reiniciar esta sesión de Telegram?')) return;
        try {
          await api('/api/tg/restart', { method:'POST', body: JSON.stringify({ tenantId: tenantId }) });
          await load({ force:true });
          setMsg('ok', 'Reinicio solicitado para ' + tenantId + '.');
        } catch(e) {
          setMsg('err', e.message || String(e));
        }
      }

      async function doToggle(tenantId, numero, currentlyDisabled){
        closeAllMenus();
        var nextDisabled = !currentlyDisabled;
        var label = nextDisabled ? 'bloquear' : 'habilitar';
        if (!confirm('¿' + label.toUpperCase() + ' esta sesión? ' + tenantId + ' · ' + numero)) return;
        try {
          await api('/api/tg/policy', { method:'POST', body: JSON.stringify({ tenantId: tenantId, disabled: nextDisabled }) });
          await load({ force:true });
          setMsg('ok', nextDisabled ? 'Sesión bloqueada.' : 'Sesión habilitada.');
        } catch(e) {
          setMsg('err', e.message || String(e));
        }
      }

      function statsSetOpen(open){
        if(!statsModal) return;
        if(open){ statsModal.hidden = false; document.body.classList.add('modalOpen'); }
        else { statsModal.hidden = true; document.body.classList.remove('modalOpen'); }
      }

      function closeStats(){ statsSetOpen(false); }

      function statsCard(label, value, sub){
        return '<div class="statsMiniCard">'
          + '<div class="small" style="opacity:.8; color:#475467">' + esc(label) + '</div>'
          + '<div class="cellMain" style="font-size:22px; margin-top:4px; color:#0f172a; font-weight:800">' + esc(value) + '</div>'
          + (sub ? ('<div class="small" style="margin-top:4px; color:#475467">' + esc(sub) + '</div>') : '')
          + '</div>';
      }

      function renderStats(data){
        var summary = data && data.summary ? data.summary : {};
        var overall = data && data.overall ? data.overall : {};
        var contacts = Array.isArray(data && data.contacts) ? data.contacts : [];
        statsMeta.textContent = 'Rango: ' + (data.from || '-') + ' a ' + (data.to || '-') + ' · Último mensaje global: ' + (overall.lastMessageAt ? fmtDate(overall.lastMessageAt) : '-');
        statsCards.innerHTML = ''
          + statsCard('Mensajes entrada', String(summary.incoming || 0))
          + statsCard('Mensajes salida', String(summary.outgoing || 0))
          + statsCard('Mensajes totales', String(summary.total || 0))
          + statsCard('Contactos', String(summary.contacts || 0))
          + statsCard('Último mensaje del rango', summary.lastAt ? fmtDate(summary.lastAt) : '-')
          + statsCard('Inactividad actual', overall.inactivityLabel || fmtDurationMs(overall.inactivityMs || 0));

        if (!contacts.length) {
          statsContactsBody.innerHTML = '<tr><td colspan="5" class="small">No hay mensajes en el rango seleccionado.</td></tr>';
          return;
        }

        statsContactsBody.innerHTML = contacts.map(function(c){
          return '<tr>'
            + '<td class="mono">' + esc(c.contact || '-') + '</td>'
            + '<td>' + esc(String(c.incoming || 0)) + '</td>'
            + '<td>' + esc(String(c.outgoing || 0)) + '</td>'
            + '<td>' + esc(String(c.total || 0)) + '</td>'
            + '<td>' + esc(c.lastAt ? fmtDate(c.lastAt) : '-') + '</td>'
            + '</tr>';
        }).join('');
      }

      function loadStats(){
        if (!statsTenant || !statsNumero) return;
        statsMeta.textContent = 'Cargando…';
        statsCards.innerHTML = '';
        statsContactsBody.innerHTML = '<tr><td colspan="5" class="small">Cargando…</td></tr>';
        return api('/api/tg/stats?tenantId=' + encodeURIComponent(statsTenant) + '&numero=' + encodeURIComponent(statsNumero) + '&from=' + encodeURIComponent(statsFrom.value || '') + '&to=' + encodeURIComponent(statsTo.value || ''), { method:'GET' })
          .then(renderStats)
          .catch(function(e){
            statsMeta.textContent = 'Error: ' + (e.message || e);
            statsContactsBody.innerHTML = '<tr><td colspan="5" class="small">Error cargando estadísticas.</td></tr>';
          });
      }

      function openStats(tenantId, numero){
        closeAllMenus();
        statsTenant = String(tenantId || '');
        statsNumero = String(numero || '');
        var today = toYmd(new Date());
        if (statsTitle) statsTitle.textContent = 'Estadísticas · ' + statsNumero;
        if (statsSub) statsSub.textContent = 'tenant: ' + statsTenant;
        if (statsFrom && !statsFrom.value) statsFrom.value = today;
        if (statsTo && !statsTo.value) statsTo.value = statsFrom.value || today;
        statsSetOpen(true);
        loadStats();
      }

      if (statsApply) statsApply.addEventListener('click', loadStats);
      if (statsClose) statsClose.addEventListener('click', closeStats);
      if (statsModal) statsModal.addEventListener('click', function(ev){
        var t = ev && ev.target;
        if (t && t.getAttribute && t.getAttribute('data-stats-close')) closeStats();
      });

      reloadBtn.addEventListener('click', async function(){
        try {
          setMsg('', '');
          await api('/api/tg/reload', { method:'POST', body:'{}' });
          await load({ force:true });
          setMsg('ok', 'Sesiones Telegram recargadas.');
        } catch(e) {
          setMsg('err', e.message || String(e));
        }
      });

      refreshBtn.addEventListener('click', function(){ load({ force:true }).catch(function(e){ setMsg('err', e.message || String(e)); }); });

      body.addEventListener('click', function(e){
        var btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
        if (!btn) return;
        var act = btn.getAttribute('data-action');
        var tenant = btn.getAttribute('data-tenant') || '';
        var numero = btn.getAttribute('data-numero') || '';
        var disabledFlag = btn.getAttribute('data-disabled');
        var currentlyDisabled = (disabledFlag === '1' || disabledFlag === 'true');

        if (act === 'menu') {
          var menuId = btn.getAttribute('data-menu') || '';
          if (!menuId) return;
          toggleMenu(menuId, btn);
          e.preventDefault();
          return;
        }
        if (act === 'restart') return doRestart(tenant);
        if (act === 'toggle') return doToggle(tenant, numero, currentlyDisabled);
        if (act === 'stats') return openStats(tenant, numero);
      });

      if (searchEl) searchEl.addEventListener('input', function(){ closeAllMenus(); renderCurrentSessions(); });
      if (stateFilterEl) stateFilterEl.addEventListener('change', function(){ closeAllMenus(); renderCurrentSessions(); });

      document.addEventListener('click', function(e){
        var inside = e.target && e.target.closest ? e.target.closest('.menuWrap') : null;
        if (!inside) closeAllMenus();
      });
      document.addEventListener('keydown', function(e){
        if (e.key === 'Escape') {
          closeAllMenus();
          closeStats();
        }
      });
      window.addEventListener('resize', function(){
        document.querySelectorAll('.menu[aria-hidden="false"]').forEach(function(menu){
          var wrap = menu.closest('.menuWrap');
          var btn = wrap ? wrap.querySelector('button[data-action="menu"]') : null;
          if (btn) positionMenu(btn);
        });
      });

      window.__tgReload = function(){ return load({ force:true }); };
      load({ initial:true });
      setInterval(function(){ if (document.hidden) return; load(); }, 8000);
      document.addEventListener('visibilitychange', function(){ if (!document.hidden) load(); });
    })();
  </script>
</body>
</html>`;
}

function mountTelegramRoutes(app) {
  if (manager.routesMounted) return;
  manager.routesMounted = true;

  app.get('/admin/telegram', auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      return res.status(200).send(telegramAdminEmbedPage());
    } catch (e) {
      return res.status(500).send(String(e?.message || e));
    }
  });

  app.get('/api/tg/status', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const visible = getVisibleContexts(req).map(getContextStatus);
      return res.json({ ok: true, now: nowArgentinaISO(), total: visible.length, items: visible });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get('/api/tg/chats', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const visible = getVisibleContexts(req);
      const tenantFilter = visible.map((ctx) => ctx.tenantId);
      if (!tenantFilter.length) return res.json({ ok: true, items: [] });
      const db = await getDb();
      const chatRows = await db.collection('tg_chat_registry')
        .find({ tenantId: { $in: tenantFilter } })
        .sort({ tenantId: 1, lastSeenAt: -1 })
        .limit(1000)
        .toArray();
      return res.json({
        ok: true,
        items: chatRows.map((r) => ({
          tenantId: r.tenantId,
          numero: r.numero,
          chatId: r.chatId,
          username: r.username || '',
          firstName: r.firstName || '',
          lastName: r.lastName || '',
          title: r.title || '',
          chatType: r.chatType || '',
          blocked: !!r.blocked,
          lastSeenAt: r.lastSeenAt || null,
          firstSeenAt: r.firstSeenAt || null,
        }))
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get('/api/tg/stats', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const role = String(req.user?.role || '').toLowerCase();
      const isSuper = role === 'superadmin';
      const tenantId = String(req.query?.tenantId || (!isSuper ? (req.user?.tenantId || 'default') : '')).trim().toUpperCase();
      const numero = String(req.query?.numero || '').trim();
      if (!tenantId || !numero) return res.status(400).json({ ok: false, error: 'tenantId y numero requeridos' });
      if (!isSuper && tenantId !== String(req.user?.tenantId || 'default').trim().toUpperCase()) return res.status(403).json({ ok: false, error: 'forbidden' });

      const from = String(req.query?.from || tgArYmd(new Date())).trim();
      const to = String(req.query?.to || from).trim();
      const { start, end } = tgArDateRange(from, to);
      const db = await getDb();
      const coll = db.collection('tg_bot_message_log');
      const baseMatch = { tenantId, numero };
      const rangeMatch = { ...baseMatch, at: { $gte: start, $lt: end } };

      const [summaryRows, contactRows, overallLast] = await Promise.all([
        coll.aggregate([
          { $match: rangeMatch },
          { $group: {
            _id: null,
            incoming: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, 1, 0] } },
            outgoing: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, 1, 0] } },
            total: { $sum: 1 },
            contactsSet: { $addToSet: '$contact' },
            firstAt: { $min: '$at' },
            lastAt: { $max: '$at' }
          } }
        ]).toArray(),
        coll.aggregate([
          { $match: rangeMatch },
          { $group: {
            _id: '$contact',
            incoming: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, 1, 0] } },
            outgoing: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, 1, 0] } },
            total: { $sum: 1 },
            firstAt: { $min: '$at' },
            lastAt: { $max: '$at' }
          } },
          { $sort: { total: -1, lastAt: -1 } },
          { $limit: 1000 }
        ]).toArray(),
        coll.find(baseMatch).sort({ at: -1 }).limit(1).toArray(),
      ]);

      const summary = summaryRows[0] || { incoming: 0, outgoing: 0, total: 0, contactsSet: [], firstAt: null, lastAt: null };
      const lastOverall = overallLast[0] || null;
      const inactivityMs = lastOverall?.at ? Math.max(0, Date.now() - new Date(lastOverall.at).getTime()) : null;

      return res.status(200).json({
        ok: true,
        tenantId,
        numero,
        from,
        to,
        range: { start, end },
        summary: {
          incoming: Number(summary.incoming || 0),
          outgoing: Number(summary.outgoing || 0),
          total: Number(summary.total || 0),
          contacts: Array.isArray(summary.contactsSet) ? summary.contactsSet.filter(Boolean).length : 0,
          firstAt: summary.firstAt || null,
          lastAt: summary.lastAt || null,
        },
        overall: {
          lastMessageAt: lastOverall?.at || null,
          inactivityMs,
          inactivityLabel: inactivityMs == null ? '' : tgHumanizeMs(inactivityMs),
        },
        contacts: (contactRows || []).map((r) => ({
          contact: String(r._id || ''),
          incoming: Number(r.incoming || 0),
          outgoing: Number(r.outgoing || 0),
          total: Number(r.total || 0),
          firstAt: r.firstAt || null,
          lastAt: r.lastAt || null,
        })),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Error leyendo estadísticas.' });
    }
  });


  app.post('/api/tg/reload', auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const status = await refreshManagerFromDb();
      return res.json(status);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/tg/release', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const visible = getVisibleContexts(req);
      const tenantId = normalizeString(req?.body?.tenantId || req?.query?.tenantId || req?.query?.tenant || '', '').toUpperCase();
      const ctx = tenantId ? visible.find((x) => x.tenantId === tenantId) : visible[0];
      if (!ctx) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      await stopContext(ctx, 'offline');
      return res.json({ ok: true, item: getContextStatus(ctx) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/tg/start', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const visible = getVisibleContexts(req);
      const tenantId = normalizeString(req?.body?.tenantId || req?.query?.tenantId || req?.query?.tenant || '', '').toUpperCase();
      const ctx = tenantId ? visible.find((x) => x.tenantId === tenantId) : visible[0];
      if (!ctx) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      ctx.shuttingDown = false;
      const status = await startContext(ctx);
      return res.json({ ok: true, item: status });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/tg/restart', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const visible = getVisibleContexts(req);
      const tenantId = normalizeString(req?.body?.tenantId || req?.query?.tenantId || req?.query?.tenant || '', '').toUpperCase();
      const ctx = tenantId ? visible.find((x) => x.tenantId === tenantId) : visible[0];
      if (!ctx) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      await stopContext(ctx, 'restarting');
      ctx.shuttingDown = false;
      ctx.lockAcquiredAt = new Date();
      const status = await startContext(ctx);
      return res.json({ ok: true, item: status });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/tg/policy', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const visible = getVisibleContexts(req);
      const tenantId = normalizeString(req?.body?.tenantId || req?.query?.tenantId || req?.query?.tenant || '', '').toUpperCase();
      const disabled = !!req?.body?.disabled;
      const ctx = tenantId ? visible.find((x) => x.tenantId === tenantId) : visible[0];
      if (!ctx) return res.status(404).json({ ok: false, error: 'tenant_not_found' });
      const db = await getDb();
      await db.collection('tg_bot_policies').updateOne(
        { numero: ctx.numero, tenantId: ctx.tenantId },
        {
          $set: {
            tenantId: ctx.tenantId,
            tenantid: ctx.tenantId,
            numero: ctx.numero,
            disabled,
            updatedAt: new Date(),
          }
        },
        { upsert: true }
      );

      if (disabled) {
        await stopContext(ctx, 'disabled');
      } else {
        ctx.shuttingDown = false;
        ctx.botState = 'idle';
        await startContext(ctx);
      }

      return res.json({ ok: true, item: getContextStatus(ctx), disabled });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
}

async function startTelegramRuntime() {
  if (manager.started) return getTelegramStatus();
  manager.started = true;
  await refreshManagerFromDb();
  try { if (manager.refreshTimer) clearInterval(manager.refreshTimer); } catch {}
  manager.refreshTimer = setInterval(() => { refreshManagerFromDb().catch(() => {}); }, REFRESH_CONFIG_MS);
  return getTelegramStatus();
}

async function stopTelegramRuntime(signal = 'STOP') {
  try { if (manager.refreshTimer) clearInterval(manager.refreshTimer); } catch {}
  manager.refreshTimer = null;
  manager.started = false;
  for (const ctx of Array.from(manager.contexts.values())) {
    await stopContext(ctx, signal);
  }
  manager.contexts.clear();
  manager.byUsername.clear();
  return { ok: true, stopped: true };
}

module.exports = {
  startTelegramRuntime,
  stopTelegramRuntime,
  mountTelegramRoutes,
  getTelegramStatus,
};
