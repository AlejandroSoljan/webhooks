// Asisto | Turnero hybrid sync | Fecha: 2026-09-22
const crypto = require('crypto');
const express = require('express');
const { ObjectId } = require('mongodb');

const cleanTenant = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 60);
const stamp = doc => +new Date(doc?.updatedAt || doc?.createdAt || 0) || 0;
const historySize = doc => Array.isArray(doc?.history) ? doc.history.length : 0;
const counterPrefix = tenantId => cleanTenant(tenantId) + ':';

function preferred(local, cloud) {
  const delta = stamp(local) - stamp(cloud);
  if (delta) return delta > 0 ? 'local' : 'cloud';
  return historySize(local) >= historySize(cloud) ? 'local' : 'cloud';
}

function reviveDates(value, key = '') {
  if (Array.isArray(value)) return value.map(item => reviveDates(item));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && (key === 'date' || key === 'at' || key.endsWith('At'))) {
      const parsed = new Date(value);
      if (!Number.isNaN(+parsed)) return parsed;
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, reviveDates(child, childKey)]));
}

function reviveTicket(raw, tenantId) {
  if (!raw || typeof raw !== 'object' || !ObjectId.isValid(String(raw._id || ''))) throw new Error('invalid_ticket');
  const expected = cleanTenant(tenantId);
  if (!expected || cleanTenant(raw.tenantId) !== expected) throw new Error('invalid_tenant');
  const ticket = reviveDates(raw);
  ticket._id = new ObjectId(String(raw._id));
  ticket.tenantId = expected;
  return ticket;
}

async function mergeInto(collection, incoming) {
  let merged = 0;
  for (const ticket of incoming) {
    const current = await collection.findOne({ _id: ticket._id });
    if (!current || preferred(current, ticket) === 'cloud') {
      await collection.replaceOne({ _id: ticket._id }, ticket, { upsert: true });
      merged++;
    }
  }
  return merged;
}

function reviveCounter(raw, tenantId) {
  const prefix = counterPrefix(tenantId), id = String(raw?._id || ''), sequence = Math.floor(Number(raw?.sequence));
  if (!prefix || !id.startsWith(prefix) || !Number.isFinite(sequence) || sequence < 0) throw new Error('invalid_counter');
  return { _id: id.slice(0, 240), sequence };
}

async function mergeCounters(collection, incoming) {
  for (const counter of incoming) await collection.updateOne({ _id: counter._id }, { $max: { sequence: counter.sequence } }, { upsert: true });
  return incoming.length;
}

const parseTenants = value => String(value || '').split(',').map(cleanTenant).filter(Boolean);
const safeSecret = (actual, expected) => {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return b.length >= 20 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

function mountQueueSyncEndpoint(app, { getDb, secret = process.env.QUEUE_SYNC_SECRET, tenantList = process.env.QUEUE_SYNC_TENANTS || 'MCN' } = {}) {
  const allowed = new Set(parseTenants(tenantList));
  app.post('/api/ext/queue-sync', express.json({ limit: '10mb' }), async (req, res) => {
    if (!safeSecret(req.get('x-queue-sync-key'), secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const tenantId = cleanTenant(req.body?.tenantId);
    if (!tenantId || !allowed.has(tenantId)) return res.status(403).json({ ok: false, error: 'tenant_not_allowed' });
      const rows = Array.isArray(req.body?.tickets) ? req.body.tickets : [];
    const counterRows = Array.isArray(req.body?.counters) ? req.body.counters : [];
    if (rows.length > 5000 || counterRows.length > 1000) return res.status(413).json({ ok: false, error: 'too_many_rows' });
    try {
      const db = await getDb();
      const collection = db.collection('queue_tickets');
      const incoming = rows.map(row => reviveTicket(row, tenantId));
      const merged = await mergeInto(collection, incoming);
      const counterCollection = db.collection('queue_counters');
      const incomingCounters = counterRows.map(row => reviveCounter(row, tenantId));
      await mergeCounters(counterCollection, incomingCounters);
      const filter = { tenantId };
      const since = req.body?.since ? new Date(req.body.since) : null;
      if (since && !Number.isNaN(+since)) filter.updatedAt = { $gte: since };
      const tickets = await collection.find(filter).limit(5000).toArray();
      const counters = await counterCollection.find({ _id: { $regex: '^' + tenantId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':' } }).limit(1000).toArray();
      return res.json({ ok: true, merged, tickets, counters, serverTime: new Date().toISOString() });
    } catch (error) {
      console.error('[QUEUE_SYNC_API] error:', error.message);
      return res.status(400).json({ ok: false, error: 'sync_failed' });
    }
  });
}

function startQueueCloudSync({ getDb, url = process.env.QUEUE_SYNC_URL, secret = process.env.QUEUE_SYNC_SECRET, tenantList = process.env.QUEUE_SYNC_TENANTS || 'MCN', everyMs = Number(process.env.QUEUE_SYNC_EVERY_MS || 1000) } = {}) {
  const tenants = parseTenants(tenantList);
  if (!url || String(secret || '').length < 20 || !tenants.length) return { enabled: false, stop: async () => {}, run: async () => ({ skipped: true }) };
  let running = false, stopped = false, initial = true, lastSync = null;
  const run = async () => {
    if (running || stopped) return { skipped: true };
    running = true;
    try {
      const db = await getDb();
      let pushed = 0, pulled = 0;
      for (const tenantId of tenants) {
        const since = lastSync ? new Date(lastSync.getTime() - 5000) : null;
        const filter = { tenantId };
        if (!initial && since) filter.updatedAt = { $gte: since };
        const tickets = await db.collection('queue_tickets').find(filter).limit(5000).toArray();
        const counters = await db.collection('queue_counters').find({ _id: { $regex: '^' + tenantId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':' } }).limit(1000).toArray();
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-queue-sync-key': secret },
          body: JSON.stringify({ tenantId, since: initial ? null : since?.toISOString(), tickets, counters }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`http_${response.status}`);
        const payload = await response.json();
        if (!payload.ok || !Array.isArray(payload.tickets)) throw new Error('invalid_response');
        const incoming = payload.tickets.map(row => reviveTicket(row, tenantId));
        pulled += await mergeInto(db.collection('queue_tickets'), incoming);
        const incomingCounters = (Array.isArray(payload.counters) ? payload.counters : []).map(row => reviveCounter(row, tenantId));
        await mergeCounters(db.collection('queue_counters'), incomingCounters);
        pushed += Number(payload.merged || 0);
      }
      initial = false;
      lastSync = new Date();
      if (pushed || pulled) console.log(`[QUEUE_CLOUD_SYNC] pushed=${pushed} pulled=${pulled} tenants=${tenants.join(',')}`);
      return { pushed, pulled };
    } catch (error) {
      console.error('[QUEUE_CLOUD_SYNC] unavailable:', error.message);
      return { error: true };
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, Math.max(1000, everyMs));
  timer.unref();
  run();
  return { enabled: true, run, stop: async () => { stopped = true; clearInterval(timer); } };
}

module.exports = { preferred, reviveTicket, reviveCounter, mergeInto, mergeCounters, mountQueueSyncEndpoint, startQueueCloudSync };
