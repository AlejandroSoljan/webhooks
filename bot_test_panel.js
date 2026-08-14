// bot_test_panel.js
// Simulador interno del bot Asisto.
// Permite probar el comportamiento de un dominio sin WhatsApp/Telegram/Instagram,
// sin QR y sin enviar mensajes a ningún teléfono real.
//
// Importante:
// - Reutiliza getGPTReply() de logic.js, por lo que toma el Comportamiento,
//   catálogo/horarios (modo pedidos), configuración de IA y acciones externas reales.
// - NO crea conversations/messages/orders/leads ni envía mensajes a canales.
// - El historial de la prueba vive sólo en memoria y se identifica por usuario+sesión.

const crypto = require('crypto');
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

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 30);
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
    db.collection('settings').distinct('tenantId'),
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

async function findTenantConfig(db, tenant) {
  const exact = await db.collection('tenant_config').findOne({ _id: tenant }).catch(() => null);
  if (exact) return exact;
  return db.collection('tenant_config').findOne({
    $or: [{ tenantId: tenant }, { tenantid: tenant }]
  }).catch(() => null);
}

function pickModel(tenantDoc) {
  const cfg = tenantDoc && typeof tenantDoc === 'object' ? tenantDoc : {};
  const openai = cfg.openai && typeof cfg.openai === 'object' ? cfg.openai : {};
  return cleanString(
    openai.chat_model || openai.chatModel || cfg.CHAT_MODEL || cfg.chat_model || cfg.chatModel || process.env.CHAT_MODEL || 'gpt-5.4',
    120
  ) || 'gpt-5.4';
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

  const keyFromChannel = String(channel?.openaiApiKey || '').trim();
  const keyFromEnv = String(process.env.OPENAI_API_KEY || '').trim();
  return {
    channel,
    apiKey: keyFromChannel || keyFromEnv,
    apiKeySource: keyFromChannel ? 'canal del dominio' : (keyFromEnv ? '.env del servidor' : 'sin configurar'),
    channelsCount: channels.length,
  };
}

async function buildInfo(db, tenant) {
  const [behavior, tenantDoc, runtime, productCount] = await Promise.all([
    loadBehaviorConfigFromMongo(tenant),
    findTenantConfig(db, tenant),
    resolveTestRuntime(db, tenant),
    db.collection('products').countDocuments({ tenantId: tenant, active: { $ne: false } }).catch(() => 0),
  ]);

  const botMode = normalizeBotMode(behavior?.bot_mode || 'pedidos');
  const actions = Array.isArray(behavior?.external_actions)
    ? behavior.external_actions.filter(x => x && x.enabled !== false)
    : [];

  return {
    tenant,
    botMode,
    historyMode: String(behavior?.history_mode || 'standard'),
    model: pickModel(tenantDoc),
    apiKeyConfigured: !!runtime.apiKey,
    apiKeySource: runtime.apiKeySource,
    channelConfigured: !!runtime.channel,
    channelType: runtime.channel?.channelType || null,
    channelsCount: runtime.channelsCount,
    leadCaptureEnabled: behavior?.lead_capture_enabled === true,
    externalActionsCount: actions.length,
    productCount,
    behaviorConfigured: !!String(behavior?.text || '').trim(),
  };
}

function parseReply(raw, botMode) {
  const text = String(raw || '').trim();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}

  const reply = payload && typeof payload === 'object'
    ? String(payload.response || '').trim()
    : text;

  const debug = { raw: text };
  if (payload && typeof payload === 'object') {
    if (botMode === 'conversacional') {
      debug.lead = payload.lead || null;
      debug.action = payload.action || null;
    } else {
      debug.estado = payload.estado || null;
      debug.Pedido = payload.Pedido || null;
    }
  }

  return {
    reply: reply || 'El motor no devolvió texto para mostrar.',
    payload,
    debug,
  };
}

