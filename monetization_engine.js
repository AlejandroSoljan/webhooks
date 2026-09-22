// Asisto | Motor de medición y monetización por dominio.
const crypto = require('crypto');
const { getDb } = require('./db');
const { CATALOG, defaultConfig, normalizeConfig } = require('./monetization_config');

const CATALOG_BY_KEY = new Map(CATALOG.map(item => [item.key, item]));
const safeTenant = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 60);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const money = value => Number(finite(value).toFixed(6));
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function calculateEvent(config, eventKey, quantity = 1, realCost = 0) {
  const item = CATALOG_BY_KEY.get(eventKey);
  const rule = config?.items?.[eventKey];
  const qty = Math.max(0, finite(quantity, 1));
  if (!item || !rule?.enabled || !qty) return { enabled: false, quantity: qty, credits: 0, creditAmount: 0, fixedAmount: 0, realCost: money(realCost), potentialAmount: 0 };
  const credits = rule.mode === 'credits' ? money(finite(rule.credits) * qty) : 0;
  const fixedAmount = rule.mode === 'fixed' ? money(finite(rule.unitPrice) * qty) : 0;
  const aiAmount = item.group === 'ai' && finite(realCost) > 0
    ? money(finite(realCost) * (1 + finite(config.aiMarkupPercent) / 100)) : 0;
  const creditAmount = money(credits * finite(config.creditValue));
  return { enabled: true, quantity: qty, credits, creditAmount, fixedAmount, realCost: money(realCost), potentialAmount: money(fixedAmount + creditAmount + aiAmount) };
}

async function loadConfig(db, tenantId) {
  const id = safeTenant(tenantId);
  const raw = await db.collection('monetization_config').findOne({ _id: id });
  return normalizeConfig(raw || defaultConfig(id), id);
}

async function recordMonetizationEvent({ db, tenantId, eventKey, quantity = 1, sourceId, occurredAt, metadata, realCost = 0 }) {
  const tenant = safeTenant(tenantId), item = CATALOG_BY_KEY.get(eventKey);
  if (!tenant || !item) return { recorded: false, reason: 'invalid_event' };
  const database = db || await getDb(), config = await loadConfig(database, tenant);
  const priced = calculateEvent(config, eventKey, quantity, realCost);
  if (!priced.enabled) return { recorded: false, reason: 'disabled' };
  const when = occurredAt instanceof Date ? occurredAt : new Date(occurredAt || Date.now());
  const stableSource = String(sourceId || crypto.randomUUID()).slice(0, 300);
  const id = hash([tenant, eventKey, stableSource].join('|'));
  const doc = {
    _id: id, tenantId: tenant, eventKey, group: item.group, name: item.name, unit: item.unit,
    quantity: priced.quantity, credits: priced.credits, creditAmount: priced.creditAmount, fixedAmount: priced.fixedAmount,
    realCost: priced.realCost, potentialAmount: priced.potentialAmount,
    billedAmount: config.billingEnabled ? priced.potentialAmount : 0,
    billingEnabled: config.billingEnabled, currency: config.currency, creditValue: config.creditValue, includedCredits: config.includedCredits,
    mode: config.items[eventKey].mode, sourceId: stableSource, occurredAt: when,
    metadata: metadata && typeof metadata === 'object' ? metadata : {}, createdAt: new Date()
  };
  const result = await database.collection('monetization_events').updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true });
  return { recorded: result.upsertedCount === 1, duplicate: result.upsertedCount !== 1, event: doc };
}

