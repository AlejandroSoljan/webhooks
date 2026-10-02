'use strict';

// This first stage deliberately has NO production-write mode. Subscription
// authorization is not evidence of payment, nor approval of a monthly invoice.
const crypto = require('node:crypto');
const API = 'https://api.mercadopago.com';
const TEST_AMOUNT = 10;
const id = value => /^[a-zA-Z0-9_-]{1,120}$/.test(String(value || '')) ? String(value) : '';

function settings(env = process.env) {
  return {
    mode: env.MP_SUBSCRIPTIONS_MODE === 'test' ? 'test' : 'disabled',
    token: String(env.MP_SUBSCRIPTIONS_ACCESS_TOKEN || ''),
    secret: String(env.MP_SUBSCRIPTIONS_WEBHOOK_SECRET || ''),
    payerId: String(env.MP_SUBSCRIPTIONS_TEST_PAYER_ID || ''),
    baseUrl: String(env.MP_SUBSCRIPTIONS_PUBLIC_URL || '').replace(/\/$/, '')
  };
}

function publicSettings(config = settings()) {
  let validUrl = false;
  try { const url = new URL(config.baseUrl); validUrl = url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch {}
  return { mode: config.mode, credentialsConfigured: !!config.token, webhookConfigured: !!config.secret,
    testPayerConfigured: !!id(config.payerId), publicUrlConfigured: validUrl,
    testReady: config.mode === 'test' && !!config.token && !!config.secret && !!id(config.payerId) && validUrl,
    liveDebitsEnabled: false, testAmountArs: TEST_AMOUNT };
}

async function request(config, path, { method = 'GET', body, key, fetcher = fetch } = {}) {
  if (!config.token) throw new Error('mp_not_configured');
  const response = await fetcher(API + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'X-Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  // Provider bodies can contain sensitive account details; never expose them.
  if (!response.ok) throw new Error(`mp_http_${response.status}`);
  return response.json();
}

async function verifyTestAccounts(config, fetcher) {
  if (!publicSettings(config).testReady) throw new Error('mp_test_not_ready');
  const seller = await request(config, '/users/me', { fetcher });
  const payer = await request(config, '/users/' + encodeURIComponent(config.payerId), { fetcher });
  if (!seller.tags?.includes('test_user') || !payer.tags?.includes('test_user') ||
      String(seller.id) === String(payer.id) || String(payer.id) !== config.payerId ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payer.email || '')) throw new Error('mp_test_accounts_required');
  return { sellerId: String(seller.id), payerEmail: payer.email };
}

function pendingPayload(reference, email, baseUrl) {
  return { reason: 'PRUEBA Asisto · adhesión mensual (sin consumos reales)', external_reference: reference,
    payer_email: email, auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: TEST_AMOUNT, currency_id: 'ARS' },
    back_url: baseUrl + '/webhooks/mercadopago/subscriptions/return', status: 'pending' };
}

function checkoutUrl(raw) {
  try { const url = new URL(raw); return url.protocol === 'https:' && url.hostname === 'www.mercadopago.com.ar' && url.pathname === '/subscriptions/checkout' ? url.href : null; } catch { return null; }
}

function validSignature({ dataId, requestId, signature, secret }) {
  if (!id(dataId) || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(requestId) || !secret) return false;
  const parts = String(signature || '').split(',').map(part => part.trim().split('='));
  const ts = parts.find(([key]) => key === 'ts')?.[1];
  if (!/^\d{10,13}$/.test(ts || '')) return false;
  const expected = crypto.createHmac('sha256', secret).update(`id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`).digest();
  // Retries may retain the original timestamp. Replay is safe because we fetch
  // the authoritative resource and store it by provider ID/update timestamp.
  return parts.some(([key, value]) => key === 'v1' && /^[a-fA-F0-9]{64}$/.test(value || '') && crypto.timingSafeEqual(expected, Buffer.from(value, 'hex')));
}

async function createTestSubscription(db, owner, actor, config = settings(), fetcher = fetch) {
  const accounts = await verifyTestAccounts(config, fetcher);
  const subscriptions = db.collection('billing_subscriptions');
  const reference = 'asisto-test-' + crypto.randomUUID();
  const row = { _id: 'test:' + owner, owner, mode: 'test', reference, status: 'creating',
    sellerId: accounts.sellerId, amountArs: TEST_AMOUNT, createdAt: new Date(), createdBy: actor };
  // Durable reservation before the external write. A timeout is UNKNOWN, never
  // an excuse to POST a second subscription. Only reconciliation can recover it.
  try { await subscriptions.insertOne(row); }
  catch (error) { if (error.code === 11000) throw new Error('subscription_exists_reconcile'); throw error; }
  try {
    const remote = await request(config, '/preapproval', { method: 'POST',
      body: pendingPayload(reference, accounts.payerEmail, config.baseUrl), key: reference, fetcher });
    if (!id(remote.id) || remote.external_reference !== reference || String(remote.collector_id) !== accounts.sellerId) throw new Error('mp_response_mismatch');
    const update = { providerId: String(remote.id), status: String(remote.status || 'pending'),
      checkoutUrl: checkoutUrl(remote.init_point), updatedAt: new Date() };
    await subscriptions.updateOne({ _id: row._id }, { $set: update });
    return { ...row, ...update };
  } catch (error) {
    await subscriptions.updateOne({ _id: row._id }, { $set: { status: 'unknown', updatedAt: new Date() } });
    throw new Error('mp_creation_unknown_reconcile');
  }
}

