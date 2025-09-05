const { getDb } = require('./db');
const { getActiveProducts, buildCatalogText } = require('./productService');

const COMPORTAMIENTO_CACHE_TTL_MS = 5 * 60 * 1000;
let behaviorCache = { at: 0, text: null };

async function loadBehaviorTextFromMongo() {
  const db = await getDb();
  const doc = await db.collection('settings').findOne({ _id: 'behavior' });
  if (doc && typeof doc.text === 'string' && doc.text.trim()) return doc.text.trim();
  const fallback = "Sos un asistente claro, amable y conciso. Respondé en español.";
  await db.collection('settings').updateOne(
    { _id: 'behavior' },
    { $setOnInsert: { text: fallback, updatedAt: new Date() } },
    { upsert: true }
  );
  return fallback;
}

async function buildSystemPrompt({ force = false } = {}) {
  const now = Date.now();
  if (!force && behaviorCache.text && (now - behaviorCache.at < COMPORTAMIENTO_CACHE_TTL_MS)) {
    return behaviorCache.text;
  }

  const baseText = await loadBehaviorTextFromMongo();

  let catalogText = "";
  try {
    const products = await getActiveProducts();
    catalogText = buildCatalogText(products);
  } catch (e) {
    console.warn("⚠️ No se pudo leer catálogo desde Mongo:", e.message);
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
    '"Pedido"?: { "Items": [ { "Item": string, "Cantidad": number, "PrecioUnitario"?: number, "Subtotal"?: number } ], ' +
    '"Total"?: number, "Pago"?: string, "Nombre"?: string, "Domicilio"?: string }, ' +
    '"Bigdata"?: { "Sexo"?: string, "Estudios"?: string, "Satisfaccion del cliente"?: number, "Motivo puntaje satisfaccion"?: string, "Cuanto nos conoce el cliente"?: number, "Motivo puntaje conocimiento"?: string, "Motivo puntaje general"?: string, "Perdida oportunidad"?: string, "Sugerencias"?: string, "Flujo"?: string, "Facilidad en el proceso de compras"?: number, "Pregunto por bot"?: string } }';

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

module.exports = { buildSystemPrompt, loadBehaviorTextFromMongo };
