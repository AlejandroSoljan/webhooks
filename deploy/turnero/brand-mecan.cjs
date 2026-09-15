// Asisto | Configuración visual del escáner de Mecan, sin modificar catálogo | 2026-09-14
const fs = require('node:fs');
const { getDb, closeDb } = require('/opt/asisto/current/db');
(async () => {
  try {
    const db = await getDb(), settings = db.collection('settings'), filter = { _id: 'behavior:DEMO_FERRETERIA' };
    const old = await settings.findOne(filter, { projection: { qr_company_logo_url: 1, qr_button_color: 1, qr_button_text_color: 1 } });
    if (!old) throw Error('No existe la configuración de Mecan');
    const backup = '/var/lib/asisto/turnero-brand-before-20260914.json';
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(old, null, 2), { mode: 0o600 });
    await settings.updateOne(filter, { $set: { qr_company_logo_url: 'https://asistobot.com.ar/customer-app/assets/mecan-logo.webp', qr_button_color: '#e00000', qr_button_text_color: '#ffffff' } });
    console.log('Mecan scanner branding updated');
  } finally { await closeDb(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
