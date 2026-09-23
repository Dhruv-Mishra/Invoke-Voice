import os from 'node:os';

export function createSetup({ platform = process.platform, arch = process.arch, cacheDir, runtimeDir, inspect, install, activate, getCapabilities, now = Date.now, minimumMemoryGiB = 16, inspectHardware = () => ({ logicalCpus: os.availableParallelism(), memoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)) }) }) {
  const supported = platform === 'win32' && arch === 'x64';
  let state = { status: 'idle', stage: 'consent', message: 'Local setup requires your permission. No downloads have started.' };
  let job;
  let controller;
  let transfer;
  const log = [];

  const getHardwareSnapshot = () => {
    const { logicalCpus, memoryGiB } = inspectHardware();
    let warning = null;
    if (!supported) {
      warning = 'Automatic local AI setup requires Windows x64.';
    } else if (logicalCpus < 4 || memoryGiB < minimumMemoryGiB) {
      warning = minimumMemoryGiB > 16
        ? `The selected Qwen3.6 model needs about 24 GB of free memory; at least ${minimumMemoryGiB} GB of system memory and 4 CPU cores are recommended. Switch back to Gemma in Settings > Local model on smaller systems.`
        : 'Local AI models run best with at least 16 GB of system memory and 4 CPU cores. On lower-spec hardware, speech recognition and voice responses may be delayed.';
    }
    return { logicalCpus, memoryGiB, warning };
  };

  const defaultCapabilities = () => {
    if (state.status === 'ready') {
      return {
        chat: { ready: true, message: 'Local chat runtime is ready.' },
        voice: { ready: true, message: 'Local voice runtimes passed startup checks. Cached files can be reused offline.' },
      };
    }
    if (state.status === 'error') {
      return {
        chat: { ready: false, message: state.message || 'Local chat setup failed.' },
        voice: { ready: false, message: state.message || 'Local voice setup failed.' },
      };
    }
    if (state.status === 'running') {
      return {
        chat: { ready: false, message: state.message || 'Local setup is running.' },
        voice: { ready: false, message: state.message || 'Local setup is running.' },
      };
    }
    return {
      chat: { ready: false, message: 'Local chat runtime is not ready. Start setup to initialize it.' },
      voice: { ready: false, message: 'Local voice pipeline is not ready. Start setup to initialize it.' },
    };
  };
  const snapshot = () => ({
    platform,
    supported,
    cacheDir,
    runtimeDir,
    ...state,
    ...(state.progress ? { progress: { ...state.progress, ...(now() - transfer?.updatedAt > 10000 ? { etaSeconds: null } : {}) } } : {}),
    capabilities: getCapabilities ? getCapabilities({ state, supported }) : defaultCapabilities(),
    components: inspect(),
    hardware: getHardwareSnapshot(),
    log: [...log],
  });
  const report = ({ stage, message, progress }) => {
    if (progress) {
      const timestamp = now();
      if (!transfer || stage !== state.stage || progress.total !== state.progress?.total || progress.received < state.progress?.received) {
        transfer = { startedAt: timestamp, initialBytes: progress.received, updatedAt: timestamp };
      }
      if (progress.received !== state.progress?.received) transfer.updatedAt = timestamp;
      const elapsed = (timestamp - transfer.startedAt) / 1000;
      const bytes = progress.received - transfer.initialBytes;
      const etaSeconds = elapsed >= 1 && bytes > 0 && progress.total > progress.received
        ? Math.ceil((progress.total - progress.received) * elapsed / bytes) : null;
      progress = { ...progress, etaSeconds };
    } else transfer = null;
    state = { status: 'running', stage, message, ...(progress ? { progress } : {}) };
    if (message !== log.at(-1)) log.push(message);
    if (log.length > 40) log.shift();
  };
  function begin(download) {
    if (job || state.status === 'ready') return snapshot();
    const needsInstall = download && !inspect().every(component => component.ready);
    controller = new AbortController();
    report({ stage: needsInstall ? 'checking' : 'starting', message: needsInstall ? 'Checking reusable local files.' : 'Initializing installed local models. No installation is needed.' });
    job = new Promise(resolve => setImmediate(resolve)).then(async () => {
      if (needsInstall) await install({ report, signal: controller.signal });
      report({ stage: 'starting', message: 'Initializing local chat and voice models.' });
      await activate({ signal: controller.signal, report });
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
    async close() {
      controller?.abort();
      await job;
      state = { status: 'idle', stage: 'consent', message: 'Local runtimes are stopped.' };
    },
  };
}