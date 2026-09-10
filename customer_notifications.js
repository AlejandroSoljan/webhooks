// Asisto | Version: 5.00.105 | Fecha: 2026-09-10
// customer_notifications.js
const { google } = require("googleapis");
const { getDb } = require("./db");

const clean = (value, max = 500) => String(value || "").trim().slice(0, max);
const tenant = (value) => clean(value, 60).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
const topicFor = (value) => tenant(value).toLowerCase();

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

function panelPage(tenantId) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notificaciones App</title><style>*{box-sizing:border-box}body{margin:0;background:#eef3f7;color:#10243d;font-family:system-ui}.wrap{max-width:820px;margin:auto;padding:28px 16px}.card{background:#fff;border-radius:18px;padding:20px;box-shadow:0 6px 24px #1232;margin-bottom:16px}h1{margin:0 0 5px}label{display:block;font-weight:750;margin:14px 0 5px}input,textarea{width:100%;padding:12px;border:1px solid #ccd7e0;border-radius:10px;font:inherit}textarea{min-height:110px;resize:vertical}.send{border:0;border-radius:11px;background:#ef1010;color:#fff;padding:13px 20px;font-weight:800;margin-top:15px;cursor:pointer}.send:disabled{opacity:.55}.status{margin-top:12px;padding:11px;border-radius:10px;background:#eef3f7}.ok{background:#e8f8ef;color:#067647}.bad{background:#fff0f0;color:#b42318}.item{padding:12px 0;border-bottom:1px solid #e4ebf0}.item:last-child{border:0}.muted{color:#68798b;font-size:13px}</style></head><body><main class="wrap"><div class="card"><h1>Notificaciones App</h1><div class="muted">Dominio ${tenantId} · se enviará a todos los celulares registrados</div><label>Título</label><input id="title" maxlength="80" placeholder="Ej.: Tu turno está cerca"><label>Mensaje</label><textarea id="body" maxlength="500" placeholder="Escribí el mensaje que verá el cliente"></textarea><label>Enlace al tocar la notificación (opcional)</label><input id="url" type="url" placeholder="https://asistobot.com.ar/customer-app/${tenantId}"><button class="send" id="send">Enviar notificación</button><div id="status" class="status">Comprobando Firebase…</div></div><div class="card"><h2>Historial reciente</h2><div id="history">Cargando…</div></div></main><script>const T=${JSON.stringify(tenantId)},A='/api/customer-notifications/'+encodeURIComponent(T),el=id=>document.getElementById(id);async function load(){const r=await fetch(A);const x=await r.json();el('status').textContent=x.configured?'Firebase configurado y listo para enviar.':'Falta configurar la credencial Firebase del servidor.';el('status').className='status '+(x.configured?'ok':'bad');el('history').innerHTML=(x.history||[]).map(n=>'<div class="item"><b>'+esc(n.title)+'</b><div>'+esc(n.body)+'</div><div class="muted">'+new Date(n.createdAt).toLocaleString()+' · '+esc(n.status)+'</div></div>').join('')||'<div class="muted">Todavía no hay envíos.</div>'}function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}el('send').onclick=async()=>{const data={title:el('title').value,body:el('body').value,url:el('url').value};if(!data.title.trim()||!data.body.trim())return alert('Completá título y mensaje.');if(!confirm('¿Enviar esta notificación a todos los celulares del dominio?'))return;el('send').disabled=true;const r=await fetch(A,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),x=await r.json();el('send').disabled=false;if(!r.ok)return alert(x.error||'No se pudo enviar');el('title').value='';el('body').value='';el('url').value='';alert('Notificación enviada.');load()};load()</script></body></html>`;
}

function mountCustomerNotifications(app, { auth } = {}) {
  const requireAuth = auth?.requireAuth || ((_req, _res, next) => next());
  app.get("/ui/notificaciones-app", requireAuth, (req, res) => {
    const t = tenant(req.user?.tenantId || req.query.tenant || "DEMO_FERRETERIA");
    if (String(req.query.embed || "") === "1" || typeof auth?.appShell !== "function") {
      return res.type("html").send(panelPage(t));
    }
    const frameUrl = `/ui/notificaciones-app?embed=1&tenant=${encodeURIComponent(t)}`;
    return res.type("html").send(auth.appShell({
      title: "Notificaciones App · Asisto",
      user: req.user,
      active: "notifications",
      main: `<iframe title="Notificaciones App" src="${frameUrl}" style="display:block;width:100%;height:calc(100vh - 110px);min-height:650px;border:0;border-radius:18px;background:#eef3f7"></iframe>`,
    }));
  });
  app.get("/api/customer-notifications/:tenant", requireAuth, async (req,res)=>{try{const t=tenant(req.params.tenant),history=await (await getDb()).collection("customer_app_notifications").find({tenantId:t}).sort({createdAt:-1}).limit(30).project({_id:0,title:1,body:1,status:1,createdAt:1}).toArray();res.json({configured:firebaseCredentials().configured,topic:topicFor(t),history})}catch(e){res.status(500).json({error:"No se pudo cargar el panel"})}});
  app.post("/api/customer-notifications/:tenant", requireAuth, async (req,res)=>{const t=tenant(req.params.tenant),title=clean(req.body?.title,80),body=clean(req.body?.body,500),url=clean(req.body?.url,800);if(!title||!body)return res.status(400).json({error:"Completá título y mensaje."});if(url&&!/^https:\/\/asistobot\.com\.ar\//i.test(url))return res.status(400).json({error:"El enlace debe pertenecer a asistobot.com.ar."});const db=await getDb(),record={tenantId:t,topic:topicFor(t),title,body,url,status:"sending",createdAt:new Date(),createdBy:clean(req.user?.username||req.user?.email||"",120)};const inserted=await db.collection("customer_app_notifications").insertOne(record);try{const messageId=await sendTopicNotification({tenantId:t,title,body,url});await db.collection("customer_app_notifications").updateOne({_id:inserted.insertedId},{$set:{status:"sent",messageId,sentAt:new Date()}});res.json({ok:true,messageId})}catch(e){const reason=e.message==="firebase_server_credentials_missing"?"Falta configurar la credencial Firebase del servidor.":"Firebase rechazó el envío.";await db.collection("customer_app_notifications").updateOne({_id:inserted.insertedId},{$set:{status:"failed",errorCode:clean(e.message,100),updatedAt:new Date()}});res.status(503).json({error:reason})}});
}
module.exports = { mountCustomerNotifications, firebaseCredentials, topicFor };