async function reconcileSubscription(db, row, config = settings(), fetcher = fetch) {
  const accounts = await verifyTestAccounts(config, fetcher);
  if (accounts.sellerId !== row.sellerId) throw new Error('mp_account_mismatch');
  let remote;
  if (row.providerId) remote = await request(config, '/preapproval/' + encodeURIComponent(row.providerId), { fetcher });
  else {
    const found = await request(config, '/preapproval/search?external_reference=' + encodeURIComponent(row.reference), { fetcher });
    const matches = (found.results || []).filter(item => item.external_reference === row.reference);
    if (matches.length !== 1) throw new Error('mp_reconciliation_required');
    remote = matches[0];
  }
  if (!id(remote.id) || remote.external_reference !== row.reference || String(remote.collector_id) !== row.sellerId) throw new Error('mp_response_mismatch');
  const providerUpdatedAt = new Date(remote.last_modified || 0);
  if (!Number.isFinite(providerUpdatedAt.getTime())) throw new Error('mp_response_mismatch');
  await db.collection('billing_subscriptions').updateOne({ _id: row._id,
    $or: [{ providerUpdatedAt: { $exists: false } }, { providerUpdatedAt: { $lte: providerUpdatedAt } }] },
  { $set: { providerId: String(remote.id), status: String(remote.status), checkoutUrl: checkoutUrl(remote.init_point),
    providerUpdatedAt, updatedAt: new Date() } });
  return db.collection('billing_subscriptions').findOne({ _id: row._id });
}

async function cancelTestSubscription(db, row, config = settings(), fetcher = fetch) {
  const current = await reconcileSubscription(db, row, config, fetcher);
  if (current.status !== 'cancelled') await request(config, '/preapproval/' + encodeURIComponent(current.providerId), {
    method: 'PUT', body: { status: 'cancelled' }, fetcher
  });
  return reconcileSubscription(db, current, config, fetcher);
}

async function reconcilePayment(db, paymentId, config = settings(), fetcher = fetch) {
  if (!id(paymentId)) throw new Error('invalid_id');
  const accounts = await verifyTestAccounts(config, fetcher);
  const payment = await request(config, '/v1/payments/' + encodeURIComponent(paymentId), { fetcher });
  if (String(payment.id) !== String(paymentId) || payment.live_mode !== false || String(payment.collector_id) !== accounts.sellerId) throw new Error('mp_response_mismatch');
  const subscription = await db.collection('billing_subscriptions').findOne({ reference: String(payment.external_reference || ''), mode: 'test' });
  if (!subscription || subscription.sellerId !== accounts.sellerId) return { ignored: true };
  const amountMatches = payment.currency_id === 'ARS' && Number(payment.transaction_amount) === subscription.amountArs;
  const updatedAt = new Date(payment.date_last_updated);
  if (!Number.isFinite(updatedAt.getTime())) throw new Error('mp_response_mismatch');
  const coll = db.collection('billing_payments'), key = 'test:' + paymentId;
  // Insert then conditional update avoids out-of-order webhooks regressing state.
  await coll.updateOne({ _id: key }, { $setOnInsert: { owner: subscription.owner, mode: 'test', providerId: String(paymentId), createdAt: new Date() } }, { upsert: true });
  await coll.updateOne({ _id: key, $or: [{ providerUpdatedAt: { $exists: false } }, { providerUpdatedAt: { $lte: updatedAt } }] }, { $set: {
    subscriptionId: subscription._id, currency: String(payment.currency_id), amount: Number(payment.transaction_amount),
    providerStatus: String(payment.status), status: amountMatches ? String(payment.status) : 'review',
    refundedAmount: Number(payment.transaction_amount_refunded || 0), providerUpdatedAt: updatedAt, checkedAt: new Date()
  } });
  // No invoice is marked paid. Matching a monthly period is a separate stage.
  return { ok: true };
}

module.exports = { settings, publicSettings, pendingPayload, validSignature, checkoutUrl, verifyTestAccounts,
  createTestSubscription, reconcileSubscription, cancelTestSubscription, reconcilePayment, request, id };
