// Asisto | Impresion silenciosa del turnero mediante CUPS | 2026-09-22
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const clean = (value, max = 120) => String(value || '').trim().slice(0, max);

function center(value, width = 42) {
  const text = clean(value, width);
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(left) + text;
}

function receiptText(ticket) {
  const createdAt = new Date(ticket.createdAt || Date.now()).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short',
  });
  return [
    center(ticket.businessName || 'Turnero'), '', center(ticket.sectorName || ''), '',
    center(ticket.displayNumber || '', 20), '', center(createdAt), '',
    center('Mira la pantalla de llamados.'), center('Conserva este numero si te derivan.'), '',
    center('Powered by Asisto'), center('www.asistobot.com.ar'), '', '', '',
  ].join('\n');
}

function createQueuePrinter(options = {}) {
  const enabled = options.enabled ?? /^true$/i.test(process.env.QUEUE_SERVER_PRINT || '');
  const configuredName = clean(options.name ?? process.env.QUEUE_PRINTER_NAME, 80);
  const execute = options.run || run;

  function printerArgs(extra = []) {
    if (configuredName && !/^[A-Za-z0-9_.-]+$/.test(configuredName)) throw new Error('Nombre de impresora invalido.');
    return configuredName ? ['-d', configuredName, ...extra] : extra;
  }

  async function status() {
    if (!enabled) return { enabled: false, ready: false, printer: configuredName || '' };
    try {
      await execute('lpstat', ['-r'], { timeout: 4000, windowsHide: true });
      const args = configuredName ? ['-p', configuredName] : ['-d'];
      const { stdout = '' } = await execute('lpstat', args, { timeout: 4000, windowsHide: true });
      const ready = configuredName ? !/disabled/i.test(stdout) : !/no system default destination/i.test(stdout);
      return { enabled: true, ready, printer: configuredName || clean(stdout.replace(/^.*?:\s*/, ''), 80), detail: clean(stdout, 240) };
    } catch (error) {
      return { enabled: true, ready: false, printer: configuredName || '', detail: clean(error.stderr || error.message, 240) };
    }
  }

  async function printTicket(ticket) {
    if (!enabled) return { enabled: false, printed: false };
    const state = await status();
    if (!state.ready) throw new Error('La impresora no esta disponible. Revisa la conexion USB, el papel y CUPS.');
    const title = clean(`Turno ${ticket.displayNumber || ''}`, 80);
    const { stdout = '' } = await execute('lp', printerArgs(['-t', title]), {
      input: receiptText(ticket), timeout: 12000, windowsHide: true, maxBuffer: 64 * 1024,
    });
    const jobId = clean((stdout.match(/request id is\s+([^\s]+)/i) || [])[1], 120);
    return { enabled: true, printed: true, jobId, printer: state.printer };
  }

  return { enabled, status, printTicket };
}

module.exports = { createQueuePrinter, receiptText };
