'use strict';
const express = require('express');
const { getDb } = require('./db');
const mp = require('./mercadopago_subscriptions');
const { renderBillingPage } = require('./billing_subscriptions_ui');

function tenantId(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,59}$/.test(text)) throw new Error('invalid_tenant');
  return text;
}

function billingGroups(docs) {
  const parents = new Map(), names = new Map();
  for (const doc of docs) {
    const owner = tenantId(doc._id); names.set(owner, String(doc.nom_emp || owner));
    for (const value of Array.isArray(doc.consumption_domains) ? doc.consumption_domains : []) {
      const child = tenantId(value);
      if (child === owner) continue;
      if (parents.has(child) && parents.get(child) !== owner) throw new Error('billing_multiple_owners');
      parents.set(child, owner);
    }
  }
  const groups = new Map();
  for (const domain of new Set([...names.keys(), ...parents.keys()])) {
    const seen = new Set(); let root = domain;
    while (parents.has(root)) { if (seen.has(root)) throw new Error('billing_cycle'); seen.add(root); root = parents.get(root); }
    if (!groups.has(root)) groups.set(root, { owner: root, company: names.get(root) || root, domains: [] });
    groups.get(root).domains.push(domain);
  }
  return [...groups.values()].map(group => ({ ...group, domains: group.domains.sort() })).sort((a, b) => a.owner.localeCompare(b.owner));
}

async function groupsFor(db) {
  return billingGroups(await db.collection('tenant_config').find({ _id: { $type: 'string', $not: /^__/ } },
    { projection: { _id: 1, nom_emp: 1, consumption_domains: 1 } }).toArray());
}

function validateProfile(raw) {
  const billingEmail = String(raw.billingEmail || '').trim();
  if (billingEmail.length > 254 || (billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail))) throw new Error('invalid_email');
  const collectionDay = Number(raw.collectionDay);
  if (!Number.isInteger(collectionDay) || collectionDay < 1 || collectionDay > 28) throw new Error('invalid_collection_day');
  return { billingEmail, collectionDay, period: 'calendar_month', currency: 'ARS',
    pricingMode: 'monthly_consumption', liveDebitsEnabled: false };
}

const errors = {
  invalid_tenant: 'Dominio inválido.', invalid_email: 'Email inválido.', invalid_collection_day: 'El día previsto debe estar entre 1 y 28.',
  billing_multiple_owners: 'Un dominio pertenece a más de un titular. Revisá los dominios asociados.',
  billing_cycle: 'Hay un ciclo entre dominios asociados. Corregí la configuración antes de facturar.',
  billing_owner_required: 'Seleccioná el titular, no un dominio secundario.',
  profile_required: 'Guardá primero la configuración del cliente.',
  mp_test_not_ready: 'Falta configurar la integración de prueba en el servidor.',
  mp_test_accounts_required: 'Sólo se admiten vendedor y comprador de prueba diferentes.',
  subscription_exists_reconcile: 'Ya existe una prueba para este cliente. Consultá su estado; no se creará otra.',
  mp_creation_unknown_reconcile: 'No se pudo confirmar el alta. Usá Consultar estado: no repitas el alta para evitar duplicados.',
  mp_reconciliation_required: 'No se encontró una única suscripción. Requiere conciliación técnica; no se creará otra.',
  mp_account_mismatch: 'La cuenta Mercado Pago no coincide con la utilizada en la prueba.',
  mp_response_mismatch: 'Mercado Pago devolvió datos que no coinciden. Requiere revisión.',
  subscription_not_found: 'Todavía no hay una suscripción de prueba.'
};

