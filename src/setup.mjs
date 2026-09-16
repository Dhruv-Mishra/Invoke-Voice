export function createSetup({ platform = process.platform, arch = process.arch, cacheDir, runtimeDir, inspect, install, activate }) {
  const supported = platform === 'win32' && arch === 'x64';
  let state = { status: 'idle', stage: 'consent', message: 'Local setup requires your permission. No downloads have started.' };
  let job;
  let controller;
  const log = [];
  const snapshot = () => ({ platform, supported, cacheDir, runtimeDir, ...state, components: inspect(), log: [...log] });
  const report = ({ stage, message, progress }) => {
    state = { status: 'running', stage, message, ...(progress ? { progress } : {}) };
    if (message !== log.at(-1)) log.push(message);
    if (log.length > 40) log.shift();
  };
  function begin(download) {
    if (job || state.status === 'ready') return snapshot();
    controller = new AbortController();
    report({ stage: 'checking', message: download ? 'Checking reusable local files.' : 'Starting previously installed local runtimes offline.' });
    job = new Promise(resolve => setImmediate(resolve)).then(async () => {
      if (download) await install({ report, signal: controller.signal });
      report({ stage: 'starting', message: 'Starting and checking the local voice runtimes.' });
      await activate({ signal: controller.signal });
      state = { status: 'ready', stage: 'complete', message: 'Local voice runtimes passed startup checks. Cached files can be reused offline.' };
    }).catch(error => {
      const message = error.setupMessage || 'Local setup failed. Check your connection, free disk space and security software, then retry. Completed files will be reused.';
      state = { status: 'error', stage: state.stage, message, error: message };
      log.push(message);
      if (log.length > 40) log.shift();
    }).finally(() => { job = undefined; });
    return snapshot();
  }
  return {
    snapshot,
    start(input) {
      if (!input || input.consent !== true || Object.keys(input).some(key => key !== 'consent')) {
        throw new Error('Explicit consent:true is required; no other setup options are accepted.');
      }
      if (!supported) throw new Error('Automatic setup supports Windows x64 only. See the source setup instructions.');
      return begin(true);
    },
    resume() { if (supported) return begin(false); return snapshot(); },
    invalidate(message) { state = { status: 'error', stage: 'runtime', message, error: message }; },
    async settled() { await job; return snapshot(); },
    async close() { controller?.abort(); await job; },
  };
}