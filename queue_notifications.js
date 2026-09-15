// Durable milestone delivery. Called under the tenant's single-writer lock.
function createQueueNotifications({ firebaseSender, publicBase }) {
  async function reconcile(db, base) {
    const tickets = db.collection('queue_tickets');
    const rows = await tickets.find({ ...base, status: { $in: ['WAITING', 'CALLED'] } }).sort({ queuedAt: 1, _id: 1 }).toArray();
    const sectors = new Map();
    for (const doc of rows) { if (!sectors.has(doc.sectorId)) sectors.set(doc.sectorId, []); sectors.get(doc.sectorId).push(doc); }
    let delivered = 0;
    for (const docs of sectors.values()) {
      const current = docs.filter(d => d.status === 'CALLED');
      const waiting = docs.filter(d => d.status === 'WAITING');
      for (const doc of docs) {
        const ahead = doc.status === 'CALLED' ? 0 : current.length + waiting.indexOf(doc);
        if (doc.status !== 'CALLED' && ![1, 2].includes(ahead)) continue;
        const visit = (doc.history || []).filter(h => h.action === 'transfer').length;
        const milestone = doc.status === 'CALLED' ? 'called_' + (+new Date(doc.calledAt)) : 'ahead_' + ahead;
        const key = 'v' + visit + '_' + milestone;
        if (doc.queueNotifications?.[key]?.status === 'sent') continue;
        const previous = doc.queueNotifications?.[key];
        if (previous?.attemptedAt && Date.now() - +previous.attemptedAt < 30000) continue;
        const device = await db.collection('customer_app_devices').findOne({ tenantId: doc.tenantId, installId: doc.installId, disabled: { $ne: true }, pushToken: { $type: 'string', $ne: '' } });
        if (!device) continue;
        const record = { milestone, sectorId: doc.sectorId, visit, attemptedAt: new Date(), status: 'sending' };
        await tickets.updateOne({ _id: doc._id }, { $set: { ['queueNotifications.' + key]: record } });
        try {
          const send = await firebaseSender();
          const title = doc.status === 'CALLED' ? '¡Es tu turno!' : ahead === 1 ? 'Falta 1 turno para el tuyo' : 'Faltan 2 turnos para el tuyo';
          const body = `${doc.displayNumber} · ${doc.sectorName}${doc.status === 'CALLED' && doc.desk ? ' · ' + doc.desk : ''}${ahead ? ' · Acercate al sector.' : ''}`;
          await send(device.pushToken, { title, body, url: publicBase.replace(/\/$/, '') + '/customer-app/' + encodeURIComponent(doc.tenantId) + '?view=ticket', channelId: 'asisto_turns' });
          record.status = 'sent'; record.sentAt = new Date(); delivered++;
        } catch (e) { record.status = 'failed'; record.error = 'push_delivery_failed'; console.error('[queue] push failed:', e.message); }
        await tickets.updateOne({ _id: doc._id }, { $set: { ['queueNotifications.' + key]: record } });
      }
    }
    return delivered;
  }
  return { reconcile };
}
module.exports = { createQueueNotifications };