function mountBillingRoutes(app, auth, { database = getDb, config = mp.settings, fetcher = fetch } = {}) {
  const requireSuper = (req, res, next) => String(req.user?.role || '').toLowerCase() === 'superadmin'
    ? next() : res.status(403).json({ ok: false, error: 'Sólo superadmin.' });
  // A custom header + JSON, with no CORS opt-in, prevents form-based CSRF.
  const writeGuard = (req, res, next) => req.get('X-Asisto-Billing') === '1' && req.is('application/json') &&
    (!req.get('Sec-Fetch-Site') || ['same-origin', 'none'].includes(req.get('Sec-Fetch-Site')))
    ? next() : res.status(403).json({ ok: false, error: 'Solicitud no autorizada.' });
  const wrap = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); }
    catch (error) { res.status(errors[error.message] ? 409 : 503).json({ ok: false, error: errors[error.message] || 'No se pudo completar la operación. Reintentá la consulta de estado.' }); }
  };
  async function ownerContext(req) {
    const db = await database(), owner = tenantId(req.params.owner);
    const group = (await groupsFor(db)).find(row => row.owner === owner);
    if (!group) throw new Error('billing_owner_required');
    return { db, owner, group };
  }
  const actor = req => String(req.user?.username || req.user?.uid || 'superadmin');

  app.get('/admin/billing', auth.requireAuth, requireSuper, (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(renderBillingPage()));
  app.get('/api/billing/accounts', auth.requireAuth, requireSuper, wrap(async (_req, res) => {
    const db = await database();
    const [groups, profiles, subscriptions, payments] = await Promise.all([
      groupsFor(db), db.collection('billing_profiles').find({}).toArray(),
      db.collection('billing_subscriptions').find({ mode: 'test' }).toArray(),
      db.collection('billing_payments').find({ mode: 'test' }).sort({ providerUpdatedAt: -1 }).limit(100).toArray()
    ]);
    res.json({ ok: true, integration: mp.publicSettings(config()), accounts: groups.map(group => ({ ...group,
      profile: profiles.find(row => row._id === group.owner) || null,
      subscription: subscriptions.find(row => row.owner === group.owner) || null })), payments });
  }));
  app.put('/api/billing/accounts/:owner', auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {
    const { db, owner } = await ownerContext(req), profile = validateProfile(req.body || {});
    await db.collection('billing_profiles').updateOne({ _id: owner }, { $set: { ...profile, updatedAt: new Date(), updatedBy: actor(req) }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.json({ ok: true, profile });
  }));
  app.post('/api/billing/accounts/:owner/test-subscription', auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {
    const { db, owner } = await ownerContext(req);
    if (!await db.collection('billing_profiles').findOne({ _id: owner })) throw new Error('profile_required');
    res.json({ ok: true, subscription: await mp.createTestSubscription(db, owner, actor(req), config(), fetcher) });
  }));
  app.post('/api/billing/accounts/:owner/reconcile', auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {
    const { db, owner } = await ownerContext(req);
    const row = await db.collection('billing_subscriptions').findOne({ _id: 'test:' + owner });
    if (!row) throw new Error('subscription_not_found');
    res.json({ ok: true, subscription: await mp.reconcileSubscription(db, row, config(), fetcher) });
  }));
  app.post('/api/billing/accounts/:owner/cancel-test', auth.requireAuth, requireSuper, writeGuard, express.json({ limit: '8kb' }), wrap(async (req, res) => {
    const { db, owner } = await ownerContext(req);
    const row = await db.collection('billing_subscriptions').findOne({ _id: 'test:' + owner });
    if (!row) throw new Error('subscription_not_found');
    res.json({ ok: true, subscription: await mp.cancelTestSubscription(db, row, config(), fetcher) });
  }));

  app.get('/webhooks/mercadopago/subscriptions/return', (_req, res) => res.type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><title>Asisto · Mercado Pago</title><h1>Volviste a Asisto</h1><p>El regreso desde Mercado Pago no confirma un pago. El administrador debe consultar el estado de la prueba en Suscripciones.</p></html>'));
  app.post('/webhooks/mercadopago/subscriptions', express.json({ limit: '16kb' }), async (req, res) => {
    const cfg = config(), dataId = req.query['data.id'];
    if (!mp.publicSettings(cfg).testReady) return res.sendStatus(503);
    if (!mp.validSignature({ dataId, requestId: req.get('x-request-id'), signature: req.get('x-signature'), secret: cfg.secret }) ||
      String(req.body?.data?.id || '') !== String(dataId)) return res.sendStatus(401);
    try {
      const db = await database();
      if (req.body.type === 'subscription_preapproval') {
        const row = await db.collection('billing_subscriptions').findOne({ providerId: String(dataId), mode: 'test' });
        if (row) await mp.reconcileSubscription(db, row, cfg, fetcher);
      } else if (req.body.type === 'payment') await mp.reconcilePayment(db, dataId, cfg, fetcher);
      else if (req.body.type === 'subscription_authorized_payment') {
        // This resource is an attempted recurring installment, not a paid invoice.
        await mp.verifyTestAccounts(cfg, fetcher);
        const attempt = await mp.request(cfg, '/authorized_payments/' + encodeURIComponent(dataId), { fetcher });
        if (mp.id(attempt.payment?.id)) await mp.reconcilePayment(db, attempt.payment.id, cfg, fetcher);
      }
      return res.sendStatus(200);
    } catch { return res.sendStatus(503); } // Provider retries; never acknowledge a lost update.
  });
}

module.exports = { billingGroups, validateProfile, groupsFor, mountBillingRoutes };
