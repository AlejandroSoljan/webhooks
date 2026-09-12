// Asisto | Version: 5.00.120 | Fecha: 2026-09-12
// Prueba HTTP escalonada y acotada para la app pública DEMO_FERRETERIA.
'use strict';

const { performance } = require('node:perf_hooks');
const ORIGIN = String(process.env.LOADTEST_ORIGIN || 'https://asistobot.com.ar').replace(/\/$/, '');
const TENANT = 'DEMO_FERRETERIA';
const CODE = String(process.env.LOADTEST_CODE || '253000018');
const LEVELS = String(process.env.LOADTEST_LEVELS || '5,10,50,100,500').split(',').map(Number).filter(n => n > 0);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function one(url, options) {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status, ms: performance.now() - started };
  } catch (error) {
    return { ok: false, status: 0, ms: performance.now() - started, error: error?.name || 'error' };
  }
}

async function batch(name, concurrency, makeRequest) {
  const started = performance.now();
  const rows = await Promise.all(Array.from({ length: concurrency }, (_, i) => makeRequest(i)));
  const elapsedMs = performance.now() - started;
  const times = rows.map(row => row.ms);
  const statuses = rows.reduce((out, row) => ({ ...out, [row.status]: (out[row.status] || 0) + 1 }), {});
  return {
    name, users: concurrency, requests: rows.length,
    success: rows.filter(row => row.ok).length,
    errors: rows.filter(row => !row.ok).length,
    elapsedMs: +elapsedMs.toFixed(1), rps: +(rows.length / (elapsedMs / 1000)).toFixed(2),
    avgMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1),
    p50Ms: +percentile(times, 50).toFixed(1), p95Ms: +percentile(times, 95).toFixed(1),
    p99Ms: +percentile(times, 99).toFixed(1), maxMs: +Math.max(...times).toFixed(1), statuses
  };
}

async function run() {
  const scenarios = [
    ['android_app_open', () => one(`${ORIGIN}/customer-app/${TENANT}`)],
    ['qr_page_open', () => one(`${ORIGIN}/qr/${TENANT}?codigo=${encodeURIComponent(CODE)}`)],
    ['product_lookup', () => one(`${ORIGIN}/api/ext/qr/product?tenant=${TENANT}&codigo=${encodeURIComponent(CODE)}`)],
    ['conversation_mongo_read', i => one(`${ORIGIN}/api/ext/qr/chat/messages?tenant=${TENANT}&codigo=${encodeURIComponent(CODE)}&sessionId=load-${Date.now()}-${i}`)]
  ];
  const results = [];
  for (const users of LEVELS) {
    for (const [name, request] of scenarios) {
      const result = await batch(name, users, request);
      results.push(result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  process.stdout.write(`RESULTS_JSON=${JSON.stringify(results)}\n`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
