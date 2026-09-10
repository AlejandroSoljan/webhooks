const { google } = require("googleapis");
const { getDb } = require("./db");

const clean = (value, max = 500) => String(value || "").trim().slice(0, max);
const tenant = (value) => clean(value, 60).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
const topicFor = (value) => tenant(value).toLowerCase();
const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function canUseTenant(req, requestedTenant) {
  const role = String(req.user?.role || "").toLowerCase();
  return role === "superadmin" || tenant(req.user?.tenantId) === requestedTenant;
}

async function listTenantIds(db, fallbackTenant) {
  const values = new Set([tenant(fallbackTenant)].filter(Boolean));
  const sources = [
    ["tenant_config", "_id"],
    ["users", "tenantId"],
    ["wa_wweb_locks", "tenantId"],
  ];
  for (const [collection, field] of sources) {
    try {
      for (const value of await db.collection(collection).distinct(field)) {
        const normalized = tenant(value);
        if (normalized) values.add(normalized);
      }
    } catch {}
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

function firebaseCredentials() {
  let json = null;
  try { if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON); } catch {}
  const projectId = clean(json?.project_id || process.env.FIREBASE_PROJECT_ID || "asisto-34dbd", 120);
  const clientEmail = clean(json?.client_email || process.env.FIREBASE_CLIENT_EMAIL, 300);
  const privateKey = String(json?.private_key || process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return { projectId, clientEmail, privateKey, configured: !!(projectId && clientEmail && privateKey) };
}

async function sendTopicNotification({ tenantId, title, body, url }) {
  const credentials = firebaseCredentials();
  if (!credentials.configured) throw new Error("firebase_server_credentials_missing");
  const auth = new google.auth.GoogleAuth({ credentials: { client_email: credentials.clientEmail, private_key: credentials.privateKey }, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token || token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { topic: topicFor(tenantId), notification: { title, body }, data: { title, body, url: url || `https://asistobot.com.ar/customer-app/${encodeURIComponent(tenantId)}` }, android: { priority: "high", notification: { channel_id: "asisto_updates", sound: "default" } } } }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(clean(payload?.error?.message || `fcm_http_${response.status}`, 300));
  return payload.name || "sent";
}

function panelPage({ tenantId, tenants, isSuper }) {
  const domainControl = isSuper
    ? `<label for="notif_tenant">Dominio</label><select id="notif_tenant">${tenants.map((t) => `<option value="${escapeHtml(t)}"${t === tenantId ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select>`
    : `<input id="notif_tenant" type="hidden" value="${escapeHtml(tenantId)}">`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notificaciones App</title><style>*{box-sizing:border-box}body{margin:0;background:#eef3f7;color:#10243d;font-family:system-ui}.wrap{max-width:820px;margin:auto;padding:28px 16px}.card{background:#fff;border-radius:18px;padding:20px;box-shadow:0 6px 24px #1232;margin-bottom:16px}h1{margin:0 0 5px}label{display:block;font-weight:750;margin:14px 0 5px}input,textarea,select{width:100%;padding:12px;border:1px solid #ccd7e0;border-radius:10px;font:inherit;background:#fff}textarea{min-height:110px;resize:vertical}.send{border:0;border-radius:11px;background:#ef1010;color:#fff;padding:13px 20px;font-weight:800;margin-top:15px;cursor:pointer}.send:disabled{opacity:.55}.status{margin-top:12px;padding:11px;border-radius:10px;background:#eef3f7}.ok{background:#e8f8ef;color:#067647}.bad{background:#fff0f0;color:#b42318}.item{padding:12px 0;border-bottom:1px solid #e4ebf0}.item:last-child{border:0}.muted{color:#68798b;font-size:13px}</style></head><body><main class="wrap" id="notif_panel"><div class="card"><h1>Notificaciones App</h1>${domainControl}<div class="muted" id="notif_domain_note">Se enviará a todos los celulares registrados en ${escapeHtml(tenantId)}</div><label for="notif_title">Título</label><input id="notif_title" maxlength="80" placeholder="Ej.: Tu turno está cerca"><label for="notif_body">Mensaje</label><textarea id="notif_body" maxlength="500" placeholder="Escribí el mensaje que verá el cliente"></textarea><label for="notif_url">Enlace al tocar la notificación (opcional)</label><input id="notif_url" type="url" placeholder="https://asistobot.com.ar/customer-app/${escapeHtml(tenantId)}"><button class="send" id="notif_send" type="button">Enviar notificación</button><div id="notif_status" class="status">Comprobando Firebase…</div></div><div class="card"><h2>Historial reciente</h2><div id="notif_history">Cargando…</div></div></main><script>(()=>{const q=id=>document.querySelector('#notif_panel #'+id),esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),selectedTenant=()=>String(q('notif_tenant').value||'').trim().toUpperCase(),api=()=>'/api/customer-notifications/'+encodeURIComponent(selectedTenant());async function load(){const t=selectedTenant();q('notif_domain_note').textContent='Se enviará a todos los celulares registrados en '+t;q('notif_url').placeholder='https://asistobot.com.ar/customer-app/'+t;const r=await fetch(api(),{credentials:'same-origin'}),x=await r.json();if(!r.ok){q('notif_status').textContent=x.error||'No se pudo cargar el dominio.';q('notif_status').className='status bad';return}q('notif_status').textContent=x.configured?'Firebase configurado y listo para enviar.':'Falta configurar la credencial Firebase del servidor.';q('notif_status').className='status '+(x.configured?'ok':'bad');q('notif_history').innerHTML=(x.history||[]).map(n=>'<div class="item"><b>'+esc(n.title)+'</b><div>'+esc(n.body)+'</div><div class="muted">'+new Date(n.createdAt).toLocaleString()+' · '+esc(n.status)+'</div></div>').join('')||'<div class="muted">Todavía no hay envíos.</div>'}q('notif_tenant').addEventListener('change',load);q('notif_send').addEventListener('click',async()=>{const title=String(q('notif_title').value||'').trim(),body=String(q('notif_body').value||'').trim(),url=String(q('notif_url').value||'').trim();if(!title||!body)return alert('Completá título y mensaje.');if(!confirm('¿Enviar esta notificación a todos los celulares de '+selectedTenant()+'?'))return;q('notif_send').disabled=true;try{const r=await fetch(api(),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({title,body,url})}),x=await r.json();if(!r.ok)return alert(x.error||'No se pudo enviar');q('notif_title').value='';q('notif_body').value='';q('notif_url').value='';alert('Notificación enviada.');await load()}finally{q('notif_send').disabled=false}});load()})();</script></body></html>`;
}

function mountCustomerNotifications(app, { auth } = {}) {
  const requireAuth = auth?.requireAuth || ((_req, _res, next) => next());
  app.get("/ui/notificaciones-app", requireAuth, async (req, res) => {
    const isSuper = String(req.user?.role || "").toLowerCase() === "superadmin";
    const ownTenant = tenant(req.user?.tenantId || "DEMO_FERRETERIA");
    const requested = tenant(req.query.tenant || req.query.tenantId);
    const selected = isSuper && requested ? requested : ownTenant;
    const tenants = isSuper ? await listTenantIds(await getDb(), selected) : [ownTenant];
    res.type("html").send(panelPage({ tenantId: selected, tenants, isSuper }));
  });
  app.get("/api/customer-notifications/:tenant", requireAuth, async (req,res)=>{try{const t=tenant(req.params.tenant);if(!t||!canUseTenant(req,t))return res.status(403).json({error:"No autorizado para ese dominio."});const history=await (await getDb()).collection("customer_app_notifications").find({tenantId:t}).sort({createdAt:-1}).limit(30).project({_id:0,title:1,body:1,status:1,createdAt:1}).toArray();res.json({configured:firebaseCredentials().configured,topic:topicFor(t),history})}catch(e){res.status(500).json({error:"No se pudo cargar el panel"})}});
  app.post("/api/customer-notifications/:tenant", requireAuth, async (req,res)=>{const t=tenant(req.params.tenant);if(!t||!canUseTenant(req,t))return res.status(403).json({error:"No autorizado para ese dominio."});const title=clean(req.body?.title,80),body=clean(req.body?.body,500),url=clean(req.body?.url,800);if(!title||!body)return res.status(400).json({error:"Completá título y mensaje."});if(url&&!/^https:\/\/asistobot\.com\.ar\//i.test(url))return res.status(400).json({error:"El enlace debe pertenecer a asistobot.com.ar."});const db=await getDb(),record={tenantId:t,topic:topicFor(t),title,body,url,status:"sending",createdAt:new Date(),createdBy:clean(req.user?.username||req.user?.email||"",120)};const inserted=await db.collection("customer_app_notifications").insertOne(record);try{const messageId=await sendTopicNotification({tenantId:t,title,body,url});await db.collection("customer_app_notifications").updateOne({_id:inserted.insertedId},{$set:{status:"sent",messageId,sentAt:new Date()}});res.json({ok:true,messageId})}catch(e){const reason=e.message==="firebase_server_credentials_missing"?"Falta configurar la credencial Firebase del servidor.":"Firebase rechazó el envío.";await db.collection("customer_app_notifications").updateOne({_id:inserted.insertedId},{$set:{status:"failed",errorCode:clean(e.message,100),updatedAt:new Date()}});res.status(503).json({error:reason})}});
}
module.exports = { mountCustomerNotifications, firebaseCredentials, topicFor };
