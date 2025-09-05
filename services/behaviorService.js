// services/behaviorService.js
const { getDb } = require("./mongoService");
const { loadProductsFromSheet, buildCatalogText } = require("./sheetsService");

const BEHAVIOR_SOURCE = (process.env.BEHAVIOR_SOURCE || "sheet").toLowerCase();
const COMPORTAMIENTO_CACHE_TTL_MS = 5 * 60 * 1000;
let behaviorCache = { at: 0, text: null };

async function loadBehaviorTextFromEnv() {
  const txt = (process.env.COMPORTAMIENTO || "Sos un asistente claro, amable y conciso. Respondé en español.").trim();
  return txt;
}
async function loadBehaviorTextFromSheet() {
  const { getSheetsClient, getSpreadsheetIdFromEnv } = require("./sheetsService");
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Comportamiento_API!A1:B100"
  });
  const rows = resp.data.values || [];
  const parts = rows
    .map(r => {
      const a = (r[0] || "").replace(/\s+/g, " ").trim();
      const b = (r[1] || "").replace(/\s+/g, " ").trim();
      const line = [a, b].filter(Boolean).join(" ").trim();
      return line;
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : "Sos un asistente claro, amable y conciso. Respondé en español.";
}
async function loadBehaviorTextFromMongo() {
  const db = await getDb();
  const doc = await db.collection("settings").findOne({ _id: "behavior" });
  if (doc && typeof doc.text === "string" && doc.text.trim()) return doc.text.trim();
  const fallback = "Sos un asistente claro, amable y conciso. Respondé en español.";
  await db.collection("settings").updateOne(
    { _id: "behavior" },
    { $setOnInsert: { text: fallback, updatedAt: new Date() } },
    { upsert: true }
  );
  return fallback;
}
async function saveBehaviorTextToMongo(newText) {
  const db = await getDb();
  await db.collection("settings").updateOne(
    { _id: "behavior" },
    { $set: { text: String(newText || "").trim(), updatedAt: new Date() } },
    { upsert: true }
  );
  behaviorCache = { at: 0, text: null };
}

async function buildSystemPrompt({ force = false, conversation = null } = {}) {
  if (conversation && conversation.behaviorSnapshot && conversation.behaviorSnapshot.text) {
    return conversation.behaviorSnapshot.text;
  }
  const now = Date.now();
  if (!force && (now - behaviorCache.at < COMPORTAMIENTO_CACHE_TTL_MS) && behaviorCache.text) {
    return behaviorCache.text;
  }
  const baseText = (BEHAVIOR_SOURCE === "env")
    ? await loadBehaviorTextFromEnv()
    : (BEHAVIOR_SOURCE === "mongo")
      ? await loadBehaviorTextFromMongo()
      : await loadBehaviorTextFromSheet();

  let catalogText = "";
  try {
    const products = await loadProductsFromSheet();
    catalogText = buildCatalogText(products);
  } catch (e) {
    console.warn("⚠️ No se pudo leer Productos:", e.message);
    catalogText = "Catálogo de productos: (error al leer)";
  }
  const reglasVenta =
    "Instrucciones de venta (OBLIGATORIAS):\n" +
    "- Usá las Observaciones para decidir qué ofrecer, sugerir complementos, aplicar restricciones o proponer sustituciones.\n" +
    "- Respetá limitaciones (stock/horarios/porciones/preparación) indicadas en Observaciones.\n" +
    "- Si sugerís bundles o combos, ofrecé esas opciones con precio estimado cuando corresponda.\n" +
    "- Si falta un dato (sabor/tamaño/cantidad), pedilo brevemente.\n";

  const jsonSchema =
    "FORMATO DE RESPUESTA (OBLIGATORIO - SOLO JSON, sin ```):\n" +
    '{ "response": "texto para WhatsApp", "estado": "IN_PROGRESS|COMPLETED|CANCELLED", ' +
    '  "Pedido"?: { "Fecha y hora de inicio de conversacion": string, "Fecha y hora fin de conversacion": string, "Estado pedido": string, "Motivo cancelacion": string, "Pedido pollo": string, "Pedido papas": string, "Milanesas comunes": string, "Milanesas Napolitanas": string, "Ensaladas": string, "Bebidas": string, "Monto": number, "Nombre": string, "Entrega": string, "Domicilio": string, "Fecha y hora de entrega": string, "Hora": string }, ' +
    '  "Bigdata"?: { "Sexo": string, "Estudios": string, "Satisfaccion del cliente": number, "Motivo puntaje satisfaccion": string, "Cuanto nos conoce el cliente": number, "Motivo puntaje conocimiento": string, "Motivo puntaje general": string, "Perdida oportunidad": string, "Sugerencias": string, "Flujo": string, "Facilidad en el proceso de compras": number, "Pregunto por bot": string } }';

  const fullText = [
    "[COMPORTAMIENTO]\n" + baseText,
    "[REGLAS]\n" + reglasVenta,
    "[CATALOGO]\n" + catalogText,
    "[SALIDA]\n" + jsonSchema,
    "RECORDATORIOS: Respondé en español. No uses bloques de código. Devolvé SOLO JSON plano."
  ].join("\n\n").trim();

  behaviorCache = { at: now, text: fullText };
  return fullText;
}

// Routes handlers
async function getBehaviorUI(_req, res) {
  try {
    const text = (BEHAVIOR_SOURCE === "env")
      ? await loadBehaviorTextFromEnv()
      : (BEHAVIOR_SOURCE === "mongo")
        ? await loadBehaviorTextFromMongo()
        : await loadBehaviorTextFromSheet();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Comportamiento del Bot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <h1>Comportamiento del Bot</h1>
  <p>Fuente actual: <strong>${BEHAVIOR_SOURCE}</strong></p>
  <pre style="white-space:pre-wrap;border:1px solid #ddd;padding:8px;">${text.replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>
  ${BEHAVIOR_SOURCE === "mongo" ? '<form method="post" action="/api/behavior"><textarea name="text" style="width:100%;height:300px;"></textarea><br/><button type="submit">Guardar</button></form>' : ''}
</body>
</html>`);
  } catch (e) {
    console.error("⚠️ /comportamiento error:", e);
    res.status(500).send("internal");
  }
}

async function getBehavior(_req, res) {
  try {
    const text = (BEHAVIOR_SOURCE === "env")
      ? await loadBehaviorTextFromEnv()
      : (BEHAVIOR_SOURCE === "mongo")
        ? await loadBehaviorTextFromMongo()
        : await loadBehaviorTextFromSheet();
    res.json({ source: BEHAVIOR_SOURCE, text });
  } catch (e) {
    res.status(500).json({ error: "internal" });
  }
}
async function saveBehavior(req, res) {
  try {
    if (BEHAVIOR_SOURCE !== "mongo") {
      return res.status(400).json({ error: "behavior_source_not_mongo" });
    }
    const text = String((req.body && req.body.text) || "").trim();
    await saveBehaviorTextToMongo(text);
    res.json({ ok: true });
  } catch (e) {
    console.error("⚠️ POST /api/behavior error:", e);
    res.status(500).json({ error: "internal" });
  }
}

module.exports = { buildSystemPrompt, getBehaviorUI, getBehavior, saveBehavior };
