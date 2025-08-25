// server.js
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai");
const { google } = require("googleapis");
const { ObjectId } = require("mongodb");
const { getDb } = require("./db");

const app = express();

/* ===================== Body / firma ===================== */
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

function isValidSignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = req.get("X-Hub-Signature-256");
  if (!appSecret || !signature) return false;
  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(req.rawBody);
  const expected = "sha256=" + hmac.digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
  catch { return false; }
}

/* ===================== OpenAI ===================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHAT_TEMPERATURE = Number.isFinite(parseFloat(process.env.OPENAI_TEMPERATURE))
  ? parseFloat(process.env.OPENAI_TEMPERATURE) : 0.2;

/* ===================== Helpers varias ===================== */
function fmt(d) {
  if (!d) return "";
  return new Date(d).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}
function fmtMoney(v) {
  if (v === undefined || v === null) return "";
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(Number(v) || 0);
}
function escapeHtml(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

/* ===================== Google Sheets ===================== */
function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Faltan credenciales de Google (email/clave).");
  const auth = new google.auth.JWT(email, null, key, ["https://www.googleapis.com/auth/spreadsheets"]);
  return google.sheets({ version: "v4", auth });
}
function getSpreadsheetIdFromEnv() {
  const raw = (process.env.GOOGLE_SHEETS_ID || "").trim();
  if (!raw) throw new Error("Falta GOOGLE_SHEETS_ID.");
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw;
}

// Productos activos (A nombre, B precio, C venta, D obs, E activo = S/N)
async function loadProductsFromSheet() {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: "Productos!A2:E"
  });
  const rows = resp.data.values || [];
  return rows
    .map(r => {
      const activo = (r[4] || "").toUpperCase() === "S";
      if (!activo) return null;
      return {
        nombre: (r[0] || "").trim(),
        precio: (r[1] || "").trim(),
        venta:  (r[2] || "").trim(),
        obs:    (r[3] || "").trim()
      };
    })
    .filter(Boolean);
}

// Comportamiento desde sheet (A y B concatenadas por fila)
async function loadBehaviorTextFromSheet() {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: "Comportamiento_API!A1:B100"
  });
  const rows = resp.data.values || [];
  const parts = rows.map(r => (String(r[0] || "").trim() + " " + String(r[1] || "").trim()).trim())
                    .filter(Boolean);
  return parts.length ? parts.join("\n") : "Sos un asistente claro, amable y conciso. Respondé en español.";
}

/* ===================== Mongo helpers ===================== */
async function insertFinalOrderDocument({ waId, conversationId, responseText, pedido, bigdata, estado }) {
  const db = await getDb();
  const doc = {
    waId,
    conversationId,
    estado,
    response: responseText || "",
    pedido: pedido || {},
    bigdata: bigdata || {},
    createdAt: new Date()
  };
  await db.collection("orders").insertOne(doc);
}

/* ===================== Admin HTML helpers ===================== */
function renderPage(title, body) {
  return `<!DOCTYPE html>
  <html lang="es"><head><meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:system-ui, Arial, sans-serif; margin:20px;}
    table{border-collapse:collapse; width:100%; margin:16px 0;}
    th,td{border:1px solid #ddd; padding:8px; font-size:14px}
    th{background:#f6f6f6}
    .kpis{display:flex; gap:12px; flex-wrap:wrap; margin:6px 0 10px}
    .kpis>div{background:#fafafa; border:1px solid #ddd; padding:8px 10px; border-radius:8px}
    .pill{border-radius:12px; padding:2px 8px; font-size:12px; border:1px solid #ddd}
    .ok{background:#dff5dd}
    .bad{background:#ffe1e1}
    .warn{background:#fff5d6}
    .topbar a{margin-right:12px}
    input,select{padding:6px; margin-right:6px}
    .filters{margin-bottom:10px}
    a.btn{display:inline-block; padding:6px 10px; border:1px solid #ccc; border-radius:6px; text-decoration:none}
  </style></head>
  <body>${body}</body></html>`;
}

function pedidoResumen(p = {}) {
  return [
    p["Pedido pollo"],
    p["Pedido papas"],
    p["Milanesas comunes"],
    p["Milanesas Napolitanas"],
    p["Ensaladas"],
    p["Bebidas"]
  ].filter(Boolean).join(", ");
}
function num(v, d=0){ const n=Number(v); return Number.isFinite(n) ? n : d; }
function extractProductsFromPedido(p={}) {
  const items = [];
  for (const [k, raw] of Object.entries(p)) {
    if (!raw) continue;
    if ([
      "Fecha y hora de inicio de conversacion","Fecha y hora fin de conversacion","Estado pedido",
      "Motivo cancelacion","Monto","Nombre","Entrega","Domicilio","Fecha y hora de entrega","Hora"
    ].includes(k)) continue;
    let s = String(raw).trim();
    if (!s) continue;
    s = s.split("(")[0].trim();
    for (const part of s.split(/[+,/]| y /i)) {
      const t = part.trim();
      if (t) items.push(t);
    }
  }
  return items;
}
function buildOrdersQuery(q) {
  const query = {};
  if (q.wa) query.waId = q.wa;
  if (q.estado) query.estado = q.estado;
  if (q.from || q.to) {
    query.createdAt = {};
    if (q.from) query.createdAt.$gte = new Date(q.from);
    if (q.to)   query.createdAt.$lte = new Date(q.to);
  }
  return query;
}

