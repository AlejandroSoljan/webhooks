// Asisto | Version: 5.00.305 | Fecha: 2026-10-22
// Baileys rc14 uses pipe(), which does not forward source download errors.
const fs = require('node:fs');
const path = require('node:path');
function patchSource(source) {
  if (source.includes('// Asisto: propagate download errors to the consumer')) return source;
  const target = 'return fetched.pipe(output, { end: true });';
  if (!source.includes(target) || !source.includes("import { Readable, Transform } from 'stream';")) throw new Error('Unsupported Baileys media stream implementation');
  return source.replace("import { Readable, Transform } from 'stream';", "import { Readable, Transform, pipeline } from 'stream';")
    .replace(target, `// Asisto: propagate download errors to the consumer
    // Keep an error listener until the caller attaches its async iterator.
    output.on('error', () => {});
    pipeline(fetched, output, () => {});
    return output;`);
}
function applyMediaStreamPatch(root = __dirname) {
  const file = path.join(root, 'node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js');
  const before = fs.readFileSync(file, 'utf8'), after = patchSource(before);
  if (after !== before) { if (!fs.existsSync(file + '.asisto-original')) fs.copyFileSync(file, file + '.asisto-original', fs.constants.COPYFILE_EXCL); fs.writeFileSync(file, after); }
}
module.exports = { patchSource, applyMediaStreamPatch };
