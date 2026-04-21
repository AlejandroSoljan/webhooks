/*script:telegram_runtime*/
/*version:1.00.00   21/04/2026   */

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const os = require('os');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const auth = require('./auth_ui');

const fetchJson = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));
};

const AR_TZ = 'America/Argentina/Cordoba';
const instanceId = process.env.INSTANCE_ID || `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

let lockAcquiredAt = null;
let tenantId = process.env.TENANT_ID || '';
let numero = process.env.NUMERO || '';
let mongo_uri = process.env.MONGO_URI || '';
let mongo_db = process.env.MONGO_DB || '';
let status_token = process.env.STATUS_TOKEN || '';
let telegram_bot_token = process.env.TELEGRAM_BOT_TOKEN || '';
let telegram_bot_username = process.env.TELEGRAM_BOT_USERNAME || '';
let tenantConfig = null;
let mongoReady = false;

let LockModel = null;
let ActionModel = null;
let PolicyModel = null;
let HistoryModel = null;
let MessageLogModel = null;
let ChatRegistryModel = null;

let heartbeatTimer = null;
let actionTimer = null;
let outboundTimer = null;
let expiryTimer = null;
let actionBusy = false;
let heartbeatBusy = false;
let outboundBusy = false;
let shuttingDown = false;
let runtimeStarted = false;

let bot = null;
let botStarted = false;
let startingNow = false;
let isOwner = false;
let lockId = '';
let localBotState = 'idle';
let telegram_self_id = '';
let telegram_self_username = '';

let seg_desde = 8000;
let seg_hasta = 12000;
let seg_msg = 5000;
let seg_tele = 3000;
let api = 'http://managermsm.ddns.net:2002/v200/api/Api_Chat_Cab/ProcesarMensajePost';
let api2 = 'http://managermsm.ddns.net:2002/v200/api/Api_Mensajes/Consulta_no_enviados';
let api3 = 'http://managermsm.ddns.net:2002/v200/api/Api_Mensajes/Actualiza_mensaje';
let key = 'FMM0325*';
let msg_inicio = '';
let msg_fin = '';
let cant_lim = 0;
let msg_lim = 'Continuar? S / N';
let time_cad = 0;
let email_err = '';
let msg_cad = '';
let msg_can = '';
let msg_errores = '';
let nom_chatbot = '';

const jsonGlobal = []; // [chatId, indiceActual, jsonPendiente, fechaUltimoMovimiento]
const recentOutgoingStatIds = new Map();

const signatures = {
  JVBERi0: 'application/pdf',
  R0lGODdh: 'image/gif',
  R0lGODlh: 'image/gif',
  iVBORw0KGgo: 'image/png',
  '/9j/': 'image/jpg'
};

const logFilePath_event = path.join(__dirname, 'telegram_runtime_event.log');
const logFilePath_error = path.join(__dirname, 'telegram_runtime_error.log');

let routesMounted = false;

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

function EscribirLog(mensaje, tipo) {
  try {
    const linea = `[${new Date().toISOString()}] ${String(mensaje || '')}\n`;
    const target = String(tipo || 'event').toLowerCase() === 'error' ? logFilePath_error : logFilePath_event;
    fs.appendFileSync(target, linea, 'utf8');
    console.log(linea.trim());
  } catch (e) {
    try { console.log('Log error', e?.message || e); } catch {}
  }
}

function readBootstrapFromFile() {
  try {
    const candidates = [
      path.join(__dirname, 'configuracion.json'),
      path.join(process.cwd(), 'configuracion.json')
    ];

    let p = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        p = candidate;
        break;
      }
    }

    if (!p) return {};

    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const obj = (raw && raw.configuracion && typeof raw.configuracion === 'object') ? raw.configuracion : raw;
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function applyTenantConfig(conf) {
  if (!conf || typeof conf !== 'object') return;

  const hasValue = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
  const asNumber = (v, current) => {
    if (!hasValue(v)) return current;
    const n = Number(v);
    return Number.isFinite(n) ? n : current;
  };
  const asString = (v, current = '') => {
    if (!hasValue(v)) return current;
    return String(v).trim();
  };

  if (!numero && (conf.numero || conf.NUMERO)) numero = asString(conf.numero || conf.NUMERO, numero);
  if (conf.status_token !== undefined) status_token = asString(conf.status_token, status_token);

  seg_desde = asNumber(conf.seg_desde, seg_desde);
  seg_hasta = asNumber(conf.seg_hasta, seg_hasta);
  seg_msg = asNumber(conf.seg_msg, seg_msg);
  seg_tele = asNumber(conf.seg_tele, seg_tele);
  if (conf.api !== undefined) api = String(conf.api);
  if (conf.api2 !== undefined) api2 = String(conf.api2);
  if (conf.api3 !== undefined) api3 = String(conf.api3);
  if (conf.key !== undefined) key = String(conf.key);
  if (conf.msg_inicio !== undefined) msg_inicio = String(conf.msg_inicio ?? '');
  if (conf.msg_fin !== undefined) msg_fin = String(conf.msg_fin ?? '');
  cant_lim = asNumber(conf.cant_lim, cant_lim);
  if (conf.msg_lim !== undefined) msg_lim = String(conf.msg_lim ?? '');
  time_cad = asNumber(conf.time_cad, time_cad);
  if (conf.msg_cad !== undefined) msg_cad = String(conf.msg_cad ?? '');
  if (conf.msg_can !== undefined) msg_can = String(conf.msg_can ?? '');
  if (conf.nom_emp !== undefined) nom_chatbot = String(conf.nom_emp);
  if (conf.nom_chatbot !== undefined) nom_chatbot = String(conf.nom_chatbot);

  telegram_bot_token = asString(
    conf.telegram_bot_token || conf.bot_token || conf.token_bot_telegram || conf.telegramToken,
    telegram_bot_token
  );

  telegram_bot_username = asString(
    conf.telegram_bot_username || conf.bot_username || conf.username_bot_telegram || conf.telegramBotUsername,
    telegram_bot_username
  );
}

function RecuperarJsonConf() {
  const boot = readBootstrapFromFile();
  if (!tenantId && boot.tenantId) tenantId = String(boot.tenantId).trim().toUpperCase();
  if (!mongo_uri && (boot.mongo_uri || boot.mongoUri)) mongo_uri = String(boot.mongo_uri || boot.mongoUri).trim();
  if (!mongo_db && (boot.mongo_db || boot.mongoDb || boot.dbName)) mongo_db = String(boot.mongo_db || boot.mongoDb || boot.dbName).trim();
  applyTenantConfig(boot);
}

async function ensureMongo() {
  try {
    if (mongoReady && mongoose?.connection?.readyState === 1 && mongoose?.connection?.db) {
      initMongoModelsIfNeeded();
      return true;
    }

    if (globalThis.__asistoTgRuntimeMongoConnectingPromise) {
      const ok = await globalThis.__asistoTgRuntimeMongoConnectingPromise;
      if (ok) initMongoModelsIfNeeded();
      return ok;
    }

    if (!mongo_uri) return false;

    globalThis.__asistoTgRuntimeMongoConnectingPromise = (async () => {
      try {
        await mongoose.connect(mongo_uri, {
          dbName: (mongo_db || tenantId || 'asisto'),
          autoIndex: true,
          serverSelectionTimeoutMS: 15000
        });

        if (!mongoose.connection.db) {
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('mongo_db_not_ready')), 15000);
            mongoose.connection.once('connected', () => {
              clearTimeout(t);
              resolve();
            });
          });
        }

        mongoReady = true;
        initMongoModelsIfNeeded();
        return true;
      } catch (e) {
        try { await mongoose.disconnect(); } catch {}
        mongoReady = false;
        EscribirLog('Mongo connect error: ' + String(e?.message || e), 'error');
        return false;
      } finally {
        globalThis.__asistoTgRuntimeMongoConnectingPromise = null;
      }
    })();

    const ok = await globalThis.__asistoTgRuntimeMongoConnectingPromise;
    if (ok) initMongoModelsIfNeeded();
    return ok;
  } catch (e) {
    mongoReady = false;
    globalThis.__asistoTgRuntimeMongoConnectingPromise = null;
    EscribirLog('ensureMongo error: ' + String(e?.message || e), 'error');
    return false;
  }
}

async function loadTenantConfigFromDbMinimal() {
  try {
    if (!tenantId || !mongo_uri) return null;
    const ok = await ensureMongo();
    if (!ok || !mongoose?.connection?.db) return null;

    const collName = String(process.env.ASISTO_CONFIG_COLLECTION || 'tenant_config').trim() || 'tenant_config';
    const coll = mongoose.connection.db.collection(collName);

    let doc = await coll.findOne({ _id: tenantId });
    if (!doc) doc = await coll.findOne({ tenantId: tenantId });
    if (!doc) return null;

    const conf = (doc && doc.configuracion && typeof doc.configuracion === 'object') ? doc.configuracion : doc;
    tenantConfig = conf;
    applyTenantConfig(conf);
    return conf;
  } catch (e) {
    EscribirLog('loadTenantConfigFromDbMinimal error: ' + String(e?.message || e), 'error');
    return null;
  }
}

async function refreshTenantConfigFromDbPerMessage() {
  try {
    const conf = await loadTenantConfigFromDbMinimal();
    if (conf && typeof conf === 'object') {
      tenantConfig = conf;
      applyTenantConfig(conf);
      return conf;
    }
  } catch (e) {
    EscribirLog('refreshTenantConfigFromDbPerMessage error: ' + String(e?.message || e), 'error');
  }

  if (tenantConfig && typeof tenantConfig === 'object') {
    applyTenantConfig(tenantConfig);
    return tenantConfig;
  }

  return null;
}

function initMongoModelsIfNeeded() {
  try {
    if (!mongoose?.connection?.db) return;

    if (!PolicyModel) {
      const PolicySchema = new mongoose.Schema({
        _id: { type: String },
        tenantid: { type: String },
        tenantId: { type: String, index: true },
        numero: { type: String, index: true },
        disabled: { type: Boolean, default: false }
      }, { collection: 'tg_bot_policies' });
      PolicyModel = mongoose.models.TgBotPolicy || mongoose.model('TgBotPolicy', PolicySchema);
    }

    if (!HistoryModel) {
      const HistorySchema = new mongoose.Schema({
        lockId: { type: String, index: true },
        event: { type: String, index: true },
        host: { type: String },
        pid: { type: Number },
        detail: { type: mongoose.Schema.Types.Mixed },
        at: { type: Date, default: Date.now, index: true }
      }, { collection: 'tg_bot_history' });
      HistoryModel = mongoose.models.TgBotHistory || mongoose.model('TgBotHistory', HistorySchema);
    }

    if (!LockModel) {
      const LockSchema = new mongoose.Schema({
        _id: { type: String },
        tenantId: { type: String },
        tenantid: { type: String, index: true },
        numero: { type: String },
        holderId: { type: String },
        host: { type: String },
        pid: { type: Number },
        state: { type: String },
        startedAt: { type: Date },
        lastSeenAt: { type: Date },
        botId: { type: String },
        botUsername: { type: String }
      }, { collection: 'tg_locks' });
      LockModel = mongoose.models.TgLock || mongoose.model('TgLock', LockSchema);
    }

    if (!ActionModel) {
      const ActionSchema = new mongoose.Schema({
        lockId: { type: String, index: true },
        action: { type: String, index: true },
        reason: { type: String },
        requestedBy: { type: String },
        requestedAt: { type: Date, default: Date.now, index: true },
        consumedAt: { type: Date },
        doneAt: { type: Date, index: true },
        doneBy: { type: String },
        result: { type: String }
      }, { collection: 'tg_bot_actions' });
      ActionModel = mongoose.models.TgBotAction || mongoose.model('TgBotAction', ActionSchema);
    }

    if (!MessageLogModel) {
      const MessageLogSchema = new mongoose.Schema({
        tenantId: { type: String, index: true },
        numero: { type: String, index: true },
        contact: { type: String, index: true },
        direction: { type: String, index: true },
        messageType: { type: String, index: true },
        body: { type: String },
        bodyLength: { type: Number },
        hasMedia: { type: Boolean, default: false },
        at: { type: Date, default: Date.now, index: true },
        atLocal: { type: String },
        dayKey: { type: String, index: true }
      }, { collection: 'tg_bot_message_log' });
      MessageLogModel = mongoose.models.TgBotMessageLog || mongoose.model('TgBotMessageLog', MessageLogSchema);
    }

    if (!ChatRegistryModel) {
      const ChatRegistrySchema = new mongoose.Schema({
        _id: { type: String },
        tenantId: { type: String, index: true },
        numero: { type: String, index: true },
        chatId: { type: String, index: true },
        userId: { type: String, index: true },
        chatType: { type: String },
        username: { type: String },
        firstName: { type: String },
        lastName: { type: String },
        title: { type: String },
        isKnown: { type: Boolean, default: true },
        blocked: { type: Boolean, default: false },
        firstSeenAt: { type: Date, default: Date.now },
        lastSeenAt: { type: Date, default: Date.now }
      }, { collection: 'tg_chat_registry' });
      ChatRegistryModel = mongoose.models.TgChatRegistry || mongoose.model('TgChatRegistry', ChatRegistrySchema);
    }
  } catch (e) {
    EscribirLog('initMongoModelsIfNeeded error: ' + String(e?.message || e), 'error');
  }
}

async function pushHistory(event, detail) {
  try {
    if (!await ensureMongo()) return null;
    if (!HistoryModel || !lockId) return null;
    return await HistoryModel.create({
      lockId,
      event: String(event || ''),
      host: os.hostname(),
      pid: process.pid,
      detail: detail || null,
      at: new Date()
    });
  } catch {
    return null;
  }
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
    for (const p of (parts || [])) {
      if (p && p.type) map[p.type] = p.value;
    }

    const y = map.year || '0000';
    const m = map.month || '00';
    const d = map.day || '00';
    const hh = map.hour || '00';
    const mm = map.minute || '00';
    const ss = map.second || '00';

    return {
      dayKey: `${y}-${m}-${d}`,
      atLocal: `${y}-${m}-${d}T${hh}:${mm}:${ss}`
    };
  } catch {
    const dt = date || new Date();
    const iso = dt.toISOString();
    return { dayKey: iso.slice(0, 10), atLocal: iso.slice(0, 19) };
  }
}

async function logMessageStat(direction, contact, payload) {
  try {
    if (!tenantId || !numero) return;
    if (!await ensureMongo()) return;
    if (!MessageLogModel) return;

    const dir = String(direction || '').trim().toLowerCase();
    if (dir !== 'in' && dir !== 'out') return;

    const now = new Date();
    const parts = arDatePartsForStats(now);

    let messageType = 'text';
    let hasMedia = false;
    let body = '';

    if (typeof payload === 'string') {
      body = payload;
      messageType = 'text';
    } else if (payload && typeof payload === 'object') {
      if (typeof payload.body === 'string') body = payload.body;
      if (typeof payload.caption === 'string' && !body) body = payload.caption;
      if (payload.type) messageType = String(payload.type);
      if (payload.hasMedia === true) hasMedia = true;
      if (payload.mimetype || payload.filename || payload.buffer || payload.base64) hasMedia = true;
      if (!messageType || messageType === 'undefined') messageType = hasMedia ? 'media' : 'text';
    }

    body = String(body || '');
    const cleanContact = String(contact || '').trim();
    if (!cleanContact) return;

    await MessageLogModel.create({
      tenantId: String(tenantId || ''),
      numero: String(numero || ''),
      contact: cleanContact,
      direction: dir,
      messageType: messageType || (hasMedia ? 'media' : 'text'),
      body,
      bodyLength: body.length,
      hasMedia: !!hasMedia,
      at: now,
      atLocal: parts.atLocal,
      dayKey: parts.dayKey
    });
  } catch (e) {
    EscribirLog('logMessageStat error: ' + String(e?.message || e), 'error');
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

function rememberOutgoingStatLogged(messageLike) {
  try {
    const id = getOutgoingStatMessageId(messageLike);
    if (!id) return;
    const now = Date.now();
    recentOutgoingStatIds.set(id, now);
    for (const [k, ts] of recentOutgoingStatIds.entries()) {
      if (!ts || (now - ts) > 10 * 60 * 1000) recentOutgoingStatIds.delete(k);
    }
  } catch {}
}

async function getPolicySafe() {
  try {
    if (!await ensureMongo()) return null;
    if (!PolicyModel) return null;

    if (tenantId && numero) {
      const tid = String(tenantId);
      const num = String(numero);
      const p = await PolicyModel.findOne({
        numero: num,
        $or: [{ tenantId: tid }, { tenantid: tid }]
      }).lean();
      if (p) return p;
    }

    if (lockId) {
      const p2 = await PolicyModel.findById(lockId).lean();
      if (p2) return p2;
    }

    return null;
  } catch {
    return null;
  }
}

async function updateLockStateSafe(state) {
  try {
    localBotState = String(state || localBotState || 'idle');
    if (!lockId) return;
    if (!await ensureMongo()) return;
    if (!LockModel) return;

    const now = new Date();
    await LockModel.updateOne(
      { _id: lockId },
      {
        $set: {
          tenantId,
          tenantid: tenantId,
          numero,
          holderId: instanceId,
          host: os.hostname(),
          pid: process.pid,
          state: localBotState,
          startedAt: lockAcquiredAt || now,
          lastSeenAt: now,
          botId: String(telegram_self_id || ''),
          botUsername: String(telegram_self_username || telegram_bot_username || '')
        }
      },
      { upsert: true }
    );
  } catch (e) {
    EscribirLog('updateLockStateSafe error: ' + String(e?.message || e), 'error');
  }
}

async function getLockDocSafe() {
  try {
    if (await ensureMongo() && LockModel && lockId) {
      const doc = await LockModel.findById(lockId).lean();
      if (doc) return doc;
    }
  } catch {}

  return {
    _id: lockId || `${tenantId}:${numero}`,
    tenantId,
    tenantid: tenantId,
    numero,
    holderId: instanceId,
    host: os.hostname(),
    pid: process.pid,
    state: localBotState,
    startedAt: lockAcquiredAt || null,
    lastSeenAt: new Date(),
    botId: telegram_self_id,
    botUsername: telegram_self_username || telegram_bot_username
  };
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

async function updateChatRegistryFromMessage(msg) {
  try {
    if (!msg || !msg.chat) return;
    if (!await ensureMongo()) return;
    if (!ChatRegistryModel) return;

    const chatId = String(msg.chat.id || '');
    if (!chatId) return;

    const from = msg.from || {};
    const keyId = `${tenantId}:${chatId}`;

    await ChatRegistryModel.updateOne(
      { _id: keyId },
      {
        $setOnInsert: {
          _id: keyId,
          tenantId: String(tenantId || ''),
          numero: String(numero || ''),
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
    EscribirLog('updateChatRegistryFromMessage error: ' + String(e?.message || e), 'error');
  }
}

async function getChatRegistry(chatId) {
  try {
    if (!await ensureMongo()) return null;
    if (!ChatRegistryModel) return null;
    return await ChatRegistryModel.findOne({ _id: `${tenantId}:${String(chatId)}` }).lean();
  } catch {
    return null;
  }
}

function detectMimeType(b64) {
  const token = String(b64 || '').slice(0, 12);
  for (const prefix of Object.keys(signatures)) {
    if (token.startsWith(prefix)) return signatures[prefix];
  }
  return 'application/octet-stream';
}

function buildMediaPayloadFromBase64(base64, filename, caption) {
  const mimetype = detectMimeType(base64);
  const safeName = String(filename || '').trim() || `archivo_${Date.now()}`;
  return {
    type: 'media',
    mimetype,
    filename: safeName,
    caption: String(caption || ''),
    buffer: Buffer.from(String(base64 || ''), 'base64')
  };
}

async function safeSendTelegram(chatId, content, opts = {}) {
  if (!bot) throw new Error('telegram_bot_not_ready');
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
        sent = await bot.sendPhoto(destination, buffer, { caption, disable_notification: false }, fileOptions);
      } else if (mimetype.startsWith('video/')) {
        sent = await bot.sendVideo(destination, buffer, { caption, disable_notification: false }, fileOptions);
      } else {
        sent = await bot.sendDocument(destination, buffer, { caption, disable_notification: false }, fileOptions);
      }

      await logMessageStat('out', destination, {
        body: '',
        caption,
        type: mimetype.startsWith('image/') ? 'photo' : mimetype.startsWith('video/') ? 'video' : 'document',
        mimetype,
        filename,
        hasMedia: true,
        buffer: true
      });
    } else {
      const text = String(content ?? '');
      sent = await bot.sendMessage(destination, text, {
        disable_web_page_preview: true,
        disable_notification: false,
        ...opts
      });

      await logMessageStat('out', destination, {
        body: text,
        type: 'text',
        hasMedia: false
      });
    }

    rememberOutgoingStatLogged(sent);
    return sent;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/bot was blocked by the user|chat not found|forbidden/i.test(msg)) {
      try {
        if (await ensureMongo() && ChatRegistryModel) {
          await ChatRegistryModel.updateOne(
            { _id: `${tenantId}:${String(destination)}` },
            { $set: { blocked: true, lastSeenAt: new Date() } },
            { upsert: true }
          );
        }
      } catch {}
    }
    throw e;
  }
}

async function actualizar_estado_mensaje(baseUrl, estado, tipo, nombre, contacto, direccion, email, idRenglon, idDest) {
  try {
    const params = new URLSearchParams();
    params.set('key', String(key || ''));
    params.set('nro_tel_from', String(telegram_self_id || numero || ''));
    params.set('estado', String(estado || ''));
    if (tipo !== undefined && tipo !== null) params.set('tipo', String(tipo));
    if (nombre !== undefined && nombre !== null) params.set('nombre', String(nombre));
    if (contacto !== undefined && contacto !== null) params.set('contacto', String(contacto));
    if (direccion !== undefined && direccion !== null) params.set('direccion', String(direccion));
    if (email !== undefined && email !== null) params.set('email', String(email));
    if (idRenglon !== undefined && idRenglon !== null) params.set('Id_msj_renglon', String(idRenglon));
    if (idDest !== undefined && idDest !== null) params.set('Id_msj_dest', String(idDest));

    const url = `${baseUrl}?${params.toString()}`;
    const resp = await fetchJson(url, { method: 'GET' });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      EscribirLog('actualizar_estado_mensaje ERROR ' + txt, 'error');
    }
  } catch (e) {
    EscribirLog('actualizar_estado_mensaje error: ' + String(e?.message || e), 'error');
  }
}

function recuperar_json(chatId, json) {
  const indice = indexOf2d(chatId);
  const now = new Date();

  if (indice !== -1) {
    jsonGlobal[indice][0] = chatId;
    jsonGlobal[indice][2] = json;
    jsonGlobal[indice][3] = now;
  } else {
    jsonGlobal.push([chatId, 0, json, now]);
  }
}

function indexOf2d(itemToFind) {
  const normalized = String(itemToFind);
  for (let i = 0; i < jsonGlobal.length; i++) {
    if (String(jsonGlobal[i][0]) === normalized) return i;
  }
  return -1;
}

async function procesar_mensaje(json, message) {
  RecuperarJsonConfMensajes();

  const chatId = String(message.from);
  const indice = indexOf2d(chatId);
  if (indice === -1) return;

  const now = new Date();
  const segundos = Math.random() * (Math.max(seg_hasta, seg_desde) - Math.min(seg_hasta, seg_desde)) + Math.min(seg_hasta, seg_desde);
  const l_json = jsonGlobal[indice][2];
  let tam_json = 0;

  jsonGlobal[indice][3] = now;

  for (const _ of (l_json || [])) {
    tam_json += 1;
  }

  for (let i = jsonGlobal[indice][1]; i < tam_json; i++) {
    let mensaje = '';

    if (l_json[i].cod_error) {
      mensaje = l_json[i].msj_error;
      EscribirLog('Error API en procesar_mensaje()', 'error');
      await EnviarEmail('ChatBot Api error', mensaje);
    } else {
      mensaje = l_json[i].Respuesta;
    }

    if (mensaje === '' || mensaje === null || mensaje === undefined) {
      continue;
    }

    mensaje = String(mensaje).replaceAll('|', '\n');

    if (i <= cant_lim + jsonGlobal[indice][1] - 1) {
      await safeSendTelegram(chatId, mensaje);
      await sleep(segundos);
      if (tam_json - 1 === i) {
        jsonGlobal[indice][1] = 0;
        jsonGlobal[indice][2] = '';
        jsonGlobal[indice][3] = '';
      }
    } else {
      let msg_loc = String(msg_lim || '').replaceAll('|', '\n');
      if (tam_json <= i + cant_lim) {
        msg_loc = msg_loc.replace('<recuento>', String(tam_json - i));
      } else {
        msg_loc = msg_loc.replace('<recuento>', String(cant_lim + 1));
      }
      msg_loc = msg_loc.replace('<recuento_lote>', String(Math.max(tam_json - 2, 0)));
      msg_loc = msg_loc.replace('<recuento_pendiente>', String(Math.max(tam_json - i, 0)));
      if (msg_loc) await safeSendTelegram(chatId, msg_loc);
      jsonGlobal[indice][1] = i;
      jsonGlobal[indice][3] = now;
      return;
    }
  }
}

async function controlar_hora_msg_once() {
  try {
    for (const item of jsonGlobal) {
      if (!item || !item[3]) continue;
      const fecha_msg = item[3].getTime ? item[3].getTime() : 0;
      const diferencia = Date.now() - fecha_msg;

      if (fecha_msg && time_cad > 0 && diferencia > time_cad) {
        if (msg_cad) await safeSendTelegram(item[0], msg_cad);
        item[3] = '';
        item[2] = '';
        item[1] = 0;
      }
    }
  } catch (e) {
    EscribirLog('controlar_hora_msg_once error: ' + String(e?.message || e), 'error');
  }
}

function RecuperarJsonConfMensajes() {
  let jsonError = null;
  try { jsonError = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'configuracion_errores.json'))); } catch {}
  try {
    if (jsonError && jsonError.configuracion) {
      email_err = jsonError.configuracion.email_err;
      msg_errores = jsonError.configuracion.msg_error;
    }
  } catch {}

  if (tenantConfig && typeof tenantConfig === 'object') {
    applyTenantConfig(tenantConfig);
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'configuracion.json')));
    const conf = (raw && raw.configuracion && typeof raw.configuracion === 'object') ? raw.configuracion : raw;
    if (conf && typeof conf === 'object') applyTenantConfig(conf);
  } catch {}
}

async function EnviarEmail(subject, texto) {
  try {
    if (!email_err) return false;
    const jsonError = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'configuracion_errores.json')));
    const cfg = jsonError.configuracion || {};
    if (!cfg.smtp || !cfg.user || !cfg.pass || !cfg.email_sal) return false;

    const transporter = nodemailer.createTransport({
      host: cfg.smtp,
      port: Number(cfg.puerto || 587),
      secure: Number(cfg.puerto || 587) === 465,
      auth: {
        user: cfg.user,
        pass: cfg.pass
      }
    });

    await transporter.sendMail({
      from: cfg.email_sal,
      to: cfg.email_err || email_err,
      subject: String(subject || 'Asisto Telegram'),
      text: String(texto || '')
    });

    return true;
  } catch (e) {
    EscribirLog('EnviarEmail error: ' + String(e?.message || e), 'error');
    return false;
  }
}

async function handleIncomingTelegramMessage(msg) {
  try {
    await refreshTenantConfigFromDbPerMessage();
    RecuperarJsonConfMensajes();
    await updateChatRegistryFromMessage(msg);

    const chatId = String(msg?.chat?.id || '');
    const body = typeof msg?.text === 'string' ? msg.text : '';

    if (!chatId) return;

    const indice_telefono = indexOf2d(chatId);
    const valor_i = indice_telefono === -1 ? 0 : jsonGlobal[indice_telefono][1];

    EscribirLog(`${chatId} ${telegram_self_id} message ${body}`, 'event');

    if (valor_i === 0) {
      if (!body) {
        EscribirLog('mensaje telegram no texto -> ignorado', 'event');
        return;
      }

      const segundos = Math.random() * (Math.max(seg_hasta, seg_desde) - Math.min(seg_hasta, seg_desde)) + Math.min(seg_hasta, seg_desde);
      const telefonoFrom = chatId;
      const telefonoTo = String(telegram_self_id || numero || '');

      try {
        await logMessageStat('in', telefonoFrom, { body, type: 'text', hasMedia: false });
      } catch {}

      if (msg_inicio) {
        await safeSendTelegram(chatId, msg_inicio);
      }

      const jsonTexto = {
        Tel_Origen: telefonoFrom,
        Tel_Destino: telefonoTo,
        Mensaje: body,
        Respuesta: ''
      };

      EscribirLog('Mensaje ' + JSON.stringify(jsonTexto), 'event');

      let timeoutId;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), 55000);

        const resp = await fetchJson(api, {
          method: 'POST',
          body: JSON.stringify(jsonTexto),
          headers: { 'Content-type': 'application/json; charset=UTF-8' },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        const raw = await resp.text();
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}

        if (!resp.ok) {
          const detalle = json ? JSON.stringify(json) : raw;
          EscribirLog('Error ApiTelegram - Response ERROR ' + detalle, 'error');
          await EnviarEmail('ApiTelegram - Response ERROR', detalle);
          if (msg_errores) await safeSendTelegram(chatId, msg_errores);
          return 'error';
        }

        recuperar_json(chatId, json);
        await procesar_mensaje(json, { from: chatId, body });

        if (msg_fin) {
          await safeSendTelegram(chatId, msg_fin);
        }

        await sleep(segundos);
        return 'ok';
      } catch (err) {
        clearTimeout(timeoutId);
        const detalle = 'Error Chatbot Telegram ' + (err?.message || err) + ' ' + JSON.stringify(jsonTexto);
        EscribirLog(detalle, 'error');
        await EnviarEmail('Chatbot Telegram Error', detalle);
        if (msg_errores) await safeSendTelegram(chatId, msg_errores);
        return 'error';
      }
    }

    const bodyUpper = String(body || '').trim().toUpperCase();

    if (valor_i !== 0 && bodyUpper === 'N') {
      if (msg_can) await safeSendTelegram(chatId, msg_can);
      jsonGlobal[indice_telefono][2] = '';
      jsonGlobal[indice_telefono][1] = 0;
      jsonGlobal[indice_telefono][3] = '';
      return;
    }

    if (valor_i !== 0 && bodyUpper !== 'N' && bodyUpper !== 'S') {
      await safeSendTelegram(chatId, '🤔 *No entiendo*,\nPor favor ingrese *S* o *N* para mostrar los siguientes resultados\n', { parse_mode: 'Markdown' });
      return;
    }

    if (valor_i !== 0 && bodyUpper === 'S') {
      await procesar_mensaje(jsonGlobal[indice_telefono][2], { from: chatId, body });
    }
  } catch (e) {
    EscribirLog('handleIncomingTelegramMessage error: ' + String(e?.message || e), 'error');
  }
}

function attachBotHandlers() {
  if (!bot) return;

  bot.on('message', async (msg) => {
    await handleIncomingTelegramMessage(msg);
  });

  bot.on('polling_error', async (err) => {
    EscribirLog('Telegram polling_error: ' + String(err?.message || err), 'error');
    await updateLockStateSafe('polling_error');
  });

  bot.on('webhook_error', async (err) => {
    EscribirLog('Telegram webhook_error: ' + String(err?.message || err), 'error');
    await updateLockStateSafe('webhook_error');
  });
}

async function createBotIfNeeded() {
  if (bot) return bot;
  if (!telegram_bot_token) throw new Error('telegram_bot_token_missing');

  bot = new TelegramBot(telegram_bot_token, {
    polling: {
      autoStart: false,
      interval: 300,
      params: {
        timeout: 10,
        allowed_updates: ['message']
      }
    }
  });

  attachBotHandlers();
  return bot;
}

async function startBotInitialize() {
  if (botStarted) return;
  if (!isOwner) return;
  if (startingNow) return;

  const pol = await getPolicySafe();
  if (pol && pol.disabled === true) {
    await updateLockStateSafe('disabled');
    await pushHistory('policy_disabled', { by: 'policy', disabled: true });
    return;
  }

  startingNow = true;

  try {
    await createBotIfNeeded();
    const me = await bot.getMe();
    telegram_self_id = String(me?.id || '');
    telegram_self_username = String(me?.username || telegram_bot_username || '');
    await bot.startPolling({ restart: true });
    botStarted = true;
    await updateLockStateSafe('online');
    EscribirLog('Telegram listo!', 'event');
    startOutboundPoller();
    startExpiryPoller();
  } catch (e) {
    botStarted = false;
    EscribirLog('Error al inicializar Telegram: ' + String(e?.message || e), 'error');
    try {
      if (bot && typeof bot.stopPolling === 'function') await bot.stopPolling({ cancel: true });
    } catch {}
    bot = null;
  } finally {
    startingNow = false;
  }
}

async function heartbeatTick() {
  try {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    if (!isOwner || !lockId) return;

    await updateLockStateSafe(localBotState || 'online');

    const pol = await getPolicySafe();
    const disabled = !!(pol && pol.disabled === true);
    if (disabled) {
      await releaseBotOwnership('disabled');
      return;
    }

    if (isOwner && !botStarted && !startingNow) {
      await startBotInitialize();
    }
  } catch (e) {
    EscribirLog('heartbeatTick error: ' + String(e?.message || e), 'error');
  } finally {
    heartbeatBusy = false;
  }
}

function startHeartbeat() {
  try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch {}
  heartbeatTick().catch(() => {});
  heartbeatTimer = setInterval(() => { heartbeatTick().catch(() => {}); }, 5000);
}

async function forceReleaseLock(finalState) {
  const st = String(finalState || 'offline');
  try {
    if (!await ensureMongo()) return;
    if (!lockId || !LockModel) return;
    await LockModel.updateOne(
      { _id: lockId },
      {
        $set: {
          tenantId,
          tenantid: tenantId,
          numero,
          holderId: instanceId,
          host: os.hostname(),
          pid: process.pid,
          state: st,
          lastSeenAt: new Date(),
          releasedAt: new Date(),
          releasedBy: instanceId,
          botId: String(telegram_self_id || ''),
          botUsername: String(telegram_self_username || telegram_bot_username || '')
        }
      },
      { upsert: true }
    );
  } catch (e) {
    EscribirLog('forceReleaseLock error: ' + String(e?.message || e), 'error');
  }
}

async function releaseBotOwnership(finalState) {
  try {
    try { if (outboundTimer) { clearTimeout(outboundTimer); outboundTimer = null; } } catch {}
    try { if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; } } catch {}
    if (bot && typeof bot.stopPolling === 'function') {
      try { await bot.stopPolling({ cancel: true, reason: 'release' }); } catch {}
    }
    bot = null;
    botStarted = false;
    localBotState = String(finalState || 'offline');
    await updateLockStateSafe(localBotState);
    await forceReleaseLock(localBotState);
    isOwner = false;
  } catch (e) {
    EscribirLog('releaseBotOwnership error: ' + String(e?.message || e), 'error');
  }
}

async function handleActionDoc(doc) {
  const action = String(doc?.action || '').toLowerCase();
  const reason = String(doc?.reason || '');

  try {
    if (action === 'restart') {
      EscribirLog('Accion RESTART recibida: ' + reason, 'event');
      await releaseBotOwnership('restarting');
      isOwner = true;
      lockAcquiredAt = new Date();
      await startBotInitialize();
      return 'restarted';
    }

    if (action === 'release') {
      EscribirLog('Accion RELEASE recibida: ' + reason, 'event');
      await releaseBotOwnership('offline');
      return 'released';
    }

    if (action === 'resetauth') {
      EscribirLog('Accion RESET AUTH recibida: ' + reason, 'event');
      await releaseBotOwnership('offline');
      isOwner = true;
      lockAcquiredAt = new Date();
      await startBotInitialize();
      return 'restarted_no_qr';
    }

    return 'ignored';
  } catch (e) {
    EscribirLog('Error manejando accion ' + action + ': ' + String(e?.message || e), 'error');
    return 'error';
  }
}

async function pollActionsOnce() {
  if (actionBusy || !isOwner || !lockId) return;
  if (!await ensureMongo()) return;
  if (!ActionModel) return;

  actionBusy = true;
  try {
    const doc = await ActionModel.findOneAndUpdate(
      { lockId, doneAt: { $exists: false } },
      { $set: { doneAt: new Date(), doneBy: instanceId } },
      { sort: { requestedAt: 1 }, returnDocument: 'after' }
    ).lean();

    if (!doc) return;

    try {
      const reqAt = doc.requestedAt ? new Date(doc.requestedAt) : null;
      if (lockAcquiredAt && reqAt && reqAt.getTime() < lockAcquiredAt.getTime()) {
        await ActionModel.updateOne({ _id: doc._id }, { $set: { result: 'stale_ignored' } });
        return;
      }
    } catch {}

    const result = await handleActionDoc(doc);
    await ActionModel.updateOne({ _id: doc._id }, { $set: { result } });
  } catch (e) {
    EscribirLog('pollActionsOnce error: ' + String(e?.message || e), 'error');
  } finally {
    actionBusy = false;
  }
}

function startActionPoller() {
  try { if (actionTimer) clearInterval(actionTimer); } catch {}
  actionTimer = setInterval(() => { pollActionsOnce().catch(() => {}); }, 4000);
}

async function ConsultaApiMensajes() {
  if (outboundBusy) return;
  outboundBusy = true;

  try {
    if (!botStarted || !bot) return;
    const botFrom = String(telegram_self_id || numero || '');
    if (!botFrom) return;

    const url = `${api2}?key=${encodeURIComponent(key)}&nro_tel_from=${encodeURIComponent(botFrom)}`;
    const url_confirma_msg = `${api3}`;

    RecuperarJsonConfMensajes();
    const resp = await fetchJson(url, { method: 'GET' });
    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      EscribirLog('ConsultaApiMensajes resp error: ' + raw, 'error');
      return;
    }

    const json = await resp.json();
    if (!Array.isArray(json) || !json[0]) return;

    const mensajes = Array.isArray(json[0].mensajes) ? json[0].mensajes : [];
    const destinatarios = Array.isArray(json[0].destinatarios) ? json[0].destinatarios : [];

    for (let i = 0; i < destinatarios.length; i++) {
      const destinatario = destinatarios[i] || {};
      const idRenglon = destinatario.Id_msj_renglon;
      const idDest = destinatario.Id_msj_dest;
      const nro_tel = String(destinatario.Nro_tel || '').trim();
      const respuestas = mensajes.filter((element) => String(element.Id_msj_renglon) === String(idRenglon));

      for (let j = 0; j < respuestas.length; j++) {
        const respuesta = respuestas[j] || {};
        const chatId = normalizeChatId(nro_tel);
        const Msj = respuesta.Msj == null ? '' : String(respuesta.Msj);
        const contenido = respuesta.Content;
        const Content_nombre = respuesta.Content_nombre || 'archivo';

        if (chatId === '' || chatId === null) {
          await actualizar_estado_mensaje(url_confirma_msg, 'I', null, null, null, null, null, idRenglon, idDest);
          continue;
        }

        const chatData = await getChatRegistry(String(chatId));
        if (!chatData) {
          EscribirLog('Telegram destino no conocido: ' + String(chatId), 'event');
          await actualizar_estado_mensaje(url_confirma_msg, 'I', null, null, null, null, null, idRenglon, idDest);
          continue;
        }

        try {
          if (contenido != null && contenido !== '') {
            const mediaPayload = buildMediaPayloadFromBase64(contenido, Content_nombre, Msj);
            await safeSendTelegram(chatId, mediaPayload, { caption: Msj });
          } else {
            await safeSendTelegram(chatId, Msj);
          }

          const contacto = [chatData.firstName, chatData.lastName].filter(Boolean).join(' ').trim() || chatData.title || chatData.username || '';
          const tipo = chatData.chatType === 'private' ? 'C' : 'B';
          const nombre = contacto || chatData.username || '';
          const direccion = chatData.chatType;
          const email = '';

          await actualizar_estado_mensaje(url_confirma_msg, 'E', tipo, nombre, contacto, direccion, email, idRenglon, idDest);
          seg_msg = Math.random() * (Math.max(seg_hasta, seg_desde) - Math.min(seg_hasta, seg_desde)) + Math.min(seg_hasta, seg_desde);
          await sleep(seg_msg);
        } catch (e) {
          EscribirLog('Error enviando cola Telegram: ' + String(e?.message || e), 'error');
          await actualizar_estado_mensaje(url_confirma_msg, 'I', null, null, null, null, null, idRenglon, idDest);
        }
      }
    }
  } catch (e) {
    EscribirLog('ConsultaApiMensajes error: ' + String(e?.message || e), 'error');
  } finally {
    outboundBusy = false;
  }
}

function scheduleOutboundPoller() {
  try { if (outboundTimer) clearTimeout(outboundTimer); } catch {}
  outboundTimer = setTimeout(async () => {
    try {
      await refreshTenantConfigFromDbPerMessage();
      await ConsultaApiMensajes();
    } catch (e) {
      EscribirLog('scheduleOutboundPoller tick error: ' + String(e?.message || e), 'error');
    } finally {
      if (!shuttingDown && isOwner) scheduleOutboundPoller();
    }
  }, Math.max(1000, Number(seg_tele) || 3000));
}

function startOutboundPoller() {
  scheduleOutboundPoller();
}

function startExpiryPoller() {
  try { if (expiryTimer) clearInterval(expiryTimer); } catch {}
  expiryTimer = setInterval(() => {
    controlar_hora_msg_once().catch(() => {});
  }, 5000);
}

async function bootstrapWithLock() {
  try {
    lockId = `${tenantId}:${numero || 'telegram'}`;
    isOwner = true;
    if (!lockAcquiredAt) lockAcquiredAt = new Date();

    await updateLockStateSafe('starting');
    startHeartbeat();
    startActionPoller();

    EscribirLog('Inicio directo Telegram -> inicializando bot...', 'event');
    await startBotInitialize();
    return true;
  } catch (e) {
    EscribirLog('bootstrap directo Telegram error: ' + String(e?.message || e), 'error');
    return false;
  }
}

async function getTelegramStatus() {
  const lock = await getLockDocSafe();
  return {
    ok: true,
    now: nowArgentinaISO(),
    tenantId,
    numero,
    instanceId,
    lockId,
    isOwner,
    runtimeStarted,
    botStarted,
    botState: localBotState,
    telegramBotUsername: telegram_self_username || telegram_bot_username,
    telegramBotId: telegram_self_id,
    lock
  };
}

async function startTelegramRuntime() {
  if (runtimeStarted) return getTelegramStatus();

  shuttingDown = false;
  RecuperarJsonConf();
  if (tenantId) tenantId = String(tenantId).trim().toUpperCase();
  if (!mongo_db) mongo_db = 'Cluster0';
  await loadTenantConfigFromDbMinimal();

  if (!tenantId || !mongo_uri) {
    throw new Error('Falta tenantId/mongo_uri en configuracion.json o variables');
  }

  if (!telegram_bot_token) {
    localBotState = 'disabled';
    EscribirLog('Telegram runtime omitido: falta telegram_bot_token en tenant_config/env.', 'event');
    runtimeStarted = true;
    return getTelegramStatus();
  }

  await bootstrapWithLock();
  runtimeStarted = true;
  return getTelegramStatus();
}

async function stopTelegramRuntime(signal = 'STOP') {
  shuttingDown = true;
  runtimeStarted = false;
  try { EscribirLog('[SHUTDOWN] ' + signal + ' -> cerrando Telegram...', 'event'); } catch {}
  try { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } } catch {}
  try { if (actionTimer) { clearInterval(actionTimer); actionTimer = null; } } catch {}
  try { if (outboundTimer) { clearTimeout(outboundTimer); outboundTimer = null; } } catch {}
  try { if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; } } catch {}
  try { await releaseBotOwnership('offline'); } catch {}
}

function mountTelegramRoutes(app) {
  if (!app || routesMounted) return;
  routesMounted = true;

  app.get('/api/tg/status', auth.requireAdmin, async (_req, res) => {
    try {
      const status = await getTelegramStatus();
      return res.json(status);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get('/api/tg/chats', auth.requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 500));
      if (!await ensureMongo() || !ChatRegistryModel) {
        return res.json({ ok: true, items: [] });
      }

      const tenantFilter = String(req.user?.role || '').toLowerCase() === 'superadmin'
        ? (String(req.query.tenantId || tenantId || '').trim() ? { tenantId: String(req.query.tenantId || tenantId || '').trim() } : {})
        : { tenantId: String(req.user?.tenantId || tenantId || '').trim() };

      const items = await ChatRegistryModel.find(tenantFilter).sort({ lastSeenAt: -1 }).limit(limit).lean();
      return res.json({ ok: true, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/tg/release', auth.requireAdmin, async (_req, res) => {
    try {
      await stopTelegramRuntime('ADMIN_RELEASE');
      return res.json({ ok: true, released: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/tg/start', auth.requireAdmin, async (_req, res) => {
    try {
      const status = await startTelegramRuntime();
      return res.json(status);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
}

module.exports = {
  startTelegramRuntime,
  stopTelegramRuntime,
  mountTelegramRoutes,
  getTelegramStatus,
};
