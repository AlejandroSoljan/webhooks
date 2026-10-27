// Asisto | Migración de enlaces visibles, sin cambiar integraciones | 2026-10-27
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(root, 'queue_branding.js'))) throw Error('Falta una release explícita válida.');
const files = ['queue_branding.js', 'queue_printer.js', 'qr_product_web.js', 'restaurant_public_page.js', 'static/restaurant_operations.js', 'static/restaurant_panel.html', 'transfer_receipt.js'];
for (const file of files) {
  const target = path.join(root, file);
  if (!fs.existsSync(target)) continue;
  const before = fs.readFileSync(target, 'utf8');
  const after = before.replaceAll('asistobot.com.ar', 'asisto.com.ar');
  if (before !== after) fs.writeFileSync(target, after);
  console.log(file + ': ' + (before === after ? 'sin cambios' : 'enlaces actualizados'));
}
