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

function contextSignature(cfg) {
  return JSON.stringify({
    token: cfg.telegram_bot_token,
    username: cfg.telegram_bot_username,
    numero: cfg.numero,
    api: cfg.api,
    api2: cfg.api2,
    api3: cfg.api3,
    key: cfg.key,
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

async function updateLockState(ctx, state) {
  try {
    ctx.botState = normalizeString(state, ctx.botState || 'idle');
    ctx.lastSeenAt = new Date();
    const db = await getDb();
    await db.collection('tg_locks').updateOne(
      { _id: ctx.lockId },
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
      { upsert: true }
    );
  } catch (e) {
    logLine(`[${ctx.tenantId}] updateLockState error: ${e?.message || e}`, 'error');
  }
}

async function forceReleaseLock(ctx, finalState = 'offline') {
  try {
    const db = await getDb();
    await db.collection('tg_locks').updateOne(
      { _id: ctx.lockId },
      {
        $set: {
          tenantId: ctx.tenantId,
          tenantid: ctx.tenantId,
          numero: ctx.numero,
          holderId: instanceId,
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
      { upsert: true }
    );
  } catch (e) {
    logLine(`[${ctx.tenantId}] forceReleaseLock error: ${e?.message || e}`, 'error');
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
    params.set('nro_tel_from', String(ctx.telegramSelfId || ctx.numero || ''));
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

      const segDesde = Math.min(Number(ctx.config.seg_desde) || 0, Number(ctx.config.seg_hasta) || 0);
      const segHasta = Math.max(Number(ctx.config.seg_desde) || 0, Number(ctx.config.seg_hasta) || 0);
      const segundos = Math.random() * (segHasta - segDesde) + segDesde;
      const telefonoFrom = chatId;
      const telefonoTo = String(ctx.telegramSelfId || ctx.numero || '');
      await logMessageStat(ctx, 'in', telefonoFrom, { body, type: 'text', hasMedia: false });

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
    logLine(`[${ctx.tenantId}] Telegram polling_error: ${err?.message || err}`, 'error');
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
  try {
    if (ctx.bot && typeof ctx.bot.stopPolling === 'function') {
      await ctx.bot.stopPolling({ cancel: true, reason });
    }
  } catch {}
  ctx.bot = null;
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
    await updateLockState(ctx, ctx.botState || 'online');
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
    const botFrom = String(ctx.telegramSelfId || ctx.numero || '');
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
    await updateLockState(ctx, 'disabled');
    await pushHistory(ctx, 'policy_disabled', { by: 'policy', disabled: true });
    return getContextStatus(ctx);
  }

  ctx.startingNow = true;
  ctx.shuttingDown = false;
  try {
    ctx.lockAcquiredAt = ctx.lockAcquiredAt || new Date();
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
    try { if (ctx.bot && typeof ctx.bot.stopPolling === 'function') await ctx.bot.stopPolling({ cancel: true }); } catch {}
    ctx.bot = null;
    await updateLockState(ctx, 'error');
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

  const prevSig = contextSignature(existing.config);
  const nextSig = contextSignature(cfg);
  existing.config = { ...existing.config, ...cfg, ...getErrorConfig() };
  existing.numero = existing.config.numero;
  existing.statusToken = existing.config.status_token || existing.statusToken || '';
  existing.lockId = `${existing.tenantId}:${existing.numero || 'telegram'}`;

  if (prevSig !== nextSig) {
    logLine(`[${cfg.tenantId}] cambio de configuración Telegram detectado -> reiniciando bot`, 'event');
    await stopContext(existing, 'reconfiguring');
    existing.lockAcquiredAt = new Date();
    existing.botState = 'idle';
    existing.telegramSelfId = '';
    existing.telegramSelfUsername = '';
    await startContext(existing);
  } else if (!existing.botStarted && !existing.startingNow) {
    await startContext(existing);
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


function telegramAdminEmbedPage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Sesiones Telegram · Asisto</title>
  <style>
    :root{--bg:#f8fafc;--card:#ffffff;--text:#0f172a;--muted:#64748b;--border:rgba(148,163,184,.24);--primary:#0e6b66;--danger:#b42318;--shadow:0 14px 36px rgba(15,23,42,.10);--radius:18px}
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--text)}
    .page{padding:16px}.toolbar{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px}.toolbar h1{margin:0 0 4px;font-size:24px}
    .small{font-size:12px;color:var(--muted)}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid var(--border);background:#fff;border-radius:12px;padding:10px 14px;font-weight:700;cursor:pointer}.btnDanger{color:var(--danger)}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:14px}.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow)}
    .metric{font-size:28px;font-weight:800;line-height:1}.metricLabel{font-size:12px;color:var(--muted);margin-top:6px}
    .filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}.filters label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)}
    .inp{min-width:220px;border:1px solid var(--border);border-radius:12px;padding:10px 12px;background:#fff;color:var(--text)}
    .layout{display:grid;grid-template-columns:1.25fr .95fr;gap:14px}.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
    .panelHead{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border)}.panelHead h2{margin:0;font-size:16px}
    .tableWrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:12px 14px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top;font-size:13px}
    th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;background:#fff;position:sticky;top:0}.tenantName{font-weight:800}
    .statusPill,.chatPill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--border);font-size:11px;font-weight:700;background:#fff}
    .statusPill.is-on{background:rgba(14,107,102,.08);color:var(--primary);border-color:rgba(14,107,102,.18)}.statusPill.is-off{background:rgba(148,163,184,.08);color:#475569}
    .rowActions{display:flex;gap:8px;flex-wrap:wrap}.rowActions .btn{padding:8px 10px;border-radius:10px;font-size:12px}
    .msg{margin-bottom:12px;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:#fff;font-size:13px}.msg.err{border-color:rgba(240,68,56,.25);background:rgba(240,68,56,.08);color:#991b1b}.msg.ok{border-color:rgba(14,107,102,.22);background:rgba(14,107,102,.08);color:#0f5132}
    .empty{padding:18px;color:var(--muted);font-size:13px}code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px}
    @media (max-width: 980px){ .layout{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <div class="page">
    <div class="toolbar"><div><h1>Sesiones Telegram</h1><div class="small">Monitoreo multi-tenant de bots, chats registrados y acciones operativas.</div></div><div class="actions"><button class="btn" id="tgReloadBtn" type="button">Recargar bots</button><button class="btn" id="tgRefreshBtn" type="button">Actualizar vista</button></div></div>
    <div id="tgMsg"></div>
    <div class="cards"><div class="card"><div class="metric" id="tgMetricTotal">0</div><div class="metricLabel">Bots configurados</div></div><div class="card"><div class="metric" id="tgMetricStarted">0</div><div class="metricLabel">Bots iniciados</div></div><div class="card"><div class="metric" id="tgMetricChats">0</div><div class="metricLabel">Chats conocidos</div></div><div class="card"><div class="metric" id="tgMetricBlocked">0</div><div class="metricLabel">Chats bloqueados</div></div></div>
    <div class="filters"><label>Buscar tenant / bot / chat<input class="inp" id="tgSearch" type="search" placeholder="Ej: CARICO, @bot, 549..." /></label><label>Estado<select class="inp" id="tgStateFilter"><option value="">Todos</option><option value="started">Iniciados</option><option value="stopped">Detenidos</option><option value="disabled">Deshabilitados</option></select></label></div>
    <div class="layout">
      <section class="panel"><div class="panelHead"><div><h2>Bots por tenant</h2><div class="small" id="tgStatusMeta">Sin datos todavía.</div></div></div><div class="tableWrap"><table><thead><tr><th>Tenant</th><th>Bot</th><th>Estado</th><th>Chats</th><th>Última actividad</th><th>Acciones</th></tr></thead><tbody id="tgBody"></tbody></table></div></section>
      <section class="panel"><div class="panelHead"><div><h2>Chats registrados</h2><div class="small">Últimos chats conocidos por los bots visibles.</div></div></div><div id="tgChats" class="tableWrap"></div></section>
    </div>
  </div>
  <script>
    (function(){
      const msgEl=document.getElementById('tgMsg'), totalEl=document.getElementById('tgMetricTotal'), startedEl=document.getElementById('tgMetricStarted'), chatsEl=document.getElementById('tgMetricChats'), blockedEl=document.getElementById('tgMetricBlocked'), bodyEl=document.getElementById('tgBody'), chatsWrap=document.getElementById('tgChats'), metaEl=document.getElementById('tgStatusMeta'), searchEl=document.getElementById('tgSearch'), stateEl=document.getElementById('tgStateFilter'), reloadBtn=document.getElementById('tgReloadBtn'), refreshBtn=document.getElementById('tgRefreshBtn');
      let state={items:[],chats:[]};
      const esc=(v)=>String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
      async function api(url, opts){ const res=await fetch(url, Object.assign({credentials:'same-origin',headers:{'Content-Type':'application/json'}}, opts||{})); let data=null; try{data=await res.json();}catch{} if(!res.ok) throw new Error((data&&(data.error||data.message))||('HTTP '+res.status)); return data||{}; }
      function setMsg(kind, text){ if(!text){ msgEl.innerHTML=''; return; } msgEl.innerHTML='<div class="msg '+(kind==='err'?'err':'ok')+'">'+esc(text)+'</div>'; }
      function statusPill(item){ const cls=item.botStarted?'statusPill is-on':'statusPill is-off'; const label=item.botStarted?(item.botState||'started'):(item.botState||'stopped'); return '<span class="'+cls+'">'+esc(label)+'</span>'; }
      function rowMatches(item,q,filter){ const hay=[item.tenantId,item.numero,item.telegramBotUsername,item.telegramBotId,item.botState,item.lastSeenAt].join(' ').toLowerCase(); if(q && !hay.includes(q)) return false; if(filter==='started' && !item.botStarted) return false; if(filter==='stopped' && item.botStarted) return false; if(filter==='disabled' && String(item.botState||'').toLowerCase()!=='disabled') return false; return true; }
      function render(){
        const q=String(searchEl.value||'').trim().toLowerCase(), filter=String(stateEl.value||'').trim();
        const items=(state.items||[]).filter((item)=>rowMatches(item,q,filter));
        const chats=(state.chats||[]).filter((chat)=>{ const hay=[chat.tenantId,chat.numero,chat.chatId,chat.username,chat.firstName,chat.lastName,chat.title,chat.chatType].join(' ').toLowerCase(); return !q || hay.includes(q); });
        totalEl.textContent=String(state.items.length||0); startedEl.textContent=String((state.items||[]).filter((x)=>x.botStarted).length||0); chatsEl.textContent=String((state.chats||[]).length||0); blockedEl.textContent=String((state.chats||[]).filter((x)=>x.blocked).length||0);
        metaEl.textContent=items.length?('Mostrando '+items.length+' bot'+(items.length===1?'':'s')+' · actualizado '+new Date().toLocaleString('es-AR')):'Sin bots visibles para el filtro actual.';
        bodyEl.innerHTML=!items.length?'<tr><td colspan="6" class="empty">No hay bots visibles con el filtro actual.</td></tr>':items.map((item)=>{ const knownChats=Number(item.knownChats||0); const botLabel=item.telegramBotUsername?('@'+String(item.telegramBotUsername).replace(/^@+/,'')):'Sin username'; const lastSeen=item.lastSeenAt?new Date(item.lastSeenAt).toLocaleString('es-AR'):'-'; return '<tr>'+'<td><div class="tenantName">'+esc(item.tenantId)+'</div><div class="small">'+esc(item.numero||'-')+'</div></td>'+'<td><div>'+esc(botLabel)+'</div><div class="small"><code>'+esc(item.telegramBotId||'-')+'</code></div></td>'+'<td>'+statusPill(item)+'</td>'+'<td><span class="chatPill">'+esc(String(knownChats))+' chats</span></td>'+'<td><div>'+esc(lastSeen)+'</div></td>'+'<td><div class="rowActions"><button class="btn" type="button" data-action="start" data-tenant="'+esc(item.tenantId)+'">Iniciar</button><button class="btn btnDanger" type="button" data-action="release" data-tenant="'+esc(item.tenantId)+'">Detener</button></div></td>'+'</tr>'; }).join('');
        chatsWrap.innerHTML=!chats.length?'<div class="empty">No hay chats registrados.</div>':'<table><thead><tr><th>Tenant</th><th>Chat</th><th>Usuario</th><th>Tipo</th><th>Última vez</th></tr></thead><tbody>'+chats.slice(0,200).map((chat)=>{ const displayName=[chat.firstName,chat.lastName].filter(Boolean).join(' ').trim()||chat.title||chat.username||'-'; return '<tr>'+'<td><div class="tenantName">'+esc(chat.tenantId)+'</div><div class="small">'+esc(chat.numero||'-')+'</div></td>'+'<td><div><code>'+esc(chat.chatId||'-')+'</code></div>'+(chat.blocked?'<div class="small" style="color:#b42318">Bloqueado</div>':'')+'</td>'+'<td><div>'+esc(displayName)+'</div><div class="small">'+esc(chat.username?('@'+String(chat.username).replace(/^@+/,'')):'-')+'</div></td>'+'<td>'+esc(chat.chatType||'-')+'</td>'+'<td>'+esc(chat.lastSeenAt?new Date(chat.lastSeenAt).toLocaleString('es-AR'):'-')+'</td>'+'</tr>'; }).join('')+'</tbody></table>';
      }
      async function load(){ setMsg('',''); const [statusRes, chatsRes]=await Promise.all([api('/api/tg/status'), api('/api/tg/chats')]); state.items=Array.isArray(statusRes.items)?statusRes.items:[]; state.chats=Array.isArray(chatsRes.items)?chatsRes.items:[]; render(); }
      async function runAction(action, tenantId){ try{ setMsg('',''); const url=action==='start'?'/api/tg/start':'/api/tg/release'; await api(url,{method:'POST',body:JSON.stringify({tenantId})}); await load(); setMsg('ok',(action==='start'?'Bot iniciado':'Bot detenido')+' para '+tenantId+'.'); }catch(e){ setMsg('err', e.message||String(e)); } }
      reloadBtn.addEventListener('click', async ()=>{ try{ setMsg('',''); await api('/api/tg/reload',{method:'POST',body:'{}'}); await load(); setMsg('ok','Bots recargados desde tenant_config.'); }catch(e){ setMsg('err', e.message||String(e)); } });
      refreshBtn.addEventListener('click', ()=>{ load().catch((e)=>setMsg('err', e.message||String(e))); });
      searchEl.addEventListener('input', render); stateEl.addEventListener('change', render);
      bodyEl.addEventListener('click', (ev)=>{ const btn=ev.target.closest('button[data-action]'); if(!btn) return; runAction(btn.getAttribute('data-action'), btn.getAttribute('data-tenant')); });
      load().catch((e)=>setMsg('err', e.message||String(e)));
    })();
  </script>
</body>
</html>`;
}



function mountTelegramRoutes(app) {
  if (manager.routesMounted) return;
  manager.routesMounted = true;

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
