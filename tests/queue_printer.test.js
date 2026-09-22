const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueuePrinter, receiptText } = require('../queue_printer');

test('CUPS prints a ticket without invoking a browser dialog', async () => {
  const calls = [];
  const printer = createQueuePrinter({ enabled: true, name: 'thermal_usb', run: async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input || '' });
    if (command === 'lpstat' && args[0] === '-r') return { stdout: 'scheduler is running\n' };
    if (command === 'lpstat') return { stdout: 'printer thermal_usb is idle. enabled since today\n' };
    if (command === 'lp') return { stdout: 'request id is thermal_usb-42 (1 file(s))\n' };
    throw new Error('unexpected command');
  } });
  const result = await printer.printTicket({ businessName: 'Mecan', sectorName: 'Caja', displayNumber: 'C007', createdAt: '2026-09-22T12:00:00Z' });
  assert.equal(result.printed, true);
  assert.equal(result.jobId, 'thermal_usb-42');
  const submit = calls.find(call => call.command === 'lp');
  assert.deepEqual(submit.args.slice(0, 2), ['-d', 'thermal_usb']);
  assert.match(submit.input, /C007/);
  assert.match(submit.input, /Powered by Asisto/);
});

test('printer reports unavailable CUPS queues', async () => {
  const printer = createQueuePrinter({ enabled: true, name: 'missing', run: async (command) => {
    if (command === 'lpstat') throw Object.assign(new Error('not found'), { stderr: 'unknown printer' });
  } });
  await assert.rejects(() => printer.printTicket({ displayNumber: 'F001' }), /impresora no esta disponible/i);
});

test('receipt is narrow plain text suitable for thermal CUPS queues', () => {
  const output = receiptText({ businessName: 'Mecan', sectorName: 'Ferreteria', displayNumber: 'F123' });
  assert.ok(output.split('\n').every(line => line.length <= 42));
});

test('kiosk source includes an HTTP-compatible request id fallback', () => {
  const source = require('../queue_kiosk').kiosk.toString();
  assert.match(source, /typeof globalThis\.crypto\.randomUUID/);
  assert.match(source, /Math\.random\(\)\.toString\(36\)/);
  assert.doesNotMatch(source, /installId:\s*crypto\.randomUUID\(\)/);
});
