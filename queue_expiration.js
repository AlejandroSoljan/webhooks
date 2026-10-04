const OPEN_STATUSES = ['RESERVED', 'WAITING', 'CALLED'];
const indexes = new WeakMap();
function businessDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(now);
}
function isPreviousDay(doc, today = businessDay()) {
  return /^\d{4}-\d{2}-\d{2}$/.test(doc.dayKey || '') && doc.dayKey < today && OPEN_STATUSES.includes(doc.status);
}
function expirationFields(doc, now = new Date()) {
  const expiredAt = new Date(+new Date(doc.dayKey + 'T00:00:00-03:00') + 86400000);
  return { status: 'SKIPPED', expiryReason: 'day_end', expiredAt, updatedAt: now };
}
function expirationEvent(doc, expiredAt) {
  return { action: 'skip', reason: 'day_end', at: expiredAt, sectorId: doc.sectorId, sellerId: doc.sellerId || '', sellerName: doc.sellerName || '', who: 'system:day_end' };
}
function expireIncomingTicket(doc, today = businessDay(), now = new Date()) {
  if (!isPreviousDay(doc, today)) return doc;
  const fields = expirationFields(doc, now);
  return { ...doc, ...fields, history: [...(doc.history || []), expirationEvent(doc, fields.expiredAt)] };
}
async function expirePreviousDays(db, today = businessDay(), tenantId) {
  const collection = db.collection('queue_tickets');
  if (!indexes.has(db)) indexes.set(db, collection.createIndex({ status: 1, dayKey: 1, tenantId: 1 }).catch(e => { indexes.delete(db); throw e; }));
  await indexes.get(db);
  const filter = { dayKey: { $lt: today, $regex: /^\d{4}-\d{2}-\d{2}$/ }, status: { $in: OPEN_STATUSES }, ...(tenantId ? { tenantId } : {}) };
  let modified = 0;
  for await (const doc of collection.find(filter)) {
    const fields = expirationFields(doc);
    const result = await collection.updateOne({ _id: doc._id, dayKey: doc.dayKey, status: { $in: OPEN_STATUSES } }, {
      $set: fields, $push: { history: expirationEvent(doc, fields.expiredAt) },
    });
    modified += result.modifiedCount;
  }
  return modified;
}
module.exports = { businessDay, isPreviousDay, expirePreviousDays, expireIncomingTicket };