function dateBoundary(value, end = false) {
  if (!value) return null;
  const d = new Date(String(value) + (String(value).length <= 10 ? (end ? 'T23:59:59.999-03:00' : 'T00:00:00.000-03:00') : ''));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function buildMonetizationSummary({ db, tenantId, from, to, isSuper = false }) {
  const database = db || await getDb(), tenant = safeTenant(tenantId);
  const match = {};
  if (tenant) match.tenantId = tenant;
  else if (!isSuper) throw new Error('tenant_required');
  const start = dateBoundary(from), end = dateBoundary(to, true);
  if (start || end) match.occurredAt = { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) };
  const rows = await database.collection('monetization_events').aggregate([
    { $match: match },
    { $group: { _id: { tenantId: '$tenantId', eventKey: '$eventKey', currency: '$currency' }, name: { $first: '$name' }, group: { $first: '$group' }, unit: { $first: '$unit' }, quantity: { $sum: '$quantity' }, credits: { $sum: '$credits' }, creditAmount: { $sum: '$creditAmount' }, includedCredits: { $max: '$includedCredits' }, billingEnabled: { $max: '$billingEnabled' }, realCost: { $sum: '$realCost' }, potentialAmount: { $sum: '$potentialAmount' }, billedAmount: { $sum: '$billedAmount' }, lastAt: { $max: '$occurredAt' } } },
    { $sort: { '_id.tenantId': 1, quantity: -1 } }
  ], { allowDiskUse: true }).toArray();
  const byDomain = new Map(), byType = new Map(), byCurrency = {};
  for (const row of rows) {
    const item = { tenantId: row._id.tenantId, eventKey: row._id.eventKey, currency: row._id.currency || 'ARS', name: row.name, group: row.group, unit: row.unit, quantity: finite(row.quantity), credits: finite(row.credits), creditAmount: finite(row.creditAmount), includedCredits: finite(row.includedCredits), billingEnabled: row.billingEnabled===true, realCost: money(row.realCost), potentialAmount: money(row.potentialAmount), billedAmount: money(row.billedAmount), lastAt: row.lastAt };
    const domain = byDomain.get(item.tenantId) || { tenantId: item.tenantId, operations: 0, credits: 0, creditAmount: 0, includedCredits: 0, realCost: 0, potentialAmount: {}, billedAmount: {}, lastAt: null };
    domain.operations += item.quantity; domain.credits += item.credits; domain.creditAmount += item.creditAmount; domain.includedCredits=Math.max(domain.includedCredits,item.includedCredits); domain.realCost += item.realCost;
    domain.potentialAmount[item.currency] = money(finite(domain.potentialAmount[item.currency]) + item.potentialAmount);
    domain.billedAmount[item.currency] = money(finite(domain.billedAmount[item.currency]) + item.billedAmount);
    domain.lastAt = !domain.lastAt || new Date(item.lastAt) > new Date(domain.lastAt) ? item.lastAt : domain.lastAt; byDomain.set(item.tenantId, domain);
    const typeKey = item.eventKey + '|' + item.currency, type = byType.get(typeKey) || { eventKey: item.eventKey, name: item.name, group: item.group, unit: item.unit, currency: item.currency, quantity: 0, credits: 0, realCost: 0, potentialAmount: 0, billedAmount: 0 };
    for (const key of ['quantity','credits','realCost','potentialAmount','billedAmount']) type[key] = money(type[key] + item[key]); byType.set(typeKey, type);
    const currency = byCurrency[item.currency] || { potentialAmount: 0, billedAmount: 0 }; currency.potentialAmount = money(currency.potentialAmount + item.potentialAmount); currency.billedAmount = money(currency.billedAmount + item.billedAmount); byCurrency[item.currency] = currency;
  }
  for(const domain of byDomain.values()){
    const included=Math.min(domain.credits,domain.includedCredits),ratio=domain.credits?included/domain.credits:0;
    domain.includedCreditsApplied=money(included);
    for(const currency of Object.keys(domain.billedAmount)) domain.billedAmount[currency]=money(Math.max(0,domain.billedAmount[currency]-domain.creditAmount*ratio));
  }
  for(const currency of Object.keys(byCurrency)) byCurrency[currency].billedAmount=money([...byDomain.values()].reduce((sum,domain)=>sum+finite(domain.billedAmount[currency]),0));
  return { ok: true, filters: { tenantId: tenant || null, from: from || null, to: to || null }, totals: { operations: [...byDomain.values()].reduce((a,x)=>a+x.operations,0), credits: [...byDomain.values()].reduce((a,x)=>a+x.credits,0), includedCreditsApplied: money([...byDomain.values()].reduce((a,x)=>a+x.includedCreditsApplied,0)), realCost: money([...byDomain.values()].reduce((a,x)=>a+x.realCost,0)), byCurrency }, byDomain: [...byDomain.values()], byType: [...byType.values()] };
}

module.exports = { calculateEvent, recordMonetizationEvent, buildMonetizationSummary, loadConfig };
