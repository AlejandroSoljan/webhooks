// Asisto | Version: 5.00.141 | Fecha: 2026-09-16
// Aviso interno de leads del formulario público por la sesión WhatsApp Web.

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function leadAlertConfig(env = process.env) {
  const tenantId = String(env.LEAD_NOTIFY_WWEB_TENANT || '').trim().toUpperCase();
  const numero = digits(env.LEAD_NOTIFY_WWEB_FROM);
  const to = digits(env.LEAD_NOTIFY_WWEB_TO);
  if (!tenantId || !numero || !to) return null;
  if (!/^[A-Z0-9_-]{2,80}$/.test(tenantId) || numero.length < 10 || to.length < 10) {
    throw new Error('invalid_lead_notification_config');
  }
  return { tenantId, numero, to };
}

function leadAlertText(lead) {
  const clean = (value, limit) => String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, limit);
  const lines = [
    'Nuevo contacto desde la web de Asisto',
    `Nombre: ${clean(lead.name, 120)}`,
    `Empresa: ${clean(lead.company, 120) || 'No indicada'}`,
    `Email: ${clean(lead.email, 200)}`,
    `Teléfono: ${clean(lead.phone, 60) || 'No indicado'}`,
    `Consulta: ${clean(lead.message, 1200)}`,
    `Lead: ${String(lead._id)}`
  ];
  return lines.join('\n');
}

async function queueLeadWhatsAppAlert(db, lead, config = leadAlertConfig()) {
  if (!config) return { status: 'not_configured' };
  const lockId = `${config.tenantId}:${config.numero}`;
  const session = await db.collection('wa_locks').findOne({ _id: lockId }, { projection: { _id: 1 } });
  if (!session) return { status: 'session_not_found' };
  const text = leadAlertText(lead);
  await db.collection('wa_wweb_actions').insertOne({
    lockId,
    tenantId: config.tenantId,
    numero: config.numero,
    action: 'send_message',
    to: config.to,
    text,
    payload: { to: config.to, text, leadId: String(lead._id) },
    requestedBy: 'public-lead-form',
    requestedAt: new Date(),
    at: new Date()
  });
  return { status: 'queued' };
}

module.exports = { leadAlertConfig, leadAlertText, queueLeadWhatsAppAlert };
