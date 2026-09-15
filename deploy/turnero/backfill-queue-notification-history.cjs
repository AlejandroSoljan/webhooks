// Backfill queue notifications sent before notificationType was introduced.
const { getDb, closeDb } = require('../../db');
const clean = value => String(value || '').slice(0, 120);
(async () => {
  const db = await getDb();
  const cursor = db.collection('queue_tickets').find({ 'queueNotifications': { $exists: true } });
  let tickets = 0, records = 0;
  for await (const doc of cursor) {
    tickets++;
    for (const [key, event] of Object.entries(doc.queueNotifications || {})) {
      if (event?.status !== 'sent') continue;
      const milestone = clean(event.milestone || key.replace(/^v\d+_/, ''));
      const ahead = milestone === 'ahead_1' ? 1 : milestone === 'ahead_2' ? 2 : 0;
      const title = ahead === 2 ? 'Faltan 2 turnos para el tuyo' : ahead === 1 ? 'Falta 1 turno para el tuyo' : '¡Es tu turno!';
      const body = `${doc.displayNumber} · ${doc.sectorName}${!ahead && doc.desk ? ' · ' + doc.desk : ''}${ahead ? ' · Acercate al sector.' : ''}`;
      const visit = Number(event.visit || key.match(/^v(\d+)_/)?.[1] || 0);
      const notificationKey = `queue:${doc._id}:v${visit}:${milestone}`;
      const createdAt = event.sentAt || event.attemptedAt || doc.updatedAt || doc.createdAt || new Date();
      await db.collection('customer_app_notifications').updateOne(
        { tenantId: doc.tenantId, notificationKey },
        { $setOnInsert: {
          tenantId: doc.tenantId, notificationKey, notificationType: 'automatic_queue', sourceLabel: 'Turnero automático',
          ticketId: String(doc._id), ticketNumber: doc.displayNumber, sectorId: event.sectorId || doc.sectorId,
          sectorName: doc.sectorName, milestone, visit, title, body, status: 'sent', targetCount: 1, requestedCount: 1,
          successCount: 1, failureCount: 0, attemptCount: 1, createdAt, firstAttemptAt: event.attemptedAt || createdAt,
          sentAt: event.sentAt || createdAt, updatedAt: event.sentAt || createdAt, importedFromTicket: true,
        } },
        { upsert: true },
      );
      records++;
    }
  }
  console.log(JSON.stringify({ ok: true, tickets, records }));
})().finally(async () => { if (closeDb) await closeDb(); });
