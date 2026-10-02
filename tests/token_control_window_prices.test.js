const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('window charges replace duplicate per-message metering, preserving other charges', () => {
  const source = fs.readFileSync(require.resolve('../token_control_stats'), 'utf8');
  const code = source.slice(source.indexOf('  function apiBillingResolution(it)'), source.indexOf('  function billingTotalArs(it,fx)'));
  const context = { num: v => Number(v) || 0,
    amountMapWithAi: (ai, amounts) => ({ ...amounts, USD: ai }),
    mergeAmountMaps: (...maps) => maps.reduce((out, map) => { for (const [k,v] of Object.entries(map)) out[k]=(out[k]||0)+v; return out; }, {}) };
  vm.createContext(context); vm.runInContext(code, context);
  const input = { billed_cost: 2, api_sources: [{ tenantId:'RVL', messages:106, windows:82, byCurrency:{ARS:1640} }],
    monetization_items:[{eventKey:'whatsapp.api_sent',tenantId:'RVL',quantity:106,potentialAmount:2120,billedAmount:2120,currency:'ARS'}],
    monetization_amounts:{ARS:2220} };
  const result = context.billingTotalMap(input);
  assert.equal(result.ARS,1740); assert.equal(result.USD,2);
  input.api_sources[0].byCurrency.ARS = 1400;
  assert.equal(context.billingTotalMap(input).ARS,1500); // historical tariffs, not count × current price
});
