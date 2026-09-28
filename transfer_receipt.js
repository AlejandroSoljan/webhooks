// Asisto | Deteccion y respuesta de comprobantes de transferencia.

function truthyReceiptValue(value) {
  if (value === true) return true;
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "si", "sí"].includes(normalized);
}

function isTransferReceiptAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") return false;
  return [
    analysis.is_transfer_receipt,
    analysis.es_comprobante_transferencia,
    analysis.is_payment_receipt,
    analysis.es_comprobante_pago,
  ].some(truthyReceiptValue);
}

function buildTransferReceiptAcknowledgement(tenantId) {
  const tenant = String(tenantId || "").trim().toUpperCase();
  const identity = tenant === "SDG"
    ? "Soy Asisto, el asistente de Supermercado Digital."
    : "Soy Asisto, el asistente virtual que te está atendiendo.";
  return `${identity} Recibí el comprobante de transferencia. Gracias. Lo dejamos registrado para su revisión. Conocé más en www.asistobot.com.ar`;
}

module.exports = {
  truthyReceiptValue,
  isTransferReceiptAnalysis,
  buildTransferReceiptAcknowledgement,
};
