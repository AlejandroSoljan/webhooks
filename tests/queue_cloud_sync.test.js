// Asisto | Turnero hybrid sync | Fecha: 2026-09-22
const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { preferred, reviveTicket } = require('../queue_cloud_sync');

test('cloud sync keeps the newest queue update and uses richer history on ties', () => {
  const old = { updatedAt: new Date('2026-09-22T10:00:00Z'), history: [{ action: 'created' }] };
  const recent = { updatedAt: new Date('2026-09-22T10:00:01Z'), history: [] };
  assert.equal(preferred(recent, old), 'local');
  assert.equal(preferred(old, recent), 'cloud');
  assert.equal(preferred({ ...old, history: [{}, {}] }, old), 'local');
});

test('cloud sync restores Mongo identifiers and dates and rejects another tenant', () => {
  const id = new ObjectId();
  const ticket = reviveTicket({
    _id: id.toHexString(), tenantId: 'MCN', createdAt: '2026-09-22T10:00:00Z',
    updatedAt: '2026-09-22T10:01:00Z', history: [{ at: '2026-09-22T10:00:30Z' }],
  }, 'MCN');
  assert.equal(ticket._id.toHexString(), id.toHexString());
  assert.ok(ticket.createdAt instanceof Date);
  assert.ok(ticket.history[0].at instanceof Date);
  assert.throws(() => reviveTicket({ ...ticket, tenantId: 'OTRO' }, 'MCN'), /invalid_tenant/);
});
