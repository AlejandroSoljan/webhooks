// Asisto | Version: 5.00.052 | Fecha: 2026-09-08
const { fork } = require('node:child_process');
const path = require('node:path');
const { inspectConfiguration } = require('./config');

// One separate process in the existing service, inheriting its environment.
// MongoDB's lease arbitrates ownership while Render replaces a deployment.
function superviseSupport({ env = process.env, forkImpl = fork, schedule = setTimeout, cancel = clearTimeout, parent = process, log = console } = {}) {
  const configuration = inspectConfiguration(env);
  if (!configuration.ready) {
    if (env.SUPPORT_ENABLED === 'true') log.error('Support worker pending setup:', configuration.checks.filter(check => !check.ok).map(check => check.key).join(', '));
    return { stop: async () => {} };
  }
  let child, retry, stopping = false, delay = 5000, stopPromise;
  const launch = () => {
    if (stopping) return;
    let current;
    const failed = () => {
      if (current && child !== current) return;
      child = undefined;
      if (stopping || retry) return;
      log.error('Support worker stopped; retrying automatically.');
      retry = schedule(() => { retry = undefined; launch(); }, delay);
      delay = Math.min(delay * 2, 30000);
    };
    try {
      current = forkImpl(path.join(__dirname, 'worker.js'), [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      child = current;
      current.once('exit', failed);
      current.once('error', failed);
      current.on('message', message => { if (message?.type === 'support-ready') delay = 5000; });
    } catch { failed(); }
  };
  const onExit = () => { try { child?.kill('SIGTERM'); } catch {} };
  parent.once('exit', onExit);
  launch();
  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      parent.removeListener('exit', onExit);
      if (retry) cancel(retry);
      retry = undefined;
      const current = child;
      stopPromise = new Promise(resolve => {
        if (!current) return resolve();
        let done = false, force;
        const finish = () => { if (done) return; done = true; cancel(force); resolve(); };
        current.once('exit', finish);
        force = schedule(() => { try { current.kill('SIGKILL'); } catch {} finish(); }, 7000);
        try { current.kill('SIGTERM'); } catch { finish(); }
      });
      return stopPromise;
    },
  };
}
module.exports = { superviseSupport };