function panelHtml({ tenant, tenantOptions = [], user, canSelectTenant = false }) {
  const role = String(user?.role || 'user');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pruebas Bot</title>
<style>
:root{--bg:#eef3f6;--card:#fff;--line:#d8e2e8;--text:#10243e;--muted:#667085;--primary:#0e6b66;--primary2:#095853;--danger:#b42318;--warn:#b54708;--ok:#067647;--blue:#175cd3;--shadow:0 8px 24px rgba(16,24,40,.08)}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text)}button,input,textarea,select{font:inherit}button{cursor:pointer}.wrap{padding:14px;min-height:100vh}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}.title h1{font-size:22px;margin:0 0 3px}.title p{font-size:12px;color:var(--muted);margin:0}.topActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tenantPicker{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:6px 9px}.tenantPicker label{font-size:11px;font-weight:800;color:#475467}.tenantPicker select{border:0;outline:none;background:transparent;font-weight:800;min-width:150px;color:var(--text)}.btn{border:1px solid var(--line);background:#fff;color:var(--text);font-weight:750;border-radius:9px;padding:8px 11px}.btn:hover{background:#f8fafc}.btnPrimary{background:var(--primary);border-color:var(--primary);color:#fff}.btnPrimary:hover{background:var(--primary2)}.btnDanger{color:var(--danger);border-color:#f1c8c5}.btn:disabled{opacity:.55;cursor:default}.statusGrid{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:8px;margin-bottom:10px}.statusCard{background:#fff;border:1px solid var(--line);border-radius:11px;padding:9px 11px;box-shadow:var(--shadow);min-width:0}.statusCard span{display:block;font-size:10px;text-transform:uppercase;color:var(--muted);font-weight:800;margin-bottom:4px}.statusCard b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:10px;align-items:stretch}.chatCard,.sideCard{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}.chatHead{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:11px 13px;border-bottom:1px solid var(--line)}.chatHead strong{font-size:14px}.online{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ok)}.dot{width:8px;height:8px;border-radius:50%;background:var(--ok)}.chatBody{height:calc(100vh - 345px);min-height:390px;max-height:720px;overflow:auto;background:#f6f8fa;padding:16px}.empty{height:100%;min-height:250px;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--muted);font-size:13px}.msgRow{display:flex;margin:8px 0}.msgRow.user{justify-content:flex-end}.msgRow.bot{justify-content:flex-start}.bubble{max-width:min(78%,720px);padding:9px 11px;border-radius:12px;font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}.user .bubble{background:#dff6e9;border:1px solid #c5ead5;border-bottom-right-radius:4px}.bot .bubble{background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}.msgMeta{display:block;color:var(--muted);font-size:9px;margin-top:5px}.typing{display:inline-flex;gap:4px;align-items:center}.typing i{width:5px;height:5px;border-radius:50%;background:#98a2b3;animation:pulse 1.1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes pulse{0%,80%,100%{opacity:.35}40%{opacity:1}}.composer{border-top:1px solid var(--line);padding:10px;background:#fff}.composeRow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.composer textarea{width:100%;min-height:54px;max-height:150px;resize:vertical;border:1px solid var(--line);border-radius:10px;padding:10px 11px;outline:none}.composer textarea:focus{border-color:#8cc7c3;box-shadow:0 0 0 3px rgba(14,107,102,.08)}.sendBtn{height:54px;min-width:92px}.composeHint{margin-top:6px;color:var(--muted);font-size:10px}.sideCard{padding:12px}.sideCard h3{font-size:13px;margin:0 0 10px}.field{margin-bottom:11px}.field label{display:block;font-size:11px;font-weight:800;color:#475467;margin-bottom:5px}.field input{width:100%;border:1px solid var(--line);border-radius:9px;padding:8px 9px}.hintBox{border:1px solid #fedf89;background:#fffaeb;color:#7a2e0e;border-radius:10px;padding:9px 10px;font-size:11px;line-height:1.4;margin-bottom:11px}.okBox{border:1px solid #abefc6;background:#ecfdf3;color:#05603a;border-radius:10px;padding:9px 10px;font-size:11px;line-height:1.4;margin-bottom:11px}.debug{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}.debug pre{background:#101828;color:#d0d5dd;padding:10px;border-radius:9px;white-space:pre-wrap;overflow:auto;max-height:330px;font-size:10px;line-height:1.4}.debugEmpty{font-size:11px;color:var(--muted);padding:9px 0}.smallActions{display:flex;gap:7px;flex-wrap:wrap}.toast{position:fixed;right:18px;bottom:18px;background:#101828;color:#fff;padding:10px 13px;border-radius:10px;display:none;z-index:100;font-size:12px}.toast.show{display:block}.toast.err{background:#b42318}.pill{display:inline-flex;border-radius:999px;background:#eef4ff;color:#3538cd;padding:3px 7px;font-size:10px;font-weight:800}
@media(max-width:1050px){.statusGrid{grid-template-columns:repeat(3,1fr)}.layout{grid-template-columns:1fr}.chatBody{height:520px}.sideCard{order:-1}}@media(max-width:650px){.wrap{padding:8px}.statusGrid{grid-template-columns:1fr 1fr}.chatBody{height:58vh;min-height:330px}.composeRow{grid-template-columns:1fr}.sendBtn{height:42px}.bubble{max-width:90%}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="title">
      <h1>Pruebas Bot</h1>
      <p>Simulador interno · no requiere WhatsApp ni un teléfono conectado · dominio <strong id="tenantLabel">${htmlEscape(tenant)}</strong> · ${htmlEscape(role)}</p>
    </div>
    <div class="topActions">
      ${canSelectTenant ? `<div class="tenantPicker"><label for="tenantSelect">Dominio</label><select id="tenantSelect">${tenantOptions.map(t => `<option value="${htmlEscape(t)}" ${String(t) === String(tenant) ? 'selected' : ''}>${htmlEscape(t)}</option>`).join('')}</select></div>` : ''}
      <button class="btn" id="behaviorBtn">⚙ Comportamiento</button>
      <button class="btn btnDanger" id="resetBtn">↻ Nueva prueba</button>
    </div>
  </div>

  <div class="statusGrid">
    <div class="statusCard"><span>Modo</span><b id="sMode">Cargando…</b></div>
    <div class="statusCard"><span>Modelo</span><b id="sModel">Cargando…</b></div>
    <div class="statusCard"><span>Comportamiento</span><b id="sBehavior">Cargando…</b></div>
    <div class="statusCard"><span>OpenAI</span><b id="sKey">Cargando…</b></div>
    <div class="statusCard"><span>Acciones externas</span><b id="sActions">—</b></div>
    <div class="statusCard"><span>Productos activos</span><b id="sProducts">—</b></div>
  </div>

  <div class="layout">
    <section class="chatCard">
      <div class="chatHead">
        <div><strong>Cliente de prueba ↔ Asisto</strong> <span class="pill" id="sessionPill">sesión nueva</span></div>
        <div class="online"><span class="dot"></span>simulador activo</div>
      </div>
      <div class="chatBody" id="chatBody">
        <div class="empty" id="emptyState"><div><b>Escribí un mensaje para comenzar.</b><br/>Asisto responderá con la configuración actual del dominio, sin enviar nada por WhatsApp.</div></div>
      </div>
      <div class="composer">
        <div class="composeRow">
          <textarea id="message" maxlength="${MAX_MESSAGE_CHARS}" placeholder="Escribí como si fueras el cliente…"></textarea>
          <button class="btn btnPrimary sendBtn" id="sendBtn">Enviar</button>
        </div>
        <div class="composeHint">Enter envía · Shift+Enter agrega una línea. La prueba mantiene contexto hasta presionar “Nueva prueba”.</div>
      </div>
    </section>

    <aside class="sideCard">
      <h3>Configuración de la prueba</h3>
      <div class="field">
        <label>Teléfono simulado del cliente</label>
        <input id="fakePhone" inputmode="numeric" value="5490000000000" placeholder="5490000000000"/>
        <div class="composeHint">No se conecta ni se envía a este número. Sólo sirve como variable para el comportamiento o APIs externas.</div>
      </div>
      <div class="okBox"><b>No usa un canal real.</b><br/>Esta pantalla llama directamente al motor del bot. No necesita QR, WhatsApp Web ni API Meta.</div>
      <div class="hintBox" id="externalWarning" style="display:none"><b>Atención:</b> este dominio tiene acciones externas configuradas. Durante la prueba pueden ejecutarse igual que en el bot real.</div>
      <div class="smallActions">
        <button class="btn" id="copyBtn">Copiar conversación</button>
        <button class="btn" id="infoBtn">Actualizar config</button>
      </div>
      <div class="debug">
        <h3>Diagnóstico de la última respuesta</h3>
        <div id="debugEmpty" class="debugEmpty">Todavía no hay una respuesta para analizar.</div>
        <pre id="debugPre" style="display:none"></pre>
      </div>
    </aside>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
let TENANT=${JSON.stringify(tenant)};
const CAN_SELECT_TENANT=${canSelectTenant ? 'true' : 'false'};
let SESSION_ID='';
let transcript=[];
let sending=false;
const el=id=>document.getElementById(id);
function newSessionId(){try{return crypto.randomUUID().replace(/-/g,'_')}catch{return 'test_'+Date.now()+'_'+Math.random().toString(36).slice(2)}}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function api(path){const u=new URL(path,location.origin);if(TENANT)u.searchParams.set('tenant',TENANT);return u.toString()}
function toast(msg,err=false){const t=el('toast');t.textContent=msg;t.className='toast show'+(err?' err':'');setTimeout(()=>t.className='toast',3000)}
function nowLabel(){return new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}
function ensureSession(){if(!SESSION_ID){SESSION_ID=newSessionId();el('sessionPill').textContent=SESSION_ID.slice(0,8)}}
function addMessage(role,text){const empty=el('emptyState');if(empty)empty.remove();const row=document.createElement('div');row.className='msgRow '+(role==='user'?'user':'bot');row.innerHTML='<div class="bubble">'+esc(text)+'<span class="msgMeta">'+(role==='user'?'Cliente simulado':'Asisto')+' · '+esc(nowLabel())+'</span></div>';el('chatBody').appendChild(row);el('chatBody').scrollTop=el('chatBody').scrollHeight;transcript.push({role,text,time:nowLabel()});return row}
function addTyping(){const empty=el('emptyState');if(empty)empty.remove();const row=document.createElement('div');row.className='msgRow bot';row.id='typingRow';row.innerHTML='<div class="bubble"><span class="typing"><i></i><i></i><i></i></span><span class="msgMeta">Asisto está procesando…</span></div>';el('chatBody').appendChild(row);el('chatBody').scrollTop=el('chatBody').scrollHeight}
function removeTyping(){const n=el('typingRow');if(n)n.remove()}
async function requestJson(path,opts){const r=await fetch(api(path),opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||j.detail||('HTTP '+r.status));return j}
function renderInfo(info){el('sMode').textContent=info.botMode==='conversacional'?'Conversacional':'Pedidos';el('sModel').textContent=info.model||'-';el('sBehavior').textContent=info.behaviorConfigured?'Configurado':'Vacío';el('sKey').textContent=info.apiKeyConfigured?'Configurada':'Falta API key';el('sActions').textContent=String(info.externalActionsCount||0);el('sProducts').textContent=String(info.productCount||0);el('externalWarning').style.display=Number(info.externalActionsCount||0)>0?'block':'none';}
async function loadInfo(){const j=await requestJson('/api/bot-test/info');renderInfo(j.info||{});return j.info||{}}
function renderDebug(d){el('debugEmpty').style.display='none';el('debugPre').style.display='block';el('debugPre').textContent=JSON.stringify(d||{},null,2)}
async function send(){if(sending)return;const text=el('message').value.trim();if(!text)return;ensureSession();sending=true;el('sendBtn').disabled=true;el('message').disabled=true;addMessage('user',text);el('message').value='';addTyping();try{const j=await requestJson('/api/bot-test/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:SESSION_ID,message:text,fakePhone:el('fakePhone').value})});removeTyping();addMessage('bot',j.reply||'Sin respuesta');renderDebug({dominio:j.tenant,modo:j.botMode,modelo:j.model,tiempo_ms:j.elapsedMs,estructura:j.debug||null});}catch(e){removeTyping();addMessage('bot','[ERROR DE PRUEBA] '+e.message);renderDebug({error:e.message});toast(e.message,true)}finally{sending=false;el('sendBtn').disabled=false;el('message').disabled=false;el('message').focus()}}
async function resetSession(){const old=SESSION_ID;try{if(old)await requestJson('/api/bot-test/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:old})})}catch{}SESSION_ID=newSessionId();transcript=[];el('sessionPill').textContent=SESSION_ID.slice(0,8);el('chatBody').innerHTML='<div class="empty" id="emptyState"><div><b>Nueva prueba iniciada.</b><br/>El historial anterior ya no se usa.</div></div>';el('debugPre').style.display='none';el('debugPre').textContent='';el('debugEmpty').style.display='block';toast('Nueva sesión de prueba');el('message').focus()}
async function changeTenant(v){const next=String(v||'').trim();if(!CAN_SELECT_TENANT||!next||next===TENANT)return;const oldTenant=TENANT;const oldSession=SESSION_ID;try{if(oldSession)await fetch((()=>{const u=new URL('/api/bot-test/reset',location.origin);u.searchParams.set('tenant',oldTenant);return u.toString()})(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:oldSession})})}catch{}TENANT=next;el('tenantLabel').textContent=TENANT;try{const u=new URL(location.href);u.searchParams.set('tenant',TENANT);history.replaceState(null,'',u.toString())}catch{}await resetSession();await loadInfo()}
function copyTranscript(){if(!transcript.length){toast('No hay conversación para copiar',true);return}const txt=transcript.map(x=>(x.role==='user'?'CLIENTE':'ASISTO')+': '+x.text).join('\n\n');navigator.clipboard.writeText(txt).then(()=>toast('Conversación copiada')).catch(()=>toast('No se pudo copiar',true))}
el('sendBtn').addEventListener('click',send);el('message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});el('resetBtn').addEventListener('click',resetSession);el('copyBtn').addEventListener('click',copyTranscript);el('infoBtn').addEventListener('click',()=>loadInfo().then(()=>toast('Configuración actualizada')).catch(e=>toast(e.message,true)));el('behaviorBtn').addEventListener('click',()=>window.open('/ui/comportamiento?tenant='+encodeURIComponent(TENANT),'_blank'));if(CAN_SELECT_TENANT&&el('tenantSelect'))el('tenantSelect').addEventListener('change',e=>changeTenant(e.target.value));ensureSession();loadInfo().catch(e=>toast(e.message,true));el('message').focus();
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
      return res.status(200).send(panelHtml({
        tenant,
        tenantOptions,
        user: req.user,
        canSelectTenant,
      }));
    } catch (e) {
      console.error('[bot-test] page:', e?.message || e);
      return res.status(500).send('Error cargando panel de pruebas del bot.');
    }
  });

  app.get('/api/bot-test/info', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const db = await getDb();
      const info = await buildInfo(db, tenant);
      return res.json({ ok: true, info });
    } catch (e) {
      console.error('[bot-test] info:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'bot_test_info_error', detail: cleanString(e?.message || e, 500) });
    }
  });

  app.post('/api/bot-test/send', async (req, res) => {
    const started = Date.now();
    try {
      const tenant = resolveTenant(req, auth);
      const message = cleanString(req.body?.message, MAX_MESSAGE_CHARS);
      if (!message) return res.status(400).json({ ok: false, error: 'message_required' });

      const sessionId = safeSessionId(req.body?.sessionId);
      const fakePhone = onlyDigits(req.body?.fakePhone) || '5490000000000';
      const from = testSessionFrom(req, tenant, sessionId);
      const db = await getDb();
      const [behavior, runtime, tenantDoc] = await Promise.all([
        loadBehaviorConfigFromMongo(tenant),
        resolveTestRuntime(db, tenant),
        findTenantConfig(db, tenant),
      ]);
      if (!runtime.apiKey) {
        return res.status(409).json({ ok: false, error: 'openai_api_key_missing', detail: 'No hay una API key de OpenAI configurada para este dominio ni en el servidor.' });
      }

      const botMode = normalizeBotMode(behavior?.bot_mode || 'pedidos');
      const usageTraceId = `bot-test:${tenant}:${cleanString(req?.user?.uid || 'user', 80)}:${sessionId}:${Date.now()}`;
      const raw = await getGPTReply(tenant, from, message, {
        tenantId: tenant,
        openaiApiKey: runtime.apiKey,
        waId: `BOT_TEST:${fakePhone}`,
        channelType: 'bot_test',
        usageTraceId,
        externalApiContext: {
          telefono_cliente: fakePhone,
          telefono_qr: '',
          consulta: message,
        },
      });
      const parsed = parseReply(raw, botMode);
      return res.json({
        ok: true,
        tenant,
        sessionId,
        botMode,
        model: pickModel(tenantDoc),
        reply: parsed.reply,
        debug: parsed.debug,
        elapsedMs: Date.now() - started,
      });
    } catch (e) {
      console.error('[bot-test] send:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'bot_test_failed', detail: cleanString(e?.response?.data?.error?.message || e?.message || e, 1000) });
    }
  });

  app.post('/api/bot-test/reset', async (req, res) => {
    try {
      const tenant = resolveTenant(req, auth);
      const sessionId = safeSessionId(req.body?.sessionId);
      const from = testSessionFrom(req, tenant, sessionId);
      // markSessionEnded limpia todos los historiales; clearEndedFlag elimina luego
      // el flag de cierre para que el identificador pueda reutilizarse sin efectos laterales.
      markSessionEnded(tenant, from);
      clearEndedFlag(tenant, from);
      return res.json({ ok: true, tenant, sessionId });
    } catch (e) {
      console.error('[bot-test] reset:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'bot_test_reset_failed' });
    }
  });
}

module.exports = { mountBotTestPanel };
