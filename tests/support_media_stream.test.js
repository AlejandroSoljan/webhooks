// Asisto | Version: 5.00.305 | Fecha: 2026-10-22
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const stream = require('node:stream');
const { patchSource } = require('../desktop/support/media-stream-patch.cjs');
const original = "import { Readable, Transform } from 'stream';\nfunction download(fetched, output) { return fetched.pipe(output, { end: true }); }";
const patched = patchSource(original);
const download = vm.runInNewContext(patched.replace("import { Readable, Transform, pipeline } from 'stream';", '') + '\ndownload', { ...stream });
test('download reset rejects consumer, closes source and permits next successful download', async () => {
  const input = new stream.Readable({ read() { this.destroy(Object.assign(new Error('terminated'), { code: 'ECONNRESET' })); } });
  const output = download(input, new stream.PassThrough());
  // Reproduce a consumer attaching after the HTTP source already failed.
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(async () => { for await (const chunk of output) {} }, { code: 'ECONNRESET' });
  assert.equal(input.destroyed, true);
  const success = download(stream.Readable.from([Buffer.from('complete')]), new stream.PassThrough());
  let text = ''; for await (const chunk of success) text += chunk;
  assert.equal(text, 'complete');
});
test('download consumer cancellation destroys upstream and patch is idempotent', async () => {
  const input = new stream.PassThrough(), output = download(input, new stream.PassThrough());
  output.destroy(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.destroyed, true); assert.equal(patchSource(patched), patched);
  assert.throws(() => patchSource('unexpected upstream source'), /Unsupported/);
});
