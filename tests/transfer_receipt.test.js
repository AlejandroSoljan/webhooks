const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isTransferReceiptAnalysis,
  buildTransferReceiptAcknowledgement,
} = require("../transfer_receipt");

test("reconoce flags booleanos y textuales de comprobante", () => {
  assert.equal(isTransferReceiptAnalysis({ is_transfer_receipt: true }), true);
  assert.equal(isTransferReceiptAnalysis({ is_transfer_receipt: "true" }), true);
  assert.equal(isTransferReceiptAnalysis({ es_comprobante_transferencia: "sí" }), true);
  assert.equal(isTransferReceiptAnalysis({ is_transfer_receipt: false }), false);
  assert.equal(isTransferReceiptAnalysis(null), false);
});

test("la respuesta SDG se presenta como Asisto y no confirma acreditación", () => {
  const reply = buildTransferReceiptAcknowledgement("SDG");
  assert.match(reply, /Soy Asisto, el asistente de Supermercado Digital/i);
  assert.match(reply, /Recibí el comprobante de transferencia/i);
  assert.match(reply, /www\.asistobot\.com\.ar/i);
  assert.doesNotMatch(reply, /pago confirmado|acreditad[oa]/i);
});