/* ===================== Admin Rutas ===================== */
app.get("/admin/orders/:id.json", async (req,res)=>{
  try{
    const db=await getDb();
    const _id=new ObjectId(req.params.id);
    const doc=await db.collection("orders").findOne({_id});
    if(!doc) return res.status(404).json({error:"No encontrada"});
    res.json(doc);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/admin/conv/:convId/order.json", async (req,res)=>{
  try{
    const db=await getDb();
    const conversationId=new ObjectId(req.params.convId);
    const doc=await db.collection("orders").findOne({conversationId});
    if(!doc) return res.status(404).json({error:"No encontrada"});
    res.json(doc);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/admin/orders", async (req,res)=>{
  try{
    const db=await getDb();
    const q=buildOrdersQuery(req.query);
    const {limit="50",skip="0"}=req.query;
    const lim=Math.min(200,Math.max(1,parseInt(limit)||50));
    const sk=Math.max(0,parseInt(skip)||0);

    const all=await db.collection("orders").find(q).toArray();
    const total=all.length;
    const completed=all.filter(o=>(o.estado||"")==="COMPLETED");
    const cancelled=all.filter(o=>(o.estado||"")==="CANCELLED");
    const totalRevenue=completed.reduce((a,o)=>a+num(o?.pedido?.["Monto"]),0);
    const avgTicket=completed.length? totalRevenue/completed.length : 0;
    const cancelRate= total ? 100*cancelled.length/total : 0;

    const counts=new Map();
    for(const o of all){
      for(const it of extractProductsFromPedido(o.pedido||{})){
        counts.set(it,(counts.get(it)||0)+1);
      }
    }
    const topProducts=Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5);

    const docs=await db.collection("orders").find(q).sort({createdAt:-1}).skip(sk).limit(lim).toArray();
    const rows=docs.map(o=>{
      const p=o.pedido||{};
      const resumen=pedidoResumen(p);
      const monto=p["Monto"]?fmtMoney(p["Monto"]):"";
      const pill=o.estado==="COMPLETED"?"pill ok":o.estado==="CANCELLED"?"pill bad":"pill warn";
      return `<tr>
        <td>${escapeHtml(fmt(o.createdAt))}</td>
        <td><span class="${pill}">${escapeHtml(o.estado||"")}</span></td>
        <td>${escapeHtml(o.waId||"")}</td>
        <td>${escapeHtml(resumen||"-")}</td>
        <td>${escapeHtml(monto||"-")}</td>
        <td><a class="btn" href="/admin/orders/${o._id}.json">JSON</a> <a class="btn" href="/admin/conv/${o.conversationId}/order.json">por conv</a></td>
      </tr>`;
    }).join("");

    const kpiHtml=`
      <div class="kpis">
        <div><b>Total</b> ${total}</div>
        <div><b>Completadas</b> ${completed.length}</div>
        <div><b>Canceladas</b> ${cancelled.length}</div>
        <div><b>% Cancelación</b> ${cancelRate.toFixed(1)}%</div>
        <div><b>Ticket Prom</b> ${fmtMoney(avgTicket)}</div>
        <div><b>Facturación</b> ${fmtMoney(totalRevenue)}</div>
      </div>
      <h3>Top productos</h3>
      <ol>${topProducts.map(([n,c])=>`<li>${escapeHtml(n)} (${c})</li>`).join("") || "<li>(sin datos)</li>"}</ol>
      <div class="filters">
        <form>
          <input type="text" name="wa" placeholder="waId" value="${escapeHtml(req.query.wa||"")}"/>
          <select name="estado">
            <option value="">(estado)</option>
            ${["COMPLETED","CANCELLED","IN_PROGRESS"].map(s=>`<option ${req.query.estado===s?"selected":""}>${s}</option>`).join("")}
          </select>
          <input type="date" name="from" value="${escapeHtml((req.query.from||"").slice(0,10))}"/>
          <input type="date" name="to" value="${escapeHtml((req.query.to||"").slice(0,10))}"/>
          <input type="number" min="1" max="200" name="limit" value="${lim}"/>
          <button class="btn" type="submit">Filtrar</button>
          <a class="btn" href="/admin/orders">Limpiar</a>
        </form>
      </div>
    `;

    res.send(renderPage("Órdenes", `
      <div class="topbar">
        <a href="/admin/orders" class="btn">Órdenes</a>
      </div>
      <h1>Órdenes</h1>
      ${kpiHtml}
      <table>
        <thead><tr><th>Creado</th><th>Estado</th><th>WA</th><th>Resumen</th><th>Monto</th><th>Acciones</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `));
  }catch(e){
    res.status(500).send(renderPage("Error", `<pre>${escapeHtml(e.stack||e.message)}</pre>`));
  }
});

/* ===================== Webhook WhatsApp (tu lógica) ===================== */
/* 
  ⚠️ Mantén tu webhook existente. 
  Solo asegurate de llamar a insertFinalOrderDocument() CUANDO finalices:

  await insertFinalOrderDocument({
    waId: from,
    conversationId: conv._id,
    responseText,                 // texto final que se envió al user
    pedido: raw?.Pedido,          // objeto Pedido completo del JSON del modelo
    bigdata: raw?.Bigdata,        // objeto Bigdata del JSON del modelo
    estado                         // COMPLETED | CANCELLED
  });

  Esto insertará la orden en `orders` y ya estará accesible en /admin/orders
*/

app.get("/", (_req, res) => res.status(200).send("Webhook activo ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 escuchando en ${PORT}`));
