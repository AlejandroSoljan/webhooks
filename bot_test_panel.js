// Asisto | Version: 5.00.001 | Fecha: 2026-08-29
// bot_test_panel.js
// Simulador interno del bot Asisto.
// - Permite probar conversaciones sin WhatsApp, QR ni teléfono conectado.
// - Reutiliza getGPTReply() para usar el mismo comportamiento del dominio.
// - No muestra datos técnicos del modelo/configuración al usuario.
// - No crea conversaciones, mensajes, pedidos ni leads reales en Mongo.

const crypto = require('crypto');
const express = require('express');
const { getDb } = require('./db');
const {
  getGPTReply,
  loadBehaviorConfigFromMongo,
  normalizeBotMode,
  markSessionEnded,
  clearEndedFlag,
} = require('./logic');

const DEFAULT_TENANT_ID = String(process.env.TENANT_ID || 'default').trim() || 'default';
const MAX_MESSAGE_CHARS = 10000;
const BOT_TEST_VERSION = '2026-08-14-v2';
const botTestJson = express.json({ limit: '1mb' });

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cleanString(value, max = 500) {
  return String(value ?? '').trim().slice(0, Math.max(1, Number(max) || 500));
}

function isSuperAdmin(req) {
  return String(req?.user?.role || '').toLowerCase() === 'superadmin';
}

function resolveTenant(req, auth) {
  if (auth && typeof auth.resolveTenantId === 'function') {
    return auth.resolveTenantId(req, {
      defaultTenantId: DEFAULT_TENANT_ID,
      envTenantId: process.env.TENANT_ID,
    });
  }
  const role = String(req?.user?.role || '').toLowerCase();
  const userTenant = String(req?.user?.tenantId || '').trim();
  if (role !== 'superadmin' && userTenant) return userTenant;
  return String(req?.query?.tenant || req?.headers?.['x-tenant-id'] || userTenant || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
}

function safeSessionId(value) {
  const raw = String(value || '').trim();
  if (/^[a-zA-Z0-9_-]{8,96}$/.test(raw)) return raw;
  return crypto.randomBytes(18).toString('hex');
}

function testSessionFrom(req, tenant, sessionId) {
  const uid = cleanString(req?.user?.uid || req?.user?.username || 'user', 80).replace(/[^a-zA-Z0-9_-]/g, '_');
  const t = cleanString(tenant, 80).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `__asisto_bot_test__:${t}:${uid}:${safeSessionId(sessionId)}`;
}

async function loadAvailableTenants(db, currentTenant) {
  const tenants = new Set();
  const add = value => {
    const v = String(value || '').trim();
    if (v && !v.startsWith('__')) tenants.add(v);
  };
  add(currentTenant);
  const results = await Promise.allSettled([
    db.collection('tenant_config').find({}, { projection: { _id: 1, tenantId: 1, tenantid: 1 } }).limit(2000).toArray(),
    db.collection('users').distinct('tenantId'),
    db.collection('tenant_channels').distinct('tenantId'),
    db.collection('conversations').distinct('tenantId'),
  ]);
  if (results[0].status === 'fulfilled') {
    for (const doc of results[0].value || []) {
      add(doc?._id);
      add(doc?.tenantId);
      add(doc?.tenantid);
    }
  }
  for (let i = 1; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    for (const value of results[i].value || []) add(value);
  }
  return Array.from(tenants).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true }));
}

async function resolveTestRuntime(db, tenant) {
  const channels = await db.collection('tenant_channels')
    .find({ tenantId: tenant })
    .sort({ isDefault: -1, updatedAt: -1, createdAt: -1 })
    .limit(200)
    .toArray()
    .catch(() => []);

  const channel = channels.find(c => c?.isDefault === true && String(c?.openaiApiKey || '').trim())
    || channels.find(c => String(c?.openaiApiKey || '').trim())
    || channels.find(c => c?.isDefault === true)
    || channels[0]
    || null;

  return {
    apiKey: String(channel?.openaiApiKey || process.env.OPENAI_API_KEY || '').trim(),
  };
}

function parseReply(raw) {
  const text = String(raw || '').trim();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  if (payload && typeof payload === 'object') {
    const response = String(payload.response || '').trim();
    if (response) return response;
  }
  return text || 'El bot no devolvió una respuesta para mostrar.';
}

function errorText(err) {
  return cleanString(
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.response?.data?.error ||
    err?.message ||
    err,
    1200
  );
}

function isUnsupportedTemperatureError(err) {
  const s = errorText(err).toLowerCase();
  return s.includes('temperature') && (
    s.includes('unsupported') ||
    s.includes('does not support') ||
    s.includes('only the default')
  );
}

