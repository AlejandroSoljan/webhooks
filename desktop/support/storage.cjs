// Asisto | Version: 5.00.053 | Fecha: 2026-09-08
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
function storage(profile) {
  if (process.platform !== 'win32') throw new Error('Windows required');
  fs.mkdirSync(profile, { recursive: true });
  const dpapi = (mode, bytes) => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'protect.ps1'), '-Mode', mode], { input: bytes.toString('base64'), encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('Local protection unavailable');
    return Buffer.from(result.stdout.trim(), 'base64');
  };
  const keyFile = path.join(profile, 'protection.bin');
  let key;
  if (fs.existsSync(keyFile)) key = dpapi('unprotect', fs.readFileSync(keyFile));
  else { key = crypto.randomBytes(32); fs.writeFileSync(keyFile, dpapi('protect', key), { flag: 'wx' }); }
  const filename = id => path.join(profile, crypto.createHash('sha256').update(id).digest('hex') + '.dat');
  const api = {
    read(id) {
      const file = filename(id); if (!fs.existsSync(file)) return null;
      const box = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
      cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(box.data, 'base64')), cipher.final()]).toString('utf8'));
    },
    write(id, value) {
      if (value == null) { fs.rmSync(filename(id), { force: true }); return; }
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(id));
      const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      const file = filename(id), temp = file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
      fs.renameSync(temp, file);
    },
  };
  return api;
}
module.exports = { storage };
