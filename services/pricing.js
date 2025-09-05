// services/pricing.js
/**
 * Tabla de precios por modelo (USD por 1K tokens).
 * Valores por defecto; podés sobreescribir con env:
 * - PRICE_<MODEL>_INPUT, PRICE_<MODEL>_OUTPUT (por ejemplo PRICE_GPT_4O_MINI_INPUT)
 */
const DEFAULTS = {
  "gpt-4o-mini": { input: 0.0005, output: 0.0015 },
  "gpt-4o": { input: 0.005, output: 0.015 },
  "gpt-4o-transcribe": { input: 0.0002, output: 0 } // STT suele ser tarifa plana por minuto, usamos aprox por token (bajo)
};

function envPrice(key, fallback){
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getModelPrices(model){
  const key = (model || "gpt-4o-mini").toLowerCase();
  const p = DEFAULTS[key] || DEFAULTS["gpt-4o-mini"];
  // Permitir override por env (KEYS: PRICE_GPT_4O_MINI_INPUT / OUTPUT)
  const envKeyBase = "PRICE_" + (model || "gpt-4o-mini").replace(/[^a-z0-9]/gi, "_").toUpperCase();
  return {
    input: envPrice(envKeyBase + "_INPUT", p.input),
    output: envPrice(envKeyBase + "_OUTPUT", p.output)
  };
}

/**
 * Calcula costo estimado en USD a partir de usage {prompt_tokens, completion_tokens} y model.
 * Devuelve { usd, breakdown }
 */
function estimateCost(usage, model){
  if (!usage) return { usd: 0, breakdown: { inputUSD: 0, outputUSD: 0 } };
  const prices = getModelPrices(model);
  const inTok = usage.prompt_tokens || 0;
  const outTok = usage.completion_tokens || 0;
  const inputUSD  = (inTok / 1000) * prices.input;
  const outputUSD = (outTok / 1000) * prices.output;
  const usd = inputUSD + outputUSD;
  return { usd: Number(usd.toFixed(6)), breakdown: { inputUSD: Number(inputUSD.toFixed(6)), outputUSD: Number(outputUSD.toFixed(6)), inTok, outTok, model } };
}

module.exports = { estimateCost, getModelPrices };