async function callBotWithCompatibility(tenant, from, message, opts) {
  try {
    return await getGPTReply(tenant, from, message, opts);
  } catch (e) {
    // Algunos modelos nuevos sólo admiten temperature=1. El motor histórico de
    // Asisto puede tener 0 configurado. En el simulador reintentamos una vez con
    // el valor compatible para no dejar la prueba bloqueada.
    if (!isUnsupportedTemperatureError(e)) throw e;
    console.warn(`[bot-test] reintento por temperature tenant=${tenant}`);
    return getGPTReply(tenant, from, message, { ...opts, chatTemperature: 1 });
  }
}

function panelHtml({ tenant, tenantOptions = [], canSelectTenant = false }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pruebas Bot</title>
<style>
:root{--bg:#eef3f6;--card:#fff;--line:#d8e2e8;--text:#10243e;--muted:#667085;--primary:#0e6b66;--primary2:#095853;--danger:#b42318;--ok:#067647;--shadow:0 8px 24px rgba(16,24,40,.08)}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text)}button,textarea,select{font:inherit}button{cursor:pointer}.wrap{padding:14px;min-height:100vh;display:flex;flex-direction:column}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}.title h1{font-size:22px;margin:0 0 3px}.title p{font-size:12px;color:var(--muted);margin:0}.topActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tenantPicker{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:6px 9px}.tenantPicker label{font-size:11px;font-weight:800;color:#475467}.tenantPicker select{border:0;outline:none;background:transparent;font-weight:800;min-width:150px;color:var(--text)}.btn{border:1px solid var(--line);background:#fff;color:var(--text);font-weight:750;border-radius:9px;padding:8px 11px}.btn:hover{background:#f8fafc}.btnPrimary{background:var(--primary);border-color:var(--primary);color:#fff}.btnPrimary:hover{background:var(--primary2)}.btnDanger{color:var(--danger);border-color:#f1c8c5}.btn:disabled{opacity:.55;cursor:default}.notice{display:flex;align-items:center;gap:8px;padding:9px 11px;margin-bottom:10px;border-radius:10px;border:1px solid #abefc6;background:#ecfdf3;color:#05603a;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:0 0 auto}.chatCard{flex:1;min-height:520px;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column}.chatHead{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:11px 13px;border-bottom:1px solid var(--line)}.chatHead strong{font-size:14px}.sessionLabel{font-size:10px;color:var(--muted)}.chatBody{flex:1;min-height:390px;overflow:auto;background:#f6f8fa;padding:16px}.empty{height:100%;min-height:300px;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--muted);font-size:13px}.msgRow{display:flex;margin:8px 0}.msgRow.user{justify-content:flex-end}.msgRow.bot{justify-content:flex-start}.bubble{max-width:min(78%,720px);padding:9px 11px;border-radius:12px;font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}.user .bubble{background:#dff6e9;border:1px solid #c5ead5;border-bottom-right-radius:4px}.bot .bubble{background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}.bot.error .bubble{border-color:#f4c7c3;background:#fef3f2;color:#912018}.msgMeta{display:block;color:var(--muted);font-size:9px;margin-top:5px}.typing{display:inline-flex;gap:4px;align-items:center}.typing i{width:5px;height:5px;border-radius:50%;background:#98a2b3;animation:pulse 1.1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes pulse{0%,80%,100%{opacity:.35}40%{opacity:1}}.composer{border-top:1px solid var(--line);padding:10px;background:#fff}.composeRow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.composer textarea{width:100%;min-height:58px;max-height:160px;resize:vertical;border:1px solid var(--line);border-radius:10px;padding:10px 11px;outline:none}.composer textarea:focus{border-color:#8cc7c3;box-shadow:0 0 0 3px rgba(14,107,102,.08)}.sendBtn{height:58px;min-width:100px}.composeHint{margin-top:6px;color:var(--muted);font-size:10px}.toast{position:fixed;right:18px;bottom:18px;background:#101828;color:#fff;padding:10px 13px;border-radius:10px;display:none;z-index:100;font-size:12px}.toast.show{display:block}.toast.err{background:#b42318}
@media(max-width:650px){.wrap{padding:8px}.composeRow{grid-template-columns:1fr}.sendBtn{height:42px}.bubble{max-width:90%}.chatCard{min-height:70vh}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="title">
      <h1>Pruebas Bot</h1>
      <p>Probá una conversación sin conectar WhatsApp ni un teléfono.</p>
    </div>
    <div class="topActions">
      ${canSelectTenant ? `<div class="tenantPicker"><label for="tenantSelect">Dominio</label><select id="tenantSelect">${tenantOptions.map(t => `<option value="${htmlEscape(t)}" ${String(t) === String(tenant) ? 'selected' : ''}>${htmlEscape(t)}</option>`).join('')}</select></div>` : ''}
      <button class="btn btnDanger" id="resetBtn">↻ Nueva prueba</button>
    </div>
  </div>

  <div class="notice"><span class="dot"></span><span>Simulación activa. Los mensajes de esta pantalla no se envían a WhatsApp.</span></div>

  <section class="chatCard">
    <div class="chatHead">
      <strong>Conversación de prueba</strong>
      <span class="sessionLabel" id="sessionLabel">Nueva sesión</span>
    </div>
    <div class="chatBody" id="chatBody">
      <div class="empty" id="emptyState"><div><b>Escribí un mensaje para comenzar.</b><br/>El bot responderá como si estuviera conversando con un cliente.</div></div>
    </div>
    <div class="composer">
      <div class="composeRow">
        <textarea id="message" maxlength="${MAX_MESSAGE_CHARS}" placeholder="Escribí como si fueras el cliente…"></textarea>
        <button class="btn btnPrimary sendBtn" id="sendBtn" type="button">Enviar</button>
      </div>
      <div class="composeHint">Enter envía · Shift+Enter agrega una línea.</div>
    </div>
  </section>
</div>
<div class="toast" id="toast"></div>
<script>
let TENANT=${JSON.stringify(tenant)};
const CAN_SELECT_TENANT=${canSelectTenant ? 'true' : 'false'};
let SESSION_ID='';
let sending=false;
const el=id=>document.getElementById(id);
function newSessionId(){try{if(window.crypto&&typeof window.crypto.randomUUID==='function')return window.crypto.randomUUID().replace(/-/g,'_')}catch(_){}return 'test_'+Date.now()+'_'+Math.random().toString(36).slice(2)}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function api(path){const u=new URL(path,location.origin);if(TENANT)u.searchParams.set('tenant',TENANT);return u.toString()}
function toast(msg,err=false){const t=el('toast');t.textContent=msg;t.className='toast show'+(err?' err':'');setTimeout(()=>t.className='toast',3200)}
function nowLabel(){return new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}
function ensureSession(){if(!SESSION_ID){SESSION_ID=newSessionId();el('sessionLabel').textContent='Sesión '+SESSION_ID.slice(0,8)}}
function addMessage(role,text,isError=false){const empty=el('emptyState');if(empty)empty.remove();const row=document.createElement('div');row.className='msgRow '+(role==='user'?'user':'bot')+(isError?' error':'');row.innerHTML='<div class="bubble">'+esc(text)+'<span class="msgMeta">'+(role==='user'?'Cliente':'Asisto')+' · '+esc(nowLabel())+'</span></div>';el('chatBody').appendChild(row);el('chatBody').scrollTop=el('chatBody').scrollHeight;return row}
function addTyping(){const empty=el('emptyState');if(empty)empty.remove();const row=document.createElement('div');row.className='msgRow bot';row.id='typingRow';row.innerHTML='<div class="bubble"><span class="typing"><i></i><i></i><i></i></span><span class="msgMeta">Asisto está respondiendo…</span></div>';el('chatBody').appendChild(row);el('chatBody').scrollTop=el('chatBody').scrollHeight}
function removeTyping(){const n=el('typingRow');if(n)n.remove()}
async function requestJson(path,opts={}){const r=await fetch(api(path),{credentials:'same-origin',cache:'no-store',...opts});const text=await r.text();let j={};try{j=text?JSON.parse(text):{}}catch{if(r.redirected||r.status===401)throw new Error('La sesión venció. Volvé a iniciar sesión.');throw new Error('El servidor devolvió una respuesta inválida.')}if(!r.ok)throw new Error(j.detail||j.message||j.error||('HTTP '+r.status));return j}
async function send(){if(sending)return;const box=el('message');const text=String(box.value||'').trim();if(!text)return;ensureSession();sending=true;const btn=el('sendBtn');btn.disabled=true;btn.textContent='Enviando…';box.disabled=true;addMessage('user',text);box.value='';addTyping();try{const j=await requestJson('/api/bot-test/send',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({sessionId:SESSION_ID,message:text})});removeTyping();addMessage('bot',j.reply||'Sin respuesta');}catch(e){removeTyping();addMessage('bot','No se pudo obtener respuesta: '+e.message,true);toast(e.message,true)}finally{sending=false;btn.disabled=false;btn.textContent='Enviar';box.disabled=false;box.focus()}}
async function resetSession(){const old=SESSION_ID;try{if(old)await requestJson('/api/bot-test/reset',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({sessionId:old})})}catch(_){}SESSION_ID=newSessionId();el('sessionLabel').textContent='Sesión '+SESSION_ID.slice(0,8);el('chatBody').innerHTML='<div class="empty" id="emptyState"><div><b>Nueva prueba iniciada.</b><br/>Escribí un mensaje para comenzar.</div></div>';el('message').value='';el('message').focus()}
async function changeTenant(value){const next=String(value||'').trim();if(!CAN_SELECT_TENANT||!next||next===TENANT)return;const oldTenant=TENANT;const oldSession=SESSION_ID;try{if(oldSession){const u=new URL('/api/bot-test/reset',location.origin);u.searchParams.set('tenant',oldTenant);await fetch(u.toString(),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:oldSession})})}}catch(_){}TENANT=next;try{const u=new URL(location.href);u.searchParams.set('tenant',TENANT);history.replaceState(null,'',u.toString())}catch(_){}await resetSession()}
el('sendBtn').addEventListener('click',send);
el('message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
el('resetBtn').addEventListener('click',resetSession);
if(CAN_SELECT_TENANT&&el('tenantSelect'))el('tenantSelect').addEventListener('change',e=>changeTenant(e.target.value));
ensureSession();el('message').focus();
</script>
</body>
</html>`;
}

function mountBotTestPanel(app, { auth } = {}) {
  if (!app || app.__asistoBotTestPanelMounted) return;
  app.__asistoBotTestPanelMounted = true;

  app.get('/admin/bot-test', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const canSelectTenant = isSuperAdmin(req);
      const db = canSelectTenant ? await getDb() : null;
      const tenantOptions = canSelectTenant ? await loadAvailableTenants(db, tenant) : [tenant];
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Asisto-Bot-Test-Version', BOT_TEST_VERSION);
      return res.status(200).send(panelHtml({ tenant, tenantOptions, canSelectTenant }));
    } catch (e) {
      console.error('[bot-test] page:', e?.message || e);
      return res.status(500).send('Error cargando panel de pruebas del bot.');
    }
  });

  app.post('/api/bot-test/send', botTestJson, async (req, res) => {
    const started = Date.now();
    try {
      const tenant = resolveTenant(req, auth);
      const message = cleanString(req.body?.message, MAX_MESSAGE_CHARS);
      if (!message) return res.status(400).json({ ok: false, error: 'message_required', detail: 'Escribí un mensaje para realizar la prueba.' });

      const sessionId = safeSessionId(req.body?.sessionId);
      const from = testSessionFrom(req, tenant, sessionId);
      const db = await getDb();
      const [behavior, runtime] = await Promise.all([
        loadBehaviorConfigFromMongo(tenant),
        resolveTestRuntime(db, tenant),
      ]);
      if (!runtime.apiKey) {
        return res.status(409).json({ ok: false, error: 'bot_not_available', detail: 'El bot no está disponible para realizar la prueba en este momento.' });
      }

      const botMode = normalizeBotMode(behavior?.bot_mode || 'pedidos');
      const usageTraceId = `bot-test:${tenant}:${cleanString(req?.user?.uid || 'user', 80)}:${sessionId}:${Date.now()}`;
      const opts = {
        tenantId: tenant,
        openaiApiKey: runtime.apiKey,
        waId: `BOT_TEST:${sessionId}`,
        channelType: 'bot_test',
        usageTraceId,
        externalApiContext: {
          telefono_cliente: '0000000000000',
          telefono_qr: '',
          consulta: message,
        },
      };

      console.log(`[bot-test] mensaje tenant=${tenant} session=${sessionId.slice(0, 8)} modo=${botMode}`);
      const raw = await callBotWithCompatibility(tenant, from, message, opts);
      const reply = parseReply(raw);
      console.log(`[bot-test] respuesta tenant=${tenant} session=${sessionId.slice(0, 8)} ms=${Date.now() - started}`);

      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, sessionId, reply });
    } catch (e) {
      const detail = errorText(e);
      console.error('[bot-test] send:', detail);
      return res.status(500).json({ ok: false, error: 'bot_test_failed', detail: detail || 'No se pudo obtener una respuesta del bot.' });
    }
  });

  app.post('/api/bot-test/reset', botTestJson, async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const sessionId = safeSessionId(req.body?.sessionId);
      const from = testSessionFrom(req, tenant, sessionId);
      markSessionEnded(tenant, from);
      clearEndedFlag(tenant, from);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true });
    } catch (e) {
      console.error('[bot-test] reset:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'bot_test_reset_failed' });
    }
  });
}

module.exports = { mountBotTestPanel };
