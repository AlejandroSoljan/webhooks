// services/sheetsService.js
const { google } = require("googleapis");

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
  const m = raw.match(/\\/spreadsheets\\/d\\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw;
}
async function ensureHeaderIfEmpty({ sheetName, header }) {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const getResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!1:1` });
  const hasHeader = (getResp.data.values && getResp.data.values.length > 0);
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${sheetName}!A1`, valueInputOption: "RAW",
      requestBody: { values: [header] }
    });
  }
}
async function appendRow({ sheetName, values }) {
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: `${sheetName}!A:A`,
    valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] }
  });
}

function headerPedido() {
  return [
    "wa_id","response","Fecha y hora de inicio de conversacion","Fecha y hora fin de conversacion",
    "Estado pedido","Motivo cancelacion","Pedido pollo","Pedido papas","Milanesas comunes","Milanesas Napolitanas",
    "Ensaladas","Bebidas","Monto","Nombre","Entrega","Domicilio","Fecha y hora de entrega","Hora"
  ];
}
function flattenPedido({ waId, response, pedido }) {
  const p = pedido || {};
  return [
    waId || "", response || "",
    p["Fecha y hora de inicio de conversacion"] || "",
    p["Fecha y hora fin de conversacion"] || "",
    p["Estado pedido"] || "", p["Motivo cancelacion"] || "",
    p["Pedido pollo"] || "", p["Pedido papas"] || "",
    p["Milanesas comunes"] || "", p["Milanesas Napolitanas"] || "",
    p["Ensaladas"] || "", p["Bebidas"] || "", p["Monto"] ?? "",
    p["Nombre"] || "", p["Entrega"] || "", p["Domicilio"] || "",
    p["Fecha y hora de entrega"] || "", p["Hora"] || ""
  ];
}
function headerBigdata() {
  return [
    "wa_id","Sexo","Estudios","Satisfaccion del cliente","Motivo puntaje satisfaccion",
    "Cuanto nos conoce el cliente","Motivo puntaje conocimiento","Motivo puntaje general",
    "Perdida oportunidad","Sugerencias","Flujo","Facilidad en el proceso de compras","Pregunto por bot"
  ];
}
function flattenBigdata({ waId, bigdata }) {
  const b = bigdata || {};
  return [
    waId || "", b["Sexo"] || "", b["Estudios"] || "",
    b["Satisfaccion del cliente"] ?? "", b["Motivo puntaje satisfaccion"] || "",
    b["Cuanto nos conoce el cliente"] ?? "", b["Motivo puntaje conocimiento"] || "",
    b["Motivo puntaje general"] || "", b["Perdida oportunidad"] || "",
    b["Sugerencias"] || "", b["Flujo"] || "",
    b["Facilidad en el proceso de compras"] ?? "", b["Pregunto por bot"] || ""
  ];
}
async function saveCompletedToSheets({ waId, data }) {
  const response = data?.response || "";
  const pedido = data?.Pedido || {};
  const bigdata = data?.Bigdata || {};

  const hPedido = headerPedido();
  const vPedido = flattenPedido({ waId, response, pedido });
  await ensureHeaderIfEmpty({ sheetName: "Hoja 1", header: hPedido });
  await appendRow({ sheetName: "Hoja 1", values: vPedido });

  const hBig = headerBigdata();
  const vBig = flattenBigdata({ waId, bigdata });
  await ensureHeaderIfEmpty({ sheetName: "BigData", header: hBig });
  await appendRow({ sheetName: "BigData", values: vBig });
}

// Productos (Sheet)
const PRODUCTS_CACHE_TTL_MS = parseInt(process.env.PRODUCTS_CACHE_TTL_MS || "300000", 10);
let productsCache = { at: 0, items: [] };
function looksActive(v) { return String(v || "").trim().toUpperCase() === "S"; }
async function loadProductsFromSheet() {
  const now = Date.now();
  if (now - productsCache.at < PRODUCTS_CACHE_TTL_MS && productsCache.items?.length) {
    return productsCache.items;
  }
  const spreadsheetId = getSpreadsheetIdFromEnv();
  const sheets = getSheetsClient();
  const range = "Productos!A2:E";
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = resp.data.values || [];
  const items = rows.map((r) => {
    const nombre = (r[0] || "").trim();
    const precioRaw = (r[1] || "").trim();
    const venta = (r[2] || "").trim();
    const obs = (r[3] || "").trim();
    const activo = r[4];
    if (!nombre) return null;
    if (!looksActive(activo)) return null;
    const maybeNum = Number(precioRaw.replace(/[^\d.,-]/g, "").replace(",", "."));
    const precio = Number.isFinite(maybeNum) ? maybeNum : precioRaw;
    return { nombre, precio, venta, obs };
  }).filter(Boolean);
  productsCache = { at: now, items };
  return items;
}
function buildCatalogText(items) {
  if (!items?.length) return "Catálogo de productos: (ninguno activo)";
  const lines = items.map(it => {
    const precioTxt = (typeof it.precio === "number") ? ` — $${it.precio}` : (it.precio ? ` — $${it.precio}` : "");
    const ventaTxt  = it.venta ? ` (${it.venta})` : "";
    const obsTxt    = it.obs ? ` | Obs: ${it.obs}` : "";
    return `- ${it.nombre}${precioTxt}${ventaTxt}${obsTxt}`;
  });
  return "Catálogo de productos (nombre — precio (modo de venta) | Obs: observaciones):\n" + lines.join("\n");
}

module.exports = {
  getSheetsClient,
  getSpreadsheetIdFromEnv,
  ensureHeaderIfEmpty,
  appendRow,
  saveCompletedToSheets,
  loadProductsFromSheet,
  buildCatalogText,
};
