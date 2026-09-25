// Asisto | Version: 5.00.226 | Fecha: 2026-09-25
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('combined Windows installer includes Baileys and the Chrome extension without dependencies', () => {
  const installer = fs.readFileSync(path.join(root, 'desktop/support/Instalar.ps1'), 'utf8');
  const builder = fs.readFileSync(path.join(root, 'scripts/build_support_desktop.ps1'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'src/support/panel.html'), 'utf8');
  const archive = fs.readFileSync(path.join(root, 'static/downloads/AsistoTareas-5.00.226.zip'));
  const archiveText = archive.toString('latin1');

  assert.match(installer, /npm-cli\.js'\) ci --omit=dev --ignore-scripts/);
  assert.match(installer, /AsistoSupport\\Extension|Join-Path \$root 'Extension'/);
  assert.match(installer, /Extension Asisto\.lnk/);
  assert.match(installer, /127\.0\.0\.1:17658\/pairing/);
  assert.match(installer, /agent-error\.log/);
  assert.match(builder, /extensions\/whatsapp-support/);
  assert.match(panel, /AsistoTareas-5\.00\.226\.zip/);
  assert.match(archiveText, /Extension\/manifest\.json/);
  assert.match(archiveText, /agent\.cjs/);
  assert.doesNotMatch(archiveText, /node_modules/);
  assert.doesNotMatch(archiveText, /\.env/);
});
